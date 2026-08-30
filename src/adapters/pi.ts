/** Beta Pi Code adapter using its subprocess-friendly JSON event-stream mode. */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import { createJsonlSessionIdExtractor } from './session-id.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const DEFAULT_BIN = 'pi';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  provider: { type: 'string', description: 'LLM provider → --provider' },
  model: { type: 'string', description: 'Model pattern or ID → --model' },
  thinking: {
    type: 'string',
    choices: THINKING_LEVELS,
    description: 'Thinking level → --thinking',
  },
};

function buildArgs(req: BuildSpawnRequest, nativeSessionId?: string): string[] {
  const args = validateToolArgs(acceptedArgs, req.toolArgs);
  const flags: string[] = ['--mode', 'json'];
  if (nativeSessionId !== undefined) flags.push('--session', nativeSessionId);
  if (typeof args.provider === 'string') flags.push('--provider', args.provider);
  if (typeof args.model === 'string') flags.push('--model', args.model);
  if (typeof args.thinking === 'string') flags.push('--thinking', args.thinking);
  flags.push(req.prompt);
  return flags;
}

export function createPiAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'pi',
    description: 'Pi Code CLI (beta)',
    acceptedArgs,
    continuation: {
      verifyResumedSessionId: true,
      createSessionIdExtractor: () =>
        createJsonlSessionIdExtractor((event) => (event.type === 'session' ? event.id : undefined)),
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

export const piAdapter = createPiAdapter();
