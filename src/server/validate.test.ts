import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWithin, validateDir } from './validate.js';
import { isTalariaError, type ErrorCode } from '../protocol/errors.js';

function expectCode(fn: () => unknown, code: ErrorCode): void {
  try {
    fn();
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(isTalariaError(err)).toBe(true);
    if (isTalariaError(err)) expect(err.code).toBe(code);
  }
}

describe('isWithin', () => {
  it('accepts the dir itself and descendants, rejects escapes', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/bevil')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/x')).toBe(false);
  });
});

describe('validateDir', () => {
  let base: string;
  let allowed: string;
  let outside: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talaria-validate-')));
    allowed = path.join(base, 'projects');
    outside = path.join(base, 'secrets');
    mkdirSync(allowed);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('returns the resolved path for the allowed dir and its subdirs', () => {
    const sub = path.join(allowed, 'app');
    mkdirSync(sub);
    expect(validateDir(allowed, [allowed])).toBe(allowed);
    expect(validateDir(sub, [allowed])).toBe(sub);
  });

  it('rejects a directory outside every allowed prefix', () => {
    expectCode(() => validateDir(outside, [allowed]), 'DIR_NOT_ALLOWED');
  });

  it('rejects a sibling that only shares a name prefix', () => {
    const sibling = path.join(base, 'projects-evil');
    mkdirSync(sibling);
    expectCode(() => validateDir(sibling, [allowed]), 'DIR_NOT_ALLOWED');
  });

  it('rejects a symlink that escapes the allowed prefix', () => {
    const link = path.join(allowed, 'escape');
    symlinkSync(outside, link);
    // Pre-symlink the path is "under" allowed, but realpath resolves outside.
    expectCode(() => validateDir(link, [allowed]), 'DIR_NOT_ALLOWED');
  });

  it('rejects a relative path', () => {
    expectCode(() => validateDir('relative/dir', [allowed]), 'DIR_NOT_ALLOWED');
  });

  it('reports a missing directory as DIR_NOT_FOUND', () => {
    expectCode(() => validateDir(path.join(allowed, 'nope'), [allowed]), 'DIR_NOT_FOUND');
  });
});
