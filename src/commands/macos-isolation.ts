/**
 * Dedicated macOS account provisioning for a Tailscale SSH Talaria server.
 *
 * Tailscale SSH authenticates before entering the local account and, on macOS,
 * invokes that account's Directory Services UserShell as `<shell> -c <command>`.
 * This module makes the OS account and filesystem ACLs the isolation boundary;
 * the exact-command shell is an additional guard against interactive access.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../util/exec.js';

export const TALARIA_ACCOUNT = 'talaria';
export const TALARIA_PROJECT_GROUP = 'talaria-projects';
export const TALARIA_HOME = '/Users/talaria';
export const TALARIA_SHELL = '/usr/local/libexec/talaria-shell';

const TALARIA_SERVICE_DIR = '/usr/local/libexec/talaria';
const TALARIA_SERVICE_NODE = path.join(TALARIA_SERVICE_DIR, 'node');
const TALARIA_SERVICE_APP = path.join(TALARIA_SERVICE_DIR, 'app');
const TALARIA_CONFIG_DIR = path.join(TALARIA_HOME, '.config', 'talaria');
const TALARIA_CONFIG_FILE = path.join(TALARIA_CONFIG_DIR, 'server.json');
const TALARIA_DATA_DIR = path.join(TALARIA_HOME, '.local', 'share', 'talaria');
const TALARIA_SESSION_DIR = path.join(TALARIA_DATA_DIR, 'sessions');

type CommandRunner = typeof runCommand;
type InteractiveCommandRunner = (bin: string, args: string[]) => Promise<number | null>;

export interface MacOsIsolationOptions {
  controllerUser: string;
  allowedDirs: string[];
  serverConfig: Record<string, unknown>;
  nodePath: string;
  cliPath: string;
  executablePath: string;
}

export interface MacOsIsolationPlan extends MacOsIsolationOptions {
  sourceNodePath: string;
  stageNodeRuntime: boolean;
  sourceCliPath: string;
  sourceAppRoot: string;
  stageTalariaApp: boolean;
  account: typeof TALARIA_ACCOUNT;
  group: typeof TALARIA_PROJECT_GROUP;
  home: typeof TALARIA_HOME;
  shellPath: typeof TALARIA_SHELL;
  configPath: typeof TALARIA_CONFIG_FILE;
  stateDir: typeof TALARIA_DATA_DIR;
  path: string;
  summary: string[];
}

export interface MacOsIsolationDependencies {
  run?: CommandRunner;
  runInteractive: InteractiveCommandRunner;
  getuid: () => number;
}

function quoteForSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireAbsoluteFile(label: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  return filePath;
}

function normalizeAllowedDirs(dirs: string[]): string[] {
  if (dirs.length === 0) throw new Error('At least one project directory is required');
  return dirs.map((dir) => {
    if (!path.isAbsolute(dir)) throw new Error(`Project directory must be absolute: ${dir}`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`Project directory does not exist or is not a directory: ${dir}`);
    }
    const resolved = realpathSync(dir);
    const unsafeRoots = new Set([
      '/',
      '/Applications',
      '/Library',
      '/System',
      '/Users',
      '/bin',
      '/etc',
      '/private',
      '/sbin',
      '/usr',
      '/var',
    ]);
    if (unsafeRoots.has(resolved)) {
      throw new Error(
        `Refusing recursive group and ACL changes on broad system directory: ${resolved}`,
      );
    }
    return resolved;
  });
}

/** Build a displayable, immutable plan before asking for administrator access. */
export function createMacOsIsolationPlan(options: MacOsIsolationOptions): MacOsIsolationPlan {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(options.controllerUser)) {
    throw new Error(`Invalid controller user name: ${options.controllerUser}`);
  }
  const sourceNodePath = requireAbsoluteFile('Node path', options.nodePath);
  const sourceCliPath = requireAbsoluteFile('Talaria CLI path', options.cliPath);
  const controllerHome = path.join('/Users', options.controllerUser);
  const stageNodeRuntime =
    sourceNodePath === controllerHome || sourceNodePath.startsWith(`${controllerHome}${path.sep}`);
  const nodePath = stageNodeRuntime ? TALARIA_SERVICE_NODE : sourceNodePath;
  const stageTalariaApp =
    sourceCliPath === controllerHome || sourceCliPath.startsWith(`${controllerHome}${path.sep}`);
  const sourceAppRoot = path.dirname(path.dirname(sourceCliPath));
  const cliPath = stageTalariaApp
    ? path.join(TALARIA_SERVICE_APP, path.relative(sourceAppRoot, sourceCliPath))
    : sourceCliPath;
  const allowedDirs = normalizeAllowedDirs(options.allowedDirs);
  const pathEntries = [
    ...options.executablePath.split(path.delimiter),
    path.dirname(nodePath),
    path.dirname(cliPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(
    (entry, index, entries) =>
      path.isAbsolute(entry) && entry.length > 1 && entries.indexOf(entry) === index,
  );
  const executablePath = pathEntries.join(path.delimiter);

  return {
    ...options,
    sourceNodePath,
    stageNodeRuntime,
    sourceCliPath,
    sourceAppRoot,
    stageTalariaApp,
    nodePath,
    cliPath,
    allowedDirs,
    executablePath,
    account: TALARIA_ACCOUNT,
    group: TALARIA_PROJECT_GROUP,
    home: TALARIA_HOME,
    shellPath: TALARIA_SHELL,
    configPath: TALARIA_CONFIG_FILE,
    stateDir: TALARIA_DATA_DIR,
    path: executablePath,
    summary: [
      `Create or verify the hidden, non-admin ${TALARIA_ACCOUNT} account with password login disabled`,
      `Install a root-owned shell that accepts only \`talaria serve\` at ${TALARIA_SHELL}`,
      ...(stageNodeRuntime
        ? [`Copy the private-home Node executable to ${TALARIA_SERVICE_NODE}`]
        : []),
      ...(stageTalariaApp
        ? [`Copy the private-home Talaria package to ${TALARIA_SERVICE_APP}`]
        : []),
      `Create ${TALARIA_PROJECT_GROUP} and add ${options.controllerUser} and ${TALARIA_ACCOUNT}`,
      `Grant that group inherited read/write access to: ${allowedDirs.join(', ')}`,
      `Install server config and private session state below ${TALARIA_HOME}`,
      'Verify the dedicated account can read Node/Talaria and execute the configured tool CLIs',
    ],
  };
}

/** Root-owned login shell. Never evaluates the SSH command as shell source. */
export function buildMacOsRestrictedShell(plan: MacOsIsolationPlan): string {
  return `#!/bin/sh
set -eu

if [ "$#" -ne 2 ] || [ "$1" != "-c" ] || [ "$2" != "talaria serve" ]; then
  echo "This account only accepts the Talaria protocol." >&2
  exit 126
fi

export HOME=${quoteForSh(plan.home)}
export XDG_CONFIG_HOME=${quoteForSh(path.join(plan.home, '.config'))}
export XDG_DATA_HOME=${quoteForSh(path.join(plan.home, '.local', 'share'))}
export PATH=${quoteForSh(plan.path)}
exec ${quoteForSh(plan.nodePath)} ${quoteForSh(plan.cliPath)} serve
`;
}

async function checked(
  runInteractive: InteractiveCommandRunner,
  bin: string,
  args: string[],
  description: string,
): Promise<void> {
  const code = await runInteractive(bin, args);
  if (code !== 0) throw new Error(`${description} failed (exit ${String(code)})`);
}

function privileged(
  getuid: () => number,
  bin: string,
  args: string[],
): readonly [string, string[]] {
  return getuid() === 0 ? [bin, args] : ['/usr/bin/sudo', [bin, ...args]];
}

async function checkedPrivileged(
  deps: MacOsIsolationDependencies,
  bin: string,
  args: string[],
  description: string,
): Promise<void> {
  const [privilegedBin, privilegedArgs] = privileged(deps.getuid, bin, args);
  await checked(deps.runInteractive, privilegedBin, privilegedArgs, description);
}

async function createAccountIfMissing(
  plan: MacOsIsolationPlan,
  deps: MacOsIsolationDependencies,
): Promise<void> {
  const run = deps.run ?? runCommand;
  const account = await run('/usr/bin/dscl', ['.', '-read', `/Users/${plan.account}`]);
  if (account.code === 0) {
    const admin = await run('/usr/sbin/dseditgroup', [
      '-o',
      'checkmember',
      '-m',
      plan.account,
      'admin',
    ]);
    if (/\byes\b/i.test(admin.stdout)) {
      throw new Error(
        `Existing account ${plan.account} is an administrator; remove it from admin first`,
      );
    }
    for (const [attribute, expected] of [
      ['NFSHomeDirectory', plan.home],
      ['UserShell', plan.shellPath],
    ] as const) {
      const result = await run('/usr/bin/dscl', [
        '.',
        '-read',
        `/Users/${plan.account}`,
        attribute,
      ]);
      if (result.code !== 0 || !result.stdout.trim().endsWith(expected)) {
        throw new Error(
          `Existing account ${plan.account} has an unexpected ${attribute}; refusing to repurpose it`,
        );
      }
    }
    return;
  }

  const listed = await run('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID']);
  if (listed.code !== 0) throw new Error('Could not inspect local macOS user IDs');
  const used = new Set(
    listed.stdout
      .split('\n')
      .map((line) => Number(line.trim().split(/\s+/).at(-1)))
      .filter((uid) => Number.isInteger(uid)),
  );
  let uid = 501;
  while (used.has(uid)) uid += 1;

  const attributes: ReadonlyArray<readonly [string, string]> = [
    ['RealName', 'Talaria Service'],
    ['UniqueID', String(uid)],
    ['PrimaryGroupID', '20'],
    ['NFSHomeDirectory', plan.home],
    ['UserShell', plan.shellPath],
    ['IsHidden', '1'],
    ['Password', '*'],
    ['AuthenticationAuthority', ';DisabledUser;'],
  ];
  await checkedPrivileged(
    deps,
    '/usr/bin/dscl',
    ['.', '-create', `/Users/${plan.account}`],
    `Creating ${plan.account}`,
  );
  for (const [attribute, value] of attributes) {
    await checkedPrivileged(
      deps,
      '/usr/bin/dscl',
      ['.', '-create', `/Users/${plan.account}`, attribute, value],
      `Setting ${plan.account} ${attribute}`,
    );
  }
}

