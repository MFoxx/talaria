/** Compatibility check for Tailscale's optional SSH wrapper. */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const VERSION = spawnSync('tailscale', ['version'], { encoding: 'utf8' });
const HAS_TAILSCALE = VERSION.status === 0;

describe.skipIf(!HAS_TAILSCALE)('Tailscale SSH wrapper (installed CLI)', () => {
  it('supports a host followed by remote command arguments', () => {
    const result = spawnSync('tailscale', ['ssh', '--help'], { encoding: 'utf8' });
    const help = result.stdout + result.stderr;

    expect(result.status, help).toBe(0);
    expect(help).toContain('tailscale ssh [user@]<host> [args...]');
  });
});
