/**
 * Thin promise wrapper over `child_process.execFile`.
 *
 * Every call passes an explicit argv array — there is no `sh -c` and no shell string
 * anywhere in talaria (ARCHITECTURE §6.3). This helper is used for short, bounded
 * commands like `tool --version` and tmux control operations, never for the tool
 * sessions themselves (those stream and are managed by the process manager).
 */

import { execFile } from 'node:child_process';

export interface RunResult {
  /** Exit code, or null if the process was terminated by a signal. */
  code: number | null;
  /** Terminating signal, if any. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the command after this many milliseconds (default 10s). */
  timeoutMs?: number;
  /** Cap captured output to guard against runaway commands (default 1 MiB). */
  maxBuffer?: number;
}

/** Raised when the binary itself could not be found (ENOENT). */
export class BinaryNotFoundError extends Error {
  constructor(readonly bin: string) {
    super(`Binary not found: ${bin}`);
    this.name = 'BinaryNotFoundError';
  }
}

/**
 * Run a command to completion, capturing stdout/stderr. Resolves even on a non-zero
 * exit (inspect `code`); rejects only when the process could not be spawned. A missing
 * binary rejects with {@link BinaryNotFoundError}.
 */
export function runCommand(
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { cwd, env, timeoutMs = 10_000, maxBuffer = 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new BinaryNotFoundError(bin));
            return;
          }
          // A non-zero exit surfaces here too; execFile attaches code/signal.
          const withExit = error as NodeJS.ErrnoException & {
            code?: number | string;
            signal?: NodeJS.Signals | null;
          };
          if (typeof withExit.code === 'number' || withExit.signal) {
            resolve({
              code: typeof withExit.code === 'number' ? withExit.code : null,
              signal: withExit.signal ?? null,
              stdout,
              stderr,
            });
            return;
          }
          // Neither ENOENT nor a normal exit/signal — surface as a plain Error.
          const message = error instanceof Error ? error.message : 'execFile failed';
          reject(new Error(message, { cause: error }));
          return;
        }
        resolve({ code: 0, signal: null, stdout, stderr });
      },
    );
  });
}
