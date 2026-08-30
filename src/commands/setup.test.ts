import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAuthorizedKeysLine,
  buildClientConfig,
  buildServerConfig,
  buildTalariaForcedCommand,
  installAuthorizedKey,
  promptAllowedDirs,
  setupAction,
} from './setup.js';
import { parseClientConfig } from '../config/client-config.js';
import { parseServerConfig } from '../config/server-config.js';
import type { Io } from './actions.js';
import type { CheckboxChoice, SelectChoice, SetupPrompter } from './setup-prompts.js';
import { BinaryNotFoundError, type RunResult } from '../util/exec.js';

const okResult = (stdout = ''): RunResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
});

class FakePrompter implements SetupPrompter {
  readonly selections: Array<{ question: string; choices: readonly SelectChoice<string>[] }> = [];
  readonly checkboxCalls: Array<{ question: string; choices: readonly CheckboxChoice<string>[] }> =
    [];

  constructor(
    private readonly selected: Record<string, string> = {},
    private readonly inputs: Record<string, string> = {},
    private readonly confirmations: boolean[] = [],
    private readonly checkboxes: Record<string, string[]> = {},
  ) {}

  select<T extends string>(question: string, choices: readonly SelectChoice<T>[]): Promise<T> {
    this.selections.push({ question, choices });
    const value = this.selected[question];
    if (!value) throw new Error(`No fake selection for ${question}`);
    return Promise.resolve(value as T);
  }

  checkbox<T extends string>(
    question: string,
    choices: readonly CheckboxChoice<T>[],
  ): Promise<T[]> {
    this.checkboxCalls.push({ question, choices });
    const override = this.checkboxes[question];
    if (override) return Promise.resolve(override as T[]);
    return Promise.resolve(
      choices.filter((choice) => choice.checked).map((choice) => choice.value),
    );
  }

  input(question: string, defaultValue?: string): Promise<string> {
    return Promise.resolve(this.inputs[question] ?? defaultValue ?? '');
  }

  confirm(): Promise<boolean> {
    return Promise.resolve(this.confirmations.shift() ?? false);
  }

  close(): void {}
}

describe('buildAuthorizedKeysLine', () => {
  it('locks the key to an absolute Talaria command with the tool PATH', () => {
    const command = buildTalariaForcedCommand({
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      serviceExecutablePath: '/opt/tools/claude:/opt/tools/codex:/usr/bin',
    });
    const line = buildAuthorizedKeysLine('ssh-ed25519 AAAAKEY talaria-agent\n', command);
    expect(line).toBe(
      "command=\"PATH='/opt/tools/claude:/opt/tools/codex:/usr/bin' '/opt/node/bin/node' '/opt/talaria/dist/cli.js' serve\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAAKEY talaria-agent",
    );
  });

  it('rejects relative entries in the forced-command service PATH', () => {
    expect(() =>
      buildTalariaForcedCommand({
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        serviceExecutablePath: './bin:/usr/bin',
      }),
    ).toThrow(/only absolute directories/);
  });
});

