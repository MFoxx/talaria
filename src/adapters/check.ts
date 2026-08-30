/**
 * Shared `--version` availability probe for adapters (ARCHITECTURE §7.2).
 */

import { BinaryNotFoundError, runCommand } from '../util/exec.js';
import type { ToolAvailability } from './types.js';

/**
 * Run `<bin> --version` and interpret the result. A missing binary reports
 * `available: false` with a stable "binary not found" message; a clean exit reports the
 * first non-empty output line as the version.
 */
export async function checkBinaryVersion(
  bin: string,
  versionArgs: string[] = ['--version'],
): Promise<ToolAvailability> {
  try {
    const result = await runCommand(bin, versionArgs);
    const line = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((value) => value.trim())
      .find((value) => value.length > 0)
      ?.slice(0, 500);
    if (result.code === 0) {
      return line ? { available: true, version: line } : { available: true };
    }
    return {
      available: false,
      error: `exited with code ${result.code}${line ? `: ${line}` : ''}`,
    };
  } catch (err) {
    if (err instanceof BinaryNotFoundError) {
      return { available: false, error: 'binary not found' };
    }
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
