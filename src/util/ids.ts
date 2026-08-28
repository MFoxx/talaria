/**
 * Session identifiers (ARCHITECTURE §6.4).
 *
 * IDs are cryptographically random so they can't be guessed. Knowing an ID only ever
 * grants what the forced command already allows (read output / kill), but unguessable
 * IDs keep one agent's sessions from being enumerable by another.
 */

import { randomBytes } from 'node:crypto';

/** A fresh 12-byte (24 hex char) session id. */
export function newSessionId(): string {
  return randomBytes(12).toString('hex');
}

/** The tmux session name for a talaria session id. */
export function tmuxSessionName(sessionId: string): string {
  return `talaria-${sessionId}`;
}
