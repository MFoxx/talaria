# talaria

Structured remote tool execution over SSH carried by Tailscale.

An agent server delegates coding-tool sessions (Claude Code, Codex, ...) to a workstation
reachable over Tailscale. The default OpenSSH transport denies raw shell access; an
optional Tailscale SSH transport trades that forced-command boundary for keyless tailnet
authentication. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the core design.

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

Talaria supports two SSH transports. `openssh` is the default and preserves the
strongest command-level isolation. `tailscale-ssh` removes key distribution and host-key
management, with the security tradeoff described below. Install Talaria, tmux, and the
enabled tools (`claude`, `codex`, and so on) on the workstation in both modes.

### Option A: OpenSSH over Tailscale

On the workstation:

```sh
talaria setup --role server --transport openssh --allowed-dir ~/projects
```

On the controller:

```sh
talaria setup --role client --transport openssh \
  --host my-workstation --ssh-user user
```

Add the printed line to the workstation user's `~/.ssh/authorized_keys` (create the file
if needed). The dedicated key is restricted to `talaria serve`—no shell, port/agent/X11
forwarding, or PTY:

```
command="talaria serve",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... talaria-agent
```

#### Running OpenSSH mode from a clone

`npm link` (or a global npm install) makes the printed `command="talaria serve"` entry
work. If you run Talaria with `node ./dist/cli.js` instead, the forced command needs
absolute paths and an explicit `PATH`. SSH forced commands are non-interactive and do
not load your shell startup files, so a tool such as `claude` can otherwise appear to be
missing even though it works in your terminal.

On the workstation, find the relevant paths:

```sh
command -v node
command -v claude # and/or: command -v codex
```

Then replace the `command="..."` portion of the `authorized_keys` entry with a command
like this, keeping the restrictions and public key unchanged:

```
command="PATH=/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /absolute/path/to/node /absolute/path/to/talaria/dist/cli.js serve",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... talaria-agent
```

`PATH` entries are directories, not executable paths. Include the parent directory of
every enabled tool (`claude`, `codex`, and so on) and use the exact absolute Node path
from `command -v node`.

### Option B: Tailscale SSH

Install compatible Tailscale versions on both machines. On the workstation, configure
the Talaria server and enable Tailscale's SSH server:

```sh
talaria setup --role server --transport tailscale-ssh --allowed-dir ~/projects
tailscale set --ssh=true
```

On the controller:

```sh
talaria setup --role client --transport tailscale-ssh \
  --host my-workstation --ssh-user user
talaria ping --host desktop
```

This mode generates no SSH key and does not use `authorized_keys`. The client runs
`tailscale ssh user@host "talaria serve"`; Tailscale supplies authentication and host-key
verification. Configure the tailnet policy to permit both network access and Tailscale
SSH only from the controller identity/tag to the workstation identity/tag and intended
OS user. An `accept` SSH rule is suitable for unattended Talaria calls; a `check` rule can
require interactive reauthentication and is therefore unsuitable when Talaria must run
fully unattended.

Security tradeoff: built-in Tailscale SSH policy restricts who may connect, to which
machine, and as which OS user, but it does **not** enforce an `authorized_keys`-style
forced command. A controller allowed by that policy can request commands other than
`talaria serve`. Use OpenSSH mode when the controller must not have shell access. To
isolate Tailscale SSH further, use a dedicated OS account with tightly scoped filesystem
permissions or a restricted login shell; Talaria does not configure that privileged OS
policy automatically. See the [Tailscale SSH security model and policy setup](https://tailscale.com/docs/features/tailscale-ssh).

The Tailscale CLI's `ssh` wrapper is unavailable in the macOS App Store/TestFlight build;
install Tailscale's standalone macOS variant on a controller that uses this transport.

The default remote command is `talaria serve`. If a clone or user-local install is not on
the workstation's non-interactive `PATH`, set `serverCommand` in that host's client config
to an exact command with `setup --server-command '…'`, or edit the host entry directly:

```json
{
  "transport": "tailscale-ssh",
  "tailscaleHost": "my-workstation",
  "sshUser": "user",
  "serverCommand": "/absolute/path/to/node /absolute/path/to/talaria/dist/cli.js serve"
}
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

For Tailscale SSH, construct the same client with:

```ts
const client = TalariaClient.overTailscaleSsh({
  transport: 'tailscale-ssh',
  tailscaleHost: 'my-workstation',
  sshUser: 'user',
});
```

## Development

```sh
npm install
npm run dev       # run the CLI from source
npm run typecheck
npm run lint
npm test          # tmux integration tests run when tmux is installed
```
