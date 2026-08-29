/**
 * Session runner (ARCHITECTURE §4.3, §4.5).
 *
 * Every conversation turn is a fresh Talaria session with its own immutable log;
 * harness-native conversation state stays behind the adapter seam.
 */

import { TalariaError } from '../protocol/errors.js';
import type {
  ContinueRequest,
  Response,
  RunRequest,
  StreamName,
  ToolArgs,
} from '../protocol/messages.js';
import type { NativeSessionIdExtractor, SpawnConfig, ToolAdapter } from '../adapters/types.js';
import type { SessionMeta, SessionStore } from './session-store.js';
import type { ServerConfig } from '../config/server-config.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { ExitResult, ProcessManager } from './process-manager.js';
import { assertCapacity, resolveTimeout } from './limits.js';
import { validateDir } from './validate.js';
import { newSessionId, tmuxSessionName } from '../util/ids.js';
import { nullLogger, type Logger } from '../util/logger.js';
import { deferred } from '../util/async.js';

export const KILL_GRACE_MS = 5000;

export interface RunnerDeps {
  store: SessionStore;
  registry: AdapterRegistry;
  config: ServerConfig;
  processManager: ProcessManager;
  logger?: Logger;
  now?: () => number;
}

export type Emit = (message: Response) => void;

interface Execution {
  sessionId: string;
  conversationId: string;
  parentSessionId: string | null;
  nativeSessionId: string | null;
  tool: string;
  dir: string;
  prompt: string;
  toolArgs: ToolArgs;
  timeout: number;
  spawn: SpawnConfig;
  extractor?: NativeSessionIdExtractor;
  verifyResumedSessionId?: boolean;
}

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

  /** Validate and start a new conversation and its first execution. */
  async run(req: RunRequest, emit: Emit): Promise<void> {
    const adapter = this.registry.get(req.tool);
    const dir = validateDir(req.dir, this.config.allowedDirs);
    assertCapacity(this.store, this.config);

    const timeout = resolveTimeout(req.timeout, this.config);
    const toolArgs = req.toolArgs ?? {};
    const sessionId = newSessionId();
    await this.execute(
      {
        sessionId,
        conversationId: sessionId,
        parentSessionId: null,
        nativeSessionId: null,
        tool: req.tool,
        dir,
        prompt: req.prompt,
        toolArgs,
        timeout,
        spawn: adapter.buildSpawn({ dir, prompt: req.prompt, timeout, toolArgs }),
        ...(adapter.continuation
          ? { extractor: adapter.continuation.createSessionIdExtractor() }
          : {}),
      },
      emit,
    );
  }

  /** Continue a server-owned conversation as a new execution. */
  async continue(req: ContinueRequest, emit: Emit): Promise<void> {
    const release = this.store.acquireConversationLock(req.conversationId);
    try {
      const executions = this.store.listConversation(req.conversationId);
      if (executions.length === 0) {
        throw new TalariaError(
          'CONVERSATION_NOT_FOUND',
          `No such conversation: ${req.conversationId}`,
        );
      }
      if (executions.some((meta) => meta.status === 'running')) {
        throw new TalariaError(
          'CONVERSATION_BUSY',
          `Conversation ${req.conversationId} already has a running execution`,
        );
      }

      const previous = executions[0]!;
      const adapter = this.registry.get(previous.tool);
      const continuation = this.requireContinuation(adapter);
      const nativeSessionId = previous.nativeSessionId;
      if (!nativeSessionId) {
        throw new TalariaError(
          'CONTINUATION_UNAVAILABLE',
          `Conversation ${req.conversationId} has no captured ${previous.tool} session ID`,
        );
      }

      const dir = validateDir(previous.dir, this.config.allowedDirs);
      assertCapacity(this.store, this.config);
      const timeout = resolveTimeout(req.timeout, this.config);
      const sessionId = newSessionId();
      const spawn = continuation.buildSpawn({
        dir,
        prompt: req.prompt,
        timeout,
        toolArgs: previous.toolArgs,
        nativeSessionId,
      });

      await this.execute(
        {
          sessionId,
          conversationId: req.conversationId,
          parentSessionId: previous.sessionId,
          nativeSessionId,
          tool: previous.tool,
          dir,
          prompt: req.prompt,
          toolArgs: previous.toolArgs,
          timeout,
          spawn,
          extractor: continuation.createSessionIdExtractor(),
          ...(continuation.verifyResumedSessionId ? { verifyResumedSessionId: true } : {}),
        },
        emit,
      );
    } finally {
      release();
    }
  }

  private requireContinuation(adapter: ToolAdapter): NonNullable<ToolAdapter['continuation']> {
    if (!adapter.continuation) {
      throw new TalariaError(
        'CONTINUATION_UNSUPPORTED',
        `Tool "${adapter.name}" does not support continuation`,
      );
    }
    return adapter.continuation;
  }

  private async execute(execution: Execution, emit: Emit): Promise<void> {
    const {
      sessionId,
      conversationId,
      parentSessionId,
      tool,
      dir,
      prompt,
      toolArgs,
      timeout,
      spawn,
      extractor,
      verifyResumedSessionId,
    } = execution;
    const tmuxSession = tmuxSessionName(sessionId);
    const startedAt = new Date(this.now()).toISOString();
    let nativeSessionId = execution.nativeSessionId;

    const meta: SessionMeta = {
      sessionId,
      conversationId,
      parentSessionId,
      nativeSessionId,
      tool,
      dir,
      prompt,
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
    let resumeMismatchReported = false;

    const finalize = (exit: ExitResult): void => {
      if (finished) return;
      finished = true;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (timers.kill) clearTimeout(timers.kill);

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
        conversationId,
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
      if (extractor && stream === 'stdout') {
        const captured = extractor.push(data);
        if (nativeSessionId === null && captured !== undefined) {
          nativeSessionId = captured;
          this.store.updateMeta(sessionId, { nativeSessionId: captured });
        } else if (
          verifyResumedSessionId &&
          captured !== undefined &&
          captured !== nativeSessionId &&
          !resumeMismatchReported
        ) {
          resumeMismatchReported = true;
          emit({
            type: 'error',
            code: 'CONTINUATION_UNAVAILABLE',
            message: `${tool} started native session ${captured} instead of resuming ${nativeSessionId}`,
          });
          forceStop('failed');
        }
      }

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
        cwd: dir,
        bin: spawn.bin,
        args: spawn.args,
        ...(spawn.env ? { env: spawn.env } : {}),
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
      conversationId,
      tool,
      dir,
      pid: handle.pid ?? 0,
      tmuxSession,
    });
    timers.timeout = setTimeout(() => {
      this.logger.warn('session timed out', { sessionId, timeout });
      forceStop('timeout');
    }, timeout * 1000);

    await exited.promise;
  }
}
