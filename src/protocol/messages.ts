/**
 * Wire protocol: JSONL messages exchanged over SSH stdin/stdout (ARCHITECTURE §5).
 *
 * This module is the single source of truth for the wire format — both the client and
 * the server import these schemas so a malformed message is caught the same way on both
 * ends. Schemas are strict: unknown fields are rejected (§6.3).
 */

import { z } from 'zod';
import { ERROR_CODES, TalariaError } from './errors.js';

/** Terminal + live states a session can be in (§4.4). */
export const SessionStatus = z.enum(['running', 'completed', 'failed', 'killed', 'timeout']);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Which stream an output chunk came from. */
export const StreamName = z.enum(['stdout', 'stderr']);
export type StreamName = z.infer<typeof StreamName>;

/** Tool-specific arguments, validated per-adapter downstream (§7). */
export const ToolArgs = z.record(z.string(), z.unknown());
export type ToolArgs = z.infer<typeof ToolArgs>;

// ---------------------------------------------------------------------------
// Client → Server requests (§5.1)
// ---------------------------------------------------------------------------

export const RunRequest = z.strictObject({
  type: z.literal('run'),
  tool: z.string().min(1),
  dir: z.string().min(1),
  prompt: z.string(),
  timeout: z.number().int().positive().optional(),
  toolArgs: ToolArgs.optional(),
});

export const AttachRequest = z.strictObject({
  type: z.literal('attach'),
  sessionId: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
});

export const ListRequest = z.strictObject({
  type: z.literal('list'),
});

export const KillRequest = z.strictObject({
  type: z.literal('kill'),
  sessionId: z.string().min(1),
});

export const StatusRequest = z.strictObject({
  type: z.literal('status'),
  sessionId: z.string().min(1),
});

export const PingRequest = z.strictObject({
  type: z.literal('ping'),
});

export const ListToolsRequest = z.strictObject({
  type: z.literal('list-tools'),
});

export const Request = z.discriminatedUnion('type', [
  RunRequest,
  AttachRequest,
  ListRequest,
  KillRequest,
  StatusRequest,
  PingRequest,
  ListToolsRequest,
]);

export type RunRequest = z.infer<typeof RunRequest>;
export type AttachRequest = z.infer<typeof AttachRequest>;
export type ListRequest = z.infer<typeof ListRequest>;
export type KillRequest = z.infer<typeof KillRequest>;
export type StatusRequest = z.infer<typeof StatusRequest>;
export type PingRequest = z.infer<typeof PingRequest>;
export type ListToolsRequest = z.infer<typeof ListToolsRequest>;
export type Request = z.infer<typeof Request>;

// ---------------------------------------------------------------------------
// Server → Client responses (§5.2)
// ---------------------------------------------------------------------------

export const StartedMessage = z.strictObject({
  type: z.literal('started'),
  sessionId: z.string(),
  tool: z.string(),
  dir: z.string(),
  pid: z.number().int(),
  tmuxSession: z.string(),
});

export const AttachedMessage = z.strictObject({
  type: z.literal('attached'),
  sessionId: z.string(),
  status: SessionStatus,
  tool: z.string(),
  dir: z.string(),
  offsetFrom: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export const OutputMessage = z.strictObject({
  type: z.literal('output'),
  stream: StreamName,
  data: z.string(),
  offset: z.number().int().nonnegative(),
});

export const DoneMessage = z.strictObject({
  type: z.literal('done'),
  sessionId: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  status: SessionStatus,
});

export const SessionSummary = z.strictObject({
  sessionId: z.string(),
  tool: z.string(),
  dir: z.string(),
  status: SessionStatus,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionListMessage = z.strictObject({
  type: z.literal('session_list'),
  sessions: z.array(SessionSummary),
});

export const SessionStatusMessage = z.strictObject({
  type: z.literal('session_status'),
  sessionId: z.string(),
  tool: z.string(),
  dir: z.string(),
  prompt: z.string(),
  status: SessionStatus,
  pid: z.number().int().nullable(),
  startedAt: z.string(),
  outputBytes: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
});

export const KilledMessage = z.strictObject({
  type: z.literal('killed'),
  sessionId: z.string(),
});

export const PongMessage = z.strictObject({
  type: z.literal('pong'),
});

export const ToolInfo = z.strictObject({
  name: z.string(),
  available: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfo>;

export const ToolListMessage = z.strictObject({
  type: z.literal('tool_list'),
  tools: z.array(ToolInfo),
});

export const ErrorMessage = z.strictObject({
  type: z.literal('error'),
  code: z.enum(ERROR_CODES),
  message: z.string(),
});

export const Response = z.discriminatedUnion('type', [
  StartedMessage,
  AttachedMessage,
  OutputMessage,
  DoneMessage,
  SessionListMessage,
  SessionStatusMessage,
  KilledMessage,
  PongMessage,
  ToolListMessage,
  ErrorMessage,
]);

export type StartedMessage = z.infer<typeof StartedMessage>;
export type AttachedMessage = z.infer<typeof AttachedMessage>;
export type OutputMessage = z.infer<typeof OutputMessage>;
export type DoneMessage = z.infer<typeof DoneMessage>;
export type SessionListMessage = z.infer<typeof SessionListMessage>;
export type SessionStatusMessage = z.infer<typeof SessionStatusMessage>;
export type KilledMessage = z.infer<typeof KilledMessage>;
export type PongMessage = z.infer<typeof PongMessage>;
export type ToolListMessage = z.infer<typeof ToolListMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type Response = z.infer<typeof Response>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Validate an already-decoded value as a {@link Request}. Throws a
 * {@link TalariaError} with code `INVALID_REQUEST` on any schema failure, so the
 * server can reply with a wire-safe `error` message instead of crashing.
 */
export function parseRequest(value: unknown): Request {
  const result = Request.safeParse(value);
  if (!result.success) {
    throw new TalariaError('INVALID_REQUEST', z.prettifyError(result.error), {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Validate an already-decoded value as a {@link Response}. Throws a
 * {@link TalariaError} with code `INTERNAL` on failure — an invalid response means
 * the server produced something malformed, which is our bug, not the client's.
 */
export function parseResponse(value: unknown): Response {
  const result = Response.safeParse(value);
  if (!result.success) {
    throw new TalariaError('INTERNAL', z.prettifyError(result.error), { cause: result.error });
  }
  return result.data;
}
