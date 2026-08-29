#!/usr/bin/env node
/**
 * `talaria` CLI entry point (ARCHITECTURE §9).
 *
 * Thin commander wiring over the command actions. `buildProgram()` is exported without
 * side effects so tests can inspect the command tree; `main()` parses argv and maps
 * thrown errors to a non-zero exit.
 */

import { Command, Option } from 'commander';
import { VERSION } from './index.js';
import { isTalariaError } from './protocol/errors.js';
import {
  attachAction,
  configAction,
  killAction,
  pingAction,
  runAction,
  serveAction,
  sessionsAction,
  toolsAction,
  type AttachCliOptions,
  type HostOutputOptions,
  type KillCliOptions,
  type RunCliOptions,
  type SessionsCliOptions,
} from './commands/actions.js';
import { setupAction, type SetupCliOptions } from './commands/setup.js';

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
    .description('Configure OpenSSH or Tailscale SSH transport and write default configs')
    .option('--role <role>', 'server | client | both', 'both')
    .option('--transport <transport>', 'openssh | tailscale-ssh', 'openssh')
    .option('--key <path>', 'SSH key path')
    .option('--server-command <command>', 'exact remote command for Tailscale SSH')
    .option('-H, --host <host>', 'Tailscale hostname of the workstation')
    .option('--ssh-user <user>', 'SSH user on the workstation')
    .option('--host-alias <alias>', 'client config host alias', 'desktop')
    .option('--allowed-dir <path>', 'allowed directory prefix (repeatable)', collect, [])
    .option('--skip-keygen', 'do not generate an SSH key')
    .option('--force', 'overwrite existing config files')
    .action((opts: SetupCliOptions) => setupAction(opts));

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

// Run when invoked as a binary (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
