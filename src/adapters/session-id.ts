import type { NativeSessionIdExtractor } from './types.js';

const MAX_NATIVE_SESSION_ID_LENGTH = 512;

/**
 * Parse newline-delimited structured output incrementally and return the first native
 * conversation ID selected by `pick`. Malformed/non-JSON lines are ignored because tool
 * output remains a pass-through stream and may contain diagnostics.
 */
export function createJsonlSessionIdExtractor(
  pick: (event: Record<string, unknown>) => unknown,
): NativeSessionIdExtractor {
  let buffered = '';
  let found: string | undefined;

  return {
    push(data: string): string | undefined {
      if (found !== undefined) return found;
      buffered += data;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        const candidate = pick(value as Record<string, unknown>);
        if (
          typeof candidate === 'string' &&
          candidate.length > 0 &&
          candidate.length <= MAX_NATIVE_SESSION_ID_LENGTH &&
          !candidate.includes('\0')
        ) {
          found = candidate;
          return found;
        }
      }
      return undefined;
    },
  };
}
