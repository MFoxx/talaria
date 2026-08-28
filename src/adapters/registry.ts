/**
 * Adapter registry (ARCHITECTURE §7).
 *
 * The registry is the authoritative allowlist of usable tools: a tool is available only
 * if its name appears in `config.tools`. Built-in adapters (`claude-code`, `codex`) and
 * generic adapters (from `customTools`) are assembled here and looked up by name.
 */

import { TalariaError } from '../protocol/errors.js';
import type { ToolInfo } from '../protocol/messages.js';
import type { ServerConfig } from '../config/server-config.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { createGenericAdapter } from './generic.js';
import type { ToolAdapter } from './types.js';

const BUILTINS: Record<string, ToolAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
};

export class AdapterRegistry {
  private readonly adapters = new Map<string, ToolAdapter>();

  private constructor(adapters: Map<string, ToolAdapter>) {
    this.adapters = adapters;
  }

  /**
   * Build a registry from server config. Assumes config has already been validated (so
   * every `tools` entry resolves to a built-in or a defined custom tool).
   */
  static fromConfig(config: ServerConfig): AdapterRegistry {
    const customByName = new Map(config.customTools.map((t) => [t.name, t]));
    const adapters = new Map<string, ToolAdapter>();

    for (const name of config.tools) {
      const builtin = BUILTINS[name];
      if (builtin) {
        adapters.set(name, builtin);
        continue;
      }
      const custom = customByName.get(name);
      if (custom) {
        adapters.set(name, createGenericAdapter(custom));
        continue;
      }
      // Should be unreachable after config validation; fail loudly if not.
      throw new TalariaError('INTERNAL', `Configured tool "${name}" has no adapter`);
    }

    return new AdapterRegistry(adapters);
  }

  /** Look up an adapter by name, or throw `UNKNOWN_TOOL`. */
  get(name: string): ToolAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new TalariaError('UNKNOWN_TOOL', `Tool "${name}" is not available`);
    }
    return adapter;
  }

  /** True if a tool name is in the allowlist. */
  has(name: string): boolean {
    return this.adapters.has(name);
  }

  /** All registered tool names. */
  names(): string[] {
    return [...this.adapters.keys()];
  }

  /** Probe availability of every registered tool (for `list-tools`). */
  async listWithAvailability(): Promise<ToolInfo[]> {
    const entries = [...this.adapters.entries()];
    const results = await Promise.all(
      entries.map(async ([name, adapter]): Promise<ToolInfo> => {
        const availability = await adapter.check();
        return {
          name,
          available: availability.available,
          ...(availability.version !== undefined ? { version: availability.version } : {}),
          ...(availability.error !== undefined ? { error: availability.error } : {}),
        };
      }),
    );
    return results;
  }
}
