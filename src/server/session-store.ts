/**
 * Session state on disk (ARCHITECTURE §4.4).
 *
 * Each session is a directory under the configured session root:
 *   <root>/<id>/meta.json     immutable metadata + mutable status
 *   <root>/<id>/output.log    append-only framed stdout+stderr, addressable by byte offset
 *
 * `meta.json` is written atomically (temp + rename) so a crash mid-write can't leave a
 * half-written file. Output reads seek by byte offset, which is the same offset the
 * protocol hands clients for resuming an attach.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TalariaError } from '../protocol/errors.js';
import { SessionStatus, ToolArgs } from '../protocol/messages.js';
import { encodeFrame } from '../protocol/framing.js';
import type { StreamName } from '../protocol/messages.js';

export const SessionMeta = z.strictObject({
  sessionId: z.string(),
  tool: z.string(),
  dir: z.string(),
  prompt: z.string(),
  toolArgs: ToolArgs,
  tmuxSession: z.string(),
  pid: z.number().int().nullable(),
  startedAt: z.string(),
  status: SessionStatus,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  endedAt: z.string().nullable(),
  timeout: z.number().int().positive(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

/** Bytes read back from the output log, plus the log's current total size. */
export interface OutputSlice {
  data: string;
  totalBytes: number;
}

export class SessionStore {
  constructor(private readonly root: string) {}

  private dir(id: string): string {
    return path.join(this.root, id);
  }

  metaPath(id: string): string {
    return path.join(this.dir(id), 'meta.json');
  }

  outputLogPath(id: string): string {
    return path.join(this.dir(id), 'output.log');
  }

  /**
   * Scratch file for a backend that captures raw (unframed) pane bytes — e.g. tmux
   * `pipe-pane`. The backend tails this and forwards chunks; the framed `output.log`
   * remains the protocol source of truth.
   */
  rawOutputPath(id: string): string {
    return path.join(this.dir(id), 'output.raw');
  }

  exists(id: string): boolean {
    return existsSync(this.metaPath(id));
  }

  /** Create the session directory, write meta, and open an empty output log. */
  create(meta: SessionMeta): void {
    mkdirSync(this.dir(meta.sessionId), { recursive: true });
    this.writeMeta(meta);
    // Touch the log so readers never hit ENOENT before the first write.
    const logPath = this.outputLogPath(meta.sessionId);
    if (!existsSync(logPath)) writeFileSync(logPath, '');
  }

  readMeta(id: string): SessionMeta {
    let text: string;
    try {
      text = readFileSync(this.metaPath(id), 'utf8');
    } catch (cause) {
      throw new TalariaError('SESSION_NOT_FOUND', `No such session: ${id}`, { cause });
    }
    const parsed = SessionMeta.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new TalariaError('INTERNAL', `Corrupt session metadata: ${id}`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  /** Atomically write metadata (temp file + rename). */
  writeMeta(meta: SessionMeta): void {
    const target = this.metaPath(meta.sessionId);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, target);
  }

  /** Read, shallow-merge a patch, and persist. Returns the updated meta. */
  updateMeta(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const merged = { ...this.readMeta(id), ...patch };
    this.writeMeta(merged);
    return merged;
  }

  /** All sessions on disk, newest first; unreadable directories are skipped. */
  list(): SessionMeta[] {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const id of entries) {
      if (!this.exists(id)) continue;
      try {
        metas.push(this.readMeta(id));
      } catch {
        // Skip corrupt/partial sessions rather than failing the whole listing.
      }
    }
    return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  delete(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** Append one output frame; returns the log's new total byte size. */
  appendOutput(id: string, stream: StreamName, data: string, ts?: number): number {
    const logPath = this.outputLogPath(id);
    appendFileSync(logPath, encodeFrame(stream, data, ts));
    return statSync(logPath).size;
  }

  /** Current byte size of the output log (0 if absent). */
  outputSize(id: string): number {
    try {
      return statSync(this.outputLogPath(id)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Read raw output-log bytes from `offset` to end. Offsets are expected to fall on
   * frame boundaries (that's what the protocol emits), so the returned text decodes
   * cleanly as whole frames.
   */
  readOutputFrom(id: string, offset: number): OutputSlice {
    const logPath = this.outputLogPath(id);
    let fd: number;
    try {
      fd = openSync(logPath, 'r');
    } catch (cause) {
      throw new TalariaError('SESSION_NOT_FOUND', `No output log for session: ${id}`, { cause });
    }
    try {
      const size = fstatSync(fd).size;
      const start = Math.min(Math.max(offset, 0), size);
      const len = size - start;
      if (len === 0) return { data: '', totalBytes: size };
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      return { data: buf.toString('utf8'), totalBytes: size };
    } finally {
      closeSync(fd);
    }
  }
}
