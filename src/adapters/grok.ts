/**
 * Grok Build adapter.
 *
 * Base invocation:
 *   grok --no-auto-update --no-alt-screen --cwd <dir>
 *     --output-format streaming-json -p <prompt>
 *
 * Headless `-p` mode matches Talaria's one-process-per-turn execution model. Structured
 * output is the default so Talaria can capture Grok's native session ID and resume it on
 * later conversation turns. Output remains a pass-through stream.
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import { createJsonlSessionIdExtractor } from './session-id.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const DEFAULT_BIN = 'grok';
const OUTPUT_FORMATS = ['plain', 'json', 'streaming-json'] as const;

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  outputFormat: {
    type: 'string',
    default: 'streaming-json',
    choices: OUTPUT_FORMATS,
    description: 'Output format → --output-format',
  },
  alwaysApprove: {
    type: 'boolean',
    description: 'Auto-approve tool executions → --always-approve (use with caution)',
  },
};

function buildArgs(req: BuildSpawnRequest, nativeSessionId?: string): string[] {
  const args = validateToolArgs(acceptedArgs, req.toolArgs);
  const flags: string[] = ['--no-auto-update', '--no-alt-screen', '--cwd', req.dir];

  if (typeof args.outputFormat === 'string') flags.push('--output-format', args.outputFormat);
  if (nativeSessionId !== undefined) flags.push('--resume', nativeSessionId);
  if (typeof args.model === 'string') flags.push('--model', args.model);
  if (args.alwaysApprove === true) flags.push('--always-approve');
  flags.push('-p', req.prompt);
  return flags;
}

export function createGrokAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'grok',
    description: 'xAI Grok Build CLI',
    acceptedArgs,
    continuation: {
      verifyResumedSessionId: true,
      createSessionIdExtractor: () => createJsonlSessionIdExtractor((event) => event.sessionId),
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

export const grokAdapter = createGrokAdapter();
