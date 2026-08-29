import { describe, expect, it } from 'vitest';
import type { RunResult } from '../util/exec.js';
import { buildServiceExecutablePath, resolveSetupRuntime } from './setup-runtime.js';

const ok: RunResult = { code: 0, signal: null, stdout: '', stderr: '' };

describe('setup runtime resolution', () => {
  it('builds a service PATH only from pinned runtime directories and system paths', () => {
    const value = buildServiceExecutablePath('/private/node/bin/node', '/private/app/dist/cli.js', {
      codex: '/pinned/codex/bin/codex',
    });
    expect(value.split(':')).toEqual([
      '/pinned/codex/bin',
      '/private/node/bin',
      '/private/app/dist',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]);
  });

  it('resolves only configured built-in tools and pins their absolute paths', async () => {
    const commands: string[] = [];
    const runtime = await resolveSetupRuntime({
      tools: ['codex'],
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      builtinToolBins: { codex: '/opt/codex/bin/codex' },
      run: (bin, args) => {
        commands.push([bin, ...args].join(' '));
        return Promise.resolve(ok);
      },
    });
    expect(runtime.builtinToolBins).toEqual({ codex: '/opt/codex/bin/codex' });
    expect(commands).toEqual([]);
  });
});
