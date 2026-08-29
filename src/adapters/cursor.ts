/**
 * Cursor CLI adapter (ARCHITECTURE §7).
 *
 * Base invocation:
 *   agent -p --output-format stream-json <prompt>
 *
 * `-p` (print mode) is Cursor's supported non-interactive mode. As with Claude Code we
 * always request the most structured output format and pass the bytes through untouched
 * (§12 "output format negotiation"). Authentication is provided out of band via the
 * `CURSOR_API_KEY` environment variable, never through `toolArgs`.
 *
 * The prompt is always the final explicit argv element — never interpolated into a
 * string (§6.4 injection defense).
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const DEFAULT_BIN = 'agent';

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  force: {
    type: 'boolean',
    description: 'Allow direct file changes without confirmation → --force (use with caution)',
  },
};

export function createCursorAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'cursor',
    description: 'Cursor CLI (Cursor Agent)',
    acceptedArgs,

    check() {
      return checkBinaryVersion(bin);
    },

    buildSpawn(req: BuildSpawnRequest): SpawnConfig {
      const args = validateToolArgs(acceptedArgs, req.toolArgs);
      const flags: string[] = ['-p', '--output-format', 'stream-json'];

      if (args.force === true) flags.push('--force');
      if (typeof args.model === 'string') flags.push('--model', args.model);

      // Prompt goes last as an explicit argv element — never interpolated into a string.
      flags.push(req.prompt);
      return { bin, args: flags };
    },
  };
}

export const cursorAdapter = createCursorAdapter();
