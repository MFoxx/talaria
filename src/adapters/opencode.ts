/** OpenCode adapter using its non-interactive JSON event stream. */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import { createJsonlSessionIdExtractor } from './session-id.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const DEFAULT_BIN = 'opencode';

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model in provider/model form → --model' },
  agent: { type: 'string', description: 'Agent to use → --agent' },
  variant: { type: 'string', description: 'Provider-specific model variant → --variant' },
  thinking: { type: 'boolean', description: 'Include thinking blocks → --thinking' },
  auto: {
    type: 'boolean',
    description: 'Auto-approve permissions not explicitly denied → --auto (use with caution)',
  },
};

function buildArgs(req: BuildSpawnRequest, nativeSessionId?: string): string[] {
  const args = validateToolArgs(acceptedArgs, req.toolArgs);
  const flags: string[] = ['run', '--format', 'json'];

  if (nativeSessionId !== undefined) flags.push('--session', nativeSessionId);
  if (typeof args.model === 'string') flags.push('--model', args.model);
  if (typeof args.agent === 'string') flags.push('--agent', args.agent);
  if (typeof args.variant === 'string') flags.push('--variant', args.variant);
  if (args.thinking === true) flags.push('--thinking');
  if (args.auto === true) flags.push('--auto');

  // `--` prevents a prompt beginning with a dash from being parsed as an OpenCode flag.
  flags.push('--', req.prompt);
  return flags;
}

export function createOpenCodeAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'opencode',
    description: 'OpenCode CLI',
    acceptedArgs,
    continuation: {
      verifyResumedSessionId: true,
      createSessionIdExtractor: () => createJsonlSessionIdExtractor((event) => event.sessionID),
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

export const openCodeAdapter = createOpenCodeAdapter();
