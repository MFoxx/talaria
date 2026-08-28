/**
 * Client-side offset cache (ARCHITECTURE §9.1).
 *
 * Maps `sessionId → last byte offset received` so `attach` without `--replay` resumes
 * exactly where the previous connection left off. Stored as JSON at
 * `~/.local/share/talaria/offsets.json`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { offsetsPath } from '../config/paths.js';

const OffsetMap = z.record(z.string(), z.number().int().nonnegative());
type OffsetMap = z.infer<typeof OffsetMap>;

export class OffsetStore {
  constructor(private readonly filePath: string = offsetsPath()) {}

  private readAll(): OffsetMap {
    try {
      const parsed = OffsetMap.safeParse(JSON.parse(readFileSync(this.filePath, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  /** Last recorded offset for a session, or undefined if none. */
  get(sessionId: string): number | undefined {
    return this.readAll()[sessionId];
  }

  /** Record the latest offset for a session (atomic write). */
  set(sessionId: string, offset: number): void {
    const all = this.readAll();
    all[sessionId] = offset;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.filePath);
  }
}
