import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('resolves and pins the Grok Build executable', async () => {
    const runtime = await resolveSetupRuntime({
      tools: ['grok'],
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      builtinToolBins: { grok: '/opt/grok/bin/grok' },
      run: () => Promise.resolve(ok),
    });
    expect(runtime.builtinToolBins).toEqual({ grok: '/opt/grok/bin/grok' });
    expect(runtime.serviceExecutablePath.split(':')[0]).toBe('/opt/grok/bin');
  });

  it("does not mistake Grok Build's agent alias for Cursor", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'talaria-tool-identity-'));
    try {
      const grokBin = path.join(root, 'grok');
      writeFileSync(grokBin, '');
      const commands: string[] = [];

      await expect(
        resolveSetupRuntime({
          tools: ['cursor'],
          nodePath: '/opt/node/bin/node',
          cliPath: '/opt/talaria/dist/cli.js',
          run: (bin, args) => {
            commands.push([bin, ...args].join(' '));
            if (bin === '/usr/bin/which' && args[0] === 'cursor-agent') {
              return Promise.resolve({ ...ok, code: 1 });
            }
            if (bin === '/usr/bin/which' && args[0] === 'agent') {
              return Promise.resolve({ ...ok, stdout: grokBin });
            }
            if (bin === grokBin && args[0] === '--version') {
              return Promise.resolve({ ...ok, stdout: 'grok 1.0.13 (stable)' });
            }
            throw new Error(`Unexpected command: ${bin} ${args.join(' ')}`);
          },
        }),
      ).rejects.toThrow(/agent.*Grok Build.*not Cursor/i);
      expect(commands).toContain('/usr/bin/which cursor-agent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects different tools pinned to the same canonical executable', async () => {
    await expect(
      resolveSetupRuntime({
        tools: ['cursor', 'grok'],
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        builtinToolBins: {
          cursor: '/opt/shared/bin/agent',
          grok: '/opt/shared/bin/agent',
        },
        run: () => Promise.resolve(ok),
      }),
    ).rejects.toThrow(/cursor and grok resolve to the same executable/);
  });

  it('resolves and pins the Pi executable', async () => {
    const runtime = await resolveSetupRuntime({
      tools: ['pi'],
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      builtinToolBins: { pi: '/opt/pi/bin/pi' },
      run: () => Promise.resolve(ok),
    });
    expect(runtime.builtinToolBins).toEqual({ pi: '/opt/pi/bin/pi' });
    expect(runtime.serviceExecutablePath.split(':')[0]).toBe('/opt/pi/bin');
  });
});
