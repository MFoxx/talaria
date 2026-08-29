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
enabled tools (`claude`, `codex`, `agent`, and so on) on the workstation in both modes.

Run the guided setup on each machine:

```sh
talaria setup
```

Choose **client** on the machine that initiates sessions and **server** on the machine
that runs the coding CLIs. The wizard explains the transport tradeoff, generates an
OpenSSH client key, configures and optionally tests the connection, and can enable the
SSH service and install the restricted public key on the server. In Tailscale SSH mode it
checks `tailscale` (and `tailscaled` on the server), offers to enable Tailscale SSH, and
on macOS can provision a dedicated service account and project ACLs.
The flags below remain available for non-interactive or repeatable setup.

### Allowed directories

Server setup accepts more than one allowed directory. In the interactive wizard, enter one
path per prompt and choose **Yes** when asked whether to add another. With flags, repeat
`--allowed-dir`; values are not comma-separated:

```sh
talaria setup --role server --transport openssh --tool codex \
  --allowed-dir /Users/me/projects \
  --allowed-dir /Volumes/work/repos
```

Each entry allows that directory and all of its descendants, after symlinks are resolved.
Use an absolute path when possible. A leading `~` or `~/` is supported and is expanded to
the home directory of the account running the Talaria server. Talaria does not itself expand
`$HOME`, other environment variables, or `~otheruser`; a shell may expand unquoted `$HOME` or
`~/projects` before the CLI sees it, but the interactive wizard will not. The wizard's absolute
default is the safest choice, particularly when macOS setup provisions a dedicated server
account whose home differs from yours.

### Option A: OpenSSH over Tailscale

On the workstation:

```sh
talaria setup --role server --transport openssh --tool codex --allowed-dir ~/projects
```

On the controller:

```sh
talaria setup --role client --transport openssh \
  --host my-workstation --ssh-user user
```

When using the wizard, paste the public key printed by client setup into the server setup
prompt; Talaria creates `~/.ssh/authorized_keys` with safe permissions and adds the
restricted entry. With non-interactive setup, add the printed line manually. The
dedicated key is restricted to `talaria serve`—no shell, port/agent/X11 forwarding, or
PTY:

If Tailscale SSH is already enabled on the server, it intercepts tailnet port 22 and
bypasses OpenSSH `authorized_keys`, including Talaria's forced command. Setup detects
this conflict in both interactive and flag-driven runs; the wizard recommends switching
to `tailscale-ssh`, while a non-interactive run stops with instructions. It
does not disable an intentionally enabled Tailscale SSH service. To deliberately use
OpenSSH instead, disable Tailscale SSH first with `tailscale set --ssh=false`.

```
command="PATH='/absolute/claude/bin:/absolute/codex/bin:/absolute/node/bin:/absolute/talaria/dist:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' '/absolute/node/bin/node' '/absolute/talaria/dist/cli.js' serve",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... talaria-agent
```

#### Running OpenSSH mode from a clone

SSH forced commands do not load shell startup files. Server setup therefore resolves Node,
Talaria, and each configured built-in tool to an absolute executable. Those tool paths are
persisted in `builtinToolBins`; adapters use them directly at runtime. The forced command
uses a service-only `PATH` assembled from those pinned locations and standard system
directories—never a relative or inherited controller `PATH`. Existing legacy entries
containing only `command="talaria serve"` are upgraded when the same key is authorized
again.

For a clone, build and link Talaria before running server setup so the wizard can resolve
the compiled CLI:

```sh
npm run build
npm link
talaria setup
```

Running server setup directly through `tsx src/cli.ts` is rejected because plain Node
cannot execute that TypeScript source when sshd later invokes the forced command.
Use `--tool codex`, `--tool claude-code`, or `--tool cursor` to enable only that built-in;
repeat the flag to enable several. When omitted, setup enables and pins claude-code and codex.
Server configs created before executable pinning must be regenerated with
`talaria setup --role server --force`.

### Option B: Tailscale SSH

Install compatible Tailscale versions on both machines. On the workstation, configure
the Talaria server and enable Tailscale's SSH server:

```sh
talaria setup --role server --transport tailscale-ssh --tool codex --allowed-dir ~/projects
tailscale set --ssh=true
```

On the controller:

```sh
talaria setup --role client --transport tailscale-ssh \
  --host my-workstation --ssh-user talaria
talaria ping --host desktop
```

This mode generates no SSH key and does not use `authorized_keys`. The client runs
`tailscale ssh user@host "talaria serve"`; Tailscale supplies authentication and host-key
verification. Configure the tailnet policy to permit both network access and Tailscale
SSH only from the controller identity/tag to the workstation identity/tag and the exact
`talaria` OS user. Do not use `autogroup:nonroot` for this rule. An `accept` SSH rule is
suitable for unattended Talaria calls; a `check` rule can
require interactive reauthentication and is therefore unsuitable when Talaria must run
fully unattended.

Security tradeoff: built-in Tailscale SSH policy restricts who may connect, to which
machine, and as which OS user, but it does **not** enforce an `authorized_keys`-style
forced command. This is important when Tailscale SSH was already enabled intentionally:
do not assume an OpenSSH `authorized_keys` restriction still applies to tailnet
connections.

On an interactive macOS server setup, Talaria therefore recommends and can provision a
hidden, password-disabled, non-admin `talaria` account. Before asking for administrator
access, it displays the complete change plan. The provisioner then:

- installs a root-owned login shell that accepts only the exact `talaria serve` command;
- creates `talaria-projects`, adds the current user and service account, and applies
  recursive group access plus inherited ACLs to the selected project directories;
- adds search-only ACLs (no directory listing or file reading) to private parent
  directories when needed to reach a selected project path;
- writes `/Users/talaria/.config/talaria/server.json` and private session state owned by
  the service account; and
- verifies Node, the Talaria CLI, and exactly the enabled tool CLIs as the service account.

The wrapper has a self-contained `PATH` and absolute paths for Node and Talaria. When
Node or the Talaria package is installed below the main user's private home, setup copies
the runtime files into the root-owned `/usr/local/libexec/talaria` service directory and
verifies that the staged Node executable can launch as `talaria`. If a tool
is installed below a private directory that `talaria` cannot traverse, verification
stops instead of weakening permissions on the main user's home; install that tool in a
shared system prefix such as `/opt/homebrew` or `/usr/local` and rerun setup. Authenticate
the tool CLIs explicitly as the service account when required (for example,
`sudo -u talaria -H codex login`). Tailscale authentication remains policy-based, so no
SSH key is created or copied for this account. The restricted shell is set directly in
Directory Services and is intentionally not added to `/etc/shells`.

On other operating systems, Tailscale server setup retains the selected/current account;
use OpenSSH mode when command-level isolation is required. See the
[Tailscale SSH security model and policy setup](https://tailscale.com/docs/features/tailscale-ssh).

The Tailscale CLI's `ssh` wrapper is unavailable in the macOS App Store/TestFlight build;
install Tailscale's standalone macOS variant on a controller that uses this transport.

The default remote command is `talaria serve`. If a clone or user-local install is not on
the workstation's non-interactive `PATH`, set `serverCommand` in that host's client config
to an exact command with `setup --server-command '…'`, or edit the host entry directly:

```json
{
  "transport": "tailscale-ssh",
  "tailscaleHost": "my-workstation",
  "sshUser": "talaria",
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
talaria continue -H desktop -c a1b2c3 -p "Now add regression tests"
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

for await (const event of client.continue({
  conversationId: '0123456789abcdef01234567',
  prompt: 'Now add regression tests',
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
