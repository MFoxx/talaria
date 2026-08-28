/**
 * Session garbage collection (ARCHITECTURE §4.5 "Reaping", §6.4).
 *
 * Run on every `talaria serve` startup. Completed sessions (any non-`running` status)
 * are kept for `sessionRetention` seconds so clients can retrieve results after the
 * fact, then deleted. Running sessions are never reaped.
 */

import type { SessionStore } from './session-store.js';

export interface ReapResult {
  reaped: string[];
}

/**
 * Delete finished sessions whose `endedAt` is older than the retention window.
 * `now` is injectable for testing. Returns the ids that were removed.
 */
export function reapExpiredSessions(
  store: SessionStore,
  retentionSeconds: number,
  now: number = Date.now(),
): ReapResult {
  const cutoff = now - retentionSeconds * 1000;
  const reaped: string[] = [];

  for (const meta of store.list()) {
    if (meta.status === 'running') continue;
    if (meta.endedAt === null) continue;
    const endedAt = Date.parse(meta.endedAt);
    if (Number.isNaN(endedAt)) continue;
    if (endedAt <= cutoff) {
      store.delete(meta.sessionId);
      reaped.push(meta.sessionId);
    }
  }

  return { reaped };
}
