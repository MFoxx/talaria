import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../util/exec.js';
import {
  buildMacOsRestrictedShell,
  createMacOsIsolationPlan,
  provisionMacOsIsolation,
} from './macos-isolation.js';

const result = (code = 0, stdout = ''): RunResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
});

describe('macOS Tailscale SSH isolation', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(path.join(os.tmpdir(), 'talaria-project-'));
  });

  afterEach(() => rmSync(project, { recursive: true, force: true }));

  function plan() {
    return createMacOsIsolationPlan({
      controllerUser: 'alice',
      allowedDirs: [project],
      serverConfig: { tools: ['claude-code', 'codex'], allowedDirs: [project] },
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/opt/homebrew/lib/node_modules/talaria/dist/cli.js',
      executablePath: '/Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin',
    });
  }

  it('builds an exact-command shell with a self-contained tool PATH', () => {
    const shell = buildMacOsRestrictedShell(plan());
    expect(shell).toContain('[ "$#" -ne 2 ]');
    expect(shell).toContain('[ "$1" != "-c" ]');
    expect(shell).toContain('[ "$2" != "talaria serve" ]');
    expect(shell).toContain("export HOME='/Users/talaria'");
    expect(shell).toContain("'/opt/homebrew/bin/node'");
    expect(shell).toContain("'/opt/homebrew/lib/node_modules/talaria/dist/cli.js' serve");
    expect(shell).toContain('/Users/alice/.local/bin');
  });

  it('uses explicit argv for account, group, ACL, install, and account-level checks', async () => {
    const commands: Array<{ bin: string; args: string[] }> = [];
    const isolationPlan = plan();
    await provisionMacOsIsolation(isolationPlan, {
      getuid: () => 501,
      run: (bin, args) => {
        if (bin === '/usr/bin/dscl' && args.includes('-list')) {
          return Promise.resolve(result(0, 'alice 501\nbob 502\n'));
        }
        return Promise.resolve(result(1));
      },
      runInteractive: (bin, args) => {
        commands.push({ bin, args });
        return Promise.resolve(0);
      },
    });

    expect(commands).toContainEqual({
      bin: '/usr/bin/sudo',
      args: ['/usr/bin/dscl', '.', '-create', '/Users/talaria', 'UniqueID', '503'],
    });
    expect(commands).toContainEqual({
      bin: '/usr/bin/sudo',
      args: [
        '/usr/sbin/dseditgroup',
        '-o',
        'edit',
        '-a',
        'talaria',
        '-t',
        'user',
        'talaria-projects',
      ],
    });
    expect(
      commands.some(
        ({ bin, args }) =>
          bin === '/usr/bin/sudo' &&
          args[0] === '/usr/bin/chgrp' &&
          args[1] === '-R' &&
          args[2] === 'talaria-projects' &&
          args[3] === isolationPlan.allowedDirs[0],
      ),
    ).toBe(true);
    expect(
      commands.some(
        ({ args }) =>
          args[0] === '/bin/chmod' &&
          args[1] === '+a' &&
          args.at(-1) === isolationPlan.allowedDirs[0],
      ),
    ).toBe(true);
    expect(commands).toContainEqual({
      bin: '/usr/bin/sudo',
      args: ['-u', 'talaria', '/bin/test', '-x', '/opt/homebrew/bin/node'],
    });
    expect(
      commands.some(
        ({ bin, args }) =>
          bin === '/usr/bin/sudo' &&
          args.includes(
            'PATH=/Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin:/opt/homebrew/lib/node_modules/talaria/dist:/usr/local/bin:/bin:/usr/sbin:/sbin',
          ) &&
          args.includes('codex'),
      ),
    ).toBe(true);
    expect(commands.every(({ args }) => !args.slice(1).includes('/usr/bin/sudo'))).toBe(true);
  });

  it('refuses to repurpose an existing administrator account', async () => {
    await expect(
      provisionMacOsIsolation(plan(), {
        getuid: () => 501,
        runInteractive: () => Promise.resolve(0),
        run: (bin) =>
          Promise.resolve(
            bin === '/usr/sbin/dseditgroup' ? result(0, 'yes alice talaria') : result(0),
          ),
      }),
    ).rejects.toThrow(/is an administrator/);
  });
});