describe('installAuthorizedKey', () => {
  it('creates a restricted, idempotent authorized_keys entry', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'talaria-authorized-key-'));
    try {
      const key = 'ssh-ed25519 AAAAPUB talaria-agent';
      expect(installAuthorizedKey(key, home)).toBe('installed');
      expect(installAuthorizedKey(key, home)).toBe('present');
      const file = path.join(home, '.ssh', 'authorized_keys');
      expect(readFileSync(file, 'utf8')).toBe(buildAuthorizedKeysLine(key) + '\n');
      expect(statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to leave the same key authorized without Talaria restrictions', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'talaria-authorized-key-'));
    try {
      const sshDir = path.join(home, '.ssh');
      writeFileSync(path.join(home, 'placeholder'), '');
      // mkdir is intentionally exercised by the production helper first.
      installAuthorizedKey('ssh-ed25519 AAAAOTHER', home);
      writeFileSync(path.join(sshDir, 'authorized_keys'), 'ssh-ed25519 AAAAPUB unrestricted\n');
      expect(() => installAuthorizedKey('ssh-ed25519 AAAAPUB talaria-agent', home)).toThrow(
        /already authorized without/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('upgrades the legacy talaria serve entry', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'talaria-authorized-key-'));
    try {
      const key = 'ssh-ed25519 AAAAPUB talaria-agent';
      installAuthorizedKey(key, home);
      const command = buildTalariaForcedCommand({
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        serviceExecutablePath: '/tools/bin:/usr/bin',
      });
      expect(installAuthorizedKey(key, home, command)).toBe('updated');
      expect(readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(
        buildAuthorizedKeysLine(key, command) + '\n',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('config builders produce valid configs', () => {
  it('server config parses', () => {
    const cfg = buildServerConfig({
      allowedDirs: ['/home/me/projects'],
      builtinToolBins: {
        'claude-code': '/usr/local/bin/claude',
        codex: '/usr/local/bin/codex',
      },
    });
    expect(() => parseServerConfig(cfg)).not.toThrow();
    expect(cfg.tools).toEqual(['claude-code', 'codex']);
  });

  it('client config parses and sets the default host', () => {
    const cfg = buildClientConfig({
      hostAlias: 'desktop',
      tailscaleHost: 'ws',
      sshUser: 'user',
      sshKey: '/home/me/.ssh/talaria',
    });
    const parsed = parseClientConfig(cfg);
    expect(parsed.defaultHost).toBe('desktop');
    expect(parsed.hosts.desktop?.tailscaleHost).toBe('ws');
    expect(parsed.hosts.desktop?.transport).toBe('openssh');
  });

  it('builds a keyless Tailscale SSH client config', () => {
    const cfg = buildClientConfig({
      transport: 'tailscale-ssh',
      hostAlias: 'desktop',
      tailscaleHost: 'ws',
      sshUser: 'user',
    });
    const parsed = parseClientConfig(cfg);
    expect(parsed.hosts.desktop).toEqual({
      transport: 'tailscale-ssh',
      tailscaleHost: 'ws',
      sshUser: 'user',
      serverCommand: 'talaria serve',
    });
  });

  it('preserves an explicit Tailscale SSH server command', () => {
    const parsed = parseClientConfig(
      buildClientConfig({
        transport: 'tailscale-ssh',
        hostAlias: 'desktop',
        tailscaleHost: 'ws',
        sshUser: 'user',
        serverCommand: '/opt/talaria/bin/talaria serve',
      }),
    );
    expect(
      parsed.hosts.desktop?.transport === 'tailscale-ssh'
        ? parsed.hosts.desktop.serverCommand
        : undefined,
    ).toBe('/opt/talaria/bin/talaria serve');
  });
});

describe('promptAllowedDirs', () => {
  it('collects one path per prompt and trims surrounding whitespace', async () => {
    const prompt = new FakePrompter(
      {},
      {
        'Allowed directory (this directory and its descendants; one path per prompt)':
          '  ~/projects  ',
        'Additional allowed directory': '/Volumes/work/repos',
      },
      [true, false],
    );

    await expect(promptAllowedDirs(prompt, '/unused')).resolves.toEqual([
      '~/projects',
      '/Volumes/work/repos',
    ]);
  });

  it('rejects an empty allowed directory', async () => {
    const prompt = new FakePrompter({}, { 'Additional allowed directory': ' ' }, [true]);
    await expect(promptAllowedDirs(prompt, '/projects')).rejects.toThrow(
      'Allowed directories cannot be empty',
    );
  });
});

describe('setupAction', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let io: Io;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-setup-'));
    out = [];
    err = [];
    io = { write: (t) => out.push(t), errLine: (t) => err.push(t) };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes valid configs and prints the public key', async () => {
    const keyPath = path.join(root, 'key');
    writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAPUB talaria-agent\n');
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };

    await setupAction(
      {
        role: 'both',
        key: keyPath,
        host: 'workstation',
        sshUser: 'user',
        tool: ['claude-code', 'codex'],
        allowedDir: [path.join(root, 'projects')],
        skipKeygen: true,
        env,
      },
      io,
    );

    const serverJson = path.join(root, 'config', 'talaria', 'server.json');
    const clientJson = path.join(root, 'config', 'talaria', 'client.json');
    expect(() => parseServerConfig(JSON.parse(readFileSync(serverJson, 'utf8')))).not.toThrow();
    const client = parseClientConfig(JSON.parse(readFileSync(clientJson, 'utf8')));
    expect(client.hosts.desktop?.tailscaleHost).toBe('workstation');

    expect(out.join('')).toContain('ssh-ed25519 AAAAPUB');
  });

  it('does not overwrite existing config without --force', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    const clientJson = path.join(root, 'config', 'talaria', 'client.json');

    await setupAction({ role: 'client', key: path.join(root, 'k'), skipKeygen: true, env }, io);
    const first = readFileSync(clientJson, 'utf8');

    // Second run with a different host but no --force: file is left untouched.
    await setupAction(
      { role: 'client', key: path.join(root, 'k'), host: 'changed', skipKeygen: true, env },
      io,
    );
    expect(readFileSync(clientJson, 'utf8')).toBe(first);
    expect(err.some((l) => l.includes('use --force'))).toBe(true);
  });

  it('does not ask a server-only setup for a controller public key', async () => {
    await setupAction(
      {
        role: 'server',
        tool: ['claude-code', 'codex'],
        allowedDir: [path.join(root, 'projects')],
        env: { XDG_CONFIG_HOME: path.join(root, 'config') },
        home: root,
      },
      io,
    );

    expect(err.join('\n')).not.toContain('No public key');
    expect(err.join('\n')).not.toContain('authorized_keys');
  });

  it('configures and pins only the selected built-in server tool', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    await setupAction(
      {
        role: 'server',
        transport: 'openssh',
        tool: ['codex'],
        allowedDir: [root],
        interactive: false,
        env,
        home: root,
      },
      io,
      {
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        builtinToolBins: { codex: '/opt/codex/bin/codex' },
        run: () => Promise.resolve({ ...okResult(), code: 1 }),
      },
    );
    const config = JSON.parse(
      readFileSync(path.join(root, 'config', 'talaria', 'server.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(config.tools).toEqual(['codex']);
    expect(config.builtinToolBins).toEqual({ codex: '/opt/codex/bin/codex' });
  });

  it('interactively offers only the tools present on PATH so setup does not fail', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    // With no checkbox override, FakePrompter accepts the pre-checked (available) tools,
    // as a user pressing Enter would.
    const prompt = new FakePrompter({}, {}, [false]);

    await setupAction(
      {
        role: 'server',
        transport: 'openssh',
        allowedDir: [root],
        interactive: true,
        env,
        home: root,
      },
      io,
      {
        prompt,
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        // Pin claude-code so resolveToolBin skips realpath on a nonexistent path.
        builtinToolBins: { 'claude-code': '/usr/local/bin/claude' },
        run: (bin, args) => {
          // Only `claude` resolves on PATH; the other built-in tools are missing.
          if (bin === '/usr/bin/which') {
            return Promise.resolve(
              args[0] === 'claude'
                ? okResult('/usr/local/bin/claude\n')
                : { ...okResult(), code: 1 },
            );
          }
          return Promise.resolve(okResult());
        },
      },
    );

    const offered = prompt.checkboxCalls[0]?.choices ?? [];
    expect(offered.map((c) => c.value)).toEqual(['claude-code', 'codex', 'cursor', 'grok', 'pi']);
    expect(offered.find((c) => c.value === 'claude-code')?.checked).toBe(true);
    expect(offered.find((c) => c.value === 'codex')?.checked).toBe(false);
    const config = JSON.parse(
      readFileSync(path.join(root, 'config', 'talaria', 'server.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(config.tools).toEqual(['claude-code']);
    expect(config.builtinToolBins).toEqual({ 'claude-code': '/usr/local/bin/claude' });
  });

  it('requires --tool for non-interactive server setup', async () => {
    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'openssh',
          allowedDir: [root],
          interactive: false,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        { run: () => Promise.resolve(okResult()) },
      ),
    ).rejects.toThrow(/Specify which tools to configure with --tool/);
  });

  it('fails clearly when no server tools are selected', async () => {
    const prompt = new FakePrompter({}, {}, [], {
      'Which CLI tools should this server run?': [],
    });
    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'openssh',
          allowedDir: [root],
          interactive: true,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        {
          prompt,
          nodePath: '/opt/node/bin/node',
          cliPath: '/opt/talaria/dist/cli.js',
          run: () => Promise.resolve({ ...okResult(), code: 1 }),
        },
      ),
    ).rejects.toThrow(/No tools selected/);
  });

  it('rejects a retained legacy server config that lacks executable pins', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    const options = {
      role: 'server' as const,
      transport: 'openssh' as const,
      tool: ['codex'],
      allowedDir: [root],
      interactive: false,
      env,
      home: root,
    };
    const dependencies = {
      nodePath: '/opt/node/bin/node',
      cliPath: '/opt/talaria/dist/cli.js',
      builtinToolBins: { codex: '/opt/codex/bin/codex' },
      run: () => Promise.resolve({ ...okResult(), code: 1 }),
    };
    await setupAction(options, io, dependencies);
    writeFileSync(
      path.join(root, 'config', 'talaria', 'server.json'),
      JSON.stringify({ tools: ['codex'], allowedDirs: [root] }),
    );

    await expect(setupAction(options, io, dependencies)).rejects.toThrow(
      /rerun setup with --force/,
    );
  });

  it('configures Tailscale SSH without generating or printing a key', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    const keyPath = path.join(root, '.ssh', 'talaria_agent_ed25519');

    await setupAction(
      {
        role: 'client',
        transport: 'tailscale-ssh',
        host: 'workstation',
        sshUser: 'user',
        env,
        home: root,
      },
      io,
    );

    const clientJson = path.join(root, 'config', 'talaria', 'client.json');
    const client = parseClientConfig(JSON.parse(readFileSync(clientJson, 'utf8')));
    expect(client.hosts.desktop?.transport).toBe('tailscale-ssh');
    expect(existsSync(keyPath)).toBe(false);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('no SSH key was generated');
    expect(err.join('\n')).toContain('tailnet policy');
  });

  it('defaults a client-only Tailscale config to the current user', async () => {
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };
    await setupAction(
      {
        role: 'client',
        transport: 'tailscale-ssh',
        host: 'workstation',
        env,
        home: root,
      },
      io,
      {
        username: 'alice',
        run: () => Promise.resolve(okResult()),
      },
    );
    const client = parseClientConfig(
      JSON.parse(readFileSync(path.join(root, 'config', 'talaria', 'client.json'), 'utf8')),
    );
    expect(client.hosts.desktop?.sshUser).toBe('alice');
  });

  it('rejects an SSH key option for Tailscale SSH', async () => {
    await expect(
      setupAction({ role: 'client', transport: 'tailscale-ssh', key: path.join(root, 'key') }, io),
    ).rejects.toThrow(/--key applies only/);
  });

  it('rejects a server command for OpenSSH', async () => {
    await expect(
      setupAction({ role: 'client', serverCommand: 'something', skipKeygen: true }, io),
    ).rejects.toThrow(/--server-command applies only/);
  });

  it('rejects an invalid role', async () => {
    await expect(
      setupAction({ role: 'bogus' as 'both', skipKeygen: true, env: {} }, io),
    ).rejects.toThrow(/Invalid --role/);
  });

  it('rejects an invalid transport', async () => {
    await expect(
      setupAction({ transport: 'magic' as 'openssh', skipKeygen: true, env: {} }, io),
    ).rejects.toThrow(/Invalid --transport/);
  });

  it('guides an OpenSSH client through key generation, config, and a connection test', async () => {
    const keyPath = path.join(root, '.ssh', 'talaria_agent_ed25519');
    const prompt = new FakePrompter(
      {
        'What do you want to configure?': 'client',
        'How should the client connect to this server?': 'openssh',
      },
      {
        'Private key path': keyPath,
        'Local name for this server': 'work',
        'Server hostname or IP': 'workstation.example',
        'SSH user on the server': 'alice',
      },
      [true],
    );
    const commands: Array<{ bin: string; args: string[] }> = [];

    await setupAction(
      {
        interactive: true,
        env: { XDG_CONFIG_HOME: path.join(root, 'config') },
        home: root,
      },
      io,
      {
        prompt,
        run: (bin, args) => {
          commands.push({ bin, args });
          if (bin === 'ssh-keygen' && args.includes('-f')) {
            writeFileSync(keyPath, 'private');
            writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAPUB talaria-agent\n');
          }
          return Promise.resolve(okResult());
        },
        testConnection: () => Promise.resolve(12),
      },
    );

    const config = parseClientConfig(
      JSON.parse(readFileSync(path.join(root, 'config', 'talaria', 'client.json'), 'utf8')),
      { home: root },
    );
    expect(config.defaultHost).toBe('work');
    expect(config.hosts.work).toMatchObject({
      transport: 'openssh',
      tailscaleHost: 'workstation.example',
      sshUser: 'alice',
      sshKey: keyPath,
    });
    expect(commands.some(({ bin }) => bin === 'ssh-keygen')).toBe(true);
    expect(prompt.selections[1]?.choices[0]?.description).toContain('strongest isolation');
    expect(err.join('\n')).toContain('connected to work (12 ms)');
    expect(out.join('')).toContain('ssh-ed25519 AAAAPUB');
  });

  it('checks for tailscaled during interactive Tailscale server setup', async () => {
    const prompt = new FakePrompter();
    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'tailscale-ssh',
          allowedDir: [root],
          interactive: true,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        {
          prompt,
          run: (bin) => {
            if (bin === 'tailscaled') return Promise.reject(new BinaryNotFoundError(bin));
            return Promise.resolve(okResult());
          },
        },
      ),
    ).rejects.toThrow(/tailscaled is required/);
  });

  it('checks for tailscaled during flag-driven Tailscale server setup', async () => {
    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'tailscale-ssh',
          allowedDir: [root],
          interactive: false,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        {
          platform: 'linux',
          run: (bin) => {
            if (bin === 'tailscaled') return Promise.reject(new BinaryNotFoundError(bin));
            return Promise.resolve(okResult());
          },
        },
      ),
    ).rejects.toThrow(/tailscaled is required/);
  });

  it('provisions a dedicated macOS account for an interactive Tailscale server', async () => {
    const prompt = new FakePrompter({}, {}, [true, true, false], {
      'Which CLI tools should this server run?': ['claude-code', 'codex'],
    });
    const privileged: Array<{ bin: string; args: string[] }> = [];
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') };

    await setupAction(
      {
        role: 'server',
        transport: 'tailscale-ssh',
        allowedDir: [root],
        interactive: true,
        env,
        home: root,
      },
      io,
      {
        prompt,
        platform: 'darwin',
        username: 'alice',
        nodePath: '/opt/homebrew/bin/node',
        cliPath: '/opt/homebrew/lib/node_modules/talaria/dist/cli.js',
        builtinToolBins: {
          'claude-code': '/opt/homebrew/bin/claude',
          codex: '/opt/homebrew/bin/codex',
        },
        run: (bin, args) => {
          if (bin === '/usr/bin/dscl' && args.includes('-list')) {
            return Promise.resolve(okResult('alice 501\n'));
          }
          if (bin === '/usr/bin/dscl' || bin === '/usr/sbin/dseditgroup') {
            return Promise.resolve({ ...okResult(), code: 1 });
          }
          return Promise.resolve(okResult());
        },
        runInteractive: (bin, args) => {
          privileged.push({ bin, args });
          return Promise.resolve(0);
        },
      },
    );

    expect(existsSync(path.join(root, 'config', 'talaria', 'server.json'))).toBe(false);
    expect(
      privileged.some(
        ({ args }) =>
          args[0] === '/usr/bin/install' &&
          args.at(-1) === '/Users/talaria/.config/talaria/server.json',
      ),
    ).toBe(true);
    expect(err.join('\n')).toContain('provisioned isolated talaria service account');
    expect(err.join('\n')).toContain('"users": ["talaria"]');
  });

  it('recommends and switches to Tailscale transport when Tailscale SSH is enabled', async () => {
    const prompt = new FakePrompter({}, {}, [true], {
      'Which CLI tools should this server run?': ['claude-code', 'codex'],
    });

    await setupAction(
      {
        role: 'server',
        transport: 'openssh',
        allowedDir: [root],
        interactive: true,
        env: { XDG_CONFIG_HOME: path.join(root, 'config') },
        home: root,
      },
      io,
      {
        prompt,
        builtinToolBins: {
          'claude-code': '/opt/homebrew/bin/claude',
          codex: '/opt/homebrew/bin/codex',
        },
        run: (bin, args) =>
          Promise.resolve(
            bin === 'tailscale' && args[0] === 'debug'
              ? okResult(JSON.stringify({ RunSSH: true }))
              : okResult(),
          ),
      },
    );

    expect(err.join('\n')).toContain('Tailscale SSH is already enabled');
    expect(err.join('\n')).toContain('bypasses OpenSSH authorized_keys');
    expect(err.join('\n')).toContain('switched setup to Tailscale SSH');
    expect(existsSync(path.join(root, '.ssh', 'authorized_keys'))).toBe(false);
  });

  it('stops OpenSSH setup without disabling intentional Tailscale SSH', async () => {
    const prompt = new FakePrompter({}, {}, [false]);

    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'openssh',
          allowedDir: [root],
          interactive: true,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        {
          prompt,
          run: () => Promise.resolve(okResult(JSON.stringify({ RunSSH: true }))),
        },
      ),
    ).rejects.toThrow(/first run `tailscale set --ssh=false`/);
    expect(err.join('\n')).toContain('use that transport instead');
  });

  it('checks the Tailscale SSH conflict during flag-driven OpenSSH setup', async () => {
    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'openssh',
          allowedDir: [root],
          interactive: false,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        {
          run: (bin, args) =>
            Promise.resolve(
              bin === 'tailscale' && args[0] === 'debug'
                ? okResult(JSON.stringify({ RunSSH: true }))
                : okResult(),
            ),
        },
      ),
    ).rejects.toThrow(/Use `--transport tailscale-ssh`/);
  });

  it('requires approval for a flag-driven macOS Tailscale server setup', async () => {
    await expect(
      setupAction(
        {
          role: 'server',
          transport: 'tailscale-ssh',
          tool: ['claude-code', 'codex'],
          allowedDir: [root],
          interactive: false,
          env: { XDG_CONFIG_HOME: path.join(root, 'config') },
          home: root,
        },
        io,
        {
          platform: 'darwin',
          nodePath: '/opt/homebrew/bin/node',
          cliPath: '/opt/talaria/dist/cli.js',
          builtinToolBins: {
            'claude-code': '/opt/homebrew/bin/claude',
            codex: '/opt/homebrew/bin/codex',
          },
          run: () => Promise.resolve(okResult()),
        },
      ),
    ).rejects.toThrow(/requires an interactive run/);
  });

  it('enables macOS Remote Login and installs the prompted controller key', async () => {
    const key = 'ssh-ed25519 AAAAPUB controller';
    const prompt = new FakePrompter({}, {}, [true, true], {
      'Which CLI tools should this server run?': ['claude-code', 'codex'],
    });
    const privileged: Array<{ bin: string; args: string[] }> = [];

    await setupAction(
      {
        role: 'server',
        transport: 'openssh',
        publicKey: key,
        allowedDir: [root],
        interactive: true,
        env: { XDG_CONFIG_HOME: path.join(root, 'config') },
        home: root,
      },
      io,
      {
        prompt,
        platform: 'darwin',
        nodePath: '/opt/node/bin/node',
        cliPath: '/opt/talaria/dist/cli.js',
        builtinToolBins: {
          'claude-code': '/tools/claude/bin/claude',
          codex: '/tools/codex/bin/codex',
        },
        run: () => Promise.resolve(okResult()),
        runInteractive: (bin, args) => {
          privileged.push({ bin, args });
          return Promise.resolve(0);
        },
      },
    );

    expect(privileged).toEqual([
      { bin: 'sudo', args: ['/usr/sbin/systemsetup', '-setremotelogin', 'on'] },
    ]);
    expect(readFileSync(path.join(root, '.ssh', 'authorized_keys'), 'utf8')).toBe(
      buildAuthorizedKeysLine(
        key,
        buildTalariaForcedCommand({
          nodePath: '/opt/node/bin/node',
          cliPath: '/opt/talaria/dist/cli.js',
          serviceExecutablePath:
            '/tools/claude/bin:/tools/codex/bin:/opt/node/bin:/opt/talaria/dist:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        }),
      ) + '\n',
    );
  });
});
