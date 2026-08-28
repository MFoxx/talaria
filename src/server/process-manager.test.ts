import { describe, expect, it } from 'vitest';
import { DirectProcessManager, type ExitResult } from './process-manager.js';
import type { StreamName } from '../protocol/messages.js';
import { deferred } from '../util/async.js';

const NODE = process.execPath;

describe('DirectProcessManager', () => {
  it('streams stdout and stderr separately and reports a clean exit', async () => {
    const pm = new DirectProcessManager();
    const chunks: Array<[StreamName, string]> = [];
    const done = deferred<ExitResult>();

    const handle = await pm.start({
      sessionId: 's1',
      tmuxSession: 'talaria-s1',
      cwd: process.cwd(),
      bin: NODE,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      onChunk: (stream, data) => chunks.push([stream, data]),
      onExit: (r) => done.resolve(r),
    });

    expect(handle.pid).toBeTypeOf('number');
    const result = await done.promise;
    expect(result).toEqual({ code: 0, signal: null });

    const stdout = chunks
      .filter(([s]) => s === 'stdout')
      .map(([, d]) => d)
      .join('');
    const stderr = chunks
      .filter(([s]) => s === 'stderr')
      .map(([, d]) => d)
      .join('');
    expect(stdout).toBe('out');
    expect(stderr).toBe('err');
  });

  it('reports a non-zero exit code', async () => {
    const pm = new DirectProcessManager();
    const done = deferred<ExitResult>();
    await pm.start({
      sessionId: 's2',
      tmuxSession: 'talaria-s2',
      cwd: process.cwd(),
      bin: NODE,
      args: ['-e', 'process.exit(3)'],
      onChunk: () => {},
      onExit: (r) => done.resolve(r),
    });
    expect((await done.promise).code).toBe(3);
  });

  it('rejects with SPAWN_FAILED when the binary is missing', async () => {
    const pm = new DirectProcessManager();
    await expect(
      pm.start({
        sessionId: 's3',
        tmuxSession: 'talaria-s3',
        cwd: process.cwd(),
        bin: '/nonexistent/xyzzy-bin',
        args: [],
        onChunk: () => {},
        onExit: () => {},
      }),
    ).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
  });
});
