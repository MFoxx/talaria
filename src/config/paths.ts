/**
 * Filesystem path resolution (ARCHITECTURE §4.4, §8).
 *
 * Follows the XDG Base Directory spec: config under `$XDG_CONFIG_HOME` (default
 * `~/.config`), data under `$XDG_DATA_HOME` (default `~/.local/share`). Config values
 * that contain a leading `~` are expanded against the user's home directory.
 */

import os from 'node:os';
import path from 'node:path';

/** Base config directory, honoring `$XDG_CONFIG_HOME`. */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
}

/** Base data directory, honoring `$XDG_DATA_HOME`. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.local', 'share');
}

/** `<configHome>/talaria`. */
export function configDir(env?: NodeJS.ProcessEnv): string {
  return path.join(configHome(env), 'talaria');
}

/** `<dataHome>/talaria`. */
export function dataDir(env?: NodeJS.ProcessEnv): string {
  return path.join(dataHome(env), 'talaria');
}

/** Path to the server config file (`server.json`). */
export function serverConfigPath(env?: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'server.json');
}

/** Path to the client config file (`client.json`). */
export function clientConfigPath(env?: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'client.json');
}

/** Default session-state directory (`<dataHome>/talaria/sessions`). */
export function defaultSessionDir(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'sessions');
}

/** Default server log file (`<dataHome>/talaria/server.log`). */
export function defaultLogFile(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'server.log');
}

/** Client-side offset cache (`<dataHome>/talaria/offsets.json`). */
export function offsetsPath(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'offsets.json');
}

/**
 * Expand a leading `~` or `~/…` in a config-supplied path to the user's home
 * directory. Paths without a leading tilde are returned unchanged. A bare `~` maps to
 * the home directory itself.
 */
export function expandTilde(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
