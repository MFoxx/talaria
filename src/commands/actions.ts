/**
 * CLI command actions (ARCHITECTURE §9).
 *
 * Each action is a thin adapter over {@link TalariaClient} / config. Streaming commands
 * (`run`, `attach`) render events as they arrive; one-shot commands print a rendered
 * result. IO is injectable so the streaming logic is unit-testable.
 */

import type { OutputFormat } from '../config/client-config.js';
import { loadClientConfig } from '../config/client-config.js';
import { loadServerConfig } from '../config/server-config.js';
import type { Response } from '../protocol/messages.js';
import { runServe } from '../server/serve.js';
import { OffsetStore } from '../client/offsets.js';
import { makeClient, parseToolArgs } from './context.js';
import { formatDuration, renderJson, renderSessions, renderTools } from './format.js';

/** Where rendered output goes; defaults to the process streams. */
export interface Io {
  write(text: string): void;
  errLine(text: string): void;
}

const defaultIo: Io = {
  write: (text) => process.stdout.write(text),
  errLine: (text) => process.stderr.write(text + '\n'),
};

/**
 * Render a stream of session events, returning the process exit code (0 on a clean
 * `done`, 1 on failure/error). Persists the last output offset when an `OffsetStore` is
 * provided so a later `attach` can resume.
 */
export async function streamSession(
  events: AsyncIterable<Response>,
  format: OutputFormat,
  io: Io = defaultIo,
  offsets?: OffsetStore,
): Promise<number> {
  let exitCode = 0;
  let sessionId = '';
  let lastOffset: number | undefined;

  for await (const ev of events) {
    switch (ev.type) {
      case 'started':
        sessionId = ev.sessionId;
        if (format === 'json') io.write(JSON.stringify(ev) + '\n');
        else if (format === 'pretty') io.errLine(`session ${ev.sessionId} started (pid ${ev.pid})`);
        break;
      case 'attached':
        sessionId = ev.sessionId;
        if (format === 'json') io.write(JSON.stringify(ev) + '\n');
        else if (format === 'pretty') io.errLine(`attached to ${ev.sessionId} [${ev.status}]`);
        break;
      case 'output':
        lastOffset = ev.offset;
        if (format === 'json') io.write(JSON.stringify(ev) + '\n');
        else io.write(ev.data);
        break;
      case 'done':
        if (format === 'json') io.write(JSON.stringify(ev) + '\n');
        else if (format === 'pretty') {
          const code = ev.exitCode !== null ? ` (exit ${ev.exitCode})` : '';
          io.errLine(`done: ${ev.status}${code} in ${formatDuration(ev.durationMs)}`);
        }
        exitCode = ev.status === 'completed' && ev.exitCode === 0 ? 0 : 1;
        break;
      case 'error':
        if (format === 'json') io.write(JSON.stringify(ev) + '\n');
        else io.errLine(`error [${ev.code}]: ${ev.message}`);
        exitCode = 1;
        break;
      default:
        break;
    }
  }

  if (offsets && sessionId && lastOffset !== undefined) offsets.set(sessionId, lastOffset);
  return exitCode;
}

export interface RunCliOptions {
  host?: string;
  tool: string;
  dir: string;
  prompt: string;
  timeout?: number;
  arg?: string[];
  output?: OutputFormat;
}

export async function runAction(opts: RunCliOptions, io: Io = defaultIo): Promise<void> {
  const { client, format } = makeClient(opts);
  const toolArgs = parseToolArgs(opts.arg);
  const events = client.run({
    tool: opts.tool,
    dir: opts.dir,
    prompt: opts.prompt,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(Object.keys(toolArgs).length > 0 ? { toolArgs } : {}),
  });
  process.exitCode = await streamSession(events, format, io, new OffsetStore());
}

export interface AttachCliOptions {
  host?: string;
  session: string;
  replay?: boolean;
  output?: OutputFormat;
}

export async function attachAction(opts: AttachCliOptions, io: Io = defaultIo): Promise<void> {
  const { client, format } = makeClient(opts);
  const offsets = new OffsetStore();
  const offset = opts.replay ? 0 : offsets.get(opts.session);
  const events = client.attach({
    sessionId: opts.session,
    ...(offset !== undefined ? { offset } : {}),
  });
  process.exitCode = await streamSession(events, format, io, offsets);
}

export interface SessionsCliOptions {
  host?: string;
  status?: string;
  output?: OutputFormat;
}

export async function sessionsAction(opts: SessionsCliOptions, io: Io = defaultIo): Promise<void> {
  const { client, format } = makeClient(opts);
  let sessions = await client.list();
  if (opts.status) sessions = sessions.filter((s) => s.status === opts.status);
  io.write(renderSessions(sessions, format) + '\n');
}

export interface KillCliOptions {
  host?: string;
  session: string;
  output?: OutputFormat;
}

/** Options shared by simple host-scoped commands. */
export interface HostOutputOptions {
  host?: string;
  output?: OutputFormat;
}

export async function killAction(opts: KillCliOptions, io: Io = defaultIo): Promise<void> {
  const { client, format } = makeClient(opts);
  await client.kill(opts.session);
  io.write(
    (format === 'json' ? renderJson({ killed: opts.session }) : `killed ${opts.session}`) + '\n',
  );
}

export async function toolsAction(opts: HostOutputOptions, io: Io = defaultIo): Promise<void> {
  const { client, format } = makeClient(opts);
  io.write(renderTools(await client.tools(), format) + '\n');
}

export async function pingAction(opts: HostOutputOptions, io: Io = defaultIo): Promise<void> {
  const { client, format } = makeClient(opts);
  const ms = await client.ping();
  io.write((format === 'json' ? renderJson({ pong: true, ms }) : `pong (${ms}ms)`) + '\n');
}

export function configAction(io: Io = defaultIo): void {
  io.write(renderJson(loadClientConfig()) + '\n');
}

export async function serveAction(): Promise<void> {
  await runServe(loadServerConfig());
}
