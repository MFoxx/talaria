import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { grokAdapter } from './grok.js';
import { openCodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';
import { createGenericAdapter } from './generic.js';
import { validateToolArgs } from './args.js';
import { isTalariaError } from '../protocol/errors.js';

const base = { dir: '/proj', timeout: 600 };

describe('opencode adapter', () => {
  it('uses non-interactive JSON mode and terminates option parsing before the prompt', () => {
    const prompt = '--session attacker-controlled';
    expect(openCodeAdapter.buildSpawn({ ...base, prompt, toolArgs: {} })).toEqual({
      bin: 'opencode',
      args: ['run', '--format', 'json', '--', prompt],
    });
  });

  it('maps supported execution arguments', () => {
    expect(
      openCodeAdapter.buildSpawn({
        ...base,
        prompt: 'go',
        toolArgs: {
          model: 'anthropic/claude-sonnet-4-6',
          agent: 'build',
          variant: 'high',
          thinking: true,
          auto: true,
        },
      }).args,
    ).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--agent',
      'build',
      '--variant',
      'high',
      '--thinking',
      '--auto',
      '--',
      'go',
    ]);
  });

  it('resumes the exact session ID extracted from fragmented JSONL', () => {
    const continuation = openCodeAdapter.continuation!;
    expect(continuation.verifyResumedSessionId).toBe(true);
    expect(
      continuation.buildSpawn({
        ...base,
        prompt: 'next',
        toolArgs: {},
        nativeSessionId: 'ses_open-code',
      }).args,
    ).toEqual(['run', '--format', 'json', '--session', 'ses_open-code', '--', 'next']);
    const extractor = continuation.createSessionIdExtractor();
    expect(extractor.push('{"type":"step_start","session')).toBeUndefined();
    expect(extractor.push('ID":"ses_open-code","part":{"type":"step-start"}}\n')).toBe(
      'ses_open-code',
    );
  });

  it('does not allow callers to select a native session through tool arguments', () => {
    expect(() =>
      openCodeAdapter.buildSpawn({
        ...base,
        prompt: 'go',
        toolArgs: { session: 'other' },
      }),
    ).toThrow(/Unknown toolArg "session"/);
  });
});

describe('pi adapter', () => {
  it('uses JSON event-stream mode and keeps the prompt as one argv element', () => {
    const prompt = 'fix it; rm -rf /';
    expect(piAdapter.buildSpawn({ ...base, prompt, toolArgs: {} })).toEqual({
      bin: 'pi',
      args: ['--mode', 'json', prompt],
    });
  });

  it('maps supported model arguments and rejects unsupported thinking levels', () => {
    expect(
      piAdapter.buildSpawn({
        ...base,
        prompt: 'go',
        toolArgs: { provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'high' },
      }).args,
    ).toEqual([
      '--mode',
      'json',
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4-6',
      '--thinking',
      'high',
      'go',
    ]);
    expect(() =>
      piAdapter.buildSpawn({ ...base, prompt: 'go', toolArgs: { thinking: 'unlimited' } }),
    ).toThrow(/must be one of/);
  });

  it('resumes the exact session ID extracted from a fragmented session header', () => {
    const continuation = piAdapter.continuation!;
    expect(continuation.verifyResumedSessionId).toBe(true);
    expect(
      continuation.buildSpawn({
        ...base,
        prompt: 'next',
        toolArgs: {},
        nativeSessionId: 'pi-session',
      }).args,
    ).toEqual(['--mode', 'json', '--session', 'pi-session', 'next']);
    const extractor = continuation.createSessionIdExtractor();
    expect(extractor.push('{"type":"session","version":3,"id":"pi-')).toBeUndefined();
    expect(extractor.push('session","cwd":"/proj"}\n')).toBe('pi-session');
  });

  it('rejects session selection through untrusted tool arguments', () => {
    expect(() =>
      piAdapter.buildSpawn({ ...base, prompt: 'go', toolArgs: { session: 'other' } }),
    ).toThrow(/Unknown toolArg/);
  });
});

