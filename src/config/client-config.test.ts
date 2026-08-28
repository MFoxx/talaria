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
    expect(cfg.hosts.desktop?.sshKey).toBe('/home/me/.ssh/talaria_agent_ed25519');
    expect(cfg.hosts.desktop?.sshOptions).toEqual(['-o', 'ConnectTimeout=10']);
    expect(cfg.defaultHost).toBe('desktop');
  });

  it('defaults sshOptions to an empty array', () => {
    const cfg = parseClientConfig({
      hosts: { h: { tailscaleHost: 't', sshUser: 'u', sshKey: '/k' } },
    });
    expect(cfg.hosts.h?.sshOptions).toEqual([]);
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
