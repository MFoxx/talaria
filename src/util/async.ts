/**
 * Small async primitives used by the server loop and transport.
 */

import type { Readable } from 'node:stream';
import { splitLines } from '../protocol/framing.js';

/** A promise plus its resolve/reject handles. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield complete newline-delimited lines from a readable stream as they arrive,
 * carrying any trailing partial line across chunks. A final unterminated line is
 * yielded when the stream ends.
 */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  let buffer = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buffer += chunk as string;
    const { lines, rest } = splitLines(buffer);
    buffer = rest;
    for (const line of lines) yield line;
  }
  const trailing = buffer.trim();
  if (trailing.length > 0) yield trailing;
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
