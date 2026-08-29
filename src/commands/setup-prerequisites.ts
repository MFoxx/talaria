/** Transport selection and binary checks shared by interactive and flag-driven setup. */

import type { TransportKind } from '../config/client-config.js';
import { BinaryNotFoundError, runCommand } from '../util/exec.js';
import type { Io } from './actions.js';
import type { SetupPrompter } from './setup-prompts.js';

type CommandRunner = typeof runCommand;

export async function binaryAvailable(
  bin: string,
  args: string[],
  run: CommandRunner,
): Promise<boolean> {
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

export interface ResolveTransportOptions {
  requested: TransportKind;
  configureServer: boolean;
  prompt?: SetupPrompter;
  run: CommandRunner;
  io: Io;
}

export interface ResolvedTransport {
  transport: TransportKind;
  tailscaleSshAlreadyEnabled: boolean;
}

/** Resolve the OpenSSH/Tailscale conflict without ever disabling Tailscale implicitly. */
export async function resolveSetupTransport(
  options: ResolveTransportOptions,
): Promise<ResolvedTransport> {
  if (!options.configureServer || options.requested !== 'openssh') {
    return { transport: options.requested, tailscaleSshAlreadyEnabled: false };
  }
  const enabled = (await isTailscaleSshEnabled(options.run)) === true;
  if (!enabled) return { transport: options.requested, tailscaleSshAlreadyEnabled: false };

  options.io.errLine('');
  options.io.errLine('  ⚠ Tailscale SSH is already enabled on this server.');
  options.io.errLine(
    '    It intercepts SSH connections on the tailnet and bypasses OpenSSH authorized_keys,',
  );
  options.io.errLine("    so Talaria's forced command and key restrictions will not be applied.");
  options.io.errLine(
    '    Keeping Tailscale SSH is usually intentional; use that transport instead.',
  );
  if (
    options.prompt &&
    (await options.prompt.confirm('Switch this setup to Tailscale SSH?', true))
  ) {
    options.io.errLine('  ✓ switched setup to Tailscale SSH');
    return { transport: 'tailscale-ssh', tailscaleSshAlreadyEnabled: true };
  }
  throw new Error(
    'OpenSSH setup cannot continue while Tailscale SSH is enabled. Use `--transport tailscale-ssh`, or first run `tailscale set --ssh=false`.',
  );
}

export interface CheckPrerequisitesOptions {
  transport: TransportKind;
  configureClient: boolean;
  configureServer: boolean;
  run: CommandRunner;
  io: Io;
}

/** Check every transport dependency regardless of whether setup is prompting. */
export async function checkSetupPrerequisites(options: CheckPrerequisitesOptions): Promise<void> {
  const { transport, configureClient, configureServer, run, io } = options;
  if (transport === 'tailscale-ssh') {
    if (!(await binaryAvailable('tailscale', ['version'], run))) {
      throw new Error(
        'Tailscale CLI is not installed. Install the standalone CLI build, then run setup again.',
      );
    }
    io.errLine('  ✓ tailscale CLI found');
    if (configureClient) {
      const wrapper = await run('tailscale', ['ssh', '--help']);
      if (wrapper.code !== 0) {
        throw new Error(
          "`tailscale ssh` is unavailable. On macOS, install Tailscale's standalone build instead of the App Store build.",
        );
      }
      io.errLine('  ✓ tailscale ssh wrapper found');
    }
    if (configureServer) {
      if (!(await binaryAvailable('tailscaled', ['--version'], run))) {
        throw new Error(
          'tailscaled is required on a Tailscale SSH server but was not found in PATH',
        );
      }
      io.errLine('  ✓ tailscaled found');
    }
    return;
  }

  if (configureClient) {
    for (const binary of ['ssh', 'ssh-keygen']) {
      if (!(await binaryAvailable(binary, ['-V'], run))) {
        throw new Error(`${binary} is required for the OpenSSH client setup`);
      }
      io.errLine(`  ✓ ${binary} found`);
    }
  }
}
