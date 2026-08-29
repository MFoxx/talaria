/**
 * Programmatic client API (ARCHITECTURE §10).
 *
 * Streaming methods (`run`, `attach`) return async iterables of protocol events; one-shot
 * methods return promises. Each call opens its own connection via the transport. A
 * protocol `error` message is raised as a {@link TalariaError} for one-shot calls and
 * yielded as an event for streaming calls (so callers can react per the spec's example).
 */

import { TalariaError } from '../protocol/errors.js';
import type {
  Request,
  Response,
  SessionStatusMessage,
  SessionSummary,
  ToolArgs,
  ToolInfo,
} from '../protocol/messages.js';
import {
  remoteConnector,
  tailscaleSshConnector,
  Transport,
  sshConnector,
  type Connector,
  type RemoteTarget,
  type SshTarget,
  type TailscaleSshTarget,
} from './transport.js';

export interface RunOptions {
  tool: string;
  dir: string;
  prompt: string;
  timeout?: number;
  toolArgs?: ToolArgs;
}

export interface AttachOptions {
  sessionId: string;
  offset?: number;
}

export class TalariaClient {
  private readonly transport: Transport;

  constructor(connector: Connector) {
    this.transport = new Transport(connector);
  }

  /** Build a client that talks to a host over SSH. */
  static overSsh(target: SshTarget, sshBinary?: string): TalariaClient {
    return new TalariaClient(sshConnector(target, sshBinary));
  }

  /** Build a client that authenticates through Tailscale SSH. */
  static overTailscaleSsh(target: TailscaleSshTarget, tailscaleBinary?: string): TalariaClient {
    return new TalariaClient(tailscaleSshConnector(target, tailscaleBinary));
  }

  /** Build a client using the transport selected by a resolved host config. */
  static overRemote(target: RemoteTarget): TalariaClient {
    return new TalariaClient(remoteConnector(target));
  }

  /** Start a new session and stream its events (`started`, `output…`, `done`/`error`). */
  run(options: RunOptions): AsyncGenerator<Response> {
    const request: Request = {
      type: 'run',
      tool: options.tool,
      dir: options.dir,
      prompt: options.prompt,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.toolArgs !== undefined ? { toolArgs: options.toolArgs } : {}),
    };
    return this.transport.send(request);
  }

  /** Reconnect to a session and stream its events (`attached`, `output…`, `done`/`error`). */
  attach(options: AttachOptions): AsyncGenerator<Response> {
    const request: Request = {
      type: 'attach',
      sessionId: options.sessionId,
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    };
    return this.transport.send(request);
  }

  /** List all sessions on the host. */
  async list(): Promise<SessionSummary[]> {
    const msg = await this.collect({ type: 'list' }, 'session_list');
    return msg.sessions;
  }

  /** Terminate a running session. */
  async kill(sessionId: string): Promise<void> {
    await this.collect({ type: 'kill', sessionId }, 'killed');
  }

  /** Detailed status of a single session. */
  status(sessionId: string): Promise<SessionStatusMessage> {
    return this.collect({ type: 'status', sessionId }, 'session_status');
  }

  /** Round-trip health check; resolves with the latency in milliseconds. */
  async ping(): Promise<number> {
    const start = Date.now();
    await this.collect({ type: 'ping' }, 'pong');
    return Date.now() - start;
  }

  /** Available tools on the host and their versions. */
  async tools(): Promise<ToolInfo[]> {
    const msg = await this.collect({ type: 'list-tools' }, 'tool_list');
    return msg.tools;
  }

  /**
   * Drive a one-shot request to completion, returning the message of the expected type.
   * Throws on a protocol `error` or if no matching message arrives.
   */
  private async collect<T extends Response['type']>(
    request: Request,
    expected: T,
  ): Promise<Extract<Response, { type: T }>> {
    for await (const msg of this.transport.send(request)) {
      if (msg.type === 'error') throw new TalariaError(msg.code, msg.message);
      if (msg.type === expected) return msg as Extract<Response, { type: T }>;
    }
    throw new TalariaError('INTERNAL', `Server did not return a ${expected} response`);
  }
}
