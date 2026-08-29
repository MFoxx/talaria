/**
 * Error taxonomy shared by client and server.
 *
 * Every failure that crosses the wire carries one of these codes (ARCHITECTURE §5.2).
 * Handlers translate thrown {@link TalariaError}s into `error` protocol messages; raw
 * stack traces never reach the client.
 */

export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNKNOWN_TOOL',
  'DIR_NOT_ALLOWED',
  'DIR_NOT_FOUND',
  'TOOL_NOT_FOUND',
  'SPAWN_FAILED',
  'TIMEOUT',
  'SESSION_NOT_FOUND',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_BUSY',
  'CONTINUATION_UNAVAILABLE',
  'CONTINUATION_UNSUPPORTED',
  'MAX_SESSIONS',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error with a wire-safe {@link ErrorCode}. */
export class TalariaError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TalariaError';
    this.code = code;
    // Restore prototype chain when compiled down to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** True when `value` is a {@link TalariaError}. */
export function isTalariaError(value: unknown): value is TalariaError {
  return value instanceof TalariaError;
}

/**
 * Coerce any thrown value into a {@link TalariaError}. Unknown errors become
 * `INTERNAL` so nothing leaks an uncoded failure onto the wire.
 */
export function toTalariaError(value: unknown): TalariaError {
  if (isTalariaError(value)) return value;
  if (value instanceof Error) {
    return new TalariaError('INTERNAL', value.message, { cause: value });
  }
  return new TalariaError('INTERNAL', String(value), { cause: value });
}
