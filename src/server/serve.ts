/**
 * The `talaria serve` connection loop (ARCHITECTURE §5).
 *
 * One request per connection: read exactly one JSONL line from stdin, dispatch it, and
 * stream responses to stdout. Stdout carries only protocol messages; stderr is reserved
 * for server-level panics. Any thrown {@link TalariaError} becomes a wire `error`.
 */

import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { toTalariaError } from '../protocol/errors.js';
import { encodeLine, decodeLine } from '../protocol/framing.js';
import { parseRequest, type Request, type Response } from '../protocol/messages.js';
import { SessionStore } from './session-store.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { DirectProcessManager, type ProcessManager } from './process-manager.js';
import { TmuxProcessManager, isTmuxAvailable } from './tmux.js';
import { Runner } from './runner.js';
import { reapExpiredSessions } from './reaper.js';
import { createLogger, nullLogger, type Logger } from '../util/logger.js';
import { readLines } from '../util/async.js';
import type { ServerConfig } from '../config/server-config.js';
import {
  handleAttach,
  handleKill,
  handleList,
  handleListTools,
  handlePing,
  handleStatus,
  type HandlerContext,
} from './handlers.js';

export interface BuildContextOverrides {
  processManager?: ProcessManager;
  logger?: Logger;
  now?: () => number;
  tailPollMs?: number;
}

/** Assemble the handler context (store, registry, runner, backend) from config. */
export function buildContext(
  config: ServerConfig,
  overrides: BuildContextOverrides = {},
): HandlerContext {
  const store = new SessionStore(config.sessionDir);
  const registry = AdapterRegistry.fromConfig(config);
  const processManager = overrides.processManager ?? new DirectProcessManager();
  const logger = overrides.logger ?? nullLogger;
  const runner = new Runner({
    store,
    registry,
    config,
    processManager,
    logger,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return {
    store,
    registry,
    config,
    runner,
    processManager,
    logger,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.tailPollMs !== undefined ? { tailPollMs: overrides.tailPollMs } : {}),
  };
}

/** Route a validated request to its handler. */
export async function dispatch(
  ctx: HandlerContext,
  req: Request,
  emit: (m: Response) => void,
): Promise<void> {
  switch (req.type) {
    case 'run':
      await ctx.runner.run(req, emit);
      return;
    case 'attach':
      await handleAttach(ctx, req, emit);
      return;
    case 'list':
      handleList(ctx, emit);
      return;
    case 'kill':
      handleKill(ctx, req, emit);
      return;
    case 'status':
      handleStatus(ctx, req, emit);
      return;
    case 'ping':
      handlePing(emit);
      return;
    case 'list-tools':
      await handleListTools(ctx, emit);
      return;
  }
}

/**
 * Handle a single connection end to end. Reads the first line from `input`, dispatches,
 * and writes responses to `output`. Never rejects — failures are emitted as `error`.
 */
export async function serveConnection(
  ctx: HandlerContext,
  input: Readable,
  output: Writable,
): Promise<void> {
  const emit = (message: Response): void => {
    output.write(encodeLine(message));
  };

  try {
    let firstLine: string | null = null;
    for await (const line of readLines(input)) {
      firstLine = line;
      break;
    }
    if (firstLine === null) {
      emit({ type: 'error', code: 'INVALID_REQUEST', message: 'Empty request' });
      return;
    }
    const req = parseRequest(decodeLine(firstLine));
    await dispatch(ctx, req, emit);
  } catch (err) {
    const e = toTalariaError(err);
    emit({ type: 'error', code: e.code, message: e.message });
  }
}

/**
 * Choose the persistence backend: tmux when available (sessions survive disconnects),
 * otherwise the direct backend with a warning. The tmux control socket is dedicated to
 * talaria so it never touches the user's own tmux server.
 */
export async function selectProcessManager(
  config: ServerConfig,
  logger: Logger,
): Promise<ProcessManager> {
  if (await isTmuxAvailable()) {
    const socketPath = path.join(path.dirname(config.sessionDir), 'tmux.sock');
    return new TmuxProcessManager(new SessionStore(config.sessionDir), { socketPath });
  }
  logger.warn('tmux not found; using direct backend (sessions will not survive disconnects)');
  return new DirectProcessManager();
}

/**
 * Production entry point for `talaria serve`: GC expired sessions, pick the backend, then
 * serve one connection over stdio.
 */
export async function runServe(config: ServerConfig): Promise<void> {
  const logger = createLogger({ level: config.logLevel, filePath: config.logFile });
  const store = new SessionStore(config.sessionDir);
  const { reaped } = reapExpiredSessions(store, config.sessionRetention);
  if (reaped.length > 0) logger.info('reaped sessions', { count: reaped.length });

  const processManager = await selectProcessManager(config, logger);
  const ctx = buildContext(config, { logger, processManager });
  await serveConnection(ctx, process.stdin, process.stdout);
}
