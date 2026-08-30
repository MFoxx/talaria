# talaria

Talaria is a TypeScript CLI and library for orchestrating coding-agent sessions on remote machines over SSH. A controller sends structured requests to `talaria serve` on a workstation; the server validates them, starts an approved tool, persists session state and output, and streams typed events back. Sessions can later be listed, attached to, stopped, or continued.

Read [`.AGENTS/ARCHITECTURE.md`](.AGENTS/ARCHITECTURE.md) before changing module seams, the wire protocol, process execution, session persistence, or transport behavior. Keep `docs/` for user-facing documentation.

## Project map

- `src/protocol/` — shared Zod schemas, errors, JSONL messages, and framed output logs.
- `src/config/` — validated client/server configuration and XDG paths.
- `src/adapters/` — tool adapters, built-in coding agents, and custom tools.
- `src/server/` — dispatch, execution, process backends, validation, persistence, and reaping.
- `src/client/` — SSH transports, the programmatic client, and reconnect offsets.
- `src/commands/` — CLI actions, output formatting, and guided setup.
- `src/cli.ts` — Commander wiring and process-level error handling.
- `src/index.ts` — public library exports.
- `docs/` — public documentation.
- `.AGENTS/` — internal architecture and maintainer context.

## Toolchain

- TypeScript in strict mode, ESM, and NodeNext module resolution.
- Node.js 20 or newer; npm is the package manager. Commit `package-lock.json` changes.
- ESLint with typescript-eslint, Prettier, and Vitest.

## Commands

- `npm install` — install dependencies.
- `npm run dev -- <command>` — run the CLI from source.
- `npm run build` — compile into `dist/`.
- `npm run typecheck` — check TypeScript without emitting files.
- `npm run lint` / `npm run lint:fix` — check or fix lint violations.
- `npm run format` / `npm run format:check` — write or verify formatting.
- `npm test` — run Vitest; external integration tests skip when prerequisites are absent.

Before considering a change complete, run `npm run typecheck`, `npm run lint`, and `npm test`. Run `npm run format:check` for documentation or formatting-sensitive changes.

## Engineering guidelines

- Do not use `any`; `@typescript-eslint/no-explicit-any` is an error.
- Keep CLI wiring thin. Put behavior behind explicit interfaces in command, client, server, protocol, or adapter modules.
- Treat protocol schemas as the source of truth. Both endpoints validate with the shared schemas; protocol changes require tests on both sides of the seam.
- Tool adapters must construct an executable and explicit argv array. Never interpolate prompts, paths, or tool arguments into a shell command.
- Validate and canonicalize remote working directories before execution. Preserve allowlist and symlink protections.
- Treat spawn/exec, executable lookup, SSH setup, paths, environment variables, and server allowlists as security-sensitive.
- Reserve `serve` stdout for JSONL protocol traffic; diagnostics belong on stderr or in the log.
- Add or update tests with behavior changes. Prefer injected dependencies and test a module through its interface.
