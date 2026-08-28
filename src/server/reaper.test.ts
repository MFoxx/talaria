import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, type SessionMeta } from './session-store.js';
import { reapExpiredSessions } from './reaper.js';

const NOW = Date.parse('2026-08-28T20:00:00.000Z');

function meta(id: string, status: SessionMeta['status'], endedAt: string | null): SessionMeta {
  return {
    sessionId: id,
    tool: 'codex',
    dir: '/p',
    prompt: 'x',
    toolArgs: {},
    tmuxSession: `talaria-${id}`,
    pid: null,
    startedAt: '2026-08-28T10:00:00.000Z',
    status,
    exitCode: status === 'completed' ? 0 : null,
    signal: null,
    endedAt,
    timeout: 600,
  };
}

describe('reapExpiredSessions', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-reap-'));
    store = new SessionStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('deletes finished sessions past retention, keeps recent and running ones', () => {
    // Ended 2h ago; retention 1h → expired.
    store.create(meta('old', 'completed', '2026-08-28T18:00:00.000Z'));
    // Ended 10m ago; retention 1h → kept.
    store.create(meta('recent', 'completed', '2026-08-28T19:50:00.000Z'));
    // Still running → never reaped, even without endedAt.
    store.create(meta('live', 'running', null));

    const { reaped } = reapExpiredSessions(store, 3600, NOW);

    expect(reaped).toEqual(['old']);
    expect(
      store
        .list()
        .map((m) => m.sessionId)
        .sort(),
    ).toEqual(['live', 'recent']);
  });

  it('does nothing when there is nothing expired', () => {
    store.create(meta('live', 'running', null));
    expect(reapExpiredSessions(store, 3600, NOW).reaped).toEqual([]);
  });
});
