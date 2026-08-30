# Talaria

Run and orchestrate coding agents on another machine—without moving your repositories, credentials, or development environment there.

Talaria turns a workstation reachable through Tailscale into a remote execution target for Claude Code, Codex, Cursor (beta), Grok, OpenCode, Pi Code (beta), and custom tools. Start work from a laptop, server, automation, or your own orchestrator; stream the result live; disconnect and reconnect; inspect or stop sessions; and continue supported tool-native conversations.

```sh
talaria run -H desktop -t codex -d ~/projects/my-app \
  -p "Find the checkout regression, fix it, and run the relevant tests"
```

## Why Talaria?

Your best development machine is often not the machine initiating the work. Talaria keeps source trees, build caches, language runtimes, local services, and agent credentials on the workstation while exposing a small, structured orchestration interface.

With Talaria you can:

- dispatch coding work to configured remote hosts;
- choose among approved coding-agent CLIs through one command shape;
- stream stdout and stderr as typed events for people or automation;
- leave work running and resume its output without replaying everything;
- list, inspect, time out, and terminate sessions;
- continue supported native agent conversations in new executions;
- embed `TalariaClient` in a larger orchestrator; and
- restrict execution to explicitly allowed tools and project directories.

Talaria is not a remote shell, hosted IDE, or agent framework. It is the narrow execution layer between an orchestrator and the coding tools already installed on your machines.

## Install

Install Talaria on both the controller and the workstation:

```sh
npm install -g talaria
talaria setup
```

Choose `server` on the workstation that owns the repositories and tools, and `client` on the machine initiating work. See [Installation and setup](docs/install.md) for requirements, security tradeoffs, and non-interactive configuration.

Then verify the host and start a task:

```sh
talaria ping -H desktop
talaria tools -H desktop
talaria run -H desktop -t codex -d ~/projects/my-app -p "Explain this codebase"
```

## How it works

The controller opens an SSH connection and sends one validated JSON request to `talaria serve` on the workstation. Talaria translates it into an explicit argv invocation for an approved tool, records session metadata and output, and streams structured events back. tmux keeps processes alive across connection loss when available; a direct-process backend is the non-persistent fallback.

Talaria supports two transports:

- **OpenSSH over your tailnet** uses a dedicated key restricted to `talaria serve` and provides the strongest command-level isolation.
- **Tailscale SSH** provides keyless tailnet authentication. Because it cannot enforce an OpenSSH forced command, Talaria can provision a restricted service account on macOS and recommends tightly scoped tailnet policy.

## Orchestrate sessions

```sh
# Start a task and stream output.
talaria run -H desktop -t claude-code -d ~/projects/app -p "Fix the auth middleware"

# Find work, reconnect, or replay from the beginning.
talaria sessions -H desktop
talaria attach -H desktop -s a1b2c3
talaria attach -H desktop -s a1b2c3 --replay

# Stop a task or continue its underlying conversation.
talaria kill -H desktop -s a1b2c3
talaria continue -H desktop -c 0123456789abcdef01234567 -p "Now add regression tests"
```

Use `-o pretty`, `-o json`, or `-o raw` for human-readable, JSONL, or unadorned output. Repeat `--arg key=value` for supported tool-specific options.

## Build an orchestrator

The programmatic client exposes the same session model:

```ts
import { TalariaClient } from 'talaria';

const client = TalariaClient.overSsh({
  tailscaleHost: 'my-workstation',
  sshUser: 'me',
  sshKey: '~/.ssh/talaria_agent_ed25519',
});

for await (const event of client.run({
  tool: 'codex',
  dir: '/home/me/projects/app',
  prompt: 'Fix the failing integration test',
})) {
  if (event.type === 'output') process.stdout.write(event.data);
  if (event.type === 'started') console.error(`session: ${event.sessionId}`);
}
```

Streaming methods return async iterables of typed events. Session listing, status, termination, tool discovery, and health checks return promises. Talaria can therefore sit beneath schedulers, chat bots, CI jobs, multi-host dispatchers, and other agent-control systems.

## Security

Talaria runs tools that can edit files and execute commands. Treat workstation configuration as security policy: enable only necessary tools and project roots, prefer OpenSSH when forced-command isolation matters, and tightly scope Tailscale rules and OS-user access.

Prompts and tool arguments are argv entries, never shell-interpolated. Working directories are resolved and checked against the server allowlist before execution.

## Contributing

Contributions are welcome. For substantial behavior or design changes, open an issue first so the approach can be discussed. Keep pull requests focused, include tests, describe user-visible and security implications, and run:

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run format:check
```

Maintainer architecture notes live in [`.AGENTS/ARCHITECTURE.md`](.AGENTS/ARCHITECTURE.md).

## Issues and feature requests

[Open an issue](https://github.com/MFoxx/talaria/issues/new) for bugs or feature requests. For bugs, include your OS, Node and Talaria versions, transport, command, expected result, and relevant redacted output. For features, describe the workflow you want to enable. Search existing issues first and never include credentials, private source, SSH keys, or unredacted configuration.

## Support Talaria

If Talaria makes remote agent orchestration useful for you, please [star the repository](https://github.com/MFoxx/talaria). It helps other builders discover the project and shows that open orchestration tooling matters.

Talaria is available under the [MIT License](LICENSE).
