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
import { createJsonlSessionIdExtractor } from './session-id.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const DEFAULT_BIN = 'claude';

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  allowedTools: { type: 'string[]', description: 'Allowed tools → --allowedTools (comma-joined)' },
  maxTurns: { type: 'number', description: 'Max agent turns → --max-turns' },
  dangerouslySkipPermissions: {
    type: 'boolean',
    description: 'Skip permission prompts → --dangerously-skip-permissions (use with caution)',
  },
};

function buildArgs(req: BuildSpawnRequest, nativeSessionId?: string): string[] {
  const args = validateToolArgs(acceptedArgs, req.toolArgs);
  const flags: string[] = ['--output-format', 'stream-json', '--verbose'];

  if (nativeSessionId !== undefined) flags.push('--resume', nativeSessionId);
  if (typeof args.model === 'string') flags.push('--model', args.model);
  if (Array.isArray(args.allowedTools)) flags.push('--allowedTools', args.allowedTools.join(','));
  if (typeof args.maxTurns === 'number') flags.push('--max-turns', String(args.maxTurns));
  if (args.dangerouslySkipPermissions === true) flags.push('--dangerously-skip-permissions');
  flags.push('-p', req.prompt);
  return flags;
}

export function createClaudeCodeAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'claude-code',
    description: 'Anthropic Claude Code CLI',
    acceptedArgs,
    continuation: {
      createSessionIdExtractor: () => createJsonlSessionIdExtractor((event) => event.session_id),
      buildSpawn(req) {
        return { bin, args: buildArgs(req, req.nativeSessionId) };
      },
    },

    check() {
      return checkBinaryVersion(bin);
    },

    buildSpawn(req: BuildSpawnRequest): SpawnConfig {
      return { bin, args: buildArgs(req) };
    },
  };
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
