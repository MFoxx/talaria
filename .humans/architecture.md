# Talaria architecture, for humans

Talaria lets you start a coding agent on a machine that has the code, credentials, and development tools you need—even when you are working from somewhere else. It is deliberately a small remote-control layer, not a hosted IDE or an agent framework.

There are two sides:

- The **controller** is where you run `talaria` or use the JavaScript library. It might be your laptop, a CI job, or another orchestrator.
- The **workstation** is where the repository and coding-agent CLI live. It runs the actual work.

## The big picture

```text
You, a script, or another service
             |
             | talaria run / attach / continue / kill
             v
       Controller machine
             |
             | SSH + small, validated JSON messages
             v
       Workstation machine
             |
             v
  Talaria checks policy and starts an approved coding tool
             |
             v
 Claude Code / Codex / Cursor / Grok / Pi / custom tool
```

The workstation keeps the source code, build caches, local services, and provider login. The controller only tells it what job to run and receives events and output as the job progresses.

## What happens when you run a task

When you run a command such as:

```sh
talaria run -H desktop -t codex -d /projects/app -p "Fix the failing test"
```

Talaria does the following:

1. The controller opens an SSH connection to `desktop`.
2. It sends one structured request: which enabled tool to use, which project directory to use, and the prompt.
3. The workstation validates that request against its configuration.
4. It starts the requested provider with a fixed executable and an explicit list of command-line arguments.
5. It saves session details and streams the provider's output back over the SSH connection.
6. When the work finishes—or is stopped, times out, or reaches an output limit—Talaria records the result.

Each command uses a fresh SSH connection. Talaria is not a continually running network daemon. Saved session state, and `tmux` when installed, are what make it possible to reconnect to work later.

## Sessions and conversations

A **session** is one execution of a coding tool. It has an ID, output, status, and timestamps. You can list it, attach to its output, or stop it.

A **conversation** is a chain of related sessions. When a provider supports continuation, `talaria continue` starts a _new_ session that tells the provider to resume its own native conversation. It never revives the old process.

Talaria stores each session on the workstation with its metadata and append-only output. That output has positions, so an attachment can resume from where you last read rather than replaying everything.

```text
first run ──> session A ──> provider-native conversation ID
                                      |
talaria continue ────────────────────┘
                                      v
                               session B (new process)
```

## Why tools are adapters

Coding-agent CLIs do not all use the same flags or output formats. Talaria gives them a shared interface by using a small adapter for each provider.

An adapter knows:

- how to check whether its CLI is installed;
- which tool-specific options are allowed;
- the exact executable and argument list to start;
- how to recognize a provider's native session ID, when continuation is supported.

This means a prompt is never pasted into a shell command. Talaria runs an executable with individual arguments, which avoids shell interpretation and makes each supported option explicit.

## The security boundary

The workstation's server configuration is the central policy document. It says:

- which tools may run;
- which project directories they may use;
- how much time, concurrent work, and output each session may consume; and
- where Talaria may keep its state.

Before starting work, Talaria resolves the requested directory and checks the real location against the allowed roots. This prevents a symlink from escaping an approved project tree. It also rejects unknown request fields and unknown tool options.

For transport, Talaria supports two choices:

| Transport              | What it provides                                                   | Important tradeoff                                                   |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| OpenSSH over Tailscale | A dedicated SSH key can be restricted to run only `talaria serve`. | Requires SSH-key setup.                                              |
| Tailscale SSH          | Tailnet identity without managing SSH keys.                        | Cannot apply OpenSSH's `authorized_keys` forced-command restriction. |

On macOS, setup can create a limited non-admin service account for the Tailscale SSH case. Keep tailnet rules tightly scoped and enable only the tools and directories you need.

## Where things live

On a typical system, Talaria keeps configuration and saved session state in XDG-style locations:

```text
~/.config/talaria/client.json   controller hosts and transport settings
~/.config/talaria/server.json   workstation policy and limits
~/.local/share/talaria/         workstation session metadata and logs
```

The client configuration explains how to reach a workstation. The server configuration controls what it may do once reached. Treat the server configuration as sensitive operational policy: do not add API keys to it.

## How the code is organized

The source layout mirrors the journey of a request:

| Area                             | Responsibility                                                         |
| -------------------------------- | ---------------------------------------------------------------------- |
| `src/commands/` and `src/cli.ts` | Turn CLI input into operations and present results.                    |
| `src/client/`                    | Connect over SSH and expose the programmatic `TalariaClient`.          |
| `src/protocol/`                  | Define and validate the messages shared by both sides.                 |
| `src/server/`                    | Validate requests, enforce policy, run processes, and manage sessions. |
| `src/adapters/`                  | Translate a tool-neutral request into a provider-specific invocation.  |
| `src/config/`                    | Read, validate, and locate configuration.                              |

The public JavaScript interface is `TalariaClient`. It intentionally hides SSH details and provides streaming methods for work that emits output over time, plus ordinary promise-returning methods for things such as listing sessions and checking health.

## Design principles

Talaria is built around a few deliberately boring choices:

- SSH is the transport and authentication layer; Talaria does not invent another one.
- Protocol messages are strict and typed, so both client and server agree on what is allowed.
- Provider invocations use executable-plus-arguments, never a generated shell command.
- Session state lives on the workstation, so a lost connection does not necessarily lose the work.
- The narrow interface makes the tool useful under a terminal, a scheduler, CI, or another agent system.
