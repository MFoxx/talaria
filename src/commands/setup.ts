/**
 * `talaria setup` (ARCHITECTURE §9.3, §11).
 *
 * Bootstraps a machine for either OpenSSH or Tailscale SSH. OpenSSH generates a
 * dedicated client key and installs a self-contained forced command on the server;
 * Tailscale SSH delegates authentication to the tailnet and prints policy guidance.
 *
 * The pure builders (config objects, authorized_keys line) are unit-tested; the action
 * wires them to the filesystem and `ssh-keygen`.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { clientConfigPath, serverConfigPath } from '../config/paths.js';
import {
  parseClientConfig,
  TransportKind,
  type TransportKind as TransportKindType,
} from '../config/client-config.js';
import { loadServerConfig, parseServerConfig } from '../config/server-config.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { TalariaClient } from '../client/talaria-client.js';
import { isTmuxAvailable } from '../server/tmux.js';
import { runCommand } from '../util/exec.js';
import { quoteShellWord } from '../util/shell.js';
import type { Io } from './actions.js';
import {
  InquirerSetupPrompter,
  type CheckboxChoice,
  type SelectChoice,
  type SetupPrompter,
} from './setup-prompts.js';
import {
  createMacOsIsolationPlan,
  provisionMacOsIsolation,
  TALARIA_ACCOUNT,
  type MacOsIsolationPlan,
} from './macos-isolation.js';
import {
  BUILTIN_TOOL_NAMES,
  builtinToolCommand,
  isBuiltinToolAvailable,
  resolveSetupRuntime,
  type BuiltinToolBins,
  type BuiltinToolName,
  type SetupRuntime,
} from './setup-runtime.js';
import {
  binaryAvailable,
  checkSetupPrerequisites,
  resolveSetupTransport,
} from './setup-prerequisites.js';

/** SSH forced command and restrictions applied to the agent key (§6.2). */
export const FORCED_COMMAND = 'talaria serve';
export const KEY_RESTRICTIONS = [
  'no-port-forwarding',
  'no-agent-forwarding',
  'no-X11-forwarding',
  'no-pty',
] as const;

