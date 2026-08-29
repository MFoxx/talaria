import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(parsed.hosts.desktop?.transport).toBe('openssh');
  });

  it('builds a keyless Tailscale SSH client config', () => {
    const cfg = buildClientConfig({
      transport: 'tailscale-ssh',
      hostAlias: 'desktop',
      tailscaleHost: 'ws',
      sshUser: 'user',
    });
    const parsed = parseClientConfig(cfg);
    expect(parsed.hosts.desktop).toEqual({
      transport: 'tailscale-ssh',
      tailscaleHost: 'ws',
      sshUser: 'user',
      serverCommand: 'talaria serve',
    });
  });

  it('preserves an explicit Tailscale SSH server command', () => {
    const parsed = parseClientConfig(
      buildClientConfig({
        transport: 'tailscale-ssh',
        hostAlias: 'desktop',
        tailscaleHost: 'ws',
        sshUser: 'user',
        serverCommand: '/opt/talaria/bin/talaria serve',
      }),
    );
    expect(
      parsed.hosts.desktop?.transport === 'tailscale-ssh'
        ? parsed.hosts.desktop.serverCommand
        : undefined,
    ).toBe('/opt/talaria/bin/talaria serve');
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

  it('does not ask a server-only setup for a controller public key', async () => {
    await setupAction(
      {
        role: 'server',
        allowedDir: [path.join(root, 'projects')],
        env: { XDG_CONFIG_HOME: path.join(root, 'config') },
        home: root,
      },
      io,
    );

    expect(err.join('\n')).not.toContain('No public key');
    expect(err.join('\n')).not.toContain('authorized_keys');
  });

  it('configures Tailscale SSH without generating or printing a key', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    const keyPath = path.join(root, '.ssh', 'talaria_agent_ed25519');

    await setupAction(
      {
        role: 'client',
        transport: 'tailscale-ssh',
        host: 'workstation',
        sshUser: 'user',
        env,
        home: root,
      },
      io,
    );

    const clientJson = path.join(root, 'config', 'talaria', 'client.json');
    const client = parseClientConfig(JSON.parse(readFileSync(clientJson, 'utf8')));
    expect(client.hosts.desktop?.transport).toBe('tailscale-ssh');
    expect(existsSync(keyPath)).toBe(false);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('no SSH key was generated');
    expect(err.join('\n')).toContain('tailnet policy');
  });

  it('rejects an SSH key option for Tailscale SSH', async () => {
    await expect(
      setupAction({ role: 'client', transport: 'tailscale-ssh', key: path.join(root, 'key') }, io),
    ).rejects.toThrow(/--key applies only/);
  });

  it('rejects a server command for OpenSSH', async () => {
    await expect(
      setupAction({ role: 'client', serverCommand: 'something', skipKeygen: true }, io),
    ).rejects.toThrow(/--server-command applies only/);
  });

  it('rejects an invalid role', async () => {
    await expect(
      setupAction({ role: 'bogus' as 'both', skipKeygen: true, env: {} }, io),
    ).rejects.toThrow(/Invalid --role/);
  });

  it('rejects an invalid transport', async () => {
    await expect(
      setupAction({ transport: 'magic' as 'openssh', skipKeygen: true, env: {} }, io),
    ).rejects.toThrow(/Invalid --transport/);
  });
});
