/** Resolve and pin every executable used by a configured Talaria server. */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from '../util/exec.js';

export type BuiltinToolName = 'claude-code' | 'codex' | 'cursor';
export type BuiltinToolBins = Partial<Record<BuiltinToolName, string>>;

const TOOL_COMMANDS: Record<BuiltinToolName, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'agent',
};

/** Every built-in tool Talaria can pin, in the order shown during setup. */
export const BUILTIN_TOOL_NAMES = Object.keys(TOOL_COMMANDS) as BuiltinToolName[];

/** The executable a built-in tool is invoked through (used for PATH detection). */
export function builtinToolCommand(name: BuiltinToolName): string {
  return TOOL_COMMANDS[name];
}

/** Whether a built-in tool's executable resolves on PATH right now. */
export async function isBuiltinToolAvailable(
  name: BuiltinToolName,
  run: CommandRunner,
): Promise<boolean> {
  try {
    const result = await run('/usr/bin/which', [TOOL_COMMANDS[name]]);
    return result.code === 0 && result.stdout.trim().length > 0;
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
  const command = TOOL_COMMANDS[name];
  const result = await run('/usr/bin/which', [command]);
  const found = result.stdout.trim().split(/\r?\n/, 1)[0];
  if (result.code !== 0 || !found) {
    throw new Error(`${name} is configured but ${command} was not found in PATH`);
  }
  return realpathSync(requireAbsolute(`${name} binary`, found));
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
      name === 'claude-code' || name === 'codex' || name === 'cursor',
  );
  const entries = await Promise.all(
    configuredBuiltins.map(async (name) => {
      const bin = await resolveToolBin(name, options.builtinToolBins?.[name], options.run);
      return [name, bin] as const;
    }),
  );
  const builtinToolBins = Object.fromEntries(entries) as BuiltinToolBins;
  return {
    nodePath,
    cliPath,
    builtinToolBins,
    serviceExecutablePath: buildServiceExecutablePath(nodePath, cliPath, builtinToolBins),
  };
}
