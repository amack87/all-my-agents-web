# All My Agents Mobile - Project Instructions

## Running

The server can be run directly or as a **launchd agent** that auto-starts on login.

```bash
# Run directly
node server.js

# Or install as a launchd agent (see setup/launchd-example.plist)
# Customize the plist with your paths, then:
cp setup/launchd-example.plist ~/Library/LaunchAgents/com.allmyagents-mobile.plist
launchctl load ~/Library/LaunchAgents/com.allmyagents-mobile.plist

# Restart after code changes
launchctl stop com.allmyagents-mobile && launchctl start com.allmyagents-mobile
```

- **Port**: 3456 (HTTP + WebSocket), configurable via `ALL_MY_AGENTS_PORT` env var
- **KeepAlive**: If using launchd, it auto-restarts on crash. Do NOT use `kill` — use `launchctl stop/start`.
- **launchd PATH**: The launchd plist MUST set `PATH` in `EnvironmentVariables` (e.g. `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), otherwise Tailscale discovery fails silently because `tailscale` is not in launchd's default PATH.

## Architecture

- **server.js** - Express + express-ws backend. PTY allocation via node-pty. Tmux session discovery, status detection, agent detection.
- **mesh.js** - Multi-machine mesh networking. Tailscale auto-discovery + manual peer config.
- **mesh.config.json** - Peer configuration (name, host, port). Gitignored — copy from `mesh.config.example.json`.
- **public/app.js** - Frontend SPA. xterm.js terminals, session list, speedrun mode, zoom controls.
- **public/style.css** - Dark theme, mobile-first responsive layout.

## Key Constraints

- **tmux target validation**: All user-supplied tmux targets must match `TMUX_TARGET_RE` (`/^[a-zA-Z0-9_.%:-]+$/`).
- **Peer validation**: WebSocket proxy and API proxy routes validate peer hosts against mesh config before forwarding.
- **Init buffer**: Terminal connections buffer initial PTY output and write it as one chunk to prevent visible scroll-from-top flicker.
- **No HTTPS**: Relies on Tailscale network isolation for security. Do not expose port 3456 to the public internet.

## Session Restore & Registry

- **Continuous registry**: The server keeps a live registry of managed sessions (`~/.local/state/all-my-agents/active-sessions.json`, one entry per tmux session hosting an opencode TUI) and rewrites it on every change. Restore replays the registry at startup — no shutdown hook, so hard power-off is safe; conversations themselves live in opencode's own store and are resumed, not re-imported.
- **Resume via native flags**: Restored panes launch `opencode -s <session-id>` (or `opencode -c` when the recorded id no longer resolves). Every AMA-managed pane launches opencode with `-s` so panes self-restore.
- **Env vars**: `OPENCODE_BIN` (default `~/.opencode/bin/opencode`), `ALL_MY_AGENTS_REGISTRY_POLL_MS` (default 30000), `ALL_MY_AGENTS_RESTORE_DELAY_MS` (default 10000). Live state is exposed at `GET /api/registry`.

