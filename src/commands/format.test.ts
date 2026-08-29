import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, renderSessions, renderTools, table } from './format.js';
import type { SessionSummary, ToolInfo } from '../protocol/messages.js';

describe('formatDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(135_000)).toBe('2m 15s');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });
});

describe('formatClock', () => {
  it('renders HH:MM and passes through unparseable input', () => {
    expect(formatClock('2026-08-28T09:05:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatClock('not-a-date')).toBe('not-a-date');
  });
});

describe('table', () => {
  it('aligns columns with a 2-space gutter', () => {
    const out = table(
      ['A', 'BB'],
      [
        ['x', 'yy'],
        ['zzz', 'w'],
      ],
    );
    expect(out.split('\n')).toEqual(['A    BB', 'x    yy', 'zzz  w']);
  });
});

describe('renderSessions', () => {
  const sessions: SessionSummary[] = [
    {
      sessionId: 'a1',
      conversationId: 'c1',
      tool: 'codex',
      dir: '/p',
      status: 'completed',
      startedAt: '2026-08-28T14:20:00.000Z',
      durationMs: 312_000,
      exitCode: 0,
    },
  ];

  it('renders json when requested', () => {
    expect(JSON.parse(renderSessions(sessions, 'json'))).toHaveLength(1);
  });

  it('renders a table with a header for pretty', () => {
    const out = renderSessions(sessions, 'pretty');
    expect(out).toContain('ID');
    expect(out).toContain('a1');
    expect(out).toContain('exit 0');
  });

  it('reports an empty list', () => {
    expect(renderSessions([], 'pretty')).toBe('No sessions.');
  });
});

describe('renderTools', () => {
  const tools: ToolInfo[] = [
    { name: 'claude-code', available: true, version: '1.0.25' },
    { name: 'aider', available: false, error: 'binary not found' },
  ];

  it('marks availability in pretty output', () => {
    const out = renderTools(tools, 'pretty');
    expect(out).toContain('✓ available');
    expect(out).toContain('✗ binary not found');
  });
});
