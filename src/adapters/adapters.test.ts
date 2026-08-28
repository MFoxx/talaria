import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { createGenericAdapter } from './generic.js';
import { validateToolArgs } from './args.js';
import { isTalariaError } from '../protocol/errors.js';

const base = { dir: '/proj', timeout: 600 };

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
