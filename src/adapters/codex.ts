/**
 * Codex adapter (ARCHITECTURE §7.3).
 *
 * Base invocation:
 *   codex exec --sandbox workspace-write <prompt>
 *
 * `exec` is Codex's supported non-interactive mode. Sandbox values are allowlisted
 * before they become argv elements; prompts are always passed as one final element.
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';
import { runCommand } from '../util/exec.js';

const BIN = 'codex';
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  sandbox: {
    type: 'string',
    default: 'workspace-write',
    choices: SANDBOX_MODES,
    description: 'Sandbox policy → --sandbox',
  },
};

export const codexAdapter: ToolAdapter = {
  name: 'codex',
  description: 'OpenAI Codex CLI',
  acceptedArgs,

  async check() {
    const version = await checkBinaryVersion(BIN);
    if (!version.available) return version;

    const execHelp = await runCommand(BIN, ['exec', '--help']);
    if (execHelp.code !== 0) {
      return {
        available: false,
        error: 'installed Codex CLI does not support non-interactive `codex exec`',
      };
    }
    return version;
  },

  buildSpawn(req: BuildSpawnRequest): SpawnConfig {
    const args = validateToolArgs(acceptedArgs, req.toolArgs);
    const flags: string[] = ['exec'];

    // sandbox is defaulted, so this is always set exactly once.
    if (typeof args.sandbox === 'string') {
      flags.push('--sandbox', args.sandbox);
    }
    if (typeof args.model === 'string') flags.push('--model', args.model);

    flags.push(req.prompt);
    return { bin: BIN, args: flags };
  },
};
