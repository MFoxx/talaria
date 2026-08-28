/**
 * Directory validation (ARCHITECTURE §6.3, §6.4 "Directory traversal").
 *
 * The whole security model leans on this: a tool may only run inside a directory that
 * resolves — after following symlinks — to a location under one of the configured
 * `allowedDirs`. Symlinks are resolved *before* the prefix check so a symlink inside an
 * allowed dir can't point the tool at `/etc`. The prefix check is boundary-aware, so
 * `/home/user/projects` never matches a sibling like `/home/user/projects-evil`.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { TalariaError } from '../protocol/errors.js';

/** True when `child` is `parent` itself or nested beneath it (no `..` escape). */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validate a requested working directory against the allowlist and return its resolved
 * real path.
 *
 * @throws TalariaError `DIR_NOT_ALLOWED` if the path isn't absolute or resolves outside
 *   every allowed prefix; `DIR_NOT_FOUND` if it doesn't exist on disk.
 */
export function validateDir(dir: string, allowedDirs: string[]): string {
  if (!path.isAbsolute(dir)) {
    throw new TalariaError('DIR_NOT_ALLOWED', `Directory must be an absolute path: ${dir}`);
  }

  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new TalariaError('DIR_NOT_FOUND', `Directory does not exist: ${dir}`, { cause });
    }
    throw new TalariaError('DIR_NOT_ALLOWED', `Cannot resolve directory: ${dir}`, { cause });
  }

  for (const allowed of allowedDirs) {
    let realAllowed: string;
    try {
      realAllowed = realpathSync(allowed);
    } catch {
      // An allowed prefix that doesn't exist can't match anything — skip it.
      continue;
    }
    if (isWithin(realAllowed, resolved)) {
      return resolved;
    }
  }

  throw new TalariaError('DIR_NOT_ALLOWED', `Directory is not in the allowed list: ${dir}`);
}
