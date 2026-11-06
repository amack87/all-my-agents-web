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
- **tmux-client.js** - Pure helpers for the tmux client a PTY is: parse `list-clients`, find a client by pid, build the `switch-client` argv.
- **pane-lease.js** - Pure rules for who may move a session's shared pane: one holder per session, a touch takes the lease from a heartbeat, a lease expires when its holder stops claiming.
- **network-access.js** - Trusted-source gate for inbound TCP connections.
- **origin-allowlist.js** - Pure builder for the browser-origin allowlist.
- **session-registry.js** - Pure reconciler for the on-disk active-session registry.
- **restore-plan.js** - Pure builder for the boot-time restore plan.
- **ws-inbox.js** - Pure mailbox for websocket frames that arrive before the handler is ready.
- **public/app.js** - Frontend SPA. xterm.js terminals, session list, speedrun mode, zoom controls.
- **public/terminal-size.js** - Pure terminal-grid rules shared by the browser and the server: usable sizes, when a resize is worth sending, and the claim frame.
- **public/sidebar-sync.js** - Pure resolution rules for the sidebar group/order sync. The server imports it too, so both sides resolve the same way.
- **public/session-order.js** - Pure sidebar order model (groups, ungrouped region, manual order).
- **public/escape.js** - Pure HTML escaper for every value interpolated into markup.
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
- **Everything interpolated into markup is escaped**: peer-supplied session names reach `data-` attributes, and a value containing a quote closes the attribute and becomes markup — script in the AMA origin can then drive the API, and the AMA origin is allowlisted. Use `esc()` from `public/escape.js` for text *and* attribute values; it escapes quotes as well as `< > &`.
- **A group name is never used as a raw object key**: `__proto__`, `constructor` and `prototype` cannot be stored on a plain object without changing its prototype, so such a group silently vanishes. `isSafeGroupName()` in `public/sidebar-sync.js` refuses them, and the server and the client share one normaliser (`sanitizeSidebarOrder`) so they cannot disagree about what a group is.
- **The shared pane belongs to the device being looked at**: tmux gives the pane to the client whose size last *changed* and ignores a repeated size, so a device that comes back with an unchanged grid cannot reclaim the pane by resizing it. The browser therefore sends a `claim` frame (`{type:"claim",cols,rows}`) when it comes back — even when the grid did not change — and the server hands the window to that client with `tmux switch-client -c <client> -t <window>`, using the client's own window so it never jumps. Do not suppress claims whose size is unchanged; that is the bug this replaced. See `docs/adr/0010-the-browser-claims-the-shared-window.md`.
- **The claim repeats, and the pane is granted by a lease**: a claim is a one-off event, and any device that attaches takes the pane (tmux sizes the window from the client that attaches) — so the device being looked at keeps claiming, every two seconds, while the page is visible and focused. A claim that follows an interaction or a return to the page is a *touch* (`touch:true` on the frame) and wins the pane from whatever device held it; a plain claim is a heartbeat. The server keeps one holder per session in `pane-lease.js` and stamps the interaction time with its own clock. A device that does not hold the lease may not change its size — in tmux a client that changes size takes the pane with it — so its size frames are ignored until it is touched. See `docs/adr/0011-the-device-being-looked-at-keeps-asserting.md`.

## Launch commands & targets

- **Launch command** — the command a session's pane runs instead of a default shell. It lets a session reach a machine AMA cannot host natively.
- **Target** — a named remote machine a launch command reaches, configured in `mesh.config.json` under `targets`. A target session is *hosted* locally (it is a local tmux pane) while the agent inside it *runs* on the target. A **peer** is the opposite: a machine that runs AMA itself.
- **API** — `GET /api/targets` lists the configured targets. `POST /api/sessions` accepts `{name, command}` or `{name, target}`; a target is resolved server-side from the mesh config, so the browser never supplies a command line.
- **Launch spec** — the token-free description of a launch: `{kind: "target", name}` or `{kind: "command", command}`. The registry stores the spec, never the token, so a target session is rebuilt after a restart. Targets are re-resolved at launch time, so a changed host or identity takes effect without recreating the session.
- **Surface token** — minted per launch and exported into the pane environment as `AMA_SURFACE_TOKEN`. A target session forwards it **by name** (`ssh -o SendEnv=AMA_SURFACE_TOKEN`), never by value, so the token never reaches the ssh command line, the scrollback or the shell history; the far side's `sshd_config` must list it in `AcceptEnv`. The one place the value is visible is the `tmux new-session -e AMA_SURFACE_TOKEN=…` argv, which the same user can read from `ps` for as long as the pane lives — tmux offers no way to set a pane environment variable without passing the value in argv, and the alternatives (typing `export` into the pane) put it in the scrollback and the history, which is worse. Where the far side reports status is configured in the far side's own environment (`ALL_MY_AGENTS_URL`).
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
