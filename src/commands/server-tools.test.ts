import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthorizedKeysLine, buildServerConfig, buildTalariaForcedCommand } from './setup.js';
import {
  addServerToolAction,
  refreshAuthorizedKeysCommands,
  removeServerToolAction,
} from './server-tools.js';
import type { RunResult } from '../util/exec.js';

const okResult = (stdout = ''): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
});

describe('addServerToolAction', () => {
  let root: string;
  let home: string;
  let configFile: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-add-tool-'));
    home = path.join(root, 'home');
    configFile = path.join(root, 'config', 'talaria', 'server.json');
    mkdirSync(path.dirname(configFile), { recursive: true });
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pins a newly installed tool and refreshes restricted OpenSSH PATH entries', async () => {
    const codexBin = path.join(root, 'codex', 'bin', 'codex');
    const grokBin = path.join(root, 'grok', 'bin', 'grok');
    const nodePath = path.join(root, 'node', 'bin', 'node');
    const cliPath = path.join(root, 'talaria', 'dist', 'cli.js');
    for (const file of [codexBin, grokBin, nodePath, cliPath]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
      chmodSync(file, 0o755);
    }

    writeFileSync(
      configFile,
      JSON.stringify(
        buildServerConfig({
          tools: ['codex'],
          allowedDirs: ['/srv/projects'],
          builtinToolBins: { codex: codexBin },
        }),
      ),
    );
    const oldCommand = buildTalariaForcedCommand({
      nodePath,
      cliPath,
      serviceExecutablePath: [path.dirname(codexBin), path.dirname(nodePath), '/usr/bin'].join(':'),
    });
    writeFileSync(
      path.join(home, '.ssh', 'authorized_keys'),
      buildAuthorizedKeysLine('ssh-ed25519 AAAAKEY talaria-agent', oldCommand) + '\n',
    );

    const messages: string[] = [];
    await addServerToolAction(
      { tool: 'grok', env: { XDG_CONFIG_HOME: path.join(root, 'config') }, home },
      { write: () => {}, errLine: (line) => messages.push(line) },
      {
        nodePath,
        cliPath,
        run: (bin, args) => {
          expect([bin, ...args]).toEqual(['/usr/bin/which', 'grok']);
          return Promise.resolve(okResult(grokBin));
        },
      },
    );

    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      tools: string[];
      builtinToolBins: Record<string, string>;
    };
    expect(config.tools).toEqual(['codex', 'grok']);
    expect(config.builtinToolBins).toEqual({ codex: codexBin, grok: realpathSync(grokBin) });
    const authorizedKeys = readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8');
    expect(authorizedKeys).toContain(path.dirname(realpathSync(grokBin)));
    expect(authorizedKeys).toContain(
      'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty',
    );
    expect(authorizedKeys).toContain('ssh-ed25519 AAAAKEY talaria-agent');
    expect(messages.join('\n')).toContain('enabled grok');
  });

  it('does not change the config or keys when the requested tool is missing', async () => {
    const codexBin = path.join(root, 'codex');
    const nodePath = path.join(root, 'node');
    const cliPath = path.join(root, 'cli.js');
    const configText = JSON.stringify(
      buildServerConfig({
        tools: ['codex'],
        allowedDirs: ['/srv/projects'],
        builtinToolBins: { codex: codexBin },
      }),
    );
    const keyText = 'ssh-ed25519 AAAAUNRELATED personal\n';
    writeFileSync(configFile, configText);
    writeFileSync(path.join(home, '.ssh', 'authorized_keys'), keyText);

    await expect(
      addServerToolAction(
        { tool: 'grok', env: { XDG_CONFIG_HOME: path.join(root, 'config') }, home },
        { write: () => {}, errLine: () => {} },
        {
          nodePath,
          cliPath,
          run: () => Promise.resolve({ ...okResult(), code: 1 }),
        },
      ),
    ).rejects.toThrow(/grok was not found in PATH/);

    expect(readFileSync(configFile, 'utf8')).toBe(configText);
    expect(readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(keyText);
  });

  it('leaves unrelated authorized keys unchanged', () => {
    const filePath = path.join(home, '.ssh', 'authorized_keys');
    const unrelated = [
      'ssh-ed25519 AAAANORMAL personal',
      "command=\"PATH='/other' '/bin/node' '/other/serve.js' serve\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAAOTHER custom",
      '',
    ].join('\n');
    writeFileSync(filePath, unrelated);

    const refreshed = refreshAuthorizedKeysCommands(home, "PATH='/new' '/node' '/talaria' serve");

    expect(refreshed).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe(unrelated);
  });

  it('removes a poisoned duplicate pin and keeps the remaining tool enabled', async () => {
    const sharedBin = path.join(root, 'grok', 'bin', 'grok');
    const nodePath = path.join(root, 'node', 'bin', 'node');
    const cliPath = path.join(root, 'talaria', 'dist', 'cli.js');
    writeFileSync(
      configFile,
      JSON.stringify(
        buildServerConfig({
          tools: ['cursor', 'grok'],
          allowedDirs: ['/srv/projects'],
          builtinToolBins: { cursor: sharedBin, grok: sharedBin },
        }),
      ),
    );

    await removeServerToolAction(
      { tool: 'cursor', env: { XDG_CONFIG_HOME: path.join(root, 'config') }, home },
      { write: () => {}, errLine: () => {} },
      { nodePath, cliPath, run: () => Promise.resolve(okResult()) },
    );

    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      tools: string[];
      builtinToolBins: Record<string, string>;
    };
    expect(config.tools).toEqual(['grok']);
    expect(config.builtinToolBins).toEqual({ grok: sharedBin });
  });
});
