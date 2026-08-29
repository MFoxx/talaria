/**
 * Client transport (ARCHITECTURE §10).
 *
 * One SSH connection per command: spawn either OpenSSH or `tailscale ssh`, invoke
 * `talaria serve`, write one JSONL request to stdin, and stream JSONL responses back.
 * No SSH library — just `child_process.spawn` (§10).
 *
 * The transport is built around an injectable {@link Connector} so the same request/parse
 * logic can be driven either over real SSH or, in tests, over in-process pipes wired
 * straight to the server's connection handler.
 */

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { TalariaError, toTalariaError } from '../protocol/errors.js';
import { decodeLine } from '../protocol/framing.js';
import { encodeLine } from '../protocol/framing.js';
import { parseResponse, type Request, type Response } from '../protocol/messages.js';
import { readLines } from '../util/async.js';

/** A bidirectional byte channel to one server invocation. */
export interface Channel {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  /** Human-readable executable name for connection errors. */
  label?: string;
  /** Resolves when the underlying process exits. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Opens a fresh channel (one SSH connection). */
export type Connector = () => Channel;

/** Traditional OpenSSH connection parameters. */
export interface OpenSshTarget {
  transport?: 'openssh';
  tailscaleHost: string;
  sshUser: string;
  sshKey: string;
  sshOptions?: string[];
}

/** Tailscale SSH connection parameters. Authentication comes from the tailnet identity. */
export interface TailscaleSshTarget {
  transport: 'tailscale-ssh';
  tailscaleHost: string;
  sshUser: string;
  /** Exact remote command; useful when `talaria` is not on the non-interactive PATH. */
  serverCommand?: string;
}

export type RemoteTarget = OpenSshTarget | TailscaleSshTarget;

/** Backward-compatible name for the original OpenSSH target interface. */
export type SshTarget = OpenSshTarget;

/** The command requested on the remote SSH server. */
export const REMOTE_COMMAND = 'talaria serve';

/**
 * Build the argv for `ssh`. BatchMode disables interactive prompts so a bad key fails
 * fast instead of hanging.
 */
export function buildSshArgs(target: OpenSshTarget, remoteCommand = REMOTE_COMMAND): string[] {
  return [
    '-i',
    target.sshKey,
    '-o',
    'BatchMode=yes',
    ...(target.sshOptions ?? []),
    `${target.sshUser}@${target.tailscaleHost}`,
    remoteCommand,
  ];
}

/** Build argv for Tailscale's optional wrapper around the system SSH client. */
export function buildTailscaleSshArgs(
  target: TailscaleSshTarget,
  remoteCommand = target.serverCommand ?? REMOTE_COMMAND,
): string[] {
  return ['ssh', `${target.sshUser}@${target.tailscaleHost}`, remoteCommand];
}

function spawnConnector(bin: string, args: string[]): Connector {
  return () => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      };
      child.once('error', () => finish(127, null));
      child.once('exit', finish);
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      label: bin,
      exit,
    };
  };
}

/** A {@link Connector} that opens a real SSH connection. */
export function sshConnector(target: OpenSshTarget, sshBinary = 'ssh'): Connector {
  return spawnConnector(sshBinary, buildSshArgs(target));
}

/** A {@link Connector} that delegates authentication and host keys to Tailscale SSH. */
export function tailscaleSshConnector(
  target: TailscaleSshTarget,
  tailscaleBinary = 'tailscale',
): Connector {
  return spawnConnector(tailscaleBinary, buildTailscaleSshArgs(target));
}

/** Select the concrete SSH adapter at the transport seam. */
export function remoteConnector(target: RemoteTarget): Connector {
  return target.transport === 'tailscale-ssh'
    ? tailscaleSshConnector(target)
    : sshConnector(target);
}

export class Transport {
  constructor(private readonly connector: Connector) {}

  /**
   * Send one request and stream the response messages. If the connection produces no
   * messages, throws a transport error carrying its exit status and stderr. Some SSH
   * wrappers do not propagate a failed remote command's exit status, so stderr must not
   * be discarded when the local wrapper exits zero.
   */
  async *send(request: Request): AsyncGenerator<Response> {
    const channel = this.connector();

    let stderr = '';
    channel.stderr?.setEncoding('utf8');
    channel.stderr?.on('data', (d: string) => (stderr += d));

    channel.stdin.write(encodeLine(request));
    channel.stdin.end();

    let count = 0;
    try {
      for await (const line of readLines(channel.stdout)) {
        count += 1;
        yield parseResponse(decodeLine(line));
      }
    } catch (err) {
      throw toTalariaError(err);
    }

    const { code } = await channel.exit;
    if (count === 0) {
      const label = channel.label ?? 'ssh';
      throw new TalariaError(
        'INTERNAL',
        `Connection produced no protocol response (${label} exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
    }
  }
}
