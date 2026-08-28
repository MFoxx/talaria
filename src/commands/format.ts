/**
 * Output rendering for CLI commands (ARCHITECTURE §8.2 `outputFormat`, §9.1).
 *
 * Three formats: `pretty` (aligned tables / human text), `json` (machine-readable), and
 * `raw` (unadorned, for piping tool output). Pure functions returning strings so they're
 * trivially testable.
 */

import type { OutputFormat } from '../config/client-config.js';
import type { SessionSummary, ToolInfo } from '../protocol/messages.js';

/** Render a duration in milliseconds as e.g. `2m 15s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Render an ISO timestamp as a local `HH:MM` clock time. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Render a fixed-width table from headers and rows (2-space gutters). */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Render a session list. */
export function renderSessions(sessions: SessionSummary[], format: OutputFormat): string {
  if (format === 'json') return renderJson(sessions);
  if (sessions.length === 0) return 'No sessions.';
  const rows = sessions.map((s) => [
    s.sessionId,
    s.tool,
    s.dir,
    s.status,
    formatClock(s.startedAt),
    s.durationMs !== undefined ? formatDuration(s.durationMs) : '',
    s.exitCode !== undefined && s.exitCode !== null ? `exit ${s.exitCode}` : '',
  ]);
  return table(['ID', 'TOOL', 'DIR', 'STATUS', 'STARTED', 'DURATION', ''], rows);
}

/** Render a tool list. */
export function renderTools(tools: ToolInfo[], format: OutputFormat): string {
  if (format === 'json') return renderJson(tools);
  if (tools.length === 0) return 'No tools configured.';
  const rows = tools.map((t) => [
    t.name,
    t.version ?? '',
    t.available ? '✓ available' : `✗ ${t.error ?? 'unavailable'}`,
  ]);
  return table(['TOOL', 'VERSION', 'STATUS'], rows);
}
