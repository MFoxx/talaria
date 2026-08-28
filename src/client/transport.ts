/**
 * Client transport (ARCHITECTURE §10).
 *
 * One SSH connection per command: spawn `ssh … talaria serve`, write a single JSONL
 * request to its stdin, and stream JSONL responses back from its stdout. No SSH library —
 * just `child_process.spawn` (§10).
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
  /** Resolves when the underlying process exits. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Opens a fresh channel (one SSH connection). */
export type Connector = () => Channel;

/** SSH connection parameters. */
export interface SshTarget {
  tailscaleHost: string;
  sshUser: string;
  sshKey: string;
  sshOptions?: string[];
}

/** The remote forced command; the server ignores the argument but we still pass it. */
export const REMOTE_COMMAND = 'talaria serve';

/**
 * Build the argv for `ssh`. BatchMode disables interactive prompts so a bad key fails
 * fast instead of hanging.
 */
export function buildSshArgs(target: SshTarget, remoteCommand = REMOTE_COMMAND): string[] {
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

/** A {@link Connector} that opens a real SSH connection. */
export function sshConnector(target: SshTarget, sshBinary = 'ssh'): Connector {
  return () => {
    const child = spawn(sshBinary, buildSshArgs(target), { stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exit: new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      }),
    };
  };
}

export class Transport {
  constructor(private readonly connector: Connector) {}

  /**
   * Send one request and stream the response messages. If the connection produces no
   * messages and exits non-zero, throws a transport error carrying stderr — this is how
   * an SSH/auth failure surfaces.
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
    if (count === 0 && code !== 0) {
      throw new TalariaError(
        'INTERNAL',
        `Connection failed (ssh exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
    }
  }
}
