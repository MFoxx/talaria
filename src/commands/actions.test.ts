import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamSession, type Io } from './actions.js';
import { OffsetStore } from '../client/offsets.js';
import type { Response } from '../protocol/messages.js';

async function* gen(items: Response[]): AsyncGenerator<Response> {
  await Promise.resolve();
  for (const item of items) yield item;
}

function collectIo(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (t) => out.push(t), errLine: (t) => err.push(t) };
}

const started: Response = {
  type: 'started',
  sessionId: 'sid',
  conversationId: 'conversation',
  tool: 't',
  dir: '/p',
  pid: 1,
  tmuxSession: 'talaria-sid',
};
const output: Response = { type: 'output', stream: 'stdout', data: 'hello', offset: 42 };
const doneOk: Response = {
  type: 'done',
  sessionId: 'sid',
  conversationId: 'conversation',
  exitCode: 0,
  signal: null,
  durationMs: 1200,
  status: 'completed',
};
const doneFail: Response = {
  type: 'done',
  sessionId: 'sid',
  conversationId: 'conversation',
  exitCode: 1,
  signal: null,
  durationMs: 5,
  status: 'failed',
};
const errorMsg: Response = { type: 'error', code: 'DIR_NOT_ALLOWED', message: 'nope' };

describe('streamSession', () => {
  it('pretty: writes raw output to stdout, status to stderr, exit 0', async () => {
    const io = collectIo();
    const code = await streamSession(gen([started, output, doneOk]), 'pretty', io);
    expect(code).toBe(0);
    expect(io.out.join('')).toBe('hello');
    expect(io.err.some((l) => l.includes('started'))).toBe(true);
    expect(io.err.some((l) => l.includes('done: completed'))).toBe(true);
  });

  it('json: emits one JSON line per event', async () => {
    const io = collectIo();
    await streamSession(gen([started, output, doneOk]), 'json', io);
    const lines = io.out.join('').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'output', data: 'hello' });
  });

  it('raw: writes only output data', async () => {
    const io = collectIo();
    await streamSession(gen([started, output, doneOk]), 'raw', io);
    expect(io.out.join('')).toBe('hello');
    expect(io.err).toEqual([]);
  });

  it('returns exit 1 on a failed done', async () => {
    const io = collectIo();
    expect(await streamSession(gen([started, doneFail]), 'pretty', io)).toBe(1);
  });

  it('returns exit 1 and reports a protocol error', async () => {
    const io = collectIo();
    expect(await streamSession(gen([errorMsg]), 'pretty', io)).toBe(1);
    expect(io.err.some((l) => l.includes('DIR_NOT_ALLOWED'))).toBe(true);
  });

  it('persists the last offset when an OffsetStore is given', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'talaria-act-'));
    try {
      const offsets = new OffsetStore(path.join(root, 'offsets.json'));
      const io = collectIo();
      await streamSession(gen([started, output, doneOk]), 'raw', io, offsets);
      expect(offsets.get('sid')).toBe(42);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
