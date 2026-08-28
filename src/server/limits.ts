/**
 * Resource-limit helpers (ARCHITECTURE §6.4, §8.1).
 *
 * Concurrency and timeout enforcement live here so the run handler stays declarative.
 * `maxOutputSize` enforcement is applied by the runner as output streams in.
 */

import { TalariaError } from '../protocol/errors.js';
import type { ServerConfig } from '../config/server-config.js';
import type { SessionStore } from './session-store.js';

/** Number of sessions currently in the `running` state. */
export function countActiveSessions(store: SessionStore): number {
  return store.list().filter((m) => m.status === 'running').length;
}

/** Throw `MAX_SESSIONS` if starting another session would exceed the configured cap. */
export function assertCapacity(store: SessionStore, config: ServerConfig): void {
  if (countActiveSessions(store) >= config.maxConcurrentSessions) {
    throw new TalariaError(
      'MAX_SESSIONS',
      `Concurrent session limit reached (${config.maxConcurrentSessions})`,
    );
  }
}

/**
 * Resolve the effective timeout in seconds: the requested value or the config default,
 * clamped to `maxTimeout`.
 */
export function resolveTimeout(requested: number | undefined, config: ServerConfig): number {
  const base = requested ?? config.defaultTimeout;
  return Math.min(base, config.maxTimeout);
}
