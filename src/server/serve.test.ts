import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { buildContext, serveConnection } from './serve.js';
import { parseServerConfig, type ServerConfig } from '../config/server-config.js';
import type { HandlerContext } from './handlers.js';
import type { Request, Response } from '../protocol/messages.js';
import { SessionStore, type SessionMeta } from './session-store.js';

const NODE = process.execPath;

/** Collect everything written to a Writable as text. */
class Collector extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString('utf8'));
    cb();
  }
  messages(): Response[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Response);
  }
}

async function send(ctx: HandlerContext, req: Request): Promise<Response[]> {
  const input = Readable.from([JSON.stringify(req) + '\n']);
  const out = new Collector();
  await serveConnection(ctx, input, out);
  return out.messages();
}

describe('serveConnection (end to end)', () => {
  let workDir: string;
  let sessionDir: string;
  let config: ServerConfig;
  let ctx: HandlerContext;

  beforeEach(() => {
    workDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talaria-e2e-work-')));
    sessionDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talaria-e2e-sess-')));
    // A trivial "tool": node prints the prompt to stdout and a marker to stderr.
    const script = 'process.stdout.write("out:{{prompt}}");process.stderr.write("err:{{prompt}}")';
    config = parseServerConfig({
      tools: ['echo-tool'],
      allowedDirs: [workDir],
      sessionDir,
      customTools: [{ name: 'echo-tool', bin: NODE, argsTemplate: ['-e', script] }],
    });
    ctx = buildContext(config, { tailPollMs: 10 });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('runs a tool: started → output → done(completed)', async () => {
    const msgs = await send(ctx, {
      type: 'run',
      tool: 'echo-tool',
      dir: workDir,
      prompt: 'PONG',
    });

    const started = msgs.find((m) => m.type === 'started');
    const done = msgs.find((m) => m.type === 'done');
    expect(started).toBeDefined();
    expect(done).toMatchObject({ type: 'done', status: 'completed', exitCode: 0 });

    const outputs = msgs.filter((m) => m.type === 'output');
    const stdout = outputs
      .filter((m) => m.stream === 'stdout')
      .map((m) => m.data)
      .join('');
    const stderr = outputs
      .filter((m) => m.stream === 'stderr')
      .map((m) => m.data)
      .join('');
    expect(stdout).toBe('out:PONG');
    expect(stderr).toBe('err:PONG');

    // Offsets are monotonically increasing.
    const offsets = outputs.map((m) => m.offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('attach with offset 0 replays a finished session then sends done', async () => {
    const runMsgs = await send(ctx, { type: 'run', tool: 'echo-tool', dir: workDir, prompt: 'X' });
    const started = runMsgs.find((m) => m.type === 'started');
    expect(started?.type).toBe('started');
    const sessionId = started!.type === 'started' ? started!.sessionId : '';

    const msgs = await send(ctx, { type: 'attach', sessionId, offset: 0 });
    const attached = msgs.find((m) => m.type === 'attached');
    expect(attached).toMatchObject({ type: 'attached', status: 'completed' });
    const replayed = msgs
      .filter((m) => m.type === 'output')
      .map((m) => m.data)
      .join('');
    expect(replayed).toContain('out:X');
    expect(msgs.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it('rejects a directory outside the allowlist', async () => {
    const msgs = await send(ctx, { type: 'run', tool: 'echo-tool', dir: '/etc', prompt: 'p' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'error', code: 'DIR_NOT_ALLOWED' });
  });

  it('rejects an unknown tool', async () => {
    const msgs = await send(ctx, { type: 'run', tool: 'ghost', dir: workDir, prompt: 'p' });
    expect(msgs[0]).toMatchObject({ type: 'error', code: 'UNKNOWN_TOOL' });
  });

  it('rejects a malformed request', async () => {
    const input = Readable.from(['{ not json\n']);
    const out = new Collector();
    await serveConnection(ctx, input, out);
    expect(out.messages()[0]).toMatchObject({ type: 'error', code: 'INVALID_REQUEST' });
  });

  it('answers ping and list-tools', async () => {
    expect(await send(ctx, { type: 'ping' })).toEqual([{ type: 'pong' }]);
    const tools = await send(ctx, { type: 'list-tools' });
    expect(tools[0]).toMatchObject({ type: 'tool_list' });
  });

  it('lists and reports status for a completed session', async () => {
    const runMsgs = await send(ctx, { type: 'run', tool: 'echo-tool', dir: workDir, prompt: 'Y' });
    const started = runMsgs.find((m) => m.type === 'started');
    const sessionId = started!.type === 'started' ? started!.sessionId : '';

    const list = await send(ctx, { type: 'list' });
    expect(list[0]).toMatchObject({ type: 'session_list' });

    const status = await send(ctx, { type: 'status', sessionId });
    expect(status[0]).toMatchObject({ type: 'session_status', status: 'completed', exitCode: 0 });
  });

  it('returns SESSION_NOT_FOUND for an unknown session', async () => {
    const msgs = await send(ctx, { type: 'status', sessionId: 'deadbeef' });
    expect(msgs[0]).toMatchObject({ type: 'error', code: 'SESSION_NOT_FOUND' });
  });

  it('bounds the attach tail for an orphaned running session', async () => {
    // A session stuck in `running` whose owning serve process died: its meta never
    // reaches a terminal status, so an unbounded tail would poll forever.
    const orphan: SessionMeta = {
      sessionId: 'orphan01',
      tool: 'echo-tool',
      dir: workDir,
      prompt: 'p',
      toolArgs: {},
      tmuxSession: 'talaria-orphan01',
      pid: null,
      startedAt: '2020-01-01T00:00:00.000Z',
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
      timeout: 1,
    };
    new SessionStore(sessionDir).create(orphan);

    // `now` is well past the session's lifetime + grace, so the tail bails immediately.
    const orphanCtx = buildContext(config, {
      tailPollMs: 5,
      now: () => Date.parse('2100-01-01T00:00:00.000Z'),
    });
    const msgs = await send(orphanCtx, { type: 'attach', sessionId: 'orphan01', offset: 0 });

    expect(msgs.find((m) => m.type === 'attached')).toBeDefined();
    expect(msgs.at(-1)).toMatchObject({ type: 'error', code: 'INTERNAL' });
  });
});
