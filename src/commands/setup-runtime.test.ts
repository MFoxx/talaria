import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCursorAdapter } from '../adapters/cursor.js';
import { runCommand } from '../util/exec.js';
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

  it('resolves and pins the Gemini CLI executable', async () => {
    const runtime = await resolveSetupRuntime({
      tools: ['gemini'],
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      builtinToolBins: { gemini: '/opt/gemini/bin/gemini' },
      run: () => Promise.resolve(ok),
    });
    expect(runtime.builtinToolBins).toEqual({ gemini: '/opt/gemini/bin/gemini' });
    expect(runtime.serviceExecutablePath.split(':')[0]).toBe('/opt/gemini/bin');
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
    const root = mkdtempSync(path.join(os.tmpdir(), 'talaria-shared-tool-'));
    try {
      const target = path.join(root, 'shared-agent');
      const cursorLauncher = path.join(root, 'cursor-agent');
      const grokLauncher = path.join(root, 'grok');
      writeFileSync(target, '');
      symlinkSync(target, cursorLauncher);
      symlinkSync(target, grokLauncher);

      await expect(
        resolveSetupRuntime({
          tools: ['cursor', 'grok'],
          nodePath: '/opt/node/bin/node',
          cliPath: '/opt/talaria/dist/cli.js',
          builtinToolBins: {
            cursor: cursorLauncher,
            grok: grokLauncher,
          },
          run: () => Promise.resolve(ok),
        }),
      ).rejects.toThrow(/cursor and grok resolve to the same executable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a Cursor launcher whose target depends on its invocation name', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'talaria-cursor-launcher-'));
    try {
      const target = path.join(root, 'shared-agent');
      const launcher = path.join(root, 'cursor-agent');
      writeFileSync(
        target,
        '#!/bin/sh\ncase "$0" in *cursor-agent) echo "Cursor Agent 1.0"; exit 0;; *) exit 1;; esac\n',
      );
      chmodSync(target, 0o755);
      symlinkSync(target, launcher);

      const runtime = await resolveSetupRuntime({
        tools: ['cursor'],
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        run: (bin, args) =>
          bin === '/usr/bin/which'
            ? Promise.resolve({ ...ok, stdout: launcher })
            : runCommand(bin, args),
      });

      await expect(
        createCursorAdapter(runtime.builtinToolBins.cursor).check(),
      ).resolves.toMatchObject({ available: true });
      expect(runtime.builtinToolBins.cursor).toBe(launcher);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('resolves and pins the OpenCode executable', async () => {
    const runtime = await resolveSetupRuntime({
      tools: ['opencode'],
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      builtinToolBins: { opencode: '/opt/opencode/bin/opencode' },
      run: () => Promise.resolve(ok),
    });
    expect(runtime.builtinToolBins).toEqual({ opencode: '/opt/opencode/bin/opencode' });
    expect(runtime.serviceExecutablePath.split(':')[0]).toBe('/opt/opencode/bin');
  });
});
