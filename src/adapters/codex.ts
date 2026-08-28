/**
 * Codex adapter (ARCHITECTURE §7.3).
 *
 * Base invocation:
 *   codex --quiet --approval-mode full-auto <prompt>
 * `approvalMode` overrides the default rather than adding a duplicate flag.
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const BIN = 'codex';

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  approvalMode: {
    type: 'string',
    default: 'full-auto',
    description: 'Approval mode → --approval-mode',
  },
};

export const codexAdapter: ToolAdapter = {
  name: 'codex',
  description: 'OpenAI Codex CLI',
  acceptedArgs,

  check() {
    return checkBinaryVersion(BIN);
  },

  buildSpawn(req: BuildSpawnRequest): SpawnConfig {
    const args = validateToolArgs(acceptedArgs, req.toolArgs);
    const flags: string[] = ['--quiet'];

    // approvalMode is defaulted to full-auto, so this is always set exactly once.
    if (typeof args.approvalMode === 'string') {
      flags.push('--approval-mode', args.approvalMode);
    }
    if (typeof args.model === 'string') flags.push('--model', args.model);

    flags.push(req.prompt);
    return { bin: BIN, args: flags };
  },
};
