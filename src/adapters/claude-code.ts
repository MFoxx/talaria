/**
 * Claude Code adapter (ARCHITECTURE §7.2).
 *
 * Base invocation:
 *   claude --output-format stream-json --verbose -p <prompt>
 * Always requests the most structured output format and passes the bytes through
 * untouched (§12 "output format negotiation").
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const BIN = 'claude';

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  allowedTools: { type: 'string[]', description: 'Allowed tools → --allowedTools (comma-joined)' },
  maxTurns: { type: 'number', description: 'Max agent turns → --max-turns' },
  dangerouslySkipPermissions: {
    type: 'boolean',
    description: 'Skip permission prompts → --dangerously-skip-permissions (use with caution)',
  },
};

export const claudeCodeAdapter: ToolAdapter = {
  name: 'claude-code',
  description: 'Anthropic Claude Code CLI',
  acceptedArgs,

  check() {
    return checkBinaryVersion(BIN);
  },

  buildSpawn(req: BuildSpawnRequest): SpawnConfig {
    const args = validateToolArgs(acceptedArgs, req.toolArgs);
    const flags: string[] = ['--output-format', 'stream-json', '--verbose'];

    if (typeof args.model === 'string') flags.push('--model', args.model);
    if (Array.isArray(args.allowedTools)) {
      flags.push('--allowedTools', args.allowedTools.join(','));
    }
    if (typeof args.maxTurns === 'number') flags.push('--max-turns', String(args.maxTurns));
    if (args.dangerouslySkipPermissions === true) flags.push('--dangerously-skip-permissions');

    // Prompt goes last as an explicit argv element — never interpolated into a string.
    flags.push('-p', req.prompt);
    return { bin: BIN, args: flags };
  },
};
