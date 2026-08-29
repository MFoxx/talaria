import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { TalariaClient } from './talaria-client.js';
import { buildSshArgs, buildTailscaleSshArgs, type Connector } from './transport.js';
import { buildContext, serveConnection } from '../server/serve.js';
import { parseServerConfig } from '../config/server-config.js';
import type { HandlerContext } from '../server/handlers.js';
import { isTalariaError } from '../protocol/errors.js';

const NODE = process.execPath;

/** A connector that runs the server in-process over a pair of pipes. */
function inProcessConnector(ctx: HandlerContext): Connector {
  return () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const exit = serveConnection(ctx, toServer, toClient).then(() => {
      toClient.end();
      return { code: 0, signal: null };
    });
    return { stdin: toServer, stdout: toClient, exit };
  };
}

describe('TalariaClient over an in-process server', () => {
  let workDir: string;
  let sessionDir: string;
  let client: TalariaClient;

  beforeEach(() => {
    workDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talaria-cli-work-')));
    sessionDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talaria-cli-sess-')));
    const script = 'process.stdout.write("out:{{prompt}}");process.exit(0)';
    const config = parseServerConfig({
      tools: ['echo-tool'],
      allowedDirs: [workDir],
      sessionDir,
      customTools: [{ name: 'echo-tool', bin: NODE, argsTemplate: ['-e', script] }],
    });
    const ctx = buildContext(config, { tailPollMs: 10 });
    client = new TalariaClient(inProcessConnector(ctx));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('runs a tool and streams events', async () => {
    const events = [];
    for await (const ev of client.run({ tool: 'echo-tool', dir: workDir, prompt: 'HELLO' })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(['started', 'output', 'done']);
    const output = events
      .filter((e) => e.type === 'output')
      .map((e) => e.data)
      .join('');
    expect(output).toBe('out:HELLO');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed', exitCode: 0 });
  });

  it('pings, lists, and reports status', async () => {
    // Run one session so there's something to list.
    let sessionId = '';
    for await (const ev of client.run({ tool: 'echo-tool', dir: workDir, prompt: 'X' })) {
      if (ev.type === 'started') sessionId = ev.sessionId;
    }

    expect(await client.ping()).toBeGreaterThanOrEqual(0);

    const sessions = await client.list();
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);

    const status = await client.status(sessionId);
    expect(status).toMatchObject({ status: 'completed', exitCode: 0 });

    const tools = await client.tools();
    expect(tools.map((t) => t.name)).toContain('echo-tool');
  });

  it('raises a protocol error as a TalariaError', async () => {
    try {
      await client.status('deadbeef');
      expect.unreachable();
    } catch (err) {
      expect(isTalariaError(err) && err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('surfaces a connection failure with stderr', async () => {
    const failing: Connector = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end('Permission denied (publickey).');
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        exit: Promise.resolve({ code: 255, signal: null }),
      };
    };
    const c = new TalariaClient(failing);
    try {
      await c.ping();
      expect.unreachable();
    } catch (err) {
      if (!isTalariaError(err)) throw err;
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toContain('Permission denied (publickey).');
    }
  });

  it('surfaces remote stderr when an SSH wrapper exits zero without a response', async () => {
    const failing: Connector = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end('zsh:1: command not found: talaria');
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        label: 'tailscale',
        exit: Promise.resolve({ code: 0, signal: null }),
      };
    };
    const c = new TalariaClient(failing);
    try {
      await c.ping();
      expect.unreachable();
    } catch (err) {
      if (!isTalariaError(err)) throw err;
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toContain('zsh:1: command not found: talaria');
    }
  });
});

describe('buildSshArgs', () => {
  it('assembles ssh argv with key, batch mode, and remote command', () => {
    const args = buildSshArgs({
      tailscaleHost: 'workstation',
      sshUser: 'user',
      sshKey: '/home/me/.ssh/talaria',
      sshOptions: ['-o', 'ConnectTimeout=10'],
    });
    expect(args).toEqual([
      '-i',
      '/home/me/.ssh/talaria',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'user@workstation',
      'talaria serve',
    ]);
  });

  it('assembles tailscale ssh argv without a private key', () => {
    const args = buildTailscaleSshArgs({
      transport: 'tailscale-ssh',
      tailscaleHost: 'workstation',
      sshUser: 'user',
    });
    expect(args).toEqual(['ssh', 'user@workstation', 'talaria serve']);
  });

  it('supports an explicit Tailscale SSH server command', () => {
    const args = buildTailscaleSshArgs({
      transport: 'tailscale-ssh',
      tailscaleHost: 'workstation',
      sshUser: 'user',
      serverCommand: '/opt/talaria/bin/talaria serve',
    });
    expect(args).toEqual(['ssh', 'user@workstation', '/opt/talaria/bin/talaria serve']);
  });
});
