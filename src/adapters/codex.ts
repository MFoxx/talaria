/**
 * Codex adapter (ARCHITECTURE §7.3).
 *
 * Base invocation:
 *   codex exec --skip-git-repo-check --json --sandbox workspace-write <prompt>
 *
 * `exec` is Codex's supported non-interactive mode. Sandbox values are allowlisted
 * before they become argv elements; prompts are always passed as one final element.
 * Talaria performs its own allowed-directory validation, so the interactive Codex
 * trusted-directory prompt is deliberately bypassed for headless execution.
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import { createJsonlSessionIdExtractor } from './session-id.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';
import { runCommand } from '../util/exec.js';

const DEFAULT_BIN = 'codex';
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

function buildArgs(req: BuildSpawnRequest, nativeSessionId?: string): string[] {
  const args = validateToolArgs(acceptedArgs, req.toolArgs);
  const flags: string[] = ['exec', '--skip-git-repo-check', '--json'];

  if (typeof args.sandbox === 'string') flags.push('--sandbox', args.sandbox);
  if (typeof args.model === 'string') flags.push('--model', args.model);
  if (nativeSessionId !== undefined) flags.push('resume', nativeSessionId);
  flags.push(req.prompt);
  return flags;
}

export function createCodexAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'codex',
    description: 'OpenAI Codex CLI',
    acceptedArgs,
    continuation: {
      verifyResumedSessionId: true,
      createSessionIdExtractor: () =>
        createJsonlSessionIdExtractor((event) =>
          event.type === 'thread.started' ? event.thread_id : undefined,
        ),
      buildSpawn(req) {
        return { bin, args: buildArgs(req, req.nativeSessionId) };
      },
    },

    async check() {
      const version = await checkBinaryVersion(bin);
      if (!version.available) return version;

      const execHelp = await runCommand(bin, ['exec', '--help']);
      if (execHelp.code !== 0) {
        return {
          available: false,
          error: 'installed Codex CLI does not support non-interactive `codex exec`',
        };
      }
      return version;
    },

    buildSpawn(req: BuildSpawnRequest): SpawnConfig {
      return { bin, args: buildArgs(req) };
    },
  };
}

export const codexAdapter = createCodexAdapter();
