import { describe, expect, it } from 'vitest';
import { coerceArgValue, parseToolArgs } from './context.js';

describe('coerceArgValue', () => {
  it('coerces booleans, integers, comma-lists, and strings', () => {
    expect(coerceArgValue('true')).toBe(true);
    expect(coerceArgValue('false')).toBe(false);
    expect(coerceArgValue('5')).toBe(5);
    expect(coerceArgValue('-3')).toBe(-3);
    expect(coerceArgValue('read,write,bash')).toEqual(['read', 'write', 'bash']);
    expect(coerceArgValue('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('parseToolArgs', () => {
  it('parses key=value pairs from the spec example', () => {
    const args = parseToolArgs(['model=claude-sonnet-4-6', 'allowedTools=read,write,bash']);
    expect(args).toEqual({
      model: 'claude-sonnet-4-6',
      allowedTools: ['read', 'write', 'bash'],
    });
  });

  it('defaults to an empty object', () => {
    expect(parseToolArgs()).toEqual({});
  });

  it('rejects a malformed entry', () => {
    expect(() => parseToolArgs(['noequals'])).toThrow(/key=value/);
    expect(() => parseToolArgs(['=novalue'])).toThrow(/key=value/);
  });
});
