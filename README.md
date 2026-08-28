# talaria

Structured remote tool execution over Tailscale SSH.

An agent server delegates coding-tool sessions (Claude Code, Codex, ...) to a workstation
reachable over Tailscale, without giving the agent raw shell access. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Status

Working `0.1.0`: protocol, config, tool adapters, tmux-backed session persistence, the
`talaria serve` server, the SSH client + programmatic API, and the CLI. tmux ≥ 3 is used
for session persistence when available (the server falls back to a non-persistent direct
backend otherwise).

## Install

```sh
npm install -g talaria       # once published
# or, from a clone:
npm install && npm run build && npm link
```

Install on **both** machines: the agent server (VPS) and the workstation (target host).

## Setup

`talaria setup` generates a dedicated SSH key, writes default configs, and prints the
locked-down `authorized_keys` line.

**Workstation (target host):**

```sh
talaria setup --role server --allowed-dir ~/projects
# then add the printed forced-command line to ~/.ssh/authorized_keys
# ensure tmux + your tools (claude, codex) are installed and API keys are set
```

The forced-command line restricts the agent key to `talaria serve` only — no shell, no
port/agent/X11 forwarding, no PTY:

```
command="talaria serve",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... talaria-agent
```

**Agent server (VPS):**

```sh
talaria setup --role client --host my-workstation --ssh-user user
talaria ping --host desktop        # verify connectivity
```

Config lives at `~/.config/talaria/{server,client}.json`; session state and logs under
`~/.local/share/talaria/`.

## Usage

```sh
talaria run -H desktop -t claude-code -d ~/projects/app -p "Fix the auth middleware" \
  --arg model=claude-sonnet-4-6 --arg allowedTools=read,write,bash
talaria sessions -H desktop            # list sessions
talaria attach -H desktop -s a1b2c3    # reconnect and resume output
talaria kill -H desktop -s a1b2c3      # stop a running session
talaria tools -H desktop               # available tools + versions
```

Output format is selectable with `-o pretty|json|raw`.

### Programmatic API

```ts
import { TalariaClient } from 'talaria';

const client = TalariaClient.overSsh({
  tailscaleHost: 'my-workstation',
  sshUser: 'user',
  sshKey: '~/.ssh/talaria_agent_ed25519',
});

for await (const event of client.run({
  tool: 'claude-code',
  dir: '/home/user/projects/app',
  prompt: 'Fix the auth middleware',
})) {
  if (event.type === 'output') process.stdout.write(event.data);
}
```

## Development

```sh
npm install
npm run dev       # run the CLI from source
npm run typecheck
npm run lint
npm test          # tmux integration tests run when tmux is installed
```
