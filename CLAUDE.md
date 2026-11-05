# All My Agents Mobile - Project Instructions

## Running

The server can be run directly or as a **launchd agent** that auto-starts on login.

```bash
# Run directly
node server.js

# Or install as a launchd agent (see setup/launchd-example.plist)
# Replace the __PLACEHOLDER__ values in the plist, then:
cp setup/launchd-example.plist ~/Library/LaunchAgents/com.allmyagents-web.plist
launchctl load ~/Library/LaunchAgents/com.allmyagents-web.plist

# Restart after code changes
launchctl stop com.allmyagents-web && launchctl start com.allmyagents-web
```

- **Port**: 3456 (HTTP + WebSocket), configurable via `ALL_MY_AGENTS_PORT` env var
- **KeepAlive**: If using launchd, it auto-restarts on crash. Do NOT use `kill` — use `launchctl stop/start`.
- **launchd PATH**: The launchd plist MUST set `PATH` in `EnvironmentVariables` (e.g. `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), otherwise Tailscale discovery fails silently because `tailscale` is not in launchd's default PATH.

## Architecture

- **server.js** - Express + express-ws backend. PTY allocation via node-pty. Tmux session discovery, status detection, agent detection.
- **mesh.js** - Multi-machine mesh networking. Tailscale auto-discovery + manual peer config.
- **mesh.config.json** - Peer and target configuration (peers: name, host, port; targets: name, host, user, port, identityFile). Gitignored — copy from `mesh.config.example.json`.
- **launch-command.js** - Pure builder for launch commands and launch specs: validation, ssh argv, target resolution.
- **surface-token.js** - Per-pane capability token, plus the tmux argv that creates a pane and types a command into it.
- **network-access.js** - Trusted-source gate for inbound TCP connections.
- **origin-allowlist.js** - Pure builder for the browser-origin allowlist.
- **session-registry.js** - Pure reconciler for the on-disk active-session registry.
- **restore-plan.js** - Pure builder for the boot-time restore plan.
- **ws-inbox.js** - Pure mailbox for websocket frames that arrive before the handler is ready.
- **public/app.js** - Frontend SPA. xterm.js terminals, session list, speedrun mode, zoom controls.
- **public/sidebar-sync.js** - Pure resolution rules for the sidebar group/order sync. The server imports it too, so both sides resolve the same way.
- **public/session-order.js** - Pure sidebar order model (groups, ungrouped region, manual order).
- **public/style.css** - Dark theme, mobile-first responsive layout.

## Key Constraints

- **tmux target validation**: All user-supplied tmux targets must match `TMUX_TARGET_RE` (`/^[a-zA-Z0-9_.%:-]+$/`).
- **Peer validation**: WebSocket proxy and API proxy routes validate peer hosts against mesh config before forwarding.
- **Init buffer**: Terminal connections buffer initial PTY output and write it as one chunk to prevent visible scroll-from-top flicker.
- **Trusted sources only**: The server binds `0.0.0.0` on purpose (Tailscale may arrive after boot), but every TCP connection is checked before HTTP or WebSocket handling sees it. Trusted: loopback, Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), and the VM bridge range — and the bridge range only when the connection actually landed on this machine's own bridge address. See `docs/adr/0003-trusted-source-gate.md`.
- **No HTTPS**: There is no transport encryption. The trusted-source gate, not Tailscale isolation, is what keeps port 3456 off the public internet. Do not weaken the gate to make something reachable.
- **The pane is a shell**: a launch command is typed into the pane, never installed as the pane's initial process — otherwise an agent's `/exit` closes the window and destroys the tmux session, taking the sidebar tile with it. See `docs/adr/0004-pane-is-a-shell.md`.
- **Origin allowlist**: a request carrying an `Origin` header is refused (403) unless the origin is this machine's own name, a configured mesh peer, or this machine's **full** MagicDNS name — machine *and* tailnet, matched whole, never by prefix (another tailnet can publish `<this-machine>.<their-tailnet>.ts.net`) — and the **port** matches too. WebSocket upgrades are checked the same way, because CORS does not apply to them. Never widen this to a wildcard; a page on another site must not be able to drive the local server. See `docs/adr/0005-origin-allowlist.md`.
- **Websocket listeners attach before any `await`**: the client's first frame is its resize, and that frame is the only thing that spawns the PTY. A frame that arrives while no `message` listener is attached is dropped by the socket for good, so the listener goes on synchronously and the early frames go into `ws-inbox.js` until the handler is ready. A dropped resize means a terminal that stays black until the user hits reconnect.
- **No authentication**: the API and the terminal are unauthenticated. Anything that can reach the server can drive a terminal, so the trusted-source gate and the origin allowlist are the only defences. Do not relax either to make something reachable.

## Launch commands & targets

- **Launch command** — the command a session's pane runs instead of a default shell. It lets a session reach a machine AMA cannot host natively.
- **Target** — a named remote machine a launch command reaches, configured in `mesh.config.json` under `targets`. A target session is *hosted* locally (it is a local tmux pane) while the agent inside it *runs* on the target. A **peer** is the opposite: a machine that runs AMA itself.
- **API** — `GET /api/targets` lists the configured targets. `POST /api/sessions` accepts `{name, command}` or `{name, target}`; a target is resolved server-side from the mesh config, so the browser never supplies a command line.
- **Launch spec** — the token-free description of a launch: `{kind: "target", name}` or `{kind: "command", command}`. The registry stores the spec, never the token, so a target session is rebuilt after a restart. Targets are re-resolved at launch time, so a changed host or identity takes effect without recreating the session.
- **Surface token** — minted per launch and exported into the pane environment as `AMA_SURFACE_TOKEN`. A target session forwards it **by name** (`ssh -o SendEnv=AMA_SURFACE_TOKEN`), never by value, so the token never reaches the command line, the scrollback, the shell history or `ps`; the far side's `sshd_config` must list it in `AcceptEnv`. Where the far side reports status is configured in the far side's own environment (`ALL_MY_AGENTS_URL`).
- **Windows setup** — `setup/windows/` holds the one-time scripts (OpenSSH, toolchain, status adapter) and `setup/windows/README.md` the order of operations. AMA never runs on Windows; see `docs/adr/0002-windows-via-ssh-target.md`.

## Session Restore & Registry

- **Continuous registry**: The server keeps a live registry of managed sessions (`~/.local/state/all-my-agents/active-sessions.json`, one entry per tmux session hosting an opencode TUI) and rewrites it on every change. Restore replays the registry at startup — no shutdown hook, so hard power-off is safe; conversations themselves live in opencode's own store and are resumed, not re-imported.
- **Resume via native flags**: Restored panes launch `opencode -s <session-id>` (or `opencode -c` when the recorded id no longer resolves). Every AMA-managed pane launches opencode with `-s` so panes self-restore.
- **Restore kinds**: `restore-plan.js` emits one of `launch-opencode`, `launch-claude`, `relaunch-command` (a session owned by a launch spec) or `recreate-shell` (a bare pane, for anything unclassified). A launch spec takes precedence over an agent kind — the spec owns the pane.
- **Env vars**: `OPENCODE_BIN` (default `~/.opencode/bin/opencode`), `CLAUDE_BIN` (default `~/.local/bin/claude`), `ALL_MY_AGENTS_LOG_DIR` (default `~/.local/state/all-my-agents`), `ALL_MY_AGENTS_REGISTRY_POLL_MS` (default 30000), `ALL_MY_AGENTS_RESTORE_DELAY_MS` (default 10000). Live state is exposed at `GET /api/registry`.

## Sidebar groups & sync

- **Group definitions are protected**: a copy with **no** groups can never erase a copy that **has** them. The user declares the erasure with `groupsCleared: true`, set only when they delete their last group. Both the client and the server resolve with `pickWinner` in `public/sidebar-sync.js`, so they cannot disagree. See `docs/adr/0006-groups-are-protected.md`.
- **Sync before render**: `init()` awaits `syncGroups()` **before** `loadSessions()`. The reverse order lets a blank local copy win the race and wipe the server's groups.
- **The reset button is not app state**: `#reset-btn` clears the host list, zoom and sidebar width — never the group keys — and asks for confirmation first.
- **Session key format**: `<machineHost>::<name>` — host first (`local::slice`). Defined once, in `public/app.js`'s `sessionKey()`.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues (`gh` CLI), PRDs as `PRD: <feature>` and tickets as `<n> — <title>`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles map 1:1 to `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
