import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBinaryVersion } from './check.js';

describe('checkBinaryVersion', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('includes the first output line when a version probe fails', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'talaria-version-check-'));
    roots.push(root);
    const bin = path.join(root, 'locked-tool');
    writeFileSync(
      bin,
      '#!/bin/sh\necho "Error: Your macOS login keychain is locked." >&2\nexit 1\n',
    );
    chmodSync(bin, 0o755);

    await expect(checkBinaryVersion(bin)).resolves.toEqual({
      available: false,
      error: 'exited with code 1: Error: Your macOS login keychain is locked.',
    });
  });
});
