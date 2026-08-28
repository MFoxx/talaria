/**
 * tmux-backed process manager (ARCHITECTURE §4.3, §12).
 *
 * This is the persistence backend: the tool runs inside a detached tmux session that
 * survives the SSH connection dropping. Output is captured via `pipe-pane` into a raw
 * scratch file, which we tail and forward through `onChunk`; the runner frames those
 * chunks into the session's `output.log`. Exit status is recovered with
 * `remain-on-exit` + `#{pane_dead_status}`.
 *
 * Verified command sequence (tmux 3.x):
 *   tmux -f <conf> -S <sock> new-session -d -s <name> -x.. -y.. -c <cwd> [-e K=V ...] -- <bin> <args...>
 *   pipe-pane   -o -t <name> "cat >> '<raw>'"            (streaming, best-effort)
 *   display-message -p -t <name> '#{pane_dead}|#{pane_dead_status}|#{pane_pid}'
 *   capture-pane -p -t <name> -S -                       (backfill if nothing streamed)
 *
 * `remain-on-exit on` is set globally via the `-f <conf>` file so the pane stays readable
 * after the tool exits even for instant-exit tools — otherwise the session would vanish
 * before we could read its exit status. `pipe-pane` streams output live for long-running
 * tools; if it attached too late to capture anything (a very fast tool), we backfill from
 * `capture-pane` once the pane is dead.
 *
 * The command after `--` is passed as separate argv words, so tmux execs the tool
 * directly (no `sh -c`) — the injection defense (§6.3) holds through tmux.
 *
 * The argv builders below are pure and unit-tested; the orchestration is covered by a
 * real-tmux integration test that skips when tmux is unavailable.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinaryNotFoundError, runCommand } from '../util/exec.js';
import type { ExitResult, ProcessManager, StartHandle, StartOptions } from './process-manager.js';
import type { StreamName } from '../protocol/messages.js';
import type { SessionStore } from './session-store.js';
import { delay } from '../util/async.js';

// Default pane geometry — wide enough to avoid tmux hard-wrapping tool output.
const PANE_WIDTH = 220;
const PANE_HEIGHT = 50;

/**
 * `new-session -d -s <name> -x.. -y.. -c <cwd> [-e K=V ...] -- <bin> <args...>`
 * The command words after `--` are separate arguments, so tmux runs the tool directly.
 */
export function buildNewSessionArgv(opts: {
  tmuxSession: string;
  cwd: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  width?: number;
  height?: number;
}): string[] {
  const argv = [
    'new-session',
    '-d',
    '-s',
    opts.tmuxSession,
    '-x',
    String(opts.width ?? PANE_WIDTH),
    '-y',
    String(opts.height ?? PANE_HEIGHT),
    '-c',
    opts.cwd,
  ];
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    argv.push('-e', `${key}=${value}`);
  }
  argv.push('--', opts.bin, ...opts.args);
  return argv;
}

/** `has-session -t <name>`. */
export function buildHasSessionArgv(tmuxSession: string): string[] {
  return ['has-session', '-t', tmuxSession];
}

/** `kill-session -t <name>`. */
export function buildKillSessionArgv(tmuxSession: string): string[] {
  return ['kill-session', '-t', tmuxSession];
}

/** `capture-pane -p -t <name> -S -` — dump the whole pane (incl. history) after exit. */
export function buildCapturePaneArgv(tmuxSession: string): string[] {
  return ['capture-pane', '-p', '-t', tmuxSession, '-S', '-'];
}

/**
 * Strip tmux's trailing `Pane is dead (...)` banner (added by remain-on-exit) and trailing
 * blank lines from a `capture-pane` dump. Returns '' when nothing meaningful remains.
 */
