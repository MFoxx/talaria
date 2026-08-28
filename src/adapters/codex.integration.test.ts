/**
 * Compatibility check against an installed Codex CLI.
 *
 * The unit tests lock down Talaria's argv construction. This optional integration test
 * additionally asks the real CLI parser to accept those flags, catching upstream CLI
 * changes such as the removal of `--quiet` before release.
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './codex.js';

const HAS_CODEX = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!HAS_CODEX)('Codex adapter (installed CLI)', () => {
  it('reports a compatible installed CLI as available', async () => {
    await expect(codexAdapter.check()).resolves.toMatchObject({ available: true });
  });

  it('uses flags accepted by the installed non-interactive CLI', () => {
    const spawn = codexAdapter.buildSpawn({
      dir: process.cwd(),
      prompt: 'compatibility-check',
      timeout: 10,
      toolArgs: {},
    });
    const flags = spawn.args.slice(0, -1);
    const result = spawnSync(spawn.bin, [...flags, '--help'], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Run Codex non-interactively');
  });
});
