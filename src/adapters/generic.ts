/**
 * Generic / custom-tool adapter (ARCHITECTURE §7.4).
 *
 * Built from a `customTools` config entry. The only interpolation token is `{{prompt}}`,
 * replaced literally inside individual argv elements — never a shell expansion. Every
 * other template element is passed through verbatim.
 */

import type { CustomTool } from '../config/server-config.js';
import { validateToolArgs } from './args.js';
import { checkBinaryVersion } from './check.js';
import type { AcceptedArgSpec, BuildSpawnRequest, SpawnConfig, ToolAdapter } from './types.js';

const PROMPT_TOKEN = '{{prompt}}';
const KNOWN_TYPES = new Set(['string', 'number', 'boolean', 'string[]']);

/** Coerce a config-declared accepted-arg into an {@link AcceptedArgSpec}. */
function coerceAcceptedArgs(raw: CustomTool['acceptedArgs']): Record<string, AcceptedArgSpec> {
  const out: Record<string, AcceptedArgSpec> = {};
  for (const [key, spec] of Object.entries(raw)) {
    const type = KNOWN_TYPES.has(spec.type) ? (spec.type as AcceptedArgSpec['type']) : 'string';
    out[key] = {
      type,
      description: spec.description,
      ...(spec.default !== undefined ? { default: spec.default } : {}),
    };
  }
  return out;
}

/** Build a {@link ToolAdapter} for a user-defined generic tool. */
export function createGenericAdapter(tool: CustomTool): ToolAdapter {
  const acceptedArgs = coerceAcceptedArgs(tool.acceptedArgs);

  return {
    name: tool.name,
    description: `Custom tool (${tool.bin})`,
    acceptedArgs,

    check() {
      return checkBinaryVersion(tool.bin);
    },

    buildSpawn(req: BuildSpawnRequest): SpawnConfig {
      // Reject unknown/mistyped args even though the template controls the argv shape.
      validateToolArgs(acceptedArgs, req.toolArgs);
      const args = tool.argsTemplate.map((el) => el.split(PROMPT_TOKEN).join(req.prompt));
      return { bin: tool.bin, args };
    },
  };
}
