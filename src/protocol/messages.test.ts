import { describe, expect, it } from 'vitest';
import { parseRequest, parseResponse, Request, Response } from './messages.js';
import { isTalariaError } from './errors.js';

describe('parseRequest', () => {
  it('accepts each spec request example', () => {
    const valid: unknown[] = [
      {
        type: 'run',
        tool: 'claude-code',
        dir: '/home/user/projects/app',
        prompt: 'Fix the auth middleware',
        timeout: 600,
        toolArgs: { model: 'claude-sonnet-4-6', allowedTools: ['read', 'write'] },
      },
      { type: 'attach', sessionId: 'a1b2c3', offset: 48210 },
      { type: 'attach', sessionId: 'a1b2c3' },
      { type: 'list' },
      { type: 'kill', sessionId: 'a1b2c3' },
      { type: 'status', sessionId: 'a1b2c3' },
      { type: 'ping' },
      { type: 'list-tools' },
    ];
    for (const v of valid) {
      expect(() => parseRequest(v)).not.toThrow();
    }
  });

  it('rejects unknown fields with INVALID_REQUEST', () => {
    try {
      parseRequest({ type: 'ping', extra: true });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isTalariaError(err)).toBe(true);
      if (isTalariaError(err)) expect(err.code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects missing required fields', () => {
    expect(() => parseRequest({ type: 'run', tool: 'codex' })).toThrow();
    expect(() => parseRequest({ type: 'kill' })).toThrow();
  });

  it('rejects an unknown message type', () => {
    expect(() => parseRequest({ type: 'nope' })).toThrow();
  });

  it('rejects non-positive timeout and negative offset', () => {
    expect(() =>
      parseRequest({ type: 'run', tool: 't', dir: '/d', prompt: 'p', timeout: 0 }),
    ).toThrow();
    expect(() => parseRequest({ type: 'attach', sessionId: 'a', offset: -1 })).toThrow();
  });
});

describe('parseResponse', () => {
  it('accepts each spec response example', () => {
    const valid: unknown[] = [
      { type: 'started', sessionId: 'a', tool: 't', dir: '/d', pid: 1, tmuxSession: 'talaria-a' },
      {
        type: 'attached',
        sessionId: 'a',
        status: 'running',
        tool: 't',
        dir: '/d',
        offsetFrom: 0,
        totalBytes: 10,
      },
      { type: 'output', stream: 'stdout', data: 'hi', offset: 12 },
      {
        type: 'done',
        sessionId: 'a',
        exitCode: 0,
        signal: null,
        durationMs: 5,
        status: 'completed',
      },
      {
        type: 'done',
        sessionId: 'a',
        exitCode: null,
        signal: 'SIGTERM',
        durationMs: 5,
        status: 'killed',
      },
      {
        type: 'session_list',
        sessions: [
          { sessionId: 'a', tool: 't', dir: '/d', status: 'running', startedAt: 'now' },
          {
            sessionId: 'b',
            tool: 't',
            dir: '/d',
            status: 'completed',
            startedAt: 'then',
            endedAt: 'later',
            exitCode: 0,
          },
        ],
      },
      {
        type: 'session_status',
        sessionId: 'a',
        tool: 't',
        dir: '/d',
        prompt: 'p',
        status: 'running',
        pid: 1,
        startedAt: 'now',
        outputBytes: 10,
        exitCode: null,
      },
      { type: 'killed', sessionId: 'a' },
      { type: 'pong' },
      {
        type: 'tool_list',
        tools: [
          { name: 'claude-code', available: true, version: '1.0.25' },
          { name: 'aider', available: false, error: 'binary not found' },
        ],
      },
      { type: 'error', code: 'DIR_NOT_ALLOWED', message: 'nope' },
    ];
    for (const v of valid) {
      expect(() => parseResponse(v)).not.toThrow();
    }
  });

  it('rejects an unknown error code', () => {
    expect(() => parseResponse({ type: 'error', code: 'NOT_A_CODE', message: 'x' })).toThrow();
  });
});

describe('schema wiring', () => {
  it('exposes discriminated unions', () => {
    expect(Request.safeParse({ type: 'ping' }).success).toBe(true);
    expect(Response.safeParse({ type: 'pong' }).success).toBe(true);
  });
});