describe('claude-code adapter', () => {
  it('builds the base invocation with prompt last', () => {
    const spawn = claudeCodeAdapter.buildSpawn({ ...base, prompt: 'fix it', toolArgs: {} });
    expect(spawn.bin).toBe('claude');
    expect(spawn.args).toEqual(['--output-format', 'stream-json', '--verbose', '-p', 'fix it']);
  });

  it('maps toolArgs to flags', () => {
    const spawn = claudeCodeAdapter.buildSpawn({
      ...base,
      prompt: 'p',
      toolArgs: {
        model: 'claude-sonnet-4-6',
        allowedTools: ['read', 'write', 'bash'],
        maxTurns: 5,
        dangerouslySkipPermissions: true,
      },
    });
    expect(spawn.args).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-sonnet-4-6',
      '--allowedTools',
      'read,write,bash',
      '--max-turns',
      '5',
      '--dangerously-skip-permissions',
      '-p',
      'p',
    ]);
  });

  it('keeps an injection attempt as a single argv element', () => {
    const nasty = '"; rm -rf / #';
    const spawn = claudeCodeAdapter.buildSpawn({ ...base, prompt: nasty, toolArgs: {} });
    expect(spawn.args[spawn.args.length - 1]).toBe(nasty);
    expect(spawn.args).toContain(nasty);
    // The nasty string appears exactly once and is never split.
    expect(spawn.args.filter((a) => a === nasty)).toHaveLength(1);
  });

  it('resumes an explicit session and extracts its ID from fragmented JSONL', () => {
    const continuation = claudeCodeAdapter.continuation!;
    const spawn = continuation.buildSpawn({
      ...base,
      prompt: 'next',
      toolArgs: {},
      nativeSessionId: 'claude-session',
    });
    expect(spawn.args).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      'claude-session',
      '-p',
      'next',
    ]);

    const extractor = continuation.createSessionIdExtractor();
    expect(extractor.push('{"type":"system","session_')).toBeUndefined();
    expect(extractor.push('id":"claude-session"}\n')).toBe('claude-session');
  });

  it('rejects an unknown toolArg', () => {
    try {
      claudeCodeAdapter.buildSpawn({ ...base, prompt: 'p', toolArgs: { bogus: 1 } });
      expect.unreachable();
    } catch (err) {
      expect(isTalariaError(err) && err.code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects a mistyped toolArg', () => {
    expect(() =>
      claudeCodeAdapter.buildSpawn({ ...base, prompt: 'p', toolArgs: { maxTurns: 'lots' } }),
    ).toThrow();
  });
});

describe('codex adapter', () => {
  it('uses non-interactive exec with a workspace-write sandbox by default', () => {
    const spawn = codexAdapter.buildSpawn({ ...base, prompt: 'go', toolArgs: {} });
    expect(spawn.bin).toBe('codex');
    expect(spawn.args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--sandbox',
      'workspace-write',
      'go',
    ]);
  });

  it('maps supported sandbox and model arguments', () => {
    const spawn = codexAdapter.buildSpawn({
      ...base,
      prompt: 'go',
      toolArgs: { sandbox: 'read-only', model: 'o4' },
    });
    expect(spawn.args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--sandbox',
      'read-only',
      '--model',
      'o4',
      'go',
    ]);
    expect(spawn.args.filter((a) => a === '--sandbox')).toHaveLength(1);
  });

  it('rejects unsupported sandbox values', () => {
    expect(() =>
      codexAdapter.buildSpawn({
        ...base,
        prompt: 'go',
        toolArgs: { sandbox: 'unrestricted-ish' },
      }),
    ).toThrow(/must be one of: read-only, workspace-write, danger-full-access/);
  });

  it('rejects the removed approvalMode argument', () => {
    expect(() =>
      codexAdapter.buildSpawn({
        ...base,
        prompt: 'go',
        toolArgs: { approvalMode: 'full-auto' },
      }),
    ).toThrow(/Unknown toolArg "approvalMode"/);
  });

  it('places explicit resume after exec flags and extracts thread.started', () => {
    const continuation = codexAdapter.continuation!;
    expect(continuation.verifyResumedSessionId).toBe(true);
    const spawn = continuation.buildSpawn({
      ...base,
      prompt: 'next',
      toolArgs: { sandbox: 'read-only' },
      nativeSessionId: 'codex-thread',
    });
    expect(spawn.args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--sandbox',
      'read-only',
      'resume',
      'codex-thread',
      'next',
    ]);
    const extractor = continuation.createSessionIdExtractor();
    expect(extractor.push('{"type":"thread.started","thread_id":"codex-thread"}\n')).toBe(
      'codex-thread',
    );
  });
});

