import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  clientConfigPath,
  configDir,
  dataDir,
  defaultLogFile,
  defaultSessionDir,
  expandTilde,
  offsetsPath,
  serverConfigPath,
} from './paths.js';

describe('XDG resolution', () => {
  it('honors XDG_CONFIG_HOME / XDG_DATA_HOME', () => {
    const env = { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' };
    expect(configDir(env)).toBe('/cfg/talaria');
    expect(dataDir(env)).toBe('/data/talaria');
    expect(serverConfigPath(env)).toBe('/cfg/talaria/server.json');
    expect(clientConfigPath(env)).toBe('/cfg/talaria/client.json');
    expect(defaultSessionDir(env)).toBe('/data/talaria/sessions');
    expect(defaultLogFile(env)).toBe('/data/talaria/server.log');
    expect(offsetsPath(env)).toBe('/data/talaria/offsets.json');
  });

  it('falls back to ~/.config and ~/.local/share', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(configDir(env).endsWith(path.join('.config', 'talaria'))).toBe(true);
    expect(dataDir(env).endsWith(path.join('.local', 'share', 'talaria'))).toBe(true);
  });
});

describe('expandTilde', () => {
  it('expands ~ and ~/…', () => {
    expect(expandTilde('~', '/home/me')).toBe('/home/me');
    expect(expandTilde('~/x/y', '/home/me')).toBe('/home/me/x/y');
  });

  it('leaves absolute and relative paths untouched', () => {
    expect(expandTilde('/etc/x', '/home/me')).toBe('/etc/x');
    expect(expandTilde('rel/path', '/home/me')).toBe('rel/path');
    expect(expandTilde('/a~b', '/home/me')).toBe('/a~b');
  });
});
