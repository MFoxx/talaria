#!/usr/bin/env node
/**
 * `talaria` CLI entry point (ARCHITECTURE §9).
 *
 * Thin commander wiring over the command actions. `buildProgram()` is exported without
 * side effects so tests can inspect the command tree; `main()` parses argv and maps
 * thrown errors to a non-zero exit.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { VERSION } from './index.js';
import { isTalariaError } from './protocol/errors.js';
import {
  attachAction,
  configAction,
  continueAction,
  killAction,
  pingAction,
  runAction,
  serveAction,
  sessionsAction,
  toolsAction,
  type AttachCliOptions,
  type ContinueCliOptions,
  type HostOutputOptions,
  type KillCliOptions,
  type RunCliOptions,
  type SessionsCliOptions,
} from './commands/actions.js';
import { setupAction, type SetupCliOptions } from './commands/setup.js';
import { addServerToolAction, removeServerToolAction } from './commands/server-tools.js';

const outputOption = (): Option =>
  new Option('-o, --output <format>', 'output format').choices(['pretty', 'json', 'raw']);

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('talaria')
    .description('Structured remote tool execution over SSH carried by Tailscale')
    .version(VERSION);

  program
    .command('run')
    .description('Run a tool on a host and stream its output')
    .option('-H, --host <alias>', 'host alias from client config')
    .requiredOption('-t, --tool <name>', 'tool to run')
    .requiredOption('-d, --dir <path>', 'working directory on the remote host')
    .requiredOption('-p, --prompt <text>', 'prompt to pass to the tool')
    .option('--timeout <seconds>', 'timeout in seconds', (v) => Number.parseInt(v, 10))
    .option('--arg <key=value>', 'tool-specific arg (repeatable)', collect, [])
    .addOption(outputOption())
    .action((opts: RunCliOptions) => runAction(opts));

  program
    .command('attach')
    .description('Reconnect to an existing session and resume streaming')
    .option('-H, --host <alias>', 'host alias from client config')
    .requiredOption('-s, --session <id>', 'session id')
    .option('--replay', 'replay all output from the beginning')
    .addOption(outputOption())
    .action((opts: AttachCliOptions) => attachAction(opts));

  program
    .command('continue')
    .description('Continue a conversation in a new execution')
    .option('-H, --host <alias>', 'host alias from client config')
    .requiredOption('-c, --conversation <id>', 'conversation id')
    .requiredOption('-p, --prompt <text>', 'follow-up prompt')
    .option('--timeout <seconds>', 'timeout in seconds', (v) => Number.parseInt(v, 10))
    .addOption(outputOption())
    .action((opts: ContinueCliOptions) => continueAction(opts));

  program
    .command('sessions')
    .description('List sessions on a host')
    .option('-H, --host <alias>', 'host alias from client config')
    .option('--status <status>', 'filter by status')
    .addOption(outputOption())
    .action((opts: SessionsCliOptions) => sessionsAction(opts));

  program
    .command('kill')
    .description('Terminate a running session')
    .option('-H, --host <alias>', 'host alias from client config')
    .requiredOption('-s, --session <id>', 'session id')
    .addOption(outputOption())
    .action((opts: KillCliOptions) => killAction(opts));

  program
    .command('tools')
    .description('List available tools on a host')
    .option('-H, --host <alias>', 'host alias from client config')
    .addOption(outputOption())
    .action((opts: HostOutputOptions) => toolsAction(opts));

  program
    .command('ping')
    .description('Health-check a host')
    .option('-H, --host <alias>', 'host alias from client config')
    .addOption(outputOption())
    .action((opts: HostOutputOptions) => pingAction(opts));

  program
    .command('config')
    .description('Print the resolved client config')
    .action(() => configAction());

  program
    .command('setup')
    .description('Interactively configure a Talaria client or server')
    .option('--role <role>', 'server | client | both (prompted when omitted)')
    .option('--transport <transport>', 'openssh | tailscale-ssh (prompted when omitted)')
    .option('--key <path>', 'SSH key path')
    .option('--public-key <key>', 'controller public key to authorize on an OpenSSH server')
    .option('--server-command <command>', 'exact remote command for Tailscale SSH')
    .option('-H, --host <host>', 'server hostname or IP address')
    .option('--ssh-user <user>', 'SSH user on the server')
    .option('--host-alias <alias>', 'client config host alias')
    .option(
      '--allowed-dir <path>',
      'allowed directory and descendants (repeat for multiple; leading ~ is expanded)',
      collect,
      [],
    )
    .option(
      '--tool <name>',
      'built-in server tool (repeatable: claude-code | codex | cursor [beta] | grok | pi [beta])',
      collect,
      [],
    )
    .option('--skip-keygen', 'do not generate an SSH key')
    .option('--force', 'overwrite existing config files')
    .action((opts: SetupCliOptions) => setupAction(opts));

  const server = program
    .command('server')
    .description('Maintain the configuration on this Talaria server');

  server
    .command('add-tool')
    .description('Enable or refresh an installed built-in tool without rerunning setup')
    .argument('<name>', 'claude-code | codex | cursor [beta] | grok | pi [beta]')
    .action((tool: string) => addServerToolAction({ tool }));

  server
    .command('remove-tool')
    .description('Disable a built-in tool and remove its executable pin')
    .argument('<name>', 'claude-code | codex | cursor [beta] | grok | pi [beta]')
    .action((tool: string) => removeServerToolAction({ tool }));

  program
    .command('serve')
    .description('Server side (invoked by the SSH forced command; not run manually)')
    .action(() => serveAction());

  return program;
}

/** Commander collector for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    const message = isTalariaError(err) ? `[${err.code}] ${err.message}` : String(err);
    process.stderr.write(`talaria: ${message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Detect direct invocation (not import by tests). Compares realpaths rather than raw
 * paths/URLs: npm's global `bin` install runs this file through a symlink, and
 * `import.meta.url` resolves through it to the real path while `process.argv[1]` stays
 * the symlink, so a literal comparison always fails for a globally-installed CLI.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
