# Talaria architecture

This is internal context for maintainers and coding agents. Public setup and usage belong in `README.md` and `docs/`.

## 1. System model

Talaria connects a **controller**, where a person or orchestrator invokes the CLI or library, to a **workstation**, where repositories, credentials, and coding-agent CLIs live. SSH invokes `talaria serve` on the workstation.

Each command opens a fresh SSH connection. The client writes one JSONL request to stdin, the server streams JSONL responses on stdout, and the connection closes when the request completes. Talaria has no resident daemon. On-disk state and, when available, tmux connect successive requests and let work survive a lost client connection.

```text
CLI / TalariaClient
        |
        | one JSONL request, streamed JSONL responses
        v
OpenSSH or Tailscale SSH
        |
        v
talaria serve -> handlers -> Runner -> ToolAdapter -> coding-agent process
                              |              |
                              v              v
                         SessionStore    explicit argv
```

## 2. Main seams

- `TalariaClient` exposes orchestration operations without exposing SSH or framing.
- `Connector` opens a bidirectional channel. OpenSSH, Tailscale SSH, and in-process tests are adapters at this seam.
- Shared protocol schemas define everything either endpoint may send.
- `ToolAdapter` translates a tool-neutral request into an executable, argv, environment, and optional continuation behavior.
- `ProcessManager` owns process lifetime; direct child processes and tmux are its adapters.
- `SessionStore` owns durable session layout and byte-offset output reads.

Keep these modules deep: callers should not need to understand SSH arguments, tool flags, tmux plumbing, or session files.

## 3. Request lifecycle

1. `src/cli.ts` parses a command and delegates to `src/commands/`.
2. The action resolves a configured host and constructs a `TalariaClient`.
3. `Transport.send()` opens a channel, writes one request, and validates every response.
4. `runServe()` assembles server dependencies; `serveConnection()` reads exactly one request.
5. `src/server/handlers.ts` dispatches the strictly validated request.
6. For execution, `Runner` applies limits and directory checks, selects a tool adapter, creates session metadata, and starts the process through `ProcessManager`.
7. Output is appended to the framed log before offset-bearing events are emitted.
8. Exit, kill, timeout, or output-limit termination updates metadata and emits a terminal response.

One request per connection keeps server invocations isolated and leaves authentication and transport to SSH. Session state, rather than a socket-owning daemon, joins separate commands.

## 4. Sessions and conversations

An execution is a **session**. A sequence of tool-native turns is a **conversation**. Continuing creates a new session linked to the conversation; it does not reuse the old process.

`SessionStore` creates one directory per session:

```text
<session-root>/<session-id>/
  meta.json
  output.log
  output.raw       # backend scratch space when tmux needs it
```

Metadata is replaced atomically. The append-only output log frames stdout and stderr and exposes byte offsets. Attach requests resume from an offset, and the CLI caches its latest offsets locally. Filesystem-backed conversation locks prevent concurrent follow-ups. Adapters supporting continuation extract and persist the coding tool's native session ID.

The reaper removes expired terminal sessions according to server retention settings. Running metadata is reconciled with the process backend before requests are handled.

## 5. Protocol

`src/protocol/messages.ts` is the wire-format source of truth. Strict Zod objects reject unknown fields. `src/protocol/framing.ts` implements newline-delimited JSON for SSH traffic and framed records for persisted output.

Streaming operations yield `started`, `attached`, `output`, `done`, and `error` events. One-shot operations return typed list, status, kill, tool, or ping responses. Expected failures use stable `TalariaError` codes.

Protocol changes must remain compatible with persisted sessions or include a migration. Update schemas, types, handlers, client methods, renderers, and tests together.

## 6. Security model

The server configuration is a security policy:

- `tools` is an allowlist; unknown or disabled adapters cannot run.
- `allowedDirs` constrains working directories after realpath and symlink resolution.
- time, concurrency, output-size, and retention limits bound resource use.
- built-in executable paths are absolute and pinned during setup.
- adapters return `bin` plus `args[]`; processes run with `shell: false`.
- protocol objects are strict and adapter-specific arguments are validated.

OpenSSH mode installs a forced-command key and disables forwarding and PTY allocation. Tailscale SSH supplies tailnet authentication but cannot enforce an `authorized_keys` forced command; macOS setup can provision a restricted non-admin account to narrow execution.

Never weaken directory validation, turn argv into command strings, inherit an untrusted executable path, or write non-protocol output to server stdout.

## 7. Tool adapters

Built-ins cover Claude Code, Codex, Cursor, Grok, and Pi Code (beta). Generic tools are declared in server config with an executable, argv template, and accepted argument definitions.

An adapter owns its metadata and accepted arguments, installation probe, spawn construction, and optional native-session continuation behavior. The registry is the authoritative runtime allowlist. Adding a built-in requires the adapter, registry entry, config/setup validation and executable pinning, plus exact-argv tests. Unrecognized tool arguments must never pass through.

## 8. Configuration and storage

Configuration follows XDG locations, normally:

- `~/.config/talaria/client.json` — hosts, transports, and client defaults.
- `~/.config/talaria/server.json` — tools, allowed paths, storage, and limits.
- `~/.local/share/talaria/` — sessions and logs.

Config parsers are pure normalization modules; file loaders are thin wrappers. Keep defaults and cross-field invariants in parsers so setup, runtime, and tests share the rules. Tilde expansion is intentionally narrower than shell expansion.

## 9. CLI and setup

`src/cli.ts` declares commands; actions adapt parsed options to the client and render results. `pretty`, `json`, and `raw` modes serve people, automation, and direct output consumption.

Setup is divided into prompts, prerequisite checks, runtime resolution, and macOS isolation. It writes config and may change SSH or OS-account state. Preserve preview and confirmation behavior and independently test interactive and flag-driven paths.

## 10. Programmatic client

`TalariaClient`, exported by `src/index.ts`, is the public orchestration interface. Streaming methods return async generators and one-shot methods return promises. The injectable `Connector` lets tests connect real client and server logic with streams, without starting SSH. Keep CLI rendering and SSH-specific details outside this interface.

## 11. Verification

- Protocol tests cover schemas and framing.
- Adapter tests assert exact argv and invalid-argument rejection.
- Client/server tests use injected streams and dependencies at real interfaces.
- Store, validation, limits, reaping, process, command, and setup behavior have focused tests.
- tmux and SSH integration tests run real external programs when available and skip otherwise.

Always run type checking, linting, and tests. Security-sensitive changes also need adversarial cases for paths, argv, environment values, malformed messages, and termination.
