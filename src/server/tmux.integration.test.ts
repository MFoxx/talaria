/**
 * Real-tmux integration test for {@link TmuxProcessManager}.
 *
 * Skips automatically when tmux isn't installed. Note: tmux must be able to daemonize,
 * so this won't pass inside a sandbox that blocks the server fork — run it in a normal
 * shell (`npm test`).
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TmuxProcessManager } from './tmux.js';
import { SessionStore, type SessionMeta } from './session-store.js';
import type { ExitResult } from './process-manager.js';
import type { StreamName } from '../protocol/messages.js';
import { runCommand } from '../util/exec.js';
import { deferred } from '../util/async.js';

const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0;
const NODE = process.execPath;

function meta(id: string): SessionMeta {
  return {
    sessionId: id,
    tool: 'echo-tool',
    dir: process.cwd(),
    prompt: 'p',
    toolArgs: {},
    tmuxSession: `talaria-${id}`,
    pid: null,
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: null,
    signal: null,
    endedAt: null,
    timeout: 600,
  };
}

describe.skipIf(!HAS_TMUX)('TmuxProcessManager (real tmux)', () => {
  let root: string;
  let socket: string;
  let store: SessionStore;
  let pm: TmuxProcessManager;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-tmux-it-'));
    socket = path.join(root, 'tmux.sock');
    store = new SessionStore(root);
    pm = new TmuxProcessManager(store, { socketPath: socket, pollMs: 150, tailPollMs: 60 });
  });

  afterEach(async () => {
    await runCommand('tmux', ['-S', socket, 'kill-server']).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('streams output and reports the tool exit code', async () => {
    const id = 'itsess1';
    store.create(meta(id));
    const chunks: Array<[StreamName, string]> = [];
    const exit = deferred<ExitResult>();

    const handle = await pm.start({
      sessionId: id,
      tmuxSession: `talaria-${id}`,
      cwd: process.cwd(),
      bin: NODE,
      args: ['-e', 'process.stdout.write("hello-tmux"); process.exit(5)'],
      onChunk: (stream, data) => chunks.push([stream, data]),
      onExit: (r) => exit.resolve(r),
    });

    expect(handle.pid).toBeTypeOf('number');

    const result = await exit.promise;
    expect(result.code).toBe(5);

    const out = chunks.map(([, d]) => d).join('');
    expect(out).toContain('hello-tmux');
  }, 15_000);

  it('streams output incrementally for a longer-running tool', async () => {
    const id = 'itsess3';
    store.create(meta(id));
    const chunks: string[] = [];
    const exit = deferred<ExitResult>();

    await pm.start({
      sessionId: id,
      tmuxSession: `talaria-${id}`,
      cwd: process.cwd(),
      bin: NODE,
      // Emit, wait long enough for pipe-pane to attach and the tailer to poll, emit again.
      args: [
        '-e',
        'process.stdout.write("first\\n"); setTimeout(() => { process.stdout.write("second\\n"); process.exit(0); }, 500)',
      ],
      onChunk: (_stream, data) => chunks.push(data),
      onExit: (r) => exit.resolve(r),
    });

    const result = await exit.promise;
    expect(result.code).toBe(0);
    const out = chunks.join('');
    expect(out).toContain('first');
    expect(out).toContain('second');
  }, 15_000);

  it('kills a running session on SIGKILL', async () => {
    const id = 'itsess2';
    store.create(meta(id));
    const exit = deferred<ExitResult>();

    await pm.start({
      sessionId: id,
      tmuxSession: `talaria-${id}`,
      cwd: process.cwd(),
      bin: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'], // runs until killed
      onChunk: () => {},
      onExit: (r) => exit.resolve(r),
    });

    await pm.signal(`talaria-${id}`, 'SIGKILL');
    const result = await exit.promise;
    expect(result).toBeDefined();
  }, 15_000);
});