async function ensureGroup(plan: MacOsIsolationPlan, deps: MacOsIsolationDependencies) {
  const run = deps.run ?? runCommand;
  const group = await run('/usr/sbin/dseditgroup', ['-o', 'read', plan.group]);
  if (group.code !== 0) {
    await checkedPrivileged(
      deps,
      '/usr/sbin/dseditgroup',
      ['-o', 'create', '-r', 'Talaria project access', plan.group],
      `Creating ${plan.group}`,
    );
  }
  for (const user of [plan.controllerUser, plan.account]) {
    await checkedPrivileged(
      deps,
      '/usr/sbin/dseditgroup',
      ['-o', 'edit', '-a', user, '-t', 'user', plan.group],
      `Adding ${user} to ${plan.group}`,
    );
  }
}

async function installPrivateFiles(
  plan: MacOsIsolationPlan,
  deps: MacOsIsolationDependencies,
): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'talaria-isolation-'));
  const shellSource = path.join(tempDir, 'talaria-shell');
  const configSource = path.join(tempDir, 'server.json');
  try {
    writeFileSync(shellSource, buildMacOsRestrictedShell(plan), { mode: 0o600 });
    writeFileSync(configSource, JSON.stringify(plan.serverConfig, null, 2) + '\n', { mode: 0o600 });

    await checkedPrivileged(
      deps,
      '/usr/bin/install',
      ['-d', '-o', 'root', '-g', 'wheel', '-m', '0755', path.dirname(plan.shellPath)],
      'Creating the restricted-shell directory',
    );
    await checkedPrivileged(
      deps,
      '/usr/bin/install',
      ['-o', 'root', '-g', 'wheel', '-m', '0755', shellSource, plan.shellPath],
      'Installing the restricted shell',
    );
    if (plan.stageNodeRuntime) {
      await checkedPrivileged(
        deps,
        '/usr/bin/install',
        ['-d', '-o', 'root', '-g', 'wheel', '-m', '0755', TALARIA_SERVICE_DIR],
        'Creating the service runtime directory',
      );
      await checkedPrivileged(
        deps,
        '/usr/bin/install',
        ['-o', 'root', '-g', 'wheel', '-m', '0755', plan.sourceNodePath, plan.nodePath],
        'Installing the service Node runtime',
      );
    }
    if (plan.stageTalariaApp) {
      await checkedPrivileged(
        deps,
        '/usr/bin/install',
        ['-d', '-o', 'root', '-g', 'wheel', '-m', '0755', TALARIA_SERVICE_DIR],
        'Creating the service application directory',
      );
      for (const directory of ['dist', 'node_modules']) {
        await checkedPrivileged(
          deps,
          '/usr/bin/ditto',
          [path.join(plan.sourceAppRoot, directory), path.join(TALARIA_SERVICE_APP, directory)],
          `Installing Talaria ${directory}`,
        );
      }
      await checkedPrivileged(
        deps,
        '/usr/bin/install',
        [
          '-o',
          'root',
          '-g',
          'wheel',
          '-m',
          '0644',
          path.join(plan.sourceAppRoot, 'package.json'),
          path.join(TALARIA_SERVICE_APP, 'package.json'),
        ],
        'Installing the Talaria package manifest',
      );
      await checkedPrivileged(
        deps,
        '/usr/sbin/chown',
        ['-R', 'root:wheel', TALARIA_SERVICE_APP],
        'Securing Talaria application ownership',
      );
      await checkedPrivileged(
        deps,
        '/bin/chmod',
        ['-R', 'go-w', TALARIA_SERVICE_APP],
        'Securing Talaria application permissions',
      );
    }
    for (const directory of [
      plan.home,
      path.dirname(TALARIA_CONFIG_DIR),
      TALARIA_CONFIG_DIR,
      path.dirname(TALARIA_DATA_DIR),
      TALARIA_DATA_DIR,
      TALARIA_SESSION_DIR,
    ]) {
      await checkedPrivileged(
        deps,
        '/usr/bin/install',
        ['-d', '-o', plan.account, '-g', 'staff', '-m', '0700', directory],
        `Creating ${directory}`,
      );
    }
    await checkedPrivileged(
      deps,
      '/usr/bin/install',
      ['-o', plan.account, '-g', 'staff', '-m', '0600', configSource, plan.configPath],
      'Installing the dedicated server config',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function grantProjectAccess(
  plan: MacOsIsolationPlan,
  deps: MacOsIsolationDependencies,
): Promise<void> {
  const inheritedAcl = `group:${plan.group} allow read,write,execute,delete,append,list,search,readattr,readextattr,readsecurity,add_file,add_subdirectory,delete_child,writeattr,writeextattr,file_inherit,directory_inherit`;
  for (const directory of plan.allowedDirs) {
    await checkedPrivileged(
      deps,
      '/usr/bin/chgrp',
      ['-R', plan.group, directory],
      `Setting project group on ${directory}`,
    );
    await checkedPrivileged(
      deps,
      '/bin/chmod',
      ['-R', 'g+rwX', directory],
      `Granting existing project access on ${directory}`,
    );
    await checkedPrivileged(
      deps,
      '/bin/chmod',
      ['g+s', directory],
      `Enabling group inheritance on ${directory}`,
    );
    await checkedPrivileged(
      deps,
      '/bin/chmod',
      ['+a', inheritedAcl, directory],
      `Adding inherited project ACL on ${directory}`,
    );
  }
}

async function verifyRuntimeAccess(
  plan: MacOsIsolationPlan,
  deps: MacOsIsolationDependencies,
): Promise<void> {
  const tests: ReadonlyArray<readonly [string[], string]> = [
    [['-x', plan.shellPath], 'restricted shell'],
    [['-x', plan.nodePath], 'Node runtime'],
    [['-r', plan.cliPath], 'Talaria CLI'],
    [['-r', plan.configPath], 'server config'],
    [['-w', TALARIA_SESSION_DIR], 'session state directory'],
  ];
  for (const [testArgs, description] of tests) {
    await checked(
      deps.runInteractive,
      '/usr/bin/sudo',
      ['-u', plan.account, '/bin/test', ...testArgs],
      `Verifying ${description} access`,
    );
  }
  await checked(
    deps.runInteractive,
    '/usr/bin/sudo',
    ['-u', plan.account, plan.nodePath, '--version'],
    'Launching the Node runtime',
  );
  for (const tool of ['claude', 'codex']) {
    await checked(
      deps.runInteractive,
      '/usr/bin/sudo',
      ['-u', plan.account, '-H', '/usr/bin/env', `PATH=${plan.path}`, tool, '--version'],
      `Verifying ${tool} access`,
    );
  }
}

async function verifyProjectAccess(
  plan: MacOsIsolationPlan,
  deps: MacOsIsolationDependencies,
): Promise<void> {
  for (const directory of plan.allowedDirs) {
    for (const mode of ['-r', '-w', '-x']) {
      await checked(
        deps.runInteractive,
        '/usr/bin/sudo',
        ['-u', plan.account, '/bin/test', mode, directory],
        `Verifying project access to ${directory}`,
      );
    }
  }
}

/** Apply the confirmed plan idempotently and verify the effective service account. */
export async function provisionMacOsIsolation(
  plan: MacOsIsolationPlan,
  deps: MacOsIsolationDependencies,
): Promise<void> {
  await createAccountIfMissing(plan, deps);
  await ensureGroup(plan, deps);
  await installPrivateFiles(plan, deps);
  await verifyRuntimeAccess(plan, deps);
  await grantProjectAccess(plan, deps);
  await verifyProjectAccess(plan, deps);
}
