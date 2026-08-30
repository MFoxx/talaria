# Providers

Talaria runs the coding-agent CLIs already installed and authenticated on the workstation. Enable only the providers you intend to use during server setup, or later with `talaria server add-tool <tool>`.

Every invocation uses the same shape:

```sh
talaria run -H desktop -t <tool> -d /absolute/allowed/project \
  -p "Your task" [--arg key=value ...]
```

Run `talaria tools -H desktop` to see the providers enabled for a host and their supported `--arg` options. Tool-specific arguments are validated before Talaria starts the provider.

## Claude Code

Tool name: `claude-code`  
Executable: `claude`

Talaria invokes Claude Code in print mode with verbose JSONL output. Native Claude conversations can be continued with `talaria continue`.

```sh
talaria run -H desktop -t claude-code -d /projects/app \
  -p "Fix the failing authentication test" \
  --arg model=claude-sonnet-4-6 --arg maxTurns=12
```

Supported arguments:

- `model` — model name.
- `allowedTools` — comma-separated list of tools Claude may use.
- `maxTurns` — maximum agent turns.
- `dangerouslySkipPermissions` — skips permission prompts; use only in an appropriately isolated environment.

Authenticate the `claude` CLI as the workstation account that runs Talaria.

## Codex

Tool name: `codex`  
Executable: `codex`

Talaria uses Codex's non-interactive `codex exec` mode with JSONL output. Native Codex threads can be continued with `talaria continue`.

```sh
talaria run -H desktop -t codex -d /projects/app \
  -p "Explain the test failures and fix the smallest root cause" \
  --arg model=gpt-5.4 --arg sandbox=workspace-write
```

Supported arguments:

- `model` — model name.
- `sandbox` — Codex sandbox policy: `read-only`, `workspace-write` (default), or `danger-full-access`.

Talaria independently restricts the working directory to the server's allowed roots. `danger-full-access` controls Codex's own sandbox and should be used deliberately.

## Cursor (beta)

Tool name: `cursor`  
Executable: `cursor-agent`, falling back to the legacy `agent` executable when appropriate.

Talaria runs Cursor Agent in print mode with streaming JSON output. Native Cursor conversations can be continued with `talaria continue`.

```sh
talaria run -H desktop -t cursor -d /projects/app \
  -p "Implement the requested validation" \
  --arg model=claude-opus --arg force=true
```

Supported arguments:

- `model` — model name.
- `force` — lets Cursor make file changes without confirmation; use with caution.

### macOS login keychain issue

Cursor support is beta. Cursor may keep its login in the macOS login keychain, while a Talaria OpenSSH forced command runs outside the interactive graphical login context. Cursor can consequently fail with:

```text
Error: Your macOS login keychain is locked.
```

Unlock the keychain interactively on the workstation, then retry:

```sh
security unlock-keychain "$HOME/Library/Keychains/login.keychain-db"
talaria tools -H desktop
```

Cursor recommends `CURSOR_API_KEY` for headless use. Talaria does not currently inject tool-specific secrets: a project `.env`, shell profile, or terminal `export` is not automatically loaded by an OpenSSH forced command. Do not put API keys in `server.json`.

## Gemini CLI

Tool name: `gemini`

Executable: `gemini`

Talaria runs Gemini CLI in headless prompt mode with streaming JSON output by default. Native Gemini sessions can be continued with `talaria continue` when the initial run uses `stream-json` output.

```sh
talaria run -H desktop -t gemini -d /projects/app \
  -p "Implement the requested validation and run its tests" \
  --arg model=gemini-2.5-pro --arg approvalMode=auto_edit
```

Supported arguments:

- `model` — model name.
- `outputFormat` — `text`, `json`, or `stream-json` (default). Talaria passes all three formats through, but native continuation requires `stream-json`.
- `debug` — enables Gemini CLI debug output.
- `includeDirectories` — comma-separated additional workspace directories.
- `yolo` — deprecated Gemini alias for auto-approving all actions; prefer `approvalMode=yolo` and use with caution.
- `approvalMode` — `default`, `auto_edit`, `yolo`, or `plan`.

The validated Talaria project directory is used as Gemini's process working directory. Talaria passes `--skip-trust` because Gemini cannot show its folder-trust dialog in a headless session; the directory has already been canonicalized and checked against the server allowlist. This bypasses Gemini's folder-trust gate, not its approval mode. Authenticate the `gemini` CLI as the workstation account that runs Talaria.

## Grok Build

Tool name: `grok`  
Executable: `grok`

Talaria runs Grok Build in print mode and requests streaming JSON by default. Native Grok sessions can be continued with `talaria continue`.

```sh
talaria run -H desktop -t grok -d /projects/app \
  -p "Investigate the regression and propose a minimal fix" \
  --arg model=grok-code-fast-1 --arg alwaysApprove=true
```

Supported arguments:

- `model` — model name.
- `outputFormat` — `plain`, `json`, or `streaming-json` (default).
- `alwaysApprove` — auto-approves tool executions; use with caution.

## Pi Code (beta)

Tool name: `pi`  
Executable: `pi`

Talaria uses Pi Code's JSON event-stream mode. Native Pi sessions can be continued with `talaria continue`.

```sh
talaria run -H desktop -t pi -d /projects/app \
  -p "Add tests for the parser" \
  --arg provider=anthropic --arg model=claude-sonnet-4-6 --arg thinking=high
```

Supported arguments:

- `provider` — Pi's LLM provider name.
- `model` — model pattern or ID.
- `thinking` — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

## Custom tools

Custom tools let you expose another approved executable behind Talaria's same `run` interface. Define its executable, explicit argument template, and accepted arguments in the server configuration. A template can use `{{prompt}}` only as a literal replacement inside an individual argument; Talaria never creates a shell command from a prompt or tool argument.

Custom tools do not automatically support native-session continuation. Use `talaria tools -H desktop` after configuring one to verify its availability and accepted arguments.