describe('cursor adapter', () => {
  it('uses print mode with structured streaming output by default', () => {
    const spawn = cursorAdapter.buildSpawn({ ...base, prompt: 'go', toolArgs: {} });
    expect(spawn.bin).toBe('agent');
    expect(spawn.args).toEqual(['-p', '--output-format', 'stream-json', 'go']);
  });

  it('maps force and model arguments before the prompt', () => {
    const spawn = cursorAdapter.buildSpawn({
      ...base,
      prompt: 'go',
      toolArgs: { force: true, model: 'claude-opus' },
    });
    expect(spawn.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--force',
      '--model',
      'claude-opus',
      'go',
    ]);
  });

  it('omits --force when not requested', () => {
    const spawn = cursorAdapter.buildSpawn({
      ...base,
      prompt: 'go',
      toolArgs: { force: false },
    });
    expect(spawn.args).not.toContain('--force');
  });

  it('keeps an injection attempt as a single argv element', () => {
    const nasty = '"; rm -rf / #';
    const spawn = cursorAdapter.buildSpawn({ ...base, prompt: nasty, toolArgs: {} });
    expect(spawn.args[spawn.args.length - 1]).toBe(nasty);
    expect(spawn.args.filter((a) => a === nasty)).toHaveLength(1);
  });

  it('resumes an explicit chat and extracts its structured session ID', () => {
    const continuation = cursorAdapter.continuation!;
    const spawn = continuation.buildSpawn({
      ...base,
      prompt: 'next',
      toolArgs: {},
      nativeSessionId: 'cursor-chat',
    });
    expect(spawn.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--resume',
      'cursor-chat',
      'next',
    ]);
    const extractor = continuation.createSessionIdExtractor();
    expect(extractor.push('not json\n{"session_id":"cursor-chat"}\n')).toBe('cursor-chat');
  });

  it('rejects an unknown toolArg', () => {
    expect(() =>
      cursorAdapter.buildSpawn({ ...base, prompt: 'p', toolArgs: { sandbox: 'read-only' } }),
    ).toThrow(/Unknown toolArg "sandbox"/);
  });
});

describe('grok adapter', () => {
  it('uses headless mode with structured output and the requested cwd by default', () => {
    const spawn = grokAdapter.buildSpawn({ ...base, prompt: 'go', toolArgs: {} });
    expect(spawn.bin).toBe('grok');
    expect(spawn.args).toEqual([
      '--no-auto-update',
      '--no-alt-screen',
      '--cwd',
      '/proj',
      '--output-format',
      'streaming-json',
      '-p',
      'go',
    ]);
  });

  it('maps model, output format, and auto-approval arguments', () => {
    const spawn = grokAdapter.buildSpawn({
      ...base,
      prompt: 'go',
      toolArgs: { model: 'grok-build', outputFormat: 'json', alwaysApprove: true },
    });
    expect(spawn.args).toEqual([
      '--no-auto-update',
      '--no-alt-screen',
      '--cwd',
      '/proj',
      '--output-format',
      'json',
      '--model',
      'grok-build',
      '--always-approve',
      '-p',
      'go',
    ]);
  });

  it('accepts plain output and rejects unsupported output formats', () => {
    const plain = grokAdapter.buildSpawn({
      ...base,
      prompt: 'go',
      toolArgs: { outputFormat: 'plain' },
    });
    expect(plain.args).toContain('plain');
    expect(() =>
      grokAdapter.buildSpawn({
        ...base,
        prompt: 'go',
        toolArgs: { outputFormat: 'xml' },
      }),
    ).toThrow(/must be one of: plain, json, streaming-json/);
  });

  it('resumes an explicit session and extracts its ID from fragmented JSONL', () => {
    const continuation = grokAdapter.continuation!;
    expect(continuation.verifyResumedSessionId).toBe(true);
    const spawn = continuation.buildSpawn({
      ...base,
      prompt: 'next',
      toolArgs: {},
      nativeSessionId: 'grok-session',
    });
    expect(spawn.args).toEqual([
      '--no-auto-update',
      '--no-alt-screen',
      '--cwd',
      '/proj',
      '--output-format',
      'streaming-json',
      '--resume',
      'grok-session',
      '-p',
      'next',
    ]);

    const extractor = continuation.createSessionIdExtractor();
    expect(extractor.push('{"type":"end","session')).toBeUndefined();
    expect(extractor.push('Id":"grok-session"}\n')).toBe('grok-session');
  });

  it('extracts a session ID from json output without requiring a trailing newline', () => {
    const extractor = grokAdapter.continuation!.createSessionIdExtractor();
    expect(extractor.push('{"text":"done","session')).toBeUndefined();
    expect(extractor.push('Id":"json-session"}')).toBe('json-session');
  });

  it('keeps prompt and cwd values as individual argv elements', () => {
    const nasty = '"; rm -rf / #';
    const spawn = grokAdapter.buildSpawn({
      ...base,
      dir: '/proj with spaces',
      prompt: nasty,
      toolArgs: {},
    });
    expect(spawn.args[spawn.args.indexOf('--cwd') + 1]).toBe('/proj with spaces');
    expect(spawn.args.at(-1)).toBe(nasty);
    expect(spawn.args.filter((arg) => arg === nasty)).toHaveLength(1);
  });

  it('rejects unknown and mistyped arguments', () => {
    expect(() =>
      grokAdapter.buildSpawn({ ...base, prompt: 'p', toolArgs: { sessionId: 'external' } }),
    ).toThrow(/Unknown toolArg "sessionId"/);
    expect(() =>
      grokAdapter.buildSpawn({ ...base, prompt: 'p', toolArgs: { alwaysApprove: 'yes' } }),
    ).toThrow(/must be of type boolean/);
  });
});

