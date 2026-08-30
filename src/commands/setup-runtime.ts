/** Resolve and pin every executable used by a configured Talaria server. */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from '../util/exec.js';

export type BuiltinToolName = 'claude-code' | 'codex' | 'cursor' | 'grok';
export type BuiltinToolBins = Partial<Record<BuiltinToolName, string>>;

const TOOL_COMMANDS: Record<BuiltinToolName, readonly string[]> = {
  'claude-code': ['claude'],
  codex: ['codex'],
  cursor: ['cursor-agent', 'agent'],
  grok: ['grok'],
};

/** Every built-in tool Talaria can pin, in the order shown during setup. */
export const BUILTIN_TOOL_NAMES = Object.keys(TOOL_COMMANDS) as BuiltinToolName[];

/** The executable a built-in tool is invoked through (used for PATH detection). */
export function builtinToolCommand(name: BuiltinToolName): string {
  return TOOL_COMMANDS[name][0]!;
}

async function findToolLauncher(
  name: BuiltinToolName,
  run: CommandRunner,
): Promise<string | undefined> {
  for (const command of TOOL_COMMANDS[name]) {
    const result = await run('/usr/bin/which', [command]);
    const found = result.stdout.trim().split(/\r?\n/, 1)[0];
    if (result.code !== 0 || !found) continue;
    const absolute = requireAbsolute(`${name} binary`, found);
    if (name === 'cursor') {
      const identity = await run(absolute, ['--version']);
      const output = `${identity.stdout}\n${identity.stderr}`.trim();
      if (identity.code !== 0) {
        throw new Error(`Could not verify that ${absolute} is the Cursor CLI`);
      }
      if (/\bgrok\b/i.test(output) && !/\bcursor\b/i.test(output)) {
        throw new Error(
          `${command} resolves to Grok Build, not Cursor; install Cursor's cursor-agent command`,
        );
      }
    }
    return absolute;
  }
  return undefined;
}

/** Whether a built-in tool's executable resolves on PATH right now. */
export async function isBuiltinToolAvailable(
  name: BuiltinToolName,
  run: CommandRunner,
): Promise<boolean> {
  try {
    return (await findToolLauncher(name, run)) !== undefined;
  } catch {
    return false;
  }
}

const SYSTEM_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

type CommandRunner = typeof runCommand;

export interface ResolveSetupRuntimeOptions {
  tools: string[];
  run: CommandRunner;
  nodePath?: string;
  cliPath?: string;
  builtinToolBins?: BuiltinToolBins;
}

export interface SetupRuntime {
  nodePath: string;
  cliPath: string;
  builtinToolBins: BuiltinToolBins;
  serviceExecutablePath: string;
}

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

export function buildServiceExecutablePath(
  nodePath: string,
  cliPath: string,
  builtinToolBins: BuiltinToolBins,
): string {
  const entries = [
    ...Object.values(builtinToolBins).map((bin) => path.dirname(bin)),
    path.dirname(nodePath),
    path.dirname(cliPath),
    ...SYSTEM_PATH_DIRS,
  ];
  return entries.filter((entry, index) => entries.indexOf(entry) === index).join(path.delimiter);
}

async function resolveToolBin(
  name: BuiltinToolName,
  override: string | undefined,
  run: CommandRunner,
): Promise<string> {
  if (override) return requireAbsolute(`${name} binary`, override);
  const found = await findToolLauncher(name, run);
  if (!found) {
    throw new Error(
      `${name} is configured but ${TOOL_COMMANDS[name].join(' or ')} was not found in PATH`,
    );
  }
  return found;
}

function executableIdentity(bin: string): string {
  try {
    return realpathSync(bin);
  } catch {
    // Explicit test/setup overrides may describe a future path. Identical absolute
    // launchers can still be rejected even when their targets do not exist yet.
    return bin;
  }
}

/**
 * Resolve Node, Talaria, and configured built-in tools once. The returned absolute
 * paths are persisted in server config and reused by adapters at runtime.
 */
export async function resolveSetupRuntime(
  options: ResolveSetupRuntimeOptions,
): Promise<SetupRuntime> {
  const nodePath = options.nodePath ?? realpathSync(process.execPath);
  const cliArgument = options.cliPath ?? process.argv[1];
  if (!cliArgument) {
    throw new Error('Could not determine the Talaria CLI path; run setup through the talaria CLI');
  }
  const cliPath = options.cliPath ?? realpathSync(cliArgument);
  requireAbsolute('Node path', nodePath);
  requireAbsolute('Talaria CLI path', cliPath);
  if (path.extname(cliPath) === '.ts') {
    throw new Error(
      'Server setup needs a built Talaria CLI. Run `npm run build && npm link`, then run `talaria setup`.',
    );
  }

  const configuredBuiltins = options.tools.filter(
    (name): name is BuiltinToolName =>
      name === 'claude-code' || name === 'codex' || name === 'cursor' || name === 'grok',
  );
  const entries = await Promise.all(
    configuredBuiltins.map(async (name) => {
      const bin = await resolveToolBin(name, options.builtinToolBins?.[name], options.run);
      return [name, bin] as const;
    }),
  );
  const builtinToolBins = Object.fromEntries(entries) as BuiltinToolBins;
  const ownersByBin = new Map<string, BuiltinToolName>();
  for (const [name, bin] of entries) {
    const identity = executableIdentity(bin);
    const existing = ownersByBin.get(identity);
    if (existing) {
      throw new Error(`${existing} and ${name} resolve to the same executable: ${identity}`);
    }
    ownersByBin.set(identity, name);
  }
  return {
    nodePath,
    cliPath,
    builtinToolBins,
    serviceExecutablePath: buildServiceExecutablePath(nodePath, cliPath, builtinToolBins),
  };
}
