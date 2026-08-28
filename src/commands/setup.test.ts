import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAuthorizedKeysLine,
  buildClientConfig,
  buildServerConfig,
  setupAction,
} from './setup.js';
import { parseClientConfig } from '../config/client-config.js';
import { parseServerConfig } from '../config/server-config.js';
import type { Io } from './actions.js';

describe('buildAuthorizedKeysLine', () => {
  it('locks the key to talaria serve with restrictions', () => {
    const line = buildAuthorizedKeysLine('ssh-ed25519 AAAAKEY talaria-agent\n');
    expect(line).toBe(
      'command="talaria serve",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAAKEY talaria-agent',
    );
  });
});

describe('config builders produce valid configs', () => {
  it('server config parses', () => {
    const cfg = buildServerConfig({ allowedDirs: ['/home/me/projects'] });
    expect(() => parseServerConfig(cfg)).not.toThrow();
    expect(cfg.tools).toEqual(['claude-code', 'codex']);
  });

  it('client config parses and sets the default host', () => {
    const cfg = buildClientConfig({
      hostAlias: 'desktop',
      tailscaleHost: 'ws',
      sshUser: 'user',
      sshKey: '/home/me/.ssh/talaria',
    });
    const parsed = parseClientConfig(cfg);
    expect(parsed.defaultHost).toBe('desktop');
    expect(parsed.hosts.desktop?.tailscaleHost).toBe('ws');
  });
});

describe('setupAction', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let io: Io;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-setup-'));
    out = [];
    err = [];
    io = { write: (t) => out.push(t), errLine: (t) => err.push(t) };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes valid configs and prints the authorized_keys line', async () => {
    const keyPath = path.join(root, 'key');
    writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAPUB talaria-agent\n');
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };

    await setupAction(
      {
        role: 'both',
        key: keyPath,
        host: 'workstation',
        sshUser: 'user',
        allowedDir: [path.join(root, 'projects')],
        skipKeygen: true,
        env,
      },
      io,
    );

    const serverJson = path.join(root, 'config', 'talaria', 'server.json');
    const clientJson = path.join(root, 'config', 'talaria', 'client.json');
    expect(() => parseServerConfig(JSON.parse(readFileSync(serverJson, 'utf8')))).not.toThrow();
    const client = parseClientConfig(JSON.parse(readFileSync(clientJson, 'utf8')));
    expect(client.hosts.desktop?.tailscaleHost).toBe('workstation');

    expect(out.join('')).toContain('command="talaria serve"');
    expect(out.join('')).toContain('ssh-ed25519 AAAAPUB');
  });

  it('does not overwrite existing config without --force', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    const clientJson = path.join(root, 'config', 'talaria', 'client.json');

    await setupAction({ role: 'client', key: path.join(root, 'k'), skipKeygen: true, env }, io);
    const first = readFileSync(clientJson, 'utf8');

    // Second run with a different host but no --force: file is left untouched.
    await setupAction(
      { role: 'client', key: path.join(root, 'k'), host: 'changed', skipKeygen: true, env },
      io,
    );
    expect(readFileSync(clientJson, 'utf8')).toBe(first);
    expect(err.some((l) => l.includes('use --force'))).toBe(true);
  });

  it('rejects an invalid role', async () => {
    await expect(
      setupAction({ role: 'bogus' as 'both', skipKeygen: true, env: {} }, io),
    ).rejects.toThrow(/Invalid --role/);
  });
});
