/**
 * Request handlers (ARCHITECTURE §5).
 *
 * One handler per request type. `run` delegates to the {@link Runner}; the rest are
 * implemented here against the session store, registry, and process manager. Every
 * handler emits protocol messages through `emit` and either resolves or throws a
 * {@link TalariaError} (translated to an `error` message by the dispatcher).
 *
 * (The plan sketched a `handlers/` directory with a file per type; they are consolidated
 * here since each is small and they share one context object.)
 */

import type {
  AttachRequest,
  KillRequest,
  Response,
  SessionSummary,
  StatusRequest,
} from '../protocol/messages.js';
import { encodeFrame } from '../protocol/framing.js';
import { conversationIdFor, type SessionStore, type SessionMeta } from './session-store.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { ServerConfig } from '../config/server-config.js';
import type { ProcessManager } from './process-manager.js';
import type { Runner } from './runner.js';
import { KILL_GRACE_MS } from './runner.js';
import { nullLogger, type Logger } from '../util/logger.js';
import { decodeFrames } from '../protocol/framing.js';
import { delay } from '../util/async.js';

export interface HandlerContext {
  store: SessionStore;
  registry: AdapterRegistry;
  config: ServerConfig;
  runner: Runner;
  processManager: ProcessManager;
  logger?: Logger;
  now?: () => number;
  /** Poll interval for tailing a running session during attach. */
  tailPollMs?: number;
}

type Emit = (message: Response) => void;

/** Extra slack past a session's own lifetime before an attach tail treats it as orphaned. */
export const ATTACH_TAIL_MARGIN_MS = 10_000;

function durationFor(meta: SessionMeta, now: number): number {
  const start = Date.parse(meta.startedAt);
  const end = meta.endedAt ? Date.parse(meta.endedAt) : now;
  return Math.max(0, end - start);
}

/** `list` — summarize all sessions. */
export function handleList(ctx: HandlerContext, emit: Emit): void {
  const now = (ctx.now ?? Date.now)();
  const sessions: SessionSummary[] = ctx.store.list().map((meta) => ({
    sessionId: meta.sessionId,
    conversationId: conversationIdFor(meta),
    tool: meta.tool,
    dir: meta.dir,
    status: meta.status,
    startedAt: meta.startedAt,
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    durationMs: durationFor(meta, now),
    ...(meta.exitCode !== null ? { exitCode: meta.exitCode } : {}),
  }));
  emit({ type: 'session_list', sessions });
}

/** `status` — detailed status for one session. */
export function handleStatus(ctx: HandlerContext, req: StatusRequest, emit: Emit): void {
  const meta = ctx.store.readMeta(req.sessionId); // SESSION_NOT_FOUND
  emit({
    type: 'session_status',
    sessionId: meta.sessionId,
    conversationId: conversationIdFor(meta),
    tool: meta.tool,
    dir: meta.dir,
    prompt: meta.prompt,
    status: meta.status,
    pid: meta.pid,
    startedAt: meta.startedAt,
    outputBytes: ctx.store.outputSize(meta.sessionId),
    exitCode: meta.exitCode,
  });
}

/** `ping` — health check. */
export function handlePing(emit: Emit): void {
  emit({ type: 'pong' });
}

/** `list-tools` — available tools and versions. */
export async function handleListTools(ctx: HandlerContext, emit: Emit): Promise<void> {
  const tools = await ctx.registry.listWithAvailability();
  emit({ type: 'tool_list', tools });
}

