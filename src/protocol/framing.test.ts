import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  decodeFrames,
  decodeLine,
  encodeFrame,
  encodeLine,
  frameByteLength,
  splitLines,
} from './framing.js';
import { isTalariaError } from './errors.js';

describe('protocol JSONL', () => {
  it('round-trips a value', () => {
    const value = { type: 'ping', nested: { a: [1, 2, 3] } };
    const line = encodeLine(value);
    expect(line.endsWith('\n')).toBe(true);
    expect(decodeLine(line.trimEnd())).toEqual(value);
  });

  it('throws INVALID_REQUEST on malformed JSON', () => {
    try {
      decodeLine('{not json');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isTalariaError(err)).toBe(true);
      if (isTalariaError(err)) expect(err.code).toBe('INVALID_REQUEST');
    }
  });

  it('splits complete lines and carries the trailing partial', () => {
    const { lines, rest } = splitLines('a\nb\nhalf');
    expect(lines).toEqual(['a', 'b']);
    expect(rest).toBe('half');
  });
});

describe('output-log frames', () => {
  it('encodes exact byte length including newline', () => {
    const buf = encodeFrame('stdout', 'hello\n', 1000);
    expect(buf[buf.length - 1]).toBe(0x0a); // trailing \n
    expect(frameByteLength('stdout', 'hello\n', 1000)).toBe(buf.length);
  });

  it('is binary-safe: offset uses UTF-8 byte length, not string length', () => {
    const multibyte = '日本語 🎌';
    const buf = encodeFrame('stdout', multibyte, 1000);
    expect(buf.length).toBe(Buffer.byteLength(buf.toString('utf8'), 'utf8'));
    expect(buf.length).toBeGreaterThan(multibyte.length); // more bytes than chars
  });

  it('round-trips a frame', () => {
    const buf = encodeFrame('stderr', 'warn\n', 42);
    const frame = decodeFrame(buf.toString('utf8').trimEnd());
    expect(frame).toEqual({ ts: 42, s: 'stderr', d: 'warn\n' });
  });

  it('decodes multiple frames and ignores a trailing partial write', () => {
    const a = encodeFrame('stdout', 'one\n', 1).toString('utf8');
    const b = encodeFrame('stdout', 'two\n', 2).toString('utf8');
    const partial = '{"ts":3,"s":"stdout","d":"thr'; // half-written frame at tail
    const frames = decodeFrames(a + b + partial);
    expect(frames.map((f) => f.d)).toEqual(['one\n', 'two\n']);
  });

  it('rejects a corrupt frame as INTERNAL', () => {
    try {
      decodeFrame('{"ts":1,"s":"bogus","d":"x"}');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isTalariaError(err)).toBe(true);
      if (isTalariaError(err)) expect(err.code).toBe('INTERNAL');
    }
  });
});
