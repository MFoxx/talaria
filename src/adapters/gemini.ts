/**
 * Google Gemini CLI adapter.
 *
 * Base invocation:
 *   gemini --skip-trust --output-format stream-json -p <prompt>
 *
 * Headless `-p` mode matches Talaria's one-process-per-turn execution model. Streaming
 * JSON is the default so Talaria can capture Gemini's native session ID from the init
 * event and resume it on later conversation turns. Output remains a pass-through stream.
 * The process manager supplies the validated project directory as the subprocess cwd;
 * `--skip-trust` prevents Gemini's interactive folder-trust gate after Talaria has
 * canonicalized and allowlisted that directory.
 */

import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import { createJsonlSessionIdExtractor } from './session-id.js';
import { TalariaError } from '../protocol/errors.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const DEFAULT_BIN = 'gemini';
const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
const APPROVAL_MODES = ['default', 'auto_edit', 'yolo', 'plan'] as const;

const acceptedArgs: Record<string, AcceptedArgSpec> = {
  model: { type: 'string', description: 'Model name → --model' },
  outputFormat: {
    type: 'string',
    default: 'stream-json',
    choices: OUTPUT_FORMATS,
    description: 'Output format → --output-format',
  },
  debug: { type: 'boolean', description: 'Enable debug output → --debug' },
  includeDirectories: {
    type: 'string[]',
    description: 'Additional workspace directories → --include-directories (comma-joined)',
  },
  yolo: {
    type: 'boolean',
    description: 'Deprecated auto-approval alias → --yolo (prefer approvalMode=yolo)',
  },
  approvalMode: {
    type: 'string',
    choices: APPROVAL_MODES,
    description: 'Approval policy → --approval-mode',
  },
};

function buildArgs(req: BuildSpawnRequest, nativeSessionId?: string): string[] {
  const args = validateToolArgs(acceptedArgs, req.toolArgs);
  if (args.yolo === true && typeof args.approvalMode === 'string') {
    throw new TalariaError(
      'INVALID_REQUEST',
      'toolArgs "yolo" and "approvalMode" are mutually exclusive; use approvalMode=yolo',
    );
  }
  const flags: string[] = ['--skip-trust'];

  if (typeof args.outputFormat === 'string') flags.push('--output-format', args.outputFormat);
  if (nativeSessionId !== undefined) flags.push('--resume', nativeSessionId);
  if (typeof args.model === 'string') flags.push('--model', args.model);
  if (args.debug === true) flags.push('--debug');
  if (Array.isArray(args.includeDirectories)) {
    flags.push('--include-directories', args.includeDirectories.join(','));
  }
  if (args.yolo === true) flags.push('--yolo');
  if (typeof args.approvalMode === 'string') flags.push('--approval-mode', args.approvalMode);
  flags.push('-p', req.prompt);
  return flags;
}

export function createGeminiAdapter(bin = DEFAULT_BIN): ToolAdapter {
  return {
    name: 'gemini',
    description: 'Google Gemini CLI',
    acceptedArgs,
    continuation: {
      verifyResumedSessionId: true,
      createSessionIdExtractor: () =>
        createJsonlSessionIdExtractor((event) =>
          event.type === 'init' ? event.session_id : undefined,
        ),
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

export const geminiAdapter = createGeminiAdapter();
