import { describe, expect, it } from 'vitest';
import { parseServerConfig } from './server-config.js';

const env = { XDG_DATA_HOME: '/data' };
const home = '/home/me';

describe('parseServerConfig', () => {
  it('applies defaults when fields are omitted', () => {
    const cfg = parseServerConfig({}, { env, home });
    expect(cfg.maxConcurrentSessions).toBe(3);
    expect(cfg.defaultTimeout).toBe(600);
    expect(cfg.maxTimeout).toBe(3600);
    expect(cfg.sessionRetention).toBe(86400);
    expect(cfg.maxOutputSize).toBe(52_428_800);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.sessionDir).toBe('/data/talaria/sessions');
    expect(cfg.logFile).toBe('/data/talaria/server.log');
    expect(cfg.tools).toEqual([]);
  });

  it('accepts the spec example config', () => {
    const cfg = parseServerConfig(
      {
        tools: ['claude-code', 'codex'],
        allowedDirs: ['/home/user/projects', '/home/user/work'],
        maxConcurrentSessions: 3,
        defaultTimeout: 600,
        maxTimeout: 3600,
        sessionDir: '~/.local/share/talaria/sessions',
        sessionRetention: 86400,
        maxOutputSize: 52428800,
        customTools: [
          { name: 'aider', bin: '~/.local/bin/aider', argsTemplate: ['--message', '{{prompt}}'] },
        ],
        logFile: '~/.local/share/talaria/server.log',
        logLevel: 'info',
      },
      { env, home },
    );
    expect(cfg.tools).toEqual(['claude-code', 'codex']);
    expect(cfg.customTools[0]?.acceptedArgs).toEqual({});
  });

  it('expands ~ in path fields', () => {
    const cfg = parseServerConfig(
      { allowedDirs: ['~/projects'], sessionDir: '~/s', logFile: '~/l.log', customTools: [] },
      { env, home },
    );
    expect(cfg.allowedDirs).toEqual(['/home/me/projects']);
    expect(cfg.sessionDir).toBe('/home/me/s');
    expect(cfg.logFile).toBe('/home/me/l.log');
  });

  it('rejects defaultTimeout greater than maxTimeout', () => {
    expect(() => parseServerConfig({ defaultTimeout: 5000, maxTimeout: 1000 })).toThrow(
      /maxTimeout/,
    );
  });

  it('rejects a tool that is neither built-in nor custom', () => {
    expect(() => parseServerConfig({ tools: ['mystery'] })).toThrow(
      /not a built-in or custom tool/,
    );
  });

  it('accepts a tool provided via customTools', () => {
    const cfg = parseServerConfig(
      { tools: ['aider'], customTools: [{ name: 'aider', bin: '/bin/aider', argsTemplate: [] }] },
      { env, home },
    );
    expect(cfg.tools).toEqual(['aider']);
  });

  it('rejects a custom tool colliding with a built-in name', () => {
    expect(() =>
      parseServerConfig({ customTools: [{ name: 'codex', bin: '/bin/x', argsTemplate: [] }] }),
    ).toThrow(/collides with a built-in/);
  });

  it('rejects duplicate custom tool names', () => {
    expect(() =>
      parseServerConfig({
        customTools: [
          { name: 'a', bin: '/x', argsTemplate: [] },
          { name: 'a', bin: '/y', argsTemplate: [] },
        ],
      }),
    ).toThrow(/duplicate custom tool/);
  });

  it('rejects unknown top-level fields', () => {
    expect(() => parseServerConfig({ bogus: true })).toThrow();
  });
});
