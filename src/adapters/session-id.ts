import type { NativeSessionIdExtractor } from './types.js';

const MAX_NATIVE_SESSION_ID_LENGTH = 512;

/**
 * Parse structured output incrementally and return the first native conversation ID
 * selected by `pick`. Newline-delimited records are handled as they arrive, and a
 * complete final JSON object can be recognized before a trailing newline is emitted.
 * Malformed/non-JSON data is ignored because tool output remains a pass-through stream
 * and may contain diagnostics.
 */
export function createJsonlSessionIdExtractor(
  pick: (event: Record<string, unknown>) => unknown,
): NativeSessionIdExtractor {
  let buffered = '';
  let found: string | undefined;

  const extract = (text: string): string | undefined => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const candidate = pick(value as Record<string, unknown>);
    if (
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= MAX_NATIVE_SESSION_ID_LENGTH &&
      !candidate.includes('\0')
    ) {
      return candidate;
    }
    return undefined;
  };

  return {
    push(data: string): string | undefined {
      if (found !== undefined) return found;
      buffered += data;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        found = extract(line);
        if (found !== undefined) return found;
      }

      found = extract(buffered);
      return found;
    },
  };
}