describe('generic adapter', () => {
  it('substitutes {{prompt}} into argv elements only', () => {
    const adapter = createGenericAdapter({
      name: 'aider',
      bin: '/bin/aider',
      argsTemplate: ['--yes-always', '--message', '{{prompt}}'],
      acceptedArgs: {},
    });
    const spawn = adapter.buildSpawn({ ...base, prompt: 'hello world', toolArgs: {} });
    expect(spawn.bin).toBe('/bin/aider');
    expect(spawn.args).toEqual(['--yes-always', '--message', 'hello world']);
  });

  it('does not split a prompt containing shell metacharacters', () => {
    const adapter = createGenericAdapter({
      name: 'aider',
      bin: '/bin/aider',
      argsTemplate: ['-m', '{{prompt}}'],
      acceptedArgs: {},
    });
    const spawn = adapter.buildSpawn({ ...base, prompt: 'a; b && c | d', toolArgs: {} });
    expect(spawn.args).toEqual(['-m', 'a; b && c | d']);
  });

  it('rejects toolArgs not in acceptedArgs', () => {
    const adapter = createGenericAdapter({
      name: 'aider',
      bin: '/bin/aider',
      argsTemplate: ['{{prompt}}'],
      acceptedArgs: {},
    });
    expect(() => adapter.buildSpawn({ ...base, prompt: 'p', toolArgs: { x: 1 } })).toThrow();
  });
});

describe('validateToolArgs', () => {
  it('applies declared defaults', () => {
    const out = validateToolArgs(
      { mode: { type: 'string', default: 'auto', description: '' } },
      {},
    );
    expect(out).toEqual({ mode: 'auto' });
  });

  it('rejects string values outside declared choices', () => {
    expect(() =>
      validateToolArgs(
        { mode: { type: 'string', choices: ['safe', 'fast'], description: '' } },
        { mode: 'surprise' },
      ),
    ).toThrow(/must be one of: safe, fast/);
  });

  it('accepts each supported type', () => {
    const out = validateToolArgs(
      {
        s: { type: 'string', description: '' },
        n: { type: 'number', description: '' },
        b: { type: 'boolean', description: '' },
        a: { type: 'string[]', description: '' },
      },
      { s: 'x', n: 1, b: true, a: ['y'] },
    );
    expect(out).toEqual({ s: 'x', n: 1, b: true, a: ['y'] });
  });

  it('rejects NaN as a number and non-string array elements', () => {
    expect(() =>
      validateToolArgs({ n: { type: 'number', description: '' } }, { n: NaN }),
    ).toThrow();
    expect(() =>
      validateToolArgs({ a: { type: 'string[]', description: '' } }, { a: ['ok', 2] }),
    ).toThrow();
  });
});
