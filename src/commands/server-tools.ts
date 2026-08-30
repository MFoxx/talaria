/** Local maintenance commands for an already-configured Talaria server. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseServerConfig } from '../config/server-config.js';
import { serverConfigPath } from '../config/paths.js';
import { runCommand } from '../util/exec.js';
import type { Io } from './actions.js';
import {
  buildAuthorizedKeysLine,
  buildTalariaForcedCommand,
  FORCED_COMMAND,
  KEY_RESTRICTIONS,
} from './setup.js';
import { BUILTIN_TOOL_NAMES, resolveSetupRuntime, type BuiltinToolName } from './setup-runtime.js';

export interface AddServerToolCliOptions {
  tool: string;
  /** Environment for XDG config resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /** Home directory containing OpenSSH authorized_keys (tests). */
  home?: string;
}

type CommandRunner = typeof runCommand;

export interface AddServerToolDependencies {
  run?: CommandRunner;
  /** Absolute runtime paths for deterministic tests. */
  nodePath?: string;
  cliPath?: string;
}

const defaultIo: Io = {
  write: (text) => process.stdout.write(text),
  errLine: (text) => process.stderr.write(text + '\n'),
};

function parseConfigObject(filePath: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(`Cannot read valid JSON server config at ${filePath}`, { cause });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Server config at ${filePath} must contain a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function decodeAuthorizedKeysCommand(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && index + 1 < value.length) {
      decoded += value[index + 1];
      index += 1;
    } else {
      decoded += char;
    }
  }
  return decoded;
}

function isTalariaForcedCommand(command: string): boolean {
  if (command === FORCED_COMMAND) return true;
  const quotedShellWord = String.raw`'(?:[^']|'"'"')*'`;
  const match = new RegExp(
    `^PATH=${quotedShellWord} ${quotedShellWord} (${quotedShellWord}) serve$`,
  ).exec(command);
  if (!match?.[1]) return false;
  const cliPath = match[1].slice(1, -1).replaceAll(`'"'"'`, "'");
  return path.basename(cliPath) === 'cli.js' && path.basename(path.dirname(cliPath)) === 'dist';
}

/** Replace only Talaria-owned restricted entries, preserving unrelated authorized keys. */
export function refreshAuthorizedKeysCommands(home: string, forcedCommand: string): number {
  const filePath = path.join(home, '.ssh', 'authorized_keys');
  if (!existsSync(filePath)) return 0;

  const restrictions = KEY_RESTRICTIONS.join(',');
  const entryPattern = new RegExp(
    `^command="((?:\\\\.|[^"])*)",${restrictions.replaceAll('-', '\\-')} ((?:ssh-|ecdsa-|sk-)[^\\s]+\\s+[^\\s]+(?:\\s+.*)?)$`,
  );
  const original = readFileSync(filePath, 'utf8');
  let refreshed = 0;
  const updated = original
    .split(/(?<=\n)/)
    .map((lineWithEnding) => {
      const hasNewline = lineWithEnding.endsWith('\n');
      const line = hasNewline ? lineWithEnding.slice(0, -1).replace(/\r$/, '') : lineWithEnding;
      const match = entryPattern.exec(line);
      if (
        !match?.[1] ||
        !match[2] ||
        !isTalariaForcedCommand(decodeAuthorizedKeysCommand(match[1]))
      ) {
        return lineWithEnding;
      }
      refreshed += 1;
      return buildAuthorizedKeysLine(match[2], forcedCommand) + (hasNewline ? '\n' : '');
    })
    .join('');

  if (refreshed > 0 && updated !== original) {
    writeFileSync(filePath, updated, { mode: 0o600 });
  }
  return refreshed;
}

/** Enable or refresh one built-in tool without rerunning server setup. */
export async function addServerToolAction(
  opts: AddServerToolCliOptions,
  io: Io = defaultIo,
  dependencies: AddServerToolDependencies = {},
): Promise<void> {
  if (!BUILTIN_TOOL_NAMES.includes(opts.tool as BuiltinToolName)) {
    throw new Error(
      `Unsupported server tool ${opts.tool}; expected ${BUILTIN_TOOL_NAMES.join(', ')}`,
    );
  }
  const tool = opts.tool as BuiltinToolName;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const configFile = serverConfigPath(env);
  const rawConfig = parseConfigObject(configFile);
  const config = parseServerConfig(rawConfig, { env, home });
  const tools = config.tools.includes(tool) ? config.tools : [...config.tools, tool];
  const existingBins = { ...config.builtinToolBins };
  delete existingBins[tool];
  const runtime = await resolveSetupRuntime({
    tools,
    run: dependencies.run ?? runCommand,
    ...(dependencies.nodePath ? { nodePath: dependencies.nodePath } : {}),
    ...(dependencies.cliPath ? { cliPath: dependencies.cliPath } : {}),
    builtinToolBins: existingBins,
  });
  const builtinToolBins = {
    ...config.builtinToolBins,
    ...runtime.builtinToolBins,
  };
  const updatedRaw = {
    ...rawConfig,
    tools,
    builtinToolBins,
  };
  parseServerConfig(updatedRaw, { env, home });

  const forcedCommand = buildTalariaForcedCommand(runtime);
  const refreshedKeys = refreshAuthorizedKeysCommands(home, forcedCommand);
  writeFileSync(configFile, JSON.stringify(updatedRaw, null, 2) + '\n');

  io.errLine(`  ✓ enabled ${tool} at ${builtinToolBins[tool]}`);
  if (refreshedKeys > 0) {
    io.errLine(
      `  ✓ refreshed PATH in ${refreshedKeys} restricted OpenSSH key entr${refreshedKeys === 1 ? 'y' : 'ies'}`,
    );
  } else {
    io.errLine('  • no restricted OpenSSH key entries found; server config updated');
  }
}
