import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import { parseServerConfig } from '../config/server-config.js';
import { isTalariaError } from '../protocol/errors.js';

function config(overrides: Record<string, unknown>) {
  return parseServerConfig({
    allowedDirs: ['/tmp'],
    builtinToolBins: {
      'claude-code': '/usr/local/bin/claude',
      codex: '/usr/local/bin/codex',
      grok: '/usr/local/bin/grok',
      opencode: '/usr/local/bin/opencode',
      pi: '/usr/local/bin/pi',
    },
    ...overrides,
  });
}

describe('AdapterRegistry', () => {
  it('exposes only tools in the allowlist', () => {
    const registry = AdapterRegistry.fromConfig(config({ tools: ['claude-code', 'codex'] }));
    expect(registry.names().sort()).toEqual(['claude-code', 'codex']);
    expect(registry.has('claude-code')).toBe(true);
    expect(registry.has('aider')).toBe(false);
  });

  it('builds a generic adapter for a custom tool in the allowlist', () => {
    const registry = AdapterRegistry.fromConfig(
      config({
        tools: ['aider'],
        customTools: [{ name: 'aider', bin: '/bin/true', argsTemplate: ['{{prompt}}'] }],
      }),
    );
    expect(
      registry.get('aider').buildSpawn({ dir: '/tmp', prompt: 'p', timeout: 1, toolArgs: {} }),
    ).toEqual({ bin: '/bin/true', args: ['p'] });
  });

  it('throws UNKNOWN_TOOL for an unregistered name', () => {
    const registry = AdapterRegistry.fromConfig(config({ tools: ['codex'] }));
    try {
      registry.get('claude-code');
      expect.unreachable();
    } catch (err) {
      expect(isTalariaError(err) && err.code).toBe('UNKNOWN_TOOL');
    }
  });

  it('pins built-in adapters to configured absolute binaries', () => {
    const registry = AdapterRegistry.fromConfig(
      config({
        tools: ['claude-code', 'codex', 'grok', 'opencode', 'pi'],
        builtinToolBins: {
          'claude-code': '/opt/tools/claude',
          codex: '/opt/tools/codex',
          grok: '/opt/tools/grok',
          opencode: '/opt/tools/opencode',
          pi: '/opt/tools/pi',
        },
      }),
    );
    const request = { dir: '/tmp', prompt: 'p', timeout: 1, toolArgs: {} };
    expect(registry.get('claude-code').buildSpawn(request).bin).toBe('/opt/tools/claude');
    expect(registry.get('codex').buildSpawn(request).bin).toBe('/opt/tools/codex');
    expect(registry.get('grok').buildSpawn(request).bin).toBe('/opt/tools/grok');
    expect(registry.get('opencode').buildSpawn(request).bin).toBe('/opt/tools/opencode');
    expect(registry.get('pi').buildSpawn(request).bin).toBe('/opt/tools/pi');
  });

  it('reports availability with the ToolInfo shape', async () => {
    const registry = AdapterRegistry.fromConfig(
      config({
        tools: ['present', 'absent'],
        customTools: [
          { name: 'present', bin: '/usr/bin/true', argsTemplate: [] },
          { name: 'absent', bin: '/nonexistent/xyzzy-bin', argsTemplate: [] },
        ],
      }),
    );
    const infos = await registry.listWithAvailability();
    const present = infos.find((i) => i.name === 'present');
    const absent = infos.find((i) => i.name === 'absent');
    expect(present?.available).toBe(true);
    expect(absent).toEqual({ name: 'absent', available: false, error: 'binary not found' });
  });
});
