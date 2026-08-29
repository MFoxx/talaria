/**
 * Client config: `~/.config/talaria/client.json` (ARCHITECTURE §8.2).
 *
 * Mirrors {@link ./server-config.ts}: `parseClientConfig` is a pure validator that
 * applies defaults and expands `~` in OpenSSH key paths; `loadClientConfig` reads it
 * from disk. `resolveHost` turns a host alias into a concrete transport target.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { clientConfigPath, expandTilde } from './paths.js';

export const OutputFormat = z.enum(['pretty', 'json', 'raw']);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const TransportKind = z.enum(['openssh', 'tailscale-ssh']);
export type TransportKind = z.infer<typeof TransportKind>;

const CommonHostFields = {
  tailscaleHost: z.string().min(1),
  sshUser: z.string().min(1),
} as const;

const OpenSshHostEntry = z.strictObject({
  transport: z.literal('openssh').default('openssh'),
  ...CommonHostFields,
  sshKey: z.string().min(1),
  sshOptions: z.array(z.string()).default([]),
});
export type OpenSshHostEntry = z.infer<typeof OpenSshHostEntry>;

const TailscaleSshHostEntry = z.strictObject({
  transport: z.literal('tailscale-ssh'),
  ...CommonHostFields,
  serverCommand: z.string().min(1).default('talaria serve'),
});
export type TailscaleSshHostEntry = z.infer<typeof TailscaleSshHostEntry>;

const HostEntry = z.union([TailscaleSshHostEntry, OpenSshHostEntry]);
export type HostEntry = z.infer<typeof HostEntry>;

const ClientConfigInput = z.strictObject({
  hosts: z.record(z.string(), HostEntry).default({}),
  defaultHost: z.string().optional(),
  defaultTimeout: z.number().int().positive().default(600),
  outputFormat: OutputFormat.default('pretty'),
});

/** Normalized client config: all defaults applied, OpenSSH key paths expanded. */
export interface ClientConfig {
  hosts: Record<string, HostEntry>;
  defaultHost?: string;
  defaultTimeout: number;
  outputFormat: OutputFormat;
}

/** A resolved host, ready to hand to the configured transport. */
export type ResolvedHost = HostEntry & { alias: string };

export interface ParseClientConfigOptions {
  /** Home directory used for `~` expansion of the SSH key path. */
  home?: string;
}

/**
 * Validate and normalize a raw client-config object. Throws on schema violations and
 * when `defaultHost` names a host that isn't defined.
 */
export function parseClientConfig(
  raw: unknown,
  options: ParseClientConfigOptions = {},
): ClientConfig {
  const result = ClientConfigInput.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid client config:\n${z.prettifyError(result.error)}`);
  }
  const cfg = result.data;

  if (cfg.defaultHost !== undefined && !(cfg.defaultHost in cfg.hosts)) {
    throw new Error(
      `Invalid client config: defaultHost "${cfg.defaultHost}" is not a defined host`,
    );
  }

  const hosts: Record<string, HostEntry> = {};
  for (const [alias, host] of Object.entries(cfg.hosts)) {
    hosts[alias] =
      host.transport === 'openssh'
        ? { ...host, sshKey: expandTilde(host.sshKey, options.home) }
        : host;
  }

  return {
    hosts,
    ...(cfg.defaultHost !== undefined ? { defaultHost: cfg.defaultHost } : {}),
    defaultTimeout: cfg.defaultTimeout,
    outputFormat: cfg.outputFormat,
  };
}

/**
 * Resolve a host alias to its connection params. Falls back to `defaultHost` when no
 * alias is given. Throws if neither is available or the alias is unknown.
 */
export function resolveHost(config: ClientConfig, alias?: string): ResolvedHost {
  const name = alias ?? config.defaultHost;
  if (name === undefined) {
    throw new Error('No host specified and no defaultHost configured');
  }
  const host = config.hosts[name];
  if (host === undefined) {
    const known = Object.keys(config.hosts).join(', ') || '(none)';
    throw new Error(`Unknown host "${name}". Configured hosts: ${known}`);
  }
  return { alias: name, ...host };
}

/** Read and parse the client config from disk (defaults to the standard location). */
export function loadClientConfig(
  filePath: string = clientConfigPath(),
  options: ParseClientConfigOptions = {},
): ClientConfig {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read client config at ${filePath}`, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`Client config at ${filePath} is not valid JSON`, { cause });
  }
  return parseClientConfig(raw, options);
}
