/**
 * Minimal leveled server logger (ARCHITECTURE §8.1 `logFile` / `logLevel`).
 *
 * Writes one JSON line per event to the configured log file. The protocol stream on
 * stdout must never be polluted by diagnostics, so this logger targets a file (or a
 * caller-supplied sink) — never stdout. Secrets (API keys live in the tool's env) are
 * never logged.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for a formatted line. Defaults to appending to `filePath`. */
  sink?: (line: string) => void;
  /** Log file path, used when no `sink` is given. */
  filePath?: string;
}

/** Create a logger. With neither `sink` nor `filePath`, logging is a no-op. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = RANK[level];

  let sink = options.sink;
  if (!sink && options.filePath) {
    const filePath = options.filePath;
    mkdirSync(path.dirname(filePath), { recursive: true });
    sink = (line) => appendFileSync(filePath, line + '\n');
  }

  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (!sink || RANK[lvl] < threshold) return;
    const record = { ts: new Date().toISOString(), level: lvl, message, ...fields };
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** A logger that discards everything — handy in tests. */
export const nullLogger: Logger = createLogger();
