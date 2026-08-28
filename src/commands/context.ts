/**
 * Shared CLI helpers: client construction, `--arg` parsing, output-format resolution.
 */

import { loadClientConfig, resolveHost, type OutputFormat } from '../config/client-config.js';
import type { ToolArgs } from '../protocol/messages.js';
import { TalariaClient } from '../client/talaria-client.js';

export interface ResolvedClient {
  client: TalariaClient;
  hostAlias: string;
  defaultTimeout: number;
  format: OutputFormat;
}

/**
 * Load client config, resolve the host, and build a TalariaClient over SSH. The `--output`
 * flag (if given) overrides the configured default format.
 */
export function makeClient(opts: { host?: string; output?: OutputFormat }): ResolvedClient {
  const config = loadClientConfig();
  const host = resolveHost(config, opts.host);
  return {
    client: TalariaClient.overSsh(host),
    hostAlias: host.alias,
    defaultTimeout: config.defaultTimeout,
    format: opts.output ?? config.outputFormat,
  };
}

/** Coerce a raw `--arg` value: number, boolean, comma-list, or string. */
export function coerceArgValue(raw: string): string | number | boolean | string[] {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw.includes(',')) return raw.split(',');
  return raw;
}

/**
 * Parse repeated `--arg key=value` flags into a {@link ToolArgs} object. Throws on a
 * malformed entry (missing `=`).
 */
export function parseToolArgs(pairs: string[] = []): ToolArgs {
  const out: ToolArgs = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --arg "${pair}"; expected key=value`);
    }
    out[pair.slice(0, eq)] = coerceArgValue(pair.slice(eq + 1));
  }
  return out;
}