export function cleanCapture(text: string): string {
  const kept = text.split('\n').filter((l) => !/^Pane is dead \(/.test(l));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  return kept.length > 0 ? kept.join('\n') + '\n' : '';
}

/**
 * `pipe-pane -o -t <name> "cat >> '<logPath>'"`. pipe-pane runs its command through the
 * shell, so the server-generated log path is single-quote wrapped defensively.
 */
export function buildPipePaneArgv(tmuxSession: string, rawPath: string): string[] {
  const quoted = `'${rawPath.replace(/'/g, `'\\''`)}'`;
  return ['pipe-pane', '-o', '-t', tmuxSession, `cat >> ${quoted}`];
}

/** `display-message -p -t <name> '<format>'`. */
export function buildDisplayMessageArgv(tmuxSession: string, format: string): string[] {
  return ['display-message', '-p', '-t', tmuxSession, format];
}

/** Function that runs a tmux command (minus the socket prefix) and returns its output. */
export type TmuxRun = (argv: string[]) => Promise<{ code: number | null; stdout: string }>;

/** Whether a tmux binary is present and runnable. */
export async function isTmuxAvailable(bin = 'tmux'): Promise<boolean> {
  try {
    const result = await runCommand(bin, ['-V']);
    return result.code === 0;
  } catch (err) {
    if (err instanceof BinaryNotFoundError) return false;
    throw err;
  }
}

export interface TmuxProcessManagerOptions {
  /** tmux binary (default `tmux`). */
  bin?: string;
  /** Dedicated control socket, isolating talaria sessions from the user's tmux. */
  socketPath?: string;
  /** Exit-detection poll interval (ms). */
  pollMs?: number;
  /** Raw-output tail interval (ms). */
  tailPollMs?: number;
  /** Injectable tmux runner (tests). */
  run?: TmuxRun;
}

/**
 * Runs tool sessions inside detached tmux sessions. Because a pty merges the tool's
 * stdout and stderr into one stream, all forwarded chunks are reported as `stdout`.
 */
export class TmuxProcessManager implements ProcessManager {
  private readonly bin: string;
  private readonly globalArgs: string[];
  private readonly confPath: string;
  private confWritten = false;
  private readonly pollMs: number;
  private readonly tailPollMs: number;
  private readonly run: TmuxRun;

  constructor(
    private readonly store: SessionStore,
    options: TmuxProcessManagerOptions = {},
  ) {
    this.bin = options.bin ?? 'tmux';
    const socketArgs = options.socketPath ? ['-S', options.socketPath] : [];
    // remain-on-exit must be on before the tool exits, so set it globally via a config
    // file passed at server creation (`-f`). Keep it beside the socket when we have one.
    this.confPath = options.socketPath
      ? path.join(path.dirname(options.socketPath), 'talaria-tmux.conf')
      : path.join(os.tmpdir(), 'talaria-tmux.conf');
    this.globalArgs = ['-f', this.confPath, ...socketArgs];
    this.pollMs = options.pollMs ?? 400;
    this.tailPollMs = options.tailPollMs ?? 150;
    this.run =
      options.run ??
      (async (argv) => {
        const result = await runCommand(this.bin, [...this.globalArgs, ...argv]);
        return { code: result.code, stdout: result.stdout };
      });
  }

  private ensureConf(): void {
    if (this.confWritten) return;
    mkdirSync(path.dirname(this.confPath), { recursive: true });
    writeFileSync(this.confPath, 'set -g remain-on-exit on\n');
    this.confWritten = true;
  }

  async start(options: StartOptions): Promise<StartHandle> {
    const { sessionId, tmuxSession, cwd, bin, args, env, onChunk, onExit } = options;
    this.ensureConf();
    const rawPath = this.store.rawOutputPath(sessionId);
    writeFileSync(rawPath, ''); // truncate/create the scratch capture file

    await this.expect(
      buildNewSessionArgv({ tmuxSession, cwd, bin, args, ...(env ? { env } : {}) }),
      'new-session',
    );
    // Streaming capture — best-effort. A tool that exits before pipe-pane attaches is
    // recovered from capture-pane on exit instead.
    await this.run(buildPipePaneArgv(tmuxSession, rawPath));

    const panePid = await this.readNumber(tmuxSession, '#{pane_pid}');

    const tail = this.startTail(rawPath, onChunk);
    void this.watch(tmuxSession, tail, onChunk, onExit);

    return { pid: panePid };
  }

  async signal(tmuxSession: string, signal: NodeJS.Signals): Promise<void> {
    if (signal === 'SIGKILL') {
      await this.run(buildKillSessionArgv(tmuxSession)).catch(() => undefined);
      return;
    }
    const pid = await this.readNumber(tmuxSession, '#{pane_pid}');
    if (pid !== null) {
      try {
        process.kill(pid, signal);
      } catch {
        // Process already gone — nothing to signal.
      }
    }
  }

  async isAlive(tmuxSession: string): Promise<boolean> {
    const result = await this.run(buildHasSessionArgv(tmuxSession)).catch(() => null);
    if (result?.code !== 0) return false;
    const dead = await this.readField(tmuxSession, '#{pane_dead}');
    return dead !== '1';
  }

  /** Run a tmux command and throw if it failed. */
  private async expect(argv: string[], label: string): Promise<void> {
    const result = await this.run(argv);
    if (result.code !== 0) {
      throw new Error(`tmux ${label} failed (exit ${result.code})`);
    }
  }

  /** Read a single format field via display-message; null if the session is gone. */
  private async readField(tmuxSession: string, format: string): Promise<string | null> {
    const result = await this.run(buildDisplayMessageArgv(tmuxSession, format)).catch(() => null);
    if (!result || result.code !== 0) return null;
    return result.stdout.trim();
  }

  private async readNumber(tmuxSession: string, format: string): Promise<number | null> {
    const value = await this.readField(tmuxSession, format);
    if (value === null || value === '') return null;
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }

  /** Poll for the pane to die (or the session to vanish), then report exit. */
  private async watch(
    tmuxSession: string,
    tail: Tailer,
    onChunk: (stream: StreamName, data: string) => void,
    onExit: (r: ExitResult) => void,
  ): Promise<void> {
    for (;;) {
      await delay(this.pollMs);
      const info = await this.readField(tmuxSession, '#{pane_dead}|#{pane_dead_status}');

      if (info === null) {
        // Session vanished (e.g. killed) — exit status is unrecoverable.
        tail.flush();
        tail.stop();
        onExit({ code: null, signal: null });
        return;
      }

      const [dead, status] = info.split('|');
      if (dead === '1') {
        tail.flush();
        tail.stop();
        // If pipe-pane never captured anything (a very fast tool), backfill the output
        // from the dead pane's contents so it isn't lost.
        if (tail.forwarded === 0) {
          const dump = await this.run(buildCapturePaneArgv(tmuxSession)).catch(() => null);
          const cleaned = dump && dump.code === 0 ? cleanCapture(dump.stdout) : '';
          if (cleaned.length > 0) onChunk('stdout', cleaned);
        }
        const code = status && status !== '' ? Number.parseInt(status, 10) : NaN;
        onExit({ code: Number.isNaN(code) ? null : code, signal: null });
        await this.run(buildKillSessionArgv(tmuxSession)).catch(() => undefined);
        return;
      }
    }
  }

  /** Begin tailing the raw capture file, forwarding new bytes to `onChunk`. */
  private startTail(rawPath: string, onChunk: StartOptions['onChunk']): Tailer {
    return new Tailer(rawPath, this.tailPollMs, (data) => onChunk('stdout', data));
  }
}

/** Polls a growing file and forwards newly appended bytes. */
class Tailer {
  private offset = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly path: string,
    intervalMs: number,
    private readonly onData: (data: string) => void,
  ) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Total bytes forwarded so far. */
  get forwarded(): number {
    return this.offset;
  }

  /** Read and forward any bytes appended since the last read. */
  flush(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return;
      const len = size - this.offset;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, this.offset);
      this.offset = size;
      this.onData(buf.toString('utf8'));
    } finally {
      closeSync(fd);
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
