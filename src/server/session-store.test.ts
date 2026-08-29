import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, type SessionMeta } from './session-store.js';
import { decodeFrames } from '../protocol/framing.js';
import { isTalariaError } from '../protocol/errors.js';

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    tool: 'codex',
    dir: '/proj',
    prompt: 'do',
    toolArgs: {},
    tmuxSession: `talaria-${id}`,
    pid: 123,
    startedAt: '2026-08-28T14:00:00.000Z',
    status: 'running',
    exitCode: null,
    signal: null,
    endedAt: null,
    timeout: 600,
    ...overrides,
  };
}

describe('SessionStore', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-store-'));
    store = new SessionStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates and reads back metadata', () => {
    const m = meta('aaa');
    store.create(m);
    expect(store.exists('aaa')).toBe(true);
    expect(store.readMeta('aaa')).toEqual(m);
  });

  it('throws SESSION_NOT_FOUND for a missing session', () => {
    try {
      store.readMeta('ghost');
      expect.unreachable();
    } catch (err) {
      expect(isTalariaError(err) && err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('patches metadata via updateMeta', () => {
    store.create(meta('bbb'));
    const updated = store.updateMeta('bbb', { status: 'completed', exitCode: 0, endedAt: 'x' });
    expect(updated.status).toBe('completed');
    expect(store.readMeta('bbb').exitCode).toBe(0);
  });

  it('appends framed output and reports growing offsets', () => {
    store.create(meta('ccc'));
    const o1 = store.appendOutput('ccc', 'stdout', 'hello\n', 1);
    const o2 = store.appendOutput('ccc', 'stderr', 'warn\n', 2);
    expect(o2).toBeGreaterThan(o1);
    expect(store.outputSize('ccc')).toBe(o2);
  });

  it('reads output from an offset as whole frames', () => {
    store.create(meta('ddd'));
    const o1 = store.appendOutput('ddd', 'stdout', 'one\n', 1);
    store.appendOutput('ddd', 'stdout', 'two\n', 2);

    const all = store.readOutputFrom('ddd', 0);
    expect(decodeFrames(all.data).map((f) => f.d)).toEqual(['one\n', 'two\n']);

    const tail = store.readOutputFrom('ddd', o1);
    expect(decodeFrames(tail.data).map((f) => f.d)).toEqual(['two\n']);

    const past = store.readOutputFrom('ddd', all.totalBytes);
    expect(past.data).toBe('');
  });

  it('lists sessions newest-first and deletes them', () => {
    store.create(meta('old', { startedAt: '2026-08-28T10:00:00.000Z' }));
    store.create(meta('new', { startedAt: '2026-08-28T20:00:00.000Z' }));
    expect(store.list().map((m) => m.sessionId)).toEqual(['new', 'old']);
    store.delete('old');
    expect(store.list().map((m) => m.sessionId)).toEqual(['new']);
  });

  it('groups executions by conversation and rejects a concurrent lock', () => {
    const conversationId = '0123456789abcdef01234567';
    store.create(meta('turn1', { conversationId }));
    store.create(meta('turn2', { conversationId, parentSessionId: 'turn1' }));
    expect(store.listConversation(conversationId).map((m) => m.sessionId)).toEqual([
      'turn1',
      'turn2',
    ]);

    const release = store.acquireConversationLock(conversationId);
    expect(() => store.acquireConversationLock(conversationId)).toThrow(/busy/);
    release();
    expect(() => store.acquireConversationLock(conversationId)()).not.toThrow();
  });
});
