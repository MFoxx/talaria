import { describe, expect, it } from 'vitest';
import { parseClientConfig, resolveHost } from './client-config.js';

const home = '/home/me';

const example = {
  hosts: {
    desktop: {
      tailscaleHost: 'my-workstation',
      sshUser: 'user',
      sshKey: '~/.ssh/talaria_agent_ed25519',
      sshOptions: ['-o', 'ConnectTimeout=10'],
    },
  },
  defaultHost: 'desktop',
  defaultTimeout: 600,
  outputFormat: 'pretty',
} as const;

describe('parseClientConfig', () => {
  it('applies defaults', () => {
    const cfg = parseClientConfig({});
    expect(cfg.defaultTimeout).toBe(600);
    expect(cfg.outputFormat).toBe('pretty');
    expect(cfg.hosts).toEqual({});
    expect(cfg.defaultHost).toBeUndefined();
  });

  it('accepts the spec example and expands the ssh key path', () => {
    const cfg = parseClientConfig(example, { home });
    const host = cfg.hosts.desktop;
    expect(host?.transport).toBe('openssh');
    if (host?.transport !== 'openssh') throw new Error('expected OpenSSH host');
    expect(host.sshKey).toBe('/home/me/.ssh/talaria_agent_ed25519');
    expect(host.sshOptions).toEqual(['-o', 'ConnectTimeout=10']);
    expect(cfg.defaultHost).toBe('desktop');
  });

  it('defaults sshOptions to an empty array', () => {
    const cfg = parseClientConfig({
      hosts: { h: { tailscaleHost: 't', sshUser: 'u', sshKey: '/k' } },
    });
    const host = cfg.hosts.h;
    expect(host?.transport).toBe('openssh');
    if (host?.transport !== 'openssh') throw new Error('expected OpenSSH host');
    expect(host.sshOptions).toEqual([]);
  });

  it('accepts Tailscale SSH without a key', () => {
    const cfg = parseClientConfig({
      hosts: {
        h: {
          transport: 'tailscale-ssh',
          tailscaleHost: 'workstation',
          sshUser: 'talaria',
        },
      },
    });
    expect(cfg.hosts.h).toEqual({
      transport: 'tailscale-ssh',
      tailscaleHost: 'workstation',
      sshUser: 'talaria',
      serverCommand: 'talaria serve',
    });
  });

  it('rejects transport-specific fields on the wrong transport', () => {
    expect(() =>
      parseClientConfig({
        hosts: {
          h: {
            transport: 'tailscale-ssh',
            tailscaleHost: 'workstation',
            sshUser: 'talaria',
            sshKey: '/must-not-be-used',
          },
        },
      }),
    ).toThrow();
  });

  it('rejects a defaultHost that is not defined', () => {
    expect(() => parseClientConfig({ hosts: {}, defaultHost: 'ghost' })).toThrow(
      /not a defined host/,
    );
  });

  it('rejects unknown top-level fields', () => {
    expect(() => parseClientConfig({ bogus: 1 })).toThrow();
  });
});

describe('resolveHost', () => {
  it('resolves an explicit alias', () => {
    const cfg = parseClientConfig(example, { home });
    const host = resolveHost(cfg, 'desktop');
    expect(host.alias).toBe('desktop');
    expect(host.tailscaleHost).toBe('my-workstation');
    expect(host.transport).toBe('openssh');
  });

  it('falls back to defaultHost when no alias is given', () => {
    const cfg = parseClientConfig(example, { home });
    expect(resolveHost(cfg).alias).toBe('desktop');
  });

  it('throws when neither alias nor defaultHost is available', () => {
    const cfg = parseClientConfig({
      hosts: { h: { tailscaleHost: 't', sshUser: 'u', sshKey: '/k' } },
    });
    expect(() => resolveHost(cfg)).toThrow(/no defaultHost/i);
  });

  it('throws on an unknown alias and lists known hosts', () => {
    const cfg = parseClientConfig(example, { home });
    expect(() => resolveHost(cfg, 'nope')).toThrow(/Unknown host "nope".*desktop/s);
  });
});
