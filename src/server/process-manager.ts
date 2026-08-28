/**
 * Process backend abstraction (ARCHITECTURE §4.3).
 *
 * The runner talks to sessions through this interface so the persistence backend can
 * vary. `DirectProcessManager` spawns the tool as a child of `talaria serve` — simple,
 * fully testable, and used for the current end-to-end path. The tmux-backed manager
 * (see {@link ./tmux.ts}) implements the same interface to add cross-disconnect
 * persistence.
 *
 * Every spawn uses an explicit argv array via `child_process.spawn` with no shell
 * (`shell: false`), upholding the injection defense (§6.3).
 */

import { spawn } from 'node:child_process';
import { TalariaError } from '../protocol/errors.js';
import type { StreamName } from '../protocol/messages.js';

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface StartOptions {
  sessionId: string;
  tmuxSession: string;
  cwd: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** Called for each output chunk as it arrives. */
  onChunk: (stream: StreamName, data: string) => void;
  /** Called once when the process exits. */
  onExit: (result: ExitResult) => void;
}

export interface StartHandle {
  pid: number | null;
}

export interface ProcessManager {
  start(options: StartOptions): Promise<StartHandle>;
  signal(tmuxSession: string, signal: NodeJS.Signals): Promise<void>;
  isAlive(tmuxSession: string): Promise<boolean>;
}

/**
 * Spawns the tool as a direct child process. Keeps stdout and stderr distinct (unlike a
 * pty), so output frames carry an accurate `stream` field. Does not survive the parent
 * exiting — persistence is the tmux backend's job.
 */
export class DirectProcessManager implements ProcessManager {
  private readonly children = new Map<string, ReturnType<typeof spawn>>();

  start(options: StartOptions): Promise<StartHandle> {
    const { tmuxSession, cwd, bin, args, env, onChunk, onExit } = options;
    const child = spawn(bin, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => onChunk('stdout', d));
    child.stderr?.on('data', (d: string) => onChunk('stderr', d));
    child.on('exit', (code, signal) => {
      this.children.delete(tmuxSession);
      onExit({ code, signal });
    });

    return new Promise((resolve, reject) => {
      let started = false;
      child.on('error', (err) => {
        this.children.delete(tmuxSession);
        if (started) {
          // Post-start failure: no 'exit' will fire, so synthesize a terminal result.
          onExit({ code: null, signal: null });
        } else {
          reject(
            new TalariaError('SPAWN_FAILED', `Failed to start ${bin}: ${err.message}`, {
              cause: err,
            }),
          );
        }
      });

      // A synchronous pid means the fork succeeded. When it's undefined (e.g. ENOENT),
      // the async 'error' event above rejects instead.
      if (child.pid !== undefined) {
        started = true;
        this.children.set(tmuxSession, child);
        resolve({ pid: child.pid });
      }
    });
  }

  signal(tmuxSession: string, signal: NodeJS.Signals): Promise<void> {
    const child = this.children.get(tmuxSession);
    if (child && child.exitCode === null) child.kill(signal);
    return Promise.resolve();
  }

  isAlive(tmuxSession: string): Promise<boolean> {
    const child = this.children.get(tmuxSession);
    return Promise.resolve(Boolean(child && child.exitCode === null && child.signalCode === null));
  }
}
