/**
 * Session runner (ARCHITECTURE §4.3, §4.5).
 *
 * Orchestrates a `run`: validate → create session → spawn → stream framed output →
 * finalize. Validation (tool allowlist, directory whitelist, capacity) happens before
 * anything is spawned. Output is appended to the session log and emitted to the client
 * with the running byte offset so an `attach` can resume precisely.
 */

import { TalariaError } from '../protocol/errors.js';
import type { RunRequest, Response, StreamName } from '../protocol/messages.js';
import type { SessionMeta } from './session-store.js';
import type { SessionStore } from './session-store.js';
import type { ServerConfig } from '../config/server-config.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { ExitResult, ProcessManager } from './process-manager.js';
import { assertCapacity, resolveTimeout } from './limits.js';
import { validateDir } from './validate.js';
import { newSessionId, tmuxSessionName } from '../util/ids.js';
import { nullLogger, type Logger } from '../util/logger.js';
import { deferred } from '../util/async.js';

/** Grace period between SIGTERM and SIGKILL when a session is force-stopped. */
export const KILL_GRACE_MS = 5000;

export interface RunnerDeps {
  store: SessionStore;
  registry: AdapterRegistry;
  config: ServerConfig;
  processManager: ProcessManager;
  logger?: Logger;
  now?: () => number;
}

/** Emit a protocol message to the connected client. */
export type Emit = (message: Response) => void;

export class Runner {
  private readonly store: SessionStore;
  private readonly registry: AdapterRegistry;
  private readonly config: ServerConfig;
  private readonly pm: ProcessManager;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: RunnerDeps) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.config = deps.config;
    this.pm = deps.processManager;
    this.logger = deps.logger ?? nullLogger;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Validate and start a new session, streaming output via `emit`. Resolves when the
   * tool exits (a `done` message has been emitted). Rejects with a {@link TalariaError}
   * if validation fails before the session starts.
   */
  async run(req: RunRequest, emit: Emit): Promise<void> {
    const adapter = this.registry.get(req.tool); // UNKNOWN_TOOL
    const resolvedDir = validateDir(req.dir, this.config.allowedDirs); // DIR_NOT_ALLOWED / DIR_NOT_FOUND
    assertCapacity(this.store, this.config); // MAX_SESSIONS

    const timeout = resolveTimeout(req.timeout, this.config);
    const toolArgs = req.toolArgs ?? {};
    const spawnConfig = adapter.buildSpawn({
      dir: resolvedDir,
      prompt: req.prompt,
      timeout,
      toolArgs,
    });

    const sessionId = newSessionId();
    const tmuxSession = tmuxSessionName(sessionId);
    const startedAt = new Date(this.now()).toISOString();

    const meta: SessionMeta = {
      sessionId,
      tool: req.tool,
      dir: resolvedDir,
      prompt: req.prompt,
      toolArgs,
      tmuxSession,
      pid: null,
      startedAt,
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
      timeout,
    };
    this.store.create(meta);

    const startMs = this.now();
    const exited = deferred<void>();
    const timers: { timeout?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};
    let finished = false;
    let terminationStatus: SessionMeta['status'] | null = null;

    // Called once when the tool process exits (naturally or after a forced stop).
    const finalize = (exit: ExitResult): void => {
      if (finished) return;
      finished = true;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (timers.kill) clearTimeout(timers.kill);

      // A concurrent kill/timeout (possibly from another connection) may have already
      // written a terminal status; don't clobber it with a natural-exit verdict.
      const current = this.store.readMeta(sessionId);
      const terminalFromElsewhere = current.status !== 'running' ? current.status : null;
      const status: SessionMeta['status'] =
        terminationStatus ??
        terminalFromElsewhere ??
        (exit.code === 0 && exit.signal === null ? 'completed' : 'failed');

      this.store.updateMeta(sessionId, {
        status,
        exitCode: exit.code,
        signal: exit.signal,
        endedAt: new Date(this.now()).toISOString(),
      });

      emit({
        type: 'done',
        sessionId,
        exitCode: exit.code,
        signal: exit.signal,
        durationMs: this.now() - startMs,
        status,
      });
      exited.resolve();
    };

    const forceStop = (status: SessionMeta['status']): void => {
      if (finished || terminationStatus) return;
      terminationStatus = status;
      void this.pm.signal(tmuxSession, 'SIGTERM');
      timers.kill = setTimeout(() => void this.pm.signal(tmuxSession, 'SIGKILL'), KILL_GRACE_MS);
    };

    const onChunk = (stream: StreamName, data: string): void => {
      const offset = this.store.appendOutput(sessionId, stream, data);
      emit({ type: 'output', stream, data, offset });
      if (offset > this.config.maxOutputSize) {
        this.logger.warn('session exceeded maxOutputSize', { sessionId, offset });
        forceStop('failed');
      }
    };

    let handle;
    try {
      handle = await this.pm.start({
        sessionId,
        tmuxSession,
        cwd: resolvedDir,
        bin: spawnConfig.bin,
        args: spawnConfig.args,
        ...(spawnConfig.env ? { env: spawnConfig.env } : {}),
        onChunk,
        onExit: finalize,
      });
    } catch (err) {
      this.store.updateMeta(sessionId, {
        status: 'failed',
        endedAt: new Date(this.now()).toISOString(),
      });
      throw err instanceof TalariaError
        ? err
        : new TalariaError('SPAWN_FAILED', 'Failed to start tool', { cause: err });
    }

    this.store.updateMeta(sessionId, { pid: handle.pid });
    emit({
      type: 'started',
      sessionId,
      tool: req.tool,
      dir: resolvedDir,
      pid: handle.pid ?? 0,
      tmuxSession,
    });
    timers.timeout = setTimeout(() => {
      this.logger.warn('session timed out', { sessionId, timeout });
      forceStop('timeout');
    }, timeout * 1000);

    // Resolve when the tool exits (finalize has emitted `done`).
    await exited.promise;
  }
}
