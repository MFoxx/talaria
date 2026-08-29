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
  realpathSync,
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
import { parseServerConfig } from '../config/server-config.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { TalariaClient } from '../client/talaria-client.js';
import { isTmuxAvailable } from '../server/tmux.js';
import { BinaryNotFoundError, runCommand } from '../util/exec.js';
import type { Io } from './actions.js';
import { InquirerSetupPrompter, type SelectChoice, type SetupPrompter } from './setup-prompts.js';
import {
  createMacOsIsolationPlan,
  provisionMacOsIsolation,
  TALARIA_ACCOUNT,
  type MacOsIsolationPlan,
} from './macos-isolation.js';

/** SSH forced command and restrictions applied to the agent key (§6.2). */
export const FORCED_COMMAND = 'talaria serve';
export const KEY_RESTRICTIONS = [
  'no-port-forwarding',
  'no-agent-forwarding',
  'no-X11-forwarding',
  'no-pty',
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function authorizedKeysQuote(command: string): string {
  return command.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export interface TalariaForcedCommandOptions {
  nodePath: string;
  cliPath: string;
  executablePath: string;
}

/** Build the self-contained command used by sshd's non-interactive forced-command shell. */
export function buildTalariaForcedCommand(opts: TalariaForcedCommandOptions): string {
  if (!path.isAbsolute(opts.nodePath) || !path.isAbsolute(opts.cliPath)) {
    throw new Error('The Node and Talaria CLI paths used by OpenSSH must be absolute');
  }
  const pathEntries = [
    ...opts.executablePath.split(path.delimiter),
    path.dirname(opts.nodePath),
    path.dirname(opts.cliPath),
  ].filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index);
  return `PATH=${shellQuote(pathEntries.join(path.delimiter))} ${shellQuote(opts.nodePath)} ${shellQuote(opts.cliPath)} serve`;
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
  executablePath?: string;
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

async function binaryAvailable(bin: string, args: string[], run: CommandRunner): Promise<boolean> {
  try {
    await run(bin, args);
    return true;
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return false;
    throw error;
  }
}

async function isTailscaleSshEnabled(run: CommandRunner): Promise<boolean | undefined> {
  try {
    const result = await run('tailscale', ['debug', 'prefs']);
    if (result.code !== 0) return undefined;
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== 'object' || value === null || !('RunSSH' in value)) return undefined;
    return typeof value.RunSSH === 'boolean' ? value.RunSSH : undefined;
  } catch (error) {
    if (error instanceof BinaryNotFoundError || error instanceof SyntaxError) return undefined;
    throw error;
  }
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

function resolveTalariaForcedCommand(
  env: NodeJS.ProcessEnv,
  dependencies: SetupDependencies,
): string {
  const runtime = resolveTalariaRuntime(env, dependencies);
  return buildTalariaForcedCommand(runtime);
}

function resolveTalariaRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: SetupDependencies,
): TalariaForcedCommandOptions {
  const nodePath = dependencies.nodePath ?? realpathSync(process.execPath);
  const cliArgument = dependencies.cliPath ?? process.argv[1];
  if (!cliArgument) {
    throw new Error('Could not determine the Talaria CLI path; run setup through the talaria CLI');
  }
  const cliPath = dependencies.cliPath ?? realpathSync(cliArgument);
  if (path.extname(cliPath) === '.ts') {
    throw new Error(
      'OpenSSH setup needs a built Talaria CLI. Run `npm run build && npm link`, then run `talaria setup`.',
    );
  }
  const executablePath = dependencies.executablePath ?? env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return { nodePath, cliPath, executablePath };
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

export async function setupAction(
  opts: SetupCliOptions = {},
  io: Io = defaultIo,
  dependencies: SetupDependencies = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const interactive =
    opts.interactive ??
    (process.stdin.isTTY === true &&
      process.stderr.isTTY === true &&
      (opts.role === undefined || opts.transport === undefined));
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
    let transport = transportResult.data;
    const doServer = role === 'server' || role === 'both';
    const doClient = role === 'client' || role === 'both';
    let tailscaleSshAlreadyEnabled = false;
    if (prompt && doServer && transport === 'openssh') {
      tailscaleSshAlreadyEnabled = (await isTailscaleSshEnabled(run)) === true;
      if (tailscaleSshAlreadyEnabled) {
        io.errLine('');
        io.errLine('  ⚠ Tailscale SSH is already enabled on this server.');
        io.errLine(
          '    It intercepts SSH connections on the tailnet and bypasses OpenSSH authorized_keys,',
        );
        io.errLine("    so Talaria's forced command and key restrictions will not be applied.");
        io.errLine('    Keeping Tailscale SSH is usually intentional; use that transport instead.');
        if (await prompt.confirm('Switch this setup to Tailscale SSH?', true)) {
          transport = 'tailscale-ssh';
          io.errLine('  ✓ switched setup to Tailscale SSH');
        } else {
          throw new Error(
            'OpenSSH setup cannot continue while Tailscale SSH is enabled. To intentionally use OpenSSH, first run `tailscale set --ssh=false`.',
          );
        }
      }
    }
    if (transport === 'tailscale-ssh' && opts.key !== undefined) {
      throw new Error('--key applies only to the openssh transport');
    }
    if (transport === 'openssh' && opts.serverCommand !== undefined) {
      throw new Error('--server-command applies only to the tailscale-ssh transport');
    }

    const openSshServerCommand =
      doServer && transport === 'openssh'
        ? resolveTalariaForcedCommand(env, dependencies)
        : undefined;
    const keyPath =
      opts.key ??
      (doClient && prompt && transport === 'openssh'
        ? await prompt.input('Private key path', path.join(home, '.ssh', 'talaria_agent_ed25519'))
        : path.join(home, '.ssh', 'talaria_agent_ed25519'));

    if (prompt) {
      if (transport === 'tailscale-ssh') {
        if (!(await binaryAvailable('tailscale', ['version'], run))) {
          throw new Error(
            'Tailscale CLI is not installed. Install the standalone CLI build, then run setup again.',
          );
        }
        io.errLine('  ✓ tailscale CLI found');
        if (doClient) {
          const wrapper = await run('tailscale', ['ssh', '--help']);
          if (wrapper.code !== 0) {
            throw new Error(
              "`tailscale ssh` is unavailable. On macOS, install Tailscale's standalone build instead of the App Store build.",
            );
          }
          io.errLine('  ✓ tailscale ssh wrapper found');
        }
        if (doServer) {
          if (!(await binaryAvailable('tailscaled', ['--version'], run))) {
            throw new Error(
              'tailscaled is required on a Tailscale SSH server but was not found in PATH',
            );
          }
          io.errLine('  ✓ tailscaled found');
        }
      } else if (doClient) {
        for (const binary of ['ssh', 'ssh-keygen']) {
          if (!(await binaryAvailable(binary, ['-V'], run))) {
            throw new Error(`${binary} is required for the OpenSSH client setup`);
          }
          io.errLine(`  ✓ ${binary} found`);
        }
      }
    }

    if (doServer) {
      const defaultAllowedDir = path.join(home, 'projects');
      const allowedDirs = opts.allowedDir?.length
        ? opts.allowedDir
        : [
            prompt
              ? await prompt.input('Directory Talaria may run tools in', defaultAllowedDir)
              : defaultAllowedDir,
          ];
      const serverConfig = buildServerConfig({ allowedDirs });
      let isolationPlan: MacOsIsolationPlan | undefined;
      if (transport === 'tailscale-ssh' && platform === 'darwin' && prompt) {
        io.errLine('');
        io.errLine('  ⚠ Tailscale SSH does not enforce an authorized_keys forced command.');
        io.errLine(
          '    A dedicated macOS account is recommended so Tailscale policy and OS permissions',
        );
        io.errLine('    contain the tools even if another SSH subsystem is exposed.');
        if (
          await prompt.confirm(`Create the dedicated ${TALARIA_ACCOUNT} service account?`, true)
        ) {
          const runtime = resolveTalariaRuntime(env, dependencies);
          isolationPlan = createMacOsIsolationPlan({
            controllerUser: dependencies.username ?? os.userInfo().username,
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
      const parsedServer = parseServerConfig(serverConfig, { env: serverEnv, home: serverHome });
      if (!isolationPlan) {
        const target = serverConfigPath(env);
        if (await shouldWrite(target, opts.force, prompt, io)) {
          writeJsonFile(target, serverConfig);
          io.errLine(`  ✓ wrote server config ${target}`);
        }
      }

      const tmuxOk = await isTmuxAvailable();
      io.errLine(
        tmuxOk
          ? '  ✓ tmux found'
          : '  ✗ tmux not found — install it so sessions survive disconnects',
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
          (prompt
            ? await prompt.input('Controller public key (leave blank to install it later)')
            : '');
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
        printTailscalePolicyGuidance(
          io,
          isolationPlan?.account ?? dependencies.username ?? os.userInfo().username,
        );
      } else if (prompt && (await prompt.confirm('Enable Tailscale SSH on this server now?'))) {
        await enableTailscaleSsh(platform, runInteractive, getuid);
        io.errLine('  ✓ Tailscale SSH enabled');
        printTailscalePolicyGuidance(
          io,
          isolationPlan?.account ?? dependencies.username ?? os.userInfo().username,
        );
      } else {
        io.errLine('  • enable Tailscale SSH later with: tailscale set --ssh=true');
        printTailscalePolicyGuidance(
          io,
          isolationPlan?.account ?? dependencies.username ?? os.userInfo().username,
        );
      }
    }

    if (doClient) {
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
          (prompt
            ? await prompt.input('Server hostname or IP', 'my-workstation')
            : 'my-workstation'),
        sshUser:
          opts.sshUser ??
          (prompt
            ? await prompt.input(
                'SSH user on the server',
                transport === 'tailscale-ssh' ? TALARIA_ACCOUNT : os.userInfo().username,
              )
            : transport === 'tailscale-ssh'
              ? TALARIA_ACCOUNT
              : os.userInfo().username),
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

    io.errLine('\nSetup complete.');
  } finally {
    if (ownsPrompt) prompt?.close();
  }
}
