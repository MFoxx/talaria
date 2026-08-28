/**
 * `talaria setup` (ARCHITECTURE §9.3, §11).
 *
 * Bootstraps a machine: generates a dedicated SSH key, writes default server/client
 * configs, prints the locked-down `authorized_keys` forced-command line, and reports
 * whether tmux and the tools are installed.
 *
 * The pure builders (config objects, authorized_keys line) are unit-tested; the action
 * wires them to the filesystem and `ssh-keygen`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clientConfigPath, serverConfigPath } from '../config/paths.js';
import { parseClientConfig } from '../config/client-config.js';
import { parseServerConfig } from '../config/server-config.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { isTmuxAvailable } from '../server/tmux.js';
import { runCommand } from '../util/exec.js';
import type { Io } from './actions.js';

/** SSH forced command and restrictions applied to the agent key (§6.2). */
export const FORCED_COMMAND = 'talaria serve';
export const KEY_RESTRICTIONS = [
  'no-port-forwarding',
  'no-agent-forwarding',
  'no-X11-forwarding',
  'no-pty',
] as const;

/** Build the `~/.ssh/authorized_keys` line that locks the agent key to `talaria serve`. */
export function buildAuthorizedKeysLine(publicKey: string): string {
  return `command="${FORCED_COMMAND}",${KEY_RESTRICTIONS.join(',')} ${publicKey.trim()}`;
}

/** Default server config object (validated before it's written). */
export function buildServerConfig(opts: {
  tools?: string[];
  allowedDirs: string[];
}): Record<string, unknown> {
  return {
    tools: opts.tools ?? ['claude-code', 'codex'],
    allowedDirs: opts.allowedDirs,
    maxConcurrentSessions: 3,
    defaultTimeout: 600,
    maxTimeout: 3600,
    sessionRetention: 86400,
    logLevel: 'info',
  };
}

/** Default client config object (validated before it's written). */
export function buildClientConfig(opts: {
  hostAlias: string;
  tailscaleHost: string;
  sshUser: string;
  sshKey: string;
}): Record<string, unknown> {
  return {
    hosts: {
      [opts.hostAlias]: {
        tailscaleHost: opts.tailscaleHost,
        sshUser: opts.sshUser,
        sshKey: opts.sshKey,
        sshOptions: ['-o', 'ConnectTimeout=10'],
      },
    },
    defaultHost: opts.hostAlias,
    defaultTimeout: 600,
    outputFormat: 'pretty',
  };
}

export type SetupRole = 'server' | 'client' | 'both';

export interface SetupCliOptions {
  role?: SetupRole;
  key?: string;
  host?: string;
  sshUser?: string;
  hostAlias?: string;
  allowedDir?: string[];
  skipKeygen?: boolean;
  force?: boolean;
  /** Environment for path resolution (tests). */
  env?: NodeJS.ProcessEnv;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

const defaultIo: Io = {
  write: (text) => process.stdout.write(text),
  errLine: (text) => process.stderr.write(text + '\n'),
};

export async function setupAction(opts: SetupCliOptions = {}, io: Io = defaultIo): Promise<void> {
  const env = opts.env ?? process.env;
  const role: SetupRole = opts.role ?? 'both';
  if (!['server', 'client', 'both'].includes(role)) {
    throw new Error(`Invalid --role "${role}"; expected server, client, or both`);
  }
  const home = os.homedir();
  const doServer = role === 'server' || role === 'both';
  const doClient = role === 'client' || role === 'both';

  io.errLine('talaria setup');

  const tmuxOk = await isTmuxAvailable();
  io.errLine(
    tmuxOk ? '  ✓ tmux found' : '  ✗ tmux not found — install it so sessions survive disconnects',
  );

  const keyPath = opts.key ?? path.join(home, '.ssh', 'talaria_agent_ed25519');

  if (doServer) {
    const allowedDirs = opts.allowedDir?.length ? opts.allowedDir : [path.join(home, 'projects')];
    const serverConfig = buildServerConfig({ allowedDirs });
    parseServerConfig(serverConfig, { env, home }); // validate before writing
    const target = serverConfigPath(env);
    if (existsSync(target) && !opts.force) {
      io.errLine(`  • server config exists at ${target} (use --force to overwrite)`);
    } else {
      writeJsonFile(target, serverConfig);
      io.errLine(`  ✓ wrote server config ${target}`);
    }

    // Report tool availability for the configured tools.
    const registry = AdapterRegistry.fromConfig(parseServerConfig(serverConfig, { env, home }));
    for (const info of await registry.listWithAvailability()) {
      io.errLine(
        info.available
          ? `  ✓ ${info.name}${info.version ? ` (${info.version})` : ''}`
          : `  ✗ ${info.name} — ${info.error ?? 'unavailable'}`,
      );
    }
  }

  if (doClient) {
    if (!opts.skipKeygen && !existsSync(keyPath)) {
      mkdirSync(path.dirname(keyPath), { recursive: true });
      const result = await runCommand('ssh-keygen', [
        '-t',
        'ed25519',
        '-f',
        keyPath,
        '-N',
        '',
        '-C',
        'talaria-agent',
      ]);
      if (result.code !== 0) {
        throw new Error(`ssh-keygen failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
      io.errLine(`  ✓ generated SSH key ${keyPath}`);
    } else if (existsSync(keyPath)) {
      io.errLine(`  • SSH key exists at ${keyPath}`);
    }

    const clientConfig = buildClientConfig({
      hostAlias: opts.hostAlias ?? 'desktop',
      tailscaleHost: opts.host ?? 'my-workstation',
      sshUser: opts.sshUser ?? os.userInfo().username,
      sshKey: keyPath,
    });
    parseClientConfig(clientConfig, { home }); // validate before writing
    const target = clientConfigPath(env);
    if (existsSync(target) && !opts.force) {
      io.errLine(`  • client config exists at ${target} (use --force to overwrite)`);
    } else {
      writeJsonFile(target, clientConfig);
      io.errLine(`  ✓ wrote client config ${target}`);
    }
  }

  // Print the authorized_keys line (stdout, so it can be piped/copied).
  const pubPath = `${keyPath}.pub`;
  if (existsSync(pubPath)) {
    io.errLine('\nAdd this line to ~/.ssh/authorized_keys on the workstation:');
    io.write(buildAuthorizedKeysLine(readFileSync(pubPath, 'utf8')) + '\n');
  } else {
    io.errLine(`\nNo public key at ${pubPath}; generate one, then add the forced-command line.`);
  }
}
