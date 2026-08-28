import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OffsetStore } from './offsets.js';

describe('OffsetStore', () => {
  let root: string;
  let store: OffsetStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'talaria-offsets-'));
    store = new OffsetStore(path.join(root, 'offsets.json'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns undefined for an unknown session', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('persists and reads back offsets across instances', () => {
    store.set('a1', 100);
    store.set('a2', 250);
    store.set('a1', 300); // overwrite
    const reopened = new OffsetStore(path.join(root, 'offsets.json'));
    expect(reopened.get('a1')).toBe(300);
    expect(reopened.get('a2')).toBe(250);
  });

  it('tolerates a missing or corrupt file', () => {
    expect(store.get('x')).toBeUndefined(); // file doesn't exist yet
    rmSync(path.join(root, 'offsets.json'), { force: true });
    expect(() => store.set('y', 1)).not.toThrow();
  });
});
