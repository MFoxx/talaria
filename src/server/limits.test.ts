import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, type SessionMeta } from './session-store.js';
import { assertCapacity, countActiveSessions, resolveTimeout } from './limits.js';
import { parseServerConfig } from '../config/server-config.js';
import { isTalariaError } from '../protocol/errors.js';

function meta(id: string, status: SessionMeta['status']): SessionMeta {
  return {
    sessionId: id,
    tool: 'codex',
    dir: '/p',
    prompt: 'x',
    toolArgs: {},
    tmuxSession: `talaria-${id}`,
    pid: null,
    startedAt: '2026-08-28T14:00:00.000Z',
    status,
    exitCode: null,
    signal: null,
    endedAt: status === 'running' ? null : '2026-08-28T14:05:00.000Z',
    timeout: 600,
  };
}

describe('limits', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-limits-'));
    store = new SessionStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('counts only running sessions', () => {
    store.create(meta('a', 'running'));
    store.create(meta('b', 'completed'));
    store.create(meta('c', 'running'));
    expect(countActiveSessions(store)).toBe(2);
  });

  it('throws MAX_SESSIONS at capacity', () => {
    const config = parseServerConfig({ maxConcurrentSessions: 1 });
    store.create(meta('a', 'running'));
    try {
      assertCapacity(store, config);
      expect.unreachable();
    } catch (err) {
      expect(isTalariaError(err) && err.code).toBe('MAX_SESSIONS');
    }
  });

  it('allows a new session below capacity', () => {
    const config = parseServerConfig({ maxConcurrentSessions: 2 });
    store.create(meta('a', 'running'));
    expect(() => assertCapacity(store, config)).not.toThrow();
  });

  it('resolves and clamps timeout', () => {
    const config = parseServerConfig({ defaultTimeout: 300, maxTimeout: 1000 });
    expect(resolveTimeout(undefined, config)).toBe(300);
    expect(resolveTimeout(500, config)).toBe(500);
    expect(resolveTimeout(9999, config)).toBe(1000);
  });
});
