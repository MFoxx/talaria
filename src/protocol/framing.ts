/**
 * Two framings live here (ARCHITECTURE §4.4, §5):
 *
 *  1. Protocol JSONL — one JSON object per line, exchanged over SSH stdin/stdout.
 *  2. Output-log frames — the `{ts,s,d}` records appended to a session's `output.log`,
 *     addressable by byte offset so a client can resume exactly where it left off.
 *
 * Everything here is pure and binary-safe: offsets are computed from UTF-8 byte
 * lengths, never string `.length`, so multi-byte tool output still seeks correctly.
 */

import { z } from 'zod';
import { StreamName } from './messages.js';
import { TalariaError } from './errors.js';

// ---------------------------------------------------------------------------
// Protocol JSONL
// ---------------------------------------------------------------------------

/** Serialize a value to a single newline-terminated JSON line. */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

/**
 * Parse one JSONL line into an unknown value. Throws `INVALID_REQUEST` on malformed
 * JSON; schema validation of the shape is a separate step (see `parseRequest`).
 */
export function decodeLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new TalariaError('INVALID_REQUEST', 'Malformed JSON line', { cause });
  }
}

/**
 * Split a running buffer of bytes into complete lines. Returns the parsed lines and
 * any trailing partial line (no terminating `\n` yet) for the caller to carry over.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.length > 0), rest };
}

// ---------------------------------------------------------------------------
// Output-log frames
// ---------------------------------------------------------------------------

/** A single append-only record in a session's `output.log`. */
export const OutputFrame = z.strictObject({
  /** Unix epoch milliseconds when the chunk was captured. */
  ts: z.number().int().nonnegative(),
  /** Source stream. */
  s: StreamName,
  /** Raw chunk content (may be a partial line). */
  d: z.string(),
});
export type OutputFrame = z.infer<typeof OutputFrame>;

/**
 * Encode an output frame to its exact on-disk bytes (UTF-8, newline-terminated).
 * The returned buffer's `length` is the number of bytes the log grows by, which the
 * session store adds to the running offset.
 */
export function encodeFrame(stream: StreamName, data: string, ts: number = Date.now()): Buffer {
  const frame: OutputFrame = { ts, s: stream, d: data };
  return Buffer.from(JSON.stringify(frame) + '\n', 'utf8');
}

/** Byte length a frame will occupy on disk without materializing the buffer twice. */
export function frameByteLength(stream: StreamName, data: string, ts: number = Date.now()): number {
  return encodeFrame(stream, data, ts).length;
}

/** Parse a single output-log line into a validated {@link OutputFrame}. */
export function decodeFrame(line: string): OutputFrame {
  const result = OutputFrame.safeParse(decodeLine(line));
  if (!result.success) {
    throw new TalariaError('INTERNAL', 'Corrupt output-log frame', { cause: result.error });
  }
  return result.data;
}

/**
 * Decode a chunk of `output.log` text into frames. Ignores a trailing partial line so
 * a half-written frame at the tail of the log is never surfaced as corrupt.
 */
export function decodeFrames(text: string): OutputFrame[] {
  const { lines } = splitLines(text);
  return lines.map(decodeFrame);
}
