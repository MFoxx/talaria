/**
 * Server config: `~/.config/talaria/server.json` (ARCHITECTURE §8.1).
 *
 * `parseServerConfig` is pure — it validates a raw object, applies defaults, and
 * expands `~` in path fields. `loadServerConfig` reads the file from disk and runs it
 * through the parser. Validation failures throw a plain `Error` with a human-readable
 * message: a bad config is a local startup problem, not a wire-protocol event.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { defaultLogFile, defaultSessionDir, expandTilde, serverConfigPath } from './paths.js';

/** Tool names shipped as built-in adapters (ARCHITECTURE §7). */
export const BUILTIN_TOOL_NAMES = ['claude-code', 'codex'] as const;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

/** Declared shape of an accepted tool argument (§7.1). */
const AcceptedArg = z.strictObject({
  type: z.string(),
  default: z.unknown().optional(),
  description: z.string(),
});

/** A user-defined generic tool (§7.4). */
const CustomTool = z.strictObject({
  name: z.string().min(1),
  bin: z.string().min(1),
  argsTemplate: z.array(z.string()),
  acceptedArgs: z.record(z.string(), AcceptedArg).default({}),
});
export type CustomTool = z.infer<typeof CustomTool>;

/** Raw config as it appears on disk — every defaulted field is optional. */
const ServerConfigInput = z.strictObject({
  tools: z.array(z.string()).default([]),
  allowedDirs: z.array(z.string()).default([]),
  maxConcurrentSessions: z.number().int().positive().default(3),
  defaultTimeout: z.number().int().positive().default(600),
  maxTimeout: z.number().int().positive().default(3600),
  sessionDir: z.string().optional(),
  sessionRetention: z.number().int().nonnegative().default(86400),
  maxOutputSize: z.number().int().positive().default(52_428_800),
  customTools: z.array(CustomTool).default([]),
  logFile: z.string().optional(),
  logLevel: LogLevel.default('info'),
});

/** Normalized server config: all fields present, paths expanded. */
export interface ServerConfig {
  tools: string[];
  allowedDirs: string[];
  maxConcurrentSessions: number;
  defaultTimeout: number;
  maxTimeout: number;
  sessionDir: string;
  sessionRetention: number;
  maxOutputSize: number;
  customTools: CustomTool[];
  logFile: string;
  logLevel: LogLevel;
}

export interface ParseServerConfigOptions {
  /** Environment used for XDG default paths. */
  env?: NodeJS.ProcessEnv;
  /** Home directory used for `~` expansion. */
  home?: string;
  /** Tool names recognized as built-in adapters. */
  builtinTools?: readonly string[];
}

/**
 * Validate and normalize a raw server-config object. Throws on schema violations,
 * on `defaultTimeout > maxTimeout`, on duplicate or built-in-colliding custom tool
 * names, and on any `tools` entry that is neither a built-in nor a defined custom tool.
 */
export function parseServerConfig(
  raw: unknown,
  options: ParseServerConfigOptions = {},
): ServerConfig {
  const { env, home, builtinTools = BUILTIN_TOOL_NAMES } = options;

  const result = ServerConfigInput.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid server config:\n${z.prettifyError(result.error)}`);
  }
  const cfg = result.data;

  if (cfg.defaultTimeout > cfg.maxTimeout) {
    throw new Error(
      `Invalid server config: defaultTimeout (${cfg.defaultTimeout}) exceeds maxTimeout (${cfg.maxTimeout})`,
    );
  }

  const builtin = new Set(builtinTools);
  const customNames = new Set<string>();
  for (const tool of cfg.customTools) {
    if (builtin.has(tool.name)) {
      throw new Error(
        `Invalid server config: custom tool "${tool.name}" collides with a built-in tool`,
      );
    }
    if (customNames.has(tool.name)) {
      throw new Error(`Invalid server config: duplicate custom tool "${tool.name}"`);
    }
    customNames.add(tool.name);
  }

  for (const name of cfg.tools) {
    if (!builtin.has(name) && !customNames.has(name)) {
      throw new Error(`Invalid server config: tool "${name}" is not a built-in or custom tool`);
    }
  }

  const expand = (p: string): string => expandTilde(p, home);

  return {
    tools: cfg.tools,
    allowedDirs: cfg.allowedDirs.map(expand),
    maxConcurrentSessions: cfg.maxConcurrentSessions,
    defaultTimeout: cfg.defaultTimeout,
    maxTimeout: cfg.maxTimeout,
    sessionDir: cfg.sessionDir ? expand(cfg.sessionDir) : defaultSessionDir(env),
    sessionRetention: cfg.sessionRetention,
    maxOutputSize: cfg.maxOutputSize,
    customTools: cfg.customTools.map((t) => ({ ...t, bin: expand(t.bin) })),
    logFile: cfg.logFile ? expand(cfg.logFile) : defaultLogFile(env),
    logLevel: cfg.logLevel,
  };
}

/** Read and parse the server config from disk (defaults to the standard location). */
export function loadServerConfig(
  filePath: string = serverConfigPath(),
  options: ParseServerConfigOptions = {},
): ServerConfig {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read server config at ${filePath}`, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`Server config at ${filePath} is not valid JSON`, { cause });
  }
  return parseServerConfig(raw, options);
}