function authorizedKeysQuote(command: string): string {
  return command.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export interface TalariaForcedCommandOptions {
  nodePath: string;
  cliPath: string;
  serviceExecutablePath: string;
}

/** Build the self-contained command used by sshd's non-interactive forced-command shell. */
export function buildTalariaForcedCommand(opts: TalariaForcedCommandOptions): string {
  if (!path.isAbsolute(opts.nodePath) || !path.isAbsolute(opts.cliPath)) {
    throw new Error('The Node and Talaria CLI paths used by OpenSSH must be absolute');
  }
  const pathEntries = opts.serviceExecutablePath.split(path.delimiter);
  if (pathEntries.some((entry) => !path.isAbsolute(entry))) {
    throw new Error('The OpenSSH service PATH may contain only absolute directories');
  }
  return `PATH=${quoteShellWord(opts.serviceExecutablePath)} ${quoteShellWord(opts.nodePath)} ${quoteShellWord(opts.cliPath)} serve`;
}

/** Build the `~/.ssh/authorized_keys` line that locks the agent key to one command. */
export function buildAuthorizedKeysLine(
  publicKey: string,
  forcedCommand: string = FORCED_COMMAND,
): string {
  return `command="${authorizedKeysQuote(forcedCommand)}",${KEY_RESTRICTIONS.join(',')} ${publicKey.trim()}`;
}

/** Default server config object (validated before it's written). */
export function buildServerConfig(opts: {
  tools?: string[];
  allowedDirs: string[];
  builtinToolBins?: BuiltinToolBins;
}): Record<string, unknown> {
  return {
    tools: opts.tools ?? ['claude-code', 'codex'],
    builtinToolBins: opts.builtinToolBins ?? {},
    allowedDirs: opts.allowedDirs,
    maxConcurrentSessions: 3,
    defaultTimeout: 600,
    maxTimeout: 3600,
    sessionRetention: 86400,
    logLevel: 'info',
  };
}

/** Prompt for one or more allowed roots. Each answer is one path, so paths may contain commas. */
export async function promptAllowedDirs(
  prompt: SetupPrompter,
  defaultAllowedDir: string,
): Promise<string[]> {
  const allowedDirs: string[] = [];
  let addAnother = true;
  while (addAnother) {
    const directory = await prompt.input(
      allowedDirs.length === 0
        ? 'Allowed directory (this directory and its descendants; one path per prompt)'
        : 'Additional allowed directory',
      allowedDirs.length === 0 ? defaultAllowedDir : undefined,
    );
    const trimmed = directory.trim();
    if (trimmed.length === 0) {
      throw new Error('Allowed directories cannot be empty');
    }
    allowedDirs.push(trimmed);
    addAnother = await prompt.confirm('Allow another directory?', false);
  }
  return allowedDirs;
}

interface CommonClientConfigOptions {
  hostAlias: string;
  tailscaleHost: string;
  sshUser: string;
}

export type BuildClientConfigOptions = CommonClientConfigOptions &
  (
    | { transport?: 'openssh'; sshKey: string; serverCommand?: never }
    | { transport: 'tailscale-ssh'; sshKey?: never; serverCommand?: string }
  );

/** Default client config object (validated before it's written). */
export function buildClientConfig(opts: BuildClientConfigOptions): Record<string, unknown> {
  const transport = opts.transport ?? 'openssh';
  const host =
    transport === 'tailscale-ssh'
      ? {
          transport,
          tailscaleHost: opts.tailscaleHost,
          sshUser: opts.sshUser,
          ...(opts.serverCommand ? { serverCommand: opts.serverCommand } : {}),
        }
      : {
          transport,
          tailscaleHost: opts.tailscaleHost,
          sshUser: opts.sshUser,
          sshKey: opts.sshKey,
          sshOptions: ['-o', 'ConnectTimeout=10'],
        };

  return {
    hosts: {
      [opts.hostAlias]: host,
    },
    defaultHost: opts.hostAlias,
    defaultTimeout: 600,
    outputFormat: 'pretty',
  };
}

export type SetupRole = 'server' | 'client' | 'both';

export interface SetupCliOptions {
  role?: SetupRole;
  transport?: TransportKindType;
  key?: string;
  serverCommand?: string;
  host?: string;
  sshUser?: string;
  hostAlias?: string;
  allowedDir?: string[];
  /** Built-in tool to enable (repeatable). */
  tool?: string[];
  /** Plain controller public key to authorize during OpenSSH server setup. */
  publicKey?: string;
  skipKeygen?: boolean;
  force?: boolean;
  /** Override TTY detection (primarily useful to callers and tests). */
  interactive?: boolean;
  /** Environment for path resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /** Home directory override (tests). */
  home?: string;
}

type CommandRunner = typeof runCommand;
interface InteractiveCommandOptions {
  cwd?: string;
}
type InteractiveCommandRunner = (
  bin: string,
  args: string[],
  options?: InteractiveCommandOptions,
) => Promise<number | null>;

export interface SetupDependencies {
  prompt?: SetupPrompter;
  run?: CommandRunner;
  runInteractive?: InteractiveCommandRunner;
  platform?: NodeJS.Platform;
  getuid?: () => number;
  testConnection?: (target: Parameters<typeof TalariaClient.overRemote>[0]) => Promise<number>;
  /** Absolute runtime paths for deterministic setup tests. */
  nodePath?: string;
  cliPath?: string;
  builtinToolBins?: BuiltinToolBins;
  /** Login name running setup (tests). */
  username?: string;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

const defaultIo: Io = {
  write: (text) => process.stdout.write(text),
  errLine: (text) => process.stderr.write(text + '\n'),
};

const ROLE_CHOICES: readonly SelectChoice<'client' | 'server'>[] = [
  {
    value: 'client',
    label: 'Client',
    description: 'Starts and reconnects to sessions on a remote Talaria server.',
  },
  {
    value: 'server',
    label: 'Server',
    description: 'Accepts connections and runs Claude Code, Codex, and other local CLIs.',
  },
];

const TOOL_LABELS: Record<BuiltinToolName, { label: string; description: string }> = {
  'claude-code': { label: 'Claude Code', description: "Anthropic's Claude Code CLI (`claude`)." },
  codex: { label: 'Codex', description: "OpenAI's Codex CLI (`codex`)." },
  cursor: {
    label: 'Cursor (beta)',
    description: "Cursor's agent CLI (`cursor-agent`); see the macOS keychain limitation.",
  },
  grok: { label: 'Grok Build', description: "xAI's Grok coding CLI (`grok`)." },
  opencode: { label: 'OpenCode', description: 'The OpenCode coding agent CLI (`opencode`).' },
  pi: { label: 'Pi Code (beta)', description: 'Beta support for the Pi Code CLI (`pi`).' },
};

/**
 * Ask which built-in tools this server should run, pre-selecting the ones already on PATH so
 * setup does not later fail resolving a tool the operator never intended to install.
 */
async function selectServerTools(
  prompt: SetupPrompter,
  run: CommandRunner,
  io: Io,
): Promise<string[]> {
  const availability = await Promise.all(
    BUILTIN_TOOL_NAMES.map(async (name) => ({
      name,
      available: await isBuiltinToolAvailable(name, run),
    })),
  );
  const choices: CheckboxChoice<BuiltinToolName>[] = availability.map(({ name, available }) => ({
    value: name,
    label: available
      ? TOOL_LABELS[name].label
      : `${TOOL_LABELS[name].label} — ${builtinToolCommand(name)} not found in PATH`,
    description: TOOL_LABELS[name].description,
    checked: available,
  }));
  const selected = await prompt.checkbox('Which CLI tools should this server run?', choices);
  if (selected.length === 0) {
    throw new Error(
      'No tools selected. Install at least one supported CLI (claude, codex, cursor-agent, grok, opencode, or pi) and rerun setup.',
    );
  }
  const missing = selected.filter(
    (name) => !availability.find((entry) => entry.name === name)?.available,
  );
  for (const name of missing) {
    io.errLine(
      `  ⚠ ${builtinToolCommand(name)} is not on PATH yet; install it before starting sessions.`,
    );
  }
  return selected;
}

const TRANSPORT_CHOICES: readonly SelectChoice<TransportKindType>[] = [
  {
    value: 'openssh',
    label: 'OpenSSH (recommended)',
    description:
      'Uses a dedicated key locked to `talaria serve`; strongest isolation and works over any SSH route.',
  },
  {
    value: 'tailscale-ssh',
    label: 'Tailscale SSH',
    description:
      'Keyless tailnet authentication and simpler host keys, but policy cannot force only `talaria serve`.',
  },
];

function defaultInteractiveCommand(
  bin: string,
  args: string[],
  options?: InteractiveCommandOptions,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function publicKeyIdentity(publicKey: string): string {
  if (publicKey.includes('\n') || publicKey.includes('\r')) {
    throw new Error('Public key must be a single line');
  }
  const fields = publicKey.trim().split(/\s+/);
  const type = fields[0];
  const body = fields[1];
  if (
    !type ||
    !/^(?:ssh-|ecdsa-|sk-)/.test(type) ||
    !body ||
    !/^[A-Za-z0-9+/]+={0,3}$/.test(body)
  ) {
    throw new Error('Expected a plain OpenSSH public key such as "ssh-ed25519 AAAA… comment"');
  }
  return `${type} ${body}`;
}

/** Install a controller key with Talaria's forced command and restrictive file modes. */
export function installAuthorizedKey(
  publicKey: string,
  home: string,
  forcedCommand: string = FORCED_COMMAND,
): 'installed' | 'updated' | 'present' {
  const identity = publicKeyIdentity(publicKey);
  const sshDir = path.join(home, '.ssh');
  const authorizedKeys = path.join(sshDir, 'authorized_keys');
  const existing = existsSync(authorizedKeys) ? readFileSync(authorizedKeys, 'utf8') : '';
  const existingLines = existing.split(/\r?\n/);
  const matchingIndexes = existingLines
    .map((line, lineIndex) => {
      const fields = line.trim().split(/\s+/);
      return fields.some((field, index) => `${field} ${fields[index + 1] ?? ''}` === identity)
        ? lineIndex
        : -1;
    })
    .filter((lineIndex) => lineIndex !== -1);
  const restrictedLine = buildAuthorizedKeysLine(publicKey, forcedCommand);

  if (matchingIndexes.some((lineIndex) => existingLines[lineIndex] === restrictedLine)) {
    return 'present';
  }
  if (matchingIndexes.length > 0) {
    const legacyPrefix = `command="${FORCED_COMMAND}",${KEY_RESTRICTIONS.join(',')} `;
    const legacyIndex = matchingIndexes.find((lineIndex) =>
      existingLines[lineIndex]?.startsWith(legacyPrefix),
    );
    if (legacyIndex !== undefined) {
      existingLines[legacyIndex] = restrictedLine;
      writeFileSync(authorizedKeys, existingLines.join('\n'), { mode: 0o600 });
      chmodSync(authorizedKeys, 0o600);
      return 'updated';
    }
    throw new Error(
      "That key is already authorized without Talaria's exact restrictions; remove or restrict the existing entry first",
    );
  }

  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  chmodSync(sshDir, 0o700);
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(authorizedKeys, `${prefix}${restrictedLine}\n`, { mode: 0o600 });
  chmodSync(authorizedKeys, 0o600);
  return 'installed';
}

async function enableOpenSshServer(
  platform: NodeJS.Platform,
  run: CommandRunner,
  runInteractive: InteractiveCommandRunner,
  getuid: () => number,
): Promise<string> {
  if (platform === 'darwin') {
    if (!(await binaryAvailable('/usr/sbin/sshd', ['-V'], run))) {
      throw new Error('OpenSSH server is missing (/usr/sbin/sshd)');
    }
    const status = await run('/usr/sbin/systemsetup', ['-getremotelogin']);
    if (`${status.stdout}\n${status.stderr}`.toLowerCase().includes('remote login: on')) {
      return 'Remote Login already enabled';
    }
    const code = await runInteractive('sudo', ['/usr/sbin/systemsetup', '-setremotelogin', 'on']);
    if (code !== 0) throw new Error(`Could not enable Remote Login (exit ${String(code)})`);
    return 'Remote Login enabled';
  }

  if (platform === 'linux') {
    if (!(await binaryAvailable('sshd', ['-V'], run))) {
      throw new Error(
        "OpenSSH server is missing; install your distribution's openssh-server package",
      );
    }
    if (!(await binaryAvailable('systemctl', ['--version'], run))) {
      throw new Error('systemctl is unavailable; enable and start sshd manually');
    }
    let service: 'ssh.service' | 'sshd.service' | undefined;
    for (const candidate of ['ssh.service', 'sshd.service'] as const) {
      const result = await run('systemctl', ['cat', candidate]);
      if (result.code === 0) {
        service = candidate;
        break;
      }
    }
    if (!service) throw new Error('Could not find ssh.service or sshd.service');
    const [active, enabled] = await Promise.all([
      run('systemctl', ['is-active', '--quiet', service]),
      run('systemctl', ['is-enabled', '--quiet', service]),
    ]);
    if (active.code === 0 && enabled.code === 0) return `${service} already enabled and running`;
    const command = ['systemctl', 'enable', '--now', service];
    const [bin, args] = getuid() === 0 ? [command[0], command.slice(1)] : ['sudo', command];
    if (!bin) throw new Error('Could not construct the systemctl command');
    const code = await runInteractive(bin, args);
    if (code !== 0) throw new Error(`Could not enable ${service} (exit ${String(code)})`);
    return `${service} enabled and started`;
  }

  throw new Error('Automatic OpenSSH server setup is supported on macOS and systemd Linux only');
}

async function enableTailscaleSsh(
  platform: NodeJS.Platform,
  runInteractive: InteractiveCommandRunner,
  getuid: () => number,
): Promise<void> {
  const command = ['tailscale', 'set', '--ssh=true'];
  const [bin, args] =
    platform === 'linux' && getuid() !== 0 ? ['sudo', command] : [command[0], command.slice(1)];
  if (!bin) throw new Error('Could not construct the Tailscale command');
  const code = await runInteractive(bin, args);
  if (code !== 0) throw new Error(`Could not enable Tailscale SSH (exit ${String(code)})`);
}

async function shouldWrite(
  target: string,
  force: boolean | undefined,
  prompt: SetupPrompter | undefined,
  io: Io,
): Promise<boolean> {
  if (!existsSync(target) || force) return true;
  if (prompt && (await prompt.confirm(`Config exists at ${target}. Overwrite it?`, false)))
    return true;
  io.errLine(`  • config exists at ${target} (use --force to overwrite)`);
  return false;
}

function printTailscalePolicyGuidance(io: Io, sshUser: string): void {
  io.errLine('  • add a narrow SSH rule to your tailnet policy (replace the selectors):');
  io.errLine('    {');
  io.errLine('      "action": "accept",');
  io.errLine('      "src": ["group:talaria-controllers"],');
  io.errLine('      "dst": ["tag:talaria-server"],');
  io.errLine(`      "users": ["${sshUser}"]`);
  io.errLine('    }');
  io.errLine(`  • use the exact OS user ${sshUser}; do not use autogroup:nonroot`);
  io.errLine(
    '  ⚠ Tailscale SSH policy authenticates the connection but cannot force `talaria serve`.',
  );
  io.errLine(
    '    Keep the dedicated account and restricted shell; do not grant it admin membership.',
  );
}

interface SetupWorkflowContext {
  opts: SetupCliOptions;
  io: Io;
  dependencies: SetupDependencies;
  env: NodeJS.ProcessEnv;
  home: string;
  prompt: SetupPrompter | undefined;
  run: CommandRunner;
  runInteractive: InteractiveCommandRunner;
  platform: NodeJS.Platform;
  getuid: () => number;
  transport: TransportKindType;
  tailscaleSshAlreadyEnabled: boolean;
}

async function configureClient(
  context: SetupWorkflowContext,
  keyPath: string,
  configuredServerUser: string | undefined,
): Promise<void> {
  const { opts, io, dependencies, env, home, prompt, run, transport } = context;
  if (transport === 'openssh' && !opts.skipKeygen && !existsSync(keyPath)) {
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const result = await run('ssh-keygen', [
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
  } else if (transport === 'openssh' && existsSync(keyPath)) {
    io.errLine(`  • SSH key exists at ${keyPath}`);
  }

  const common = {
    hostAlias:
      opts.hostAlias ??
      (prompt ? await prompt.input('Local name for this server', 'desktop') : 'desktop'),
    tailscaleHost:
      opts.host ??
      (prompt ? await prompt.input('Server hostname or IP', 'my-workstation') : 'my-workstation'),
    sshUser:
      opts.sshUser ??
      (prompt
        ? await prompt.input(
            'SSH user on the server',
            configuredServerUser ?? dependencies.username ?? os.userInfo().username,
          )
        : (configuredServerUser ?? dependencies.username ?? os.userInfo().username)),
  };
  const clientConfig =
    transport === 'tailscale-ssh'
      ? buildClientConfig({
          ...common,
          transport,
          ...(opts.serverCommand ? { serverCommand: opts.serverCommand } : {}),
        })
      : buildClientConfig({ ...common, transport, sshKey: keyPath });
  const parsedClient = parseClientConfig(clientConfig, { home });
  const target = clientConfigPath(env);
  const wroteClient = await shouldWrite(target, opts.force, prompt, io);
  if (wroteClient) {
    writeJsonFile(target, clientConfig);
    io.errLine(`  ✓ wrote client config ${target}`);
  }

  if (transport === 'tailscale-ssh') {
    io.errLine('  • no SSH key was generated; authentication uses the client tailnet identity');
    io.errLine('  • restrict this client, server, and SSH user in the tailnet policy');
  } else {
    const pubPath = `${keyPath}.pub`;
    if (existsSync(pubPath)) {
      const publicKey = readFileSync(pubPath, 'utf8').trim();
      io.errLine('\nPaste this public key into `talaria setup` on the server:');
      io.write(publicKey + '\n');
    } else {
      io.errLine(`\nNo public key at ${pubPath}; generate one before authorizing the client.`);
    }
  }

  if (prompt && wroteClient && (await prompt.confirm('Test the connection now?', true))) {
    const host = parsedClient.hosts[common.hostAlias];
    if (!host) throw new Error(`Generated config is missing host ${common.hostAlias}`);
    try {
      const targetConfig = { alias: common.hostAlias, ...host };
      const latency = dependencies.testConnection
        ? await dependencies.testConnection(targetConfig)
        : await TalariaClient.overRemote(targetConfig).ping();
      io.errLine(`  ✓ connected to ${common.hostAlias} (${latency} ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.errLine(`  ✗ connection test failed: ${message}`);
      io.errLine('    The config was saved; finish the server setup and run `talaria ping`.');
    }
  }
}

async function configureServer(context: SetupWorkflowContext): Promise<string> {
  const {
    opts,
    io,
    dependencies,
    env,
    home,
    prompt,
    run,
    runInteractive,
    platform,
    getuid,
    transport,
    tailscaleSshAlreadyEnabled,
  } = context;
  const currentUser = dependencies.username ?? os.userInfo().username;
  const defaultAllowedDir = path.join(home, 'projects');
  if (prompt && !opts.allowedDir?.length) {
    io.errLine('Allowed directories include all descendants. Enter one path at a time.');
    io.errLine(
      'Use an absolute path when possible; ~ means the home of the account running the server.',
    );
  }
  const allowedDirs = opts.allowedDir?.length
    ? opts.allowedDir
    : prompt
      ? await promptAllowedDirs(prompt, defaultAllowedDir)
      : [defaultAllowedDir];
  let tools: string[];
  if (opts.tool?.length) {
    tools = opts.tool;
  } else if (prompt) {
    tools = await selectServerTools(prompt, run, io);
  } else {
    throw new Error(
      'Specify which tools to configure with --tool (claude-code, codex, cursor, grok, opencode, and/or pi) for non-interactive server setup.',
    );
  }
  for (const tool of tools) {
    if (
      tool !== 'claude-code' &&
      tool !== 'codex' &&
      tool !== 'cursor' &&
      tool !== 'grok' &&
      tool !== 'opencode' &&
      tool !== 'pi'
    ) {
      throw new Error(
        `Unsupported setup tool ${tool}; expected claude-code, codex, cursor, grok, opencode, or pi`,
      );
    }
  }
  const runtime: SetupRuntime = await resolveSetupRuntime({
    tools,
    run,
    ...(dependencies.nodePath ? { nodePath: dependencies.nodePath } : {}),
    ...(dependencies.cliPath ? { cliPath: dependencies.cliPath } : {}),
    ...(dependencies.builtinToolBins ? { builtinToolBins: dependencies.builtinToolBins } : {}),
  });
  const serverConfig = buildServerConfig({
    tools,
    allowedDirs,
    builtinToolBins: runtime.builtinToolBins,
  });
  const openSshServerCommand =
    transport === 'openssh' ? buildTalariaForcedCommand(runtime) : undefined;
  let isolationPlan: MacOsIsolationPlan | undefined;
  let configuredServerUser = currentUser;

  if (transport === 'tailscale-ssh' && platform === 'darwin' && !prompt) {
    throw new Error(
      'macOS Tailscale SSH server setup requires an interactive run so the dedicated service-account changes can be reviewed and approved',
    );
  }
  if (transport === 'tailscale-ssh' && platform === 'darwin' && prompt) {
    io.errLine('');
    io.errLine('  ⚠ Tailscale SSH does not enforce an authorized_keys forced command.');
    io.errLine(
      '    A dedicated macOS account is recommended so Tailscale policy and OS permissions',
    );
    io.errLine('    contain the tools even if another SSH subsystem is exposed.');
    if (await prompt.confirm(`Create the dedicated ${TALARIA_ACCOUNT} service account?`, true)) {
      isolationPlan = createMacOsIsolationPlan({
        controllerUser: currentUser,
        allowedDirs,
        serverConfig,
        ...runtime,
      });
      io.errLine('\nAdministrator changes:');
      for (const item of isolationPlan.summary) io.errLine(`  • ${item}`);
      if (!(await prompt.confirm('Apply these administrator changes now?', true))) {
        throw new Error('Dedicated Tailscale SSH server setup was cancelled before changes');
      }
      await provisionMacOsIsolation(isolationPlan, { run, runInteractive, getuid });
      configuredServerUser = isolationPlan.account;
      io.errLine(`  ✓ provisioned isolated ${TALARIA_ACCOUNT} service account`);
      io.errLine(`  ✓ wrote server config ${isolationPlan.configPath}`);
    } else {
      io.errLine(
        '  ⚠ continuing as the current user; Tailscale SSH sessions are not constrained to Talaria',
      );
    }
  }

  const serverEnv = isolationPlan
    ? {
        ...env,
        XDG_CONFIG_HOME: path.join(isolationPlan.home, '.config'),
        XDG_DATA_HOME: path.join(isolationPlan.home, '.local', 'share'),
      }
    : env;
  const serverHome = isolationPlan?.home ?? home;
  let parsedServer = parseServerConfig(serverConfig, { env: serverEnv, home: serverHome });
  if (!isolationPlan) {
    const target = serverConfigPath(env);
    if (await shouldWrite(target, opts.force, prompt, io)) {
      writeJsonFile(target, serverConfig);
      io.errLine(`  ✓ wrote server config ${target}`);
    } else {
      try {
        parsedServer = loadServerConfig(target, { env: serverEnv, home: serverHome });
      } catch (cause) {
        throw new Error(
          `Existing server config at ${target} is not usable; rerun setup with --force to replace it`,
          { cause },
        );
      }
    }
  }

  const tmuxOk = await isTmuxAvailable();
  io.errLine(
    tmuxOk ? '  ✓ tmux found' : '  ✗ tmux not found — install it so sessions survive disconnects',
  );
  const registry = AdapterRegistry.fromConfig(parsedServer);
  for (const info of await registry.listWithAvailability()) {
    io.errLine(
      info.available
        ? `  ✓ ${info.name}${info.version ? ` (${info.version})` : ''}`
        : `  ✗ ${info.name} — ${info.error ?? 'unavailable'}`,
    );
  }

  if (transport === 'openssh') {
    if (prompt && (await prompt.confirm('Enable the OpenSSH server / Remote Login now?'))) {
      io.errLine(`  ✓ ${await enableOpenSshServer(platform, run, runInteractive, getuid)}`);
    } else if (!prompt) {
      io.errLine('  • ensure the OpenSSH server / Remote Login is enabled');
    }

    const publicKey =
      opts.publicKey ??
      (prompt ? await prompt.input('Controller public key (leave blank to install it later)') : '');
    if (publicKey) {
      const confirmed =
        !prompt ||
        (await prompt.confirm(
          `Authorize this key in ${path.join(home, '.ssh', 'authorized_keys')}?`,
        ));
      if (confirmed) {
        if (!openSshServerCommand) throw new Error('OpenSSH server command was not resolved');
        const result = installAuthorizedKey(publicKey, home, openSshServerCommand);
        io.errLine(
          result === 'installed'
            ? '  ✓ installed restricted controller key'
            : result === 'updated'
              ? '  ✓ updated legacy controller key with the complete server command'
              : '  • restricted controller key is already installed',
        );
      }
    } else if (prompt) {
      io.errLine('  • rerun setup with --public-key after generating the key on the client');
    }
  } else if (tailscaleSshAlreadyEnabled) {
    io.errLine('  ✓ Tailscale SSH is already enabled');
    printTailscalePolicyGuidance(io, configuredServerUser);
  } else if (prompt && (await prompt.confirm('Enable Tailscale SSH on this server now?'))) {
    await enableTailscaleSsh(platform, runInteractive, getuid);
    io.errLine('  ✓ Tailscale SSH enabled');
    printTailscalePolicyGuidance(io, configuredServerUser);
  } else {
    io.errLine('  • enable Tailscale SSH later with: tailscale set --ssh=true');
    printTailscalePolicyGuidance(io, configuredServerUser);
  }

  return configuredServerUser;
}

export async function setupAction(
  opts: SetupCliOptions = {},
  io: Io = defaultIo,
  dependencies: SetupDependencies = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const interactive =
    opts.interactive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  const ownsPrompt = interactive && dependencies.prompt === undefined;
  const prompt = interactive
    ? (dependencies.prompt ?? new InquirerSetupPrompter(process.stdin, process.stderr))
    : undefined;
  const run = dependencies.run ?? runCommand;
  const runInteractive = dependencies.runInteractive ?? defaultInteractiveCommand;
  const platform = dependencies.platform ?? process.platform;
  const getuid = dependencies.getuid ?? (() => process.getuid?.() ?? -1);

  try {
    io.errLine('talaria setup');

    const role: SetupRole =
      opts.role ??
      (prompt ? await prompt.select('What do you want to configure?', ROLE_CHOICES) : 'both');
    if (!['server', 'client', 'both'].includes(role)) {
      throw new Error(`Invalid --role "${role}"; expected server, client, or both`);
    }
    const requestedTransport =
      opts.transport ??
      (prompt
        ? await prompt.select('How should the client connect to this server?', TRANSPORT_CHOICES)
        : 'openssh');
    const transportResult = TransportKind.safeParse(requestedTransport);
    if (!transportResult.success) {
      throw new Error(
        `Invalid --transport "${String(requestedTransport)}"; expected openssh or tailscale-ssh`,
      );
    }
    const doServer = role === 'server' || role === 'both';
    const doClient = role === 'client' || role === 'both';
    const { transport, tailscaleSshAlreadyEnabled } = await resolveSetupTransport({
      requested: transportResult.data,
      configureServer: doServer,
      ...(prompt ? { prompt } : {}),
      run,
      io,
    });
    if (transport === 'tailscale-ssh' && opts.key !== undefined) {
      throw new Error('--key applies only to the openssh transport');
    }
    if (transport === 'openssh' && opts.serverCommand !== undefined) {
      throw new Error('--server-command applies only to the tailscale-ssh transport');
    }

    const keyPath =
      opts.key ??
      (doClient && prompt && transport === 'openssh'
        ? await prompt.input('Private key path', path.join(home, '.ssh', 'talaria_agent_ed25519'))
        : path.join(home, '.ssh', 'talaria_agent_ed25519'));
    let configuredServerUser: string | undefined;

    await checkSetupPrerequisites({
      transport,
      configureClient: doClient,
      configureServer: doServer,
      run,
      io,
    });

    const workflowContext: SetupWorkflowContext = {
      opts,
      io,
      dependencies,
      env,
      home,
      prompt,
      run,
      runInteractive,
      platform,
      getuid,
      transport,
      tailscaleSshAlreadyEnabled,
    };
    if (doServer) configuredServerUser = await configureServer(workflowContext);
    if (doClient) await configureClient(workflowContext, keyPath, configuredServerUser);

    io.errLine('\nSetup complete.');
  } finally {
    if (ownsPrompt) prompt?.close();
  }
}
