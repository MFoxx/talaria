# talaria

Structured remote tool execution over Tailscale SSH. Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

Working `0.1.0` (M1–M4 complete). Layout:

- `src/protocol/` — wire messages, errors, JSONL/output-log framing (zod schemas shared by both ends)
- `src/config/` — server/client config + XDG paths
- `src/adapters/` — tool adapters (claude-code, codex, cursor, generic) + registry
- `src/server/` — `serve` loop, runner, session store, tmux/direct process managers, dir validation
- `src/client/` — SSH transport, `TalariaClient`, offset cache
- `src/commands/` + `src/cli.ts` — commander CLI (run/attach/sessions/kill/tools/ping/config/setup/serve)

tmux ≥ 3 is the persistence backend (verified via `src/server/tmux.integration.test.ts`, which
skips when tmux is absent); `DirectProcessManager` is the fallback. The `serve` connection loop is
one-request-per-connection over JSONL on stdio.

## Stack

- TypeScript (strict), ESM (`"type": "module"`, `NodeNext` resolution)
- npm as the package manager — commit `package-lock.json`
- ESLint (flat config, typescript-eslint) + Prettier
- Vitest for tests

## Commands

- `npm run build` — compile to `dist/`
- `npm run dev` — run the CLI from source via `tsx`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` / `npm run lint:fix`
- `npm run format` / `npm run format:check`
- `npm test` — Vitest

Run `typecheck`, `lint`, and `test` before considering a change done.

## Conventions

- No `any` — it's an ESLint error (`@typescript-eslint/no-explicit-any`), not a warning.
- Tool adapters must build argv arrays explicitly; never shell-interpolate user/prompt input into
  a command string (see docs/ARCHITECTURE.md §7 and the threat table in §6).
- This tool executes commands on a remote host on the agent's behalf. Treat anything touching
  spawn/exec, path resolution, or the server config whitelist as security-sensitive — flag
  shortcuts instead of taking them.
