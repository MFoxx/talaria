import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
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
    expect(started?.type).toBe('started');
    if (started?.type !== 'started') throw new Error('missing started');
    expect(started.conversationId).toMatch(/^[a-f0-9]{24}$/);
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

  it('continues a harness conversation in a new Talaria session', async () => {
    const harness = path.join(workDir, 'fake-claude');
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const resume = args.indexOf("--resume");',
        'const id = resume >= 0 ? args[resume + 1] : "native-claude-session";',
        'const prompt = args.at(-1);',
        'process.stdout.write(JSON.stringify({type:"system",session_id:id}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",session_id:id,result:prompt}) + "\\n");',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);
    const continuationConfig = parseServerConfig({
      tools: ['claude-code'],
      builtinToolBins: { 'claude-code': harness },
      allowedDirs: [workDir],
      sessionDir,
    });
    const continuationCtx = buildContext(continuationConfig, { tailPollMs: 10 });

    const initial = await send(continuationCtx, {
      type: 'run',
      tool: 'claude-code',
      dir: workDir,
      prompt: 'first',
      toolArgs: { model: 'test-model' },
    });
    const firstStarted = initial.find((message) => message.type === 'started');
    expect(firstStarted?.type).toBe('started');
    if (firstStarted?.type !== 'started') throw new Error('missing started');

    const store = new SessionStore(sessionDir);
    const release = store.acquireConversationLock(firstStarted.conversationId);
    const busy = await send(continuationCtx, {
      type: 'continue',
      conversationId: firstStarted.conversationId,
      prompt: 'racing follow-up',
    });
    release();
    expect(busy).toEqual([expect.objectContaining({ type: 'error', code: 'CONVERSATION_BUSY' })]);

    const followUp = await send(continuationCtx, {
      type: 'continue',
      conversationId: firstStarted.conversationId,
      prompt: 'second',
    });
    const secondStarted = followUp.find((message) => message.type === 'started');
    expect(secondStarted).toMatchObject({
      type: 'started',
      conversationId: firstStarted.conversationId,
    });
    if (secondStarted?.type !== 'started') throw new Error('missing continuation started');
    expect(secondStarted.sessionId).not.toBe(firstStarted.sessionId);

    const stored = store.readMeta(secondStarted.sessionId);
    expect(stored).toMatchObject({
      conversationId: firstStarted.conversationId,
      parentSessionId: firstStarted.sessionId,
      nativeSessionId: 'native-claude-session',
      prompt: 'second',
      toolArgs: { model: 'test-model' },
    });
    expect(
      followUp
        .filter((message) => message.type === 'output')
        .map((message) => message.data)
        .join(''),
    ).toContain('second');
  });

  it('rejects continuation for a tool without continuation support', async () => {
    const initial = await send(ctx, {
      type: 'run',
      tool: 'echo-tool',
      dir: workDir,
      prompt: 'first',
    });
    const started = initial.find((message) => message.type === 'started');
    if (started?.type !== 'started') throw new Error('missing started');

    const result = await send(ctx, {
      type: 'continue',
      conversationId: started.conversationId,
      prompt: 'second',
    });
    expect(result).toEqual([
      expect.objectContaining({ type: 'error', code: 'CONTINUATION_UNSUPPORTED' }),
    ]);
  });

  it('fails a Codex continuation that reports a different native thread', async () => {
    const harness = path.join(workDir, 'fake-codex');
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env node',
        'const resumed = process.argv.includes("resume");',
        'const id = resumed ? "different-thread" : "original-thread";',
        'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:id}) + "\\n");',
        'setTimeout(() => process.exit(0), 50);',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);
    const codexConfig = parseServerConfig({
      tools: ['codex'],
      builtinToolBins: { codex: harness },
      allowedDirs: [workDir],
      sessionDir,
    });
    const codexCtx = buildContext(codexConfig, { tailPollMs: 10 });
    const initial = await send(codexCtx, {
      type: 'run',
      tool: 'codex',
      dir: workDir,
      prompt: 'first',
    });
    const started = initial.find((message) => message.type === 'started');
    if (started?.type !== 'started') throw new Error('missing started');

    const followUp = await send(codexCtx, {
      type: 'continue',
      conversationId: started.conversationId,
      prompt: 'second',
    });
    expect(followUp).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'CONTINUATION_UNAVAILABLE' }),
    );
    expect(followUp.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });

  it('captures and resumes a Grok session from non-newline json output', async () => {
    const harness = path.join(workDir, 'fake-grok');
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'const cwd = args.indexOf("--cwd");',
        'if (cwd < 0 || args[cwd + 1] !== process.cwd()) process.exit(7);',
        'const resume = args.indexOf("--resume");',
        'const id = resume >= 0 ? args[resume + 1] : "native-grok-session";',
        'const prompt = args[args.indexOf("-p") + 1];',
        'process.stdout.write(JSON.stringify({text:prompt,sessionId:id}));',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);
    const grokConfig = parseServerConfig({
      tools: ['grok'],
      builtinToolBins: { grok: harness },
      allowedDirs: [workDir],
      sessionDir,
    });
    const grokCtx = buildContext(grokConfig, { tailPollMs: 10 });

    const initial = await send(grokCtx, {
      type: 'run',
      tool: 'grok',
      dir: workDir,
      prompt: 'first',
      toolArgs: { model: 'grok-build', outputFormat: 'json' },
    });
    const firstStarted = initial.find((message) => message.type === 'started');
    if (firstStarted?.type !== 'started') throw new Error('missing Grok started event');
    expect(initial.at(-1)).toMatchObject({ type: 'done', status: 'completed', exitCode: 0 });

    const followUp = await send(grokCtx, {
      type: 'continue',
      conversationId: firstStarted.conversationId,
      prompt: 'second',
    });
    const secondStarted = followUp.find((message) => message.type === 'started');
    if (secondStarted?.type !== 'started') throw new Error('missing Grok continuation event');
    expect(new SessionStore(sessionDir).readMeta(secondStarted.sessionId)).toMatchObject({
      conversationId: firstStarted.conversationId,
      parentSessionId: firstStarted.sessionId,
      nativeSessionId: 'native-grok-session',
      prompt: 'second',
      toolArgs: { model: 'grok-build', outputFormat: 'json' },
    });
    expect(
      followUp
        .filter((message) => message.type === 'output')
        .map((message) => message.data)
        .join(''),
    ).toContain('second');
    expect(followUp.at(-1)).toMatchObject({ type: 'done', status: 'completed', exitCode: 0 });
  });

  it('runs Gemini in the requested cwd and resumes its stream-json session', async () => {
    const harness = path.join(workDir, 'fake-gemini');
    writeFileSync(
      harness,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (!args.includes("--skip-trust")) process.exit(5);',
        'const format = args.indexOf("--output-format");',
        'if (format < 0 || args[format + 1] !== "stream-json") process.exit(6);',
        `if (process.cwd() !== ${JSON.stringify(workDir)}) process.exit(7);`,
        'const resume = args.indexOf("--resume");',
        'const id = resume >= 0 ? args[resume + 1] : "native-gemini-session";',
        'const prompt = args[args.indexOf("-p") + 1];',
        'process.stdout.write(JSON.stringify({type:"init",session_id:id,model:"gemini-test"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"message",role:"assistant",content:prompt}) + "\\n");',
      ].join('\n'),
    );
    chmodSync(harness, 0o755);
    const geminiConfig = parseServerConfig({
      tools: ['gemini'],
      builtinToolBins: { gemini: harness },
      allowedDirs: [workDir],
      sessionDir,
    });
    const geminiCtx = buildContext(geminiConfig, { tailPollMs: 10 });

    const initial = await send(geminiCtx, {
      type: 'run',
      tool: 'gemini',
      dir: workDir,
      prompt: 'first',
      toolArgs: { model: 'gemini-test', approvalMode: 'auto_edit' },
    });
    const firstStarted = initial.find((message) => message.type === 'started');
    if (firstStarted?.type !== 'started') throw new Error('missing Gemini started event');
    expect(initial.at(-1)).toMatchObject({ type: 'done', status: 'completed', exitCode: 0 });

    const followUp = await send(geminiCtx, {
      type: 'continue',
      conversationId: firstStarted.conversationId,
      prompt: 'second',
    });
    const secondStarted = followUp.find((message) => message.type === 'started');
    if (secondStarted?.type !== 'started') throw new Error('missing Gemini continuation event');
    expect(new SessionStore(sessionDir).readMeta(secondStarted.sessionId)).toMatchObject({
      conversationId: firstStarted.conversationId,
      parentSessionId: firstStarted.sessionId,
      nativeSessionId: 'native-gemini-session',
      prompt: 'second',
      toolArgs: { model: 'gemini-test', approvalMode: 'auto_edit' },
    });
    expect(
      followUp
        .filter((message) => message.type === 'output')
        .map((message) => message.data)
        .join(''),
    ).toContain('second');
    expect(followUp.at(-1)).toMatchObject({ type: 'done', status: 'completed', exitCode: 0 });
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
