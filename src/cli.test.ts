import { describe, expect, it } from 'vitest';
import { buildProgram } from './cli.js';

describe('buildProgram', () => {
  it('registers all client and server commands', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual([
      'attach',
      'config',
      'continue',
      'kill',
      'ping',
      'run',
      'serve',
      'sessions',
      'setup',
      'tools',
    ]);
  });

  it('run requires tool, dir, and prompt', () => {
    const run = buildProgram().commands.find((c) => c.name() === 'run');
    const required = run?.options.filter((o) => o.required).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--tool', '--dir', '--prompt']));
  });

  it('exposes a name and version', () => {
    const program = buildProgram();
    expect(program.name()).toBe('talaria');
    expect(program.version()).toBe('0.1.1');
  });

  it('exposes both setup transports', () => {
    const setup = buildProgram().commands.find((command) => command.name() === 'setup');
    const transport = setup?.options.find((option) => option.long === '--transport');
    expect(transport?.defaultValue).toBeUndefined();
    expect(transport?.description).toContain('tailscale-ssh');
  });
});
