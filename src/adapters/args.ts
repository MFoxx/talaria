/**
 * Per-adapter `toolArgs` validation (ARCHITECTURE §6.3, §7.1).
 *
 * Each adapter declares exactly which args it accepts and their types. Anything not
 * declared is rejected, and every declared value is type-checked before it can reach an
 * argv array. This is where a malicious or malformed `toolArgs` payload is stopped.
 */

import { TalariaError } from '../protocol/errors.js';
import type { ToolArgs } from '../protocol/messages.js';
import type { AcceptedArgSpec } from './types.js';

/** A validated arg value, narrowed to the declared type. */
export type ValidatedArgValue = string | number | boolean | string[];

function typeMatches(spec: AcceptedArgSpec, value: unknown): value is ValidatedArgValue {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
  }
}

/**
 * Validate a raw `toolArgs` object against an adapter's accepted-args declaration.
 * Rejects unknown keys and type mismatches with `INVALID_REQUEST`. Applies declared
 * defaults for absent keys. Returns only the keys that are present or defaulted.
 */
export function validateToolArgs(
  accepted: Record<string, AcceptedArgSpec>,
  raw: ToolArgs,
): Record<string, ValidatedArgValue> {
  const out: Record<string, ValidatedArgValue> = {};

  for (const key of Object.keys(raw)) {
    if (!(key in accepted)) {
      const allowed = Object.keys(accepted).join(', ') || '(none)';
      throw new TalariaError('INVALID_REQUEST', `Unknown toolArg "${key}". Accepted: ${allowed}`);
    }
    const spec = accepted[key]!;
    const value = raw[key];
    if (!typeMatches(spec, value)) {
      throw new TalariaError('INVALID_REQUEST', `toolArg "${key}" must be of type ${spec.type}`);
    }
    if (typeof value === 'string' && spec.choices && !spec.choices.includes(value)) {
      throw new TalariaError(
        'INVALID_REQUEST',
        `toolArg "${key}" must be one of: ${spec.choices.join(', ')}`,
      );
    }
    out[key] = value;
  }

  for (const [key, spec] of Object.entries(accepted)) {
    if (!(key in out) && spec.default !== undefined) {
      if (!typeMatches(spec, spec.default)) {
        throw new TalariaError('INTERNAL', `Default for toolArg "${key}" has wrong type`);
      }
      if (
        typeof spec.default === 'string' &&
        spec.choices &&
        !spec.choices.includes(spec.default)
      ) {
        throw new TalariaError('INTERNAL', `Default for toolArg "${key}" is not an allowed choice`);
      }
      out[key] = spec.default;
    }
  }

  return out;
}
