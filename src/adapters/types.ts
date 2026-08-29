/**
 * Tool adapter contract (ARCHITECTURE §7.1).
 *
 * An adapter is the *only* place a generic `(tool, dir, prompt, opts)` request becomes a
 * concrete command. Every adapter returns an explicit `(bin, args[])` tuple — argv
 * elements, never a shell string — which is the core injection defense (§6.4).
 */

import type { ToolArgs } from '../protocol/messages.js';

/** Result of probing whether a tool is installed. */
export interface ToolAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

/** Input to {@link ToolAdapter.buildSpawn}. */
export interface BuildSpawnRequest {
  dir: string;
  prompt: string;
  timeout: number;
  toolArgs: ToolArgs;
}

export interface BuildContinuationRequest extends BuildSpawnRequest {
  nativeSessionId: string;
}

/** Incrementally extracts a harness-native conversation ID from structured stdout. */
export interface NativeSessionIdExtractor {
  push(data: string): string | undefined;
}

/** Harness-specific continuation behavior kept behind the adapter seam. */
export interface ContinuationAdapter {
  createSessionIdExtractor(): NativeSessionIdExtractor;
  buildSpawn(req: BuildContinuationRequest): SpawnConfig;
  /** Fail continuation when structured output reports a different native ID. */
  readonly verifyResumedSessionId?: boolean;
}

/** The spawn tuple an adapter produces. */
export interface SpawnConfig {
  bin: string;
  args: string[];
  /** Extra env merged over the inherited process env, if any. */
  env?: Record<string, string>;
}

/** Declared type/default/description of one accepted `toolArg`. */
export interface AcceptedArgSpec {
  type: 'string' | 'number' | 'boolean' | 'string[]';
  default?: unknown;
  /** Optional allowlist for string-valued arguments. */
  choices?: readonly string[];
  description: string;
}

export interface ToolAdapter {
  readonly name: string;
  readonly description: string;
  readonly acceptedArgs: Record<string, AcceptedArgSpec>;
  /** Probe whether the tool binary is available on this machine. */
  check(): Promise<ToolAvailability>;
  /** Build the spawn tuple. Throws `INVALID_REQUEST` on bad `toolArgs`. */
  buildSpawn(req: BuildSpawnRequest): SpawnConfig;
  /** Omitted when this harness cannot safely continue a previous conversation. */
  readonly continuation?: ContinuationAdapter;
}