/** `kill` — SIGTERM (then SIGKILL after a grace period); keep the log, mark `killed`. */
export function handleKill(ctx: HandlerContext, req: KillRequest, emit: Emit): void {
  const meta = ctx.store.readMeta(req.sessionId); // SESSION_NOT_FOUND
  const logger = ctx.logger ?? nullLogger;

  if (meta.status === 'running') {
    void ctx.processManager.signal(meta.tmuxSession, 'SIGTERM');
    setTimeout(() => void ctx.processManager.signal(meta.tmuxSession, 'SIGKILL'), KILL_GRACE_MS);
    ctx.store.updateMeta(req.sessionId, {
      status: 'killed',
      signal: 'SIGTERM',
      exitCode: null,
      endedAt: new Date((ctx.now ?? Date.now)()).toISOString(),
    });
    logger.info('session killed', { sessionId: req.sessionId });
  }

  emit({ type: 'killed', sessionId: req.sessionId });
}

/**
 * `attach` — replay output from an offset, then live-tail a running session until it
 * finishes (§4.3). `offset` undefined means "live tail only" (start at the current end);
 * `offset: 0` replays everything.
 */
export async function handleAttach(
  ctx: HandlerContext,
  req: AttachRequest,
  emit: Emit,
): Promise<void> {
  const meta = ctx.store.readMeta(req.sessionId); // SESSION_NOT_FOUND
  const pollMs = ctx.tailPollMs ?? 200;

  const startOffset = req.offset ?? ctx.store.outputSize(req.sessionId);
  const initial = ctx.store.readOutputFrom(req.sessionId, startOffset);

  emit({
    type: 'attached',
    sessionId: req.sessionId,
    conversationId: conversationIdFor(meta),
    status: meta.status,
    tool: meta.tool,
    dir: meta.dir,
    offsetFrom: startOffset,
    totalBytes: initial.totalBytes,
  });

  let cursor = emitSlice(startOffset, initial.data, emit);

  // If the session already finished, replay is complete — send the recorded `done`.
  if (meta.status !== 'running') {
    emitDoneFromMeta(meta, emit);
    return;
  }

  // Bound the live tail. A healthy session is force-stopped by the runner no later than
  // its own timeout plus the SIGTERM→SIGKILL grace, at which point meta reaches a
  // terminal status. If it's still `running` past that (plus a margin), the owning serve
  // process must have died without finalizing — an orphan we should stop tailing rather
  // than hold the connection open forever.
  const now = ctx.now ?? Date.now;
  const deadline =
    Date.parse(meta.startedAt) + meta.timeout * 1000 + KILL_GRACE_MS + ATTACH_TAIL_MARGIN_MS;

  for (;;) {
    await delay(pollMs);
    const slice = ctx.store.readOutputFrom(req.sessionId, cursor);
    if (slice.data.length > 0) cursor = emitSlice(cursor, slice.data, emit);

    const current = ctx.store.readMeta(req.sessionId);
    if (current.status !== 'running') {
      const tail = ctx.store.readOutputFrom(req.sessionId, cursor);
      if (tail.data.length > 0) cursor = emitSlice(cursor, tail.data, emit);
      emitDoneFromMeta(current, emit);
      return;
    }

    if (now() > deadline) {
      (ctx.logger ?? nullLogger).warn('attach tail exceeded session lifetime; session orphaned', {
        sessionId: req.sessionId,
      });
      emit({
        type: 'error',
        code: 'INTERNAL',
        message: `Session ${req.sessionId} is still marked running past its lifetime; it may be orphaned. Retry attach.`,
      });
      return;
    }
  }
}

/** Emit each whole frame in `data`, returning the byte offset after the last one. */
function emitSlice(startOffset: number, data: string, emit: Emit): number {
  let cursor = startOffset;
  for (const frame of decodeFrames(data)) {
    cursor += encodeFrame(frame.s, frame.d, frame.ts).length;
    emit({ type: 'output', stream: frame.s, data: frame.d, offset: cursor });
  }
  return cursor;
}

function emitDoneFromMeta(meta: SessionMeta, emit: Emit): void {
  emit({
    type: 'done',
    sessionId: meta.sessionId,
    conversationId: conversationIdFor(meta),
    exitCode: meta.exitCode,
    signal: meta.signal,
    durationMs: durationFor(meta, Date.now()),
    status: meta.status === 'running' ? 'completed' : meta.status,
  });
}
