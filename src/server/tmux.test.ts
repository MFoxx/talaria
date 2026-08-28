import { describe, expect, it } from 'vitest';
import {
  buildCapturePaneArgv,
  buildDisplayMessageArgv,
  buildHasSessionArgv,
  buildKillSessionArgv,
  buildNewSessionArgv,
  buildPipePaneArgv,
  cleanCapture,
} from './tmux.js';

describe('tmux argv builders', () => {
  it('passes the command after -- as separate words (no shell)', () => {
    const argv = buildNewSessionArgv({
      tmuxSession: 'talaria-abc',
      cwd: '/proj',
      bin: 'claude',
      args: ['-p', 'a; rm -rf /'],
    });
    expect(argv).toEqual([
      'new-session',
      '-d',
      '-s',
      'talaria-abc',
      '-x',
      '220',
      '-y',
      '50',
      '-c',
      '/proj',
      '--',
      'claude',
      '-p',
      'a; rm -rf /',
    ]);
    // The injection attempt survives intact as one element after --.
    const sep = argv.indexOf('--');
    expect(argv.slice(sep + 1)).toEqual(['claude', '-p', 'a; rm -rf /']);
  });

  it('adds -e flags for env entries', () => {
    const argv = buildNewSessionArgv({
      tmuxSession: 't',
      cwd: '/p',
      bin: 'b',
      args: [],
      env: { FOO: 'bar' },
    });
    expect(argv).toContain('-e');
    expect(argv).toContain('FOO=bar');
  });

  it('builds control-command argv', () => {
    expect(buildHasSessionArgv('t')).toEqual(['has-session', '-t', 't']);
    expect(buildKillSessionArgv('t')).toEqual(['kill-session', '-t', 't']);
    expect(buildCapturePaneArgv('t')).toEqual(['capture-pane', '-p', '-t', 't', '-S', '-']);
    expect(buildPipePaneArgv('t', '/data/out.raw')).toEqual([
      'pipe-pane',
      '-o',
      '-t',
      't',
      "cat >> '/data/out.raw'",
    ]);
    expect(buildDisplayMessageArgv('t', '#{pane_pid}')).toEqual([
      'display-message',
      '-p',
      '-t',
      't',
      '#{pane_pid}',
    ]);
  });
});

describe('cleanCapture', () => {
  it('strips the trailing "Pane is dead" banner and blank lines', () => {
    const raw = 'hello-capture\n\nPane is dead (status 0, Fri Aug 28 22:18:17 2026)';
    expect(cleanCapture(raw)).toBe('hello-capture\n');
  });

  it('returns empty when there is nothing but the banner', () => {
    expect(cleanCapture('Pane is dead (status 0, ...)\n')).toBe('');
  });

  it('preserves multi-line content', () => {
    expect(cleanCapture('line1\nline2\n')).toBe('line1\nline2\n');
  });
});
