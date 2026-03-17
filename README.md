# AgentHub Mobile

A web interface for managing Claude Code tmux sessions across multiple machines. Works on both mobile and desktop, with auto-discovery of peers via Tailscale.

## Why

When running multiple Claude Code agents in tmux across one or more machines, you need a way to monitor them and respond to input prompts from anywhere. AgentHub Mobile gives you a unified view of all sessions across your Tailscale mesh with full terminal access, status detection, and a speedrun mode for quickly triaging agents that need attention.

## Features

- **Multi-machine mesh** - auto-discovers other AgentHub instances on your Tailscale network
- **Session list** with live status indicators (Working, Needs Input, Idle)
- **Full terminal access** via xterm.js + node-pty WebSocket connections
- **WebSocket proxy** - access terminal sessions on remote machines through the local server
- **Speedrun mode** - cycles through agents needing input, auto-advances after you respond
- **Session management** - create and kill tmux sessions (local and remote)
- **Responsive layout** - sidebar + terminal on desktop, card list on mobile
- **Machine filter** - filter sessions by machine when multiple are connected
- **Peer health indicators** - see which machines are online/offline
- **PWA-capable** - installable as a home screen app on iOS/Android
- **Mobile-optimized toolbar** - Paste, Esc, Tab, Ctrl keys, scroll mode (tmux copy-mode)
- **Swipe-to-go-back** navigation from left edge
- **Long-press to delete** sessions
- **Claude session enrichment** - reads `~/.claude/projects/` metadata to show project paths and summaries
- **Auto-refresh** - session list polls every 3s, terminal status polls every 2s

## Architecture

```
Phone / Laptop Browser
    │
    │  HTTP + WebSocket over Tailscale VPN
    │
    ▼
Node.js server (Machine A)  ◄──── auto-discovery ────►  Node.js server (Machine B)
    │                                                        │
    ├── /api/sessions (local tmux)                          ├── /api/sessions (local tmux)
    ├── /api/mesh/sessions (aggregated from all peers)      ├── /api/mesh/sessions
    ├── /api/identity (machine name + peer list)            ├── /api/identity
    ├── /ws/terminal/:target (local PTY)                    ├── /ws/terminal/:target
    └── /ws/proxy/:peer/:target (proxied to remote)         └── /ws/proxy/:peer/:target
```

**Auto-discovery flow:**
1. Runs `tailscale status --json` to find online devices on the tailnet
2. Probes each device's `/api/identity` endpoint (port 3456, 2s timeout)
3. Devices that respond are added as peers automatically
4. Discovery results cached for 60 seconds
5. Manual peers in `mesh.config.json` take priority and are always included

**Key components:**
- **mesh.js** - Tailscale auto-discovery, peer session fetching, schema validation
- **server.js** - Express server with local tmux API, mesh aggregation, HTTP/WebSocket proxy
- **public/app.js** - Vanilla JS SPA with mesh-aware session loading and desktop layout
- **Terminal**: node-pty (v1.2.0-beta.11, required for Node 22 + macOS ARM) spawns `tmux attach-session`
- **Status detection**: Captures tmux pane content and pattern-matches for Claude Code UI states

## Requirements

- Node.js 22+
- tmux
- [Tailscale](https://tailscale.com/) (for remote access and peer auto-discovery)

## Setup

```bash
cd ~/Repos/AgentHub-Mobile
npm install
```

### Configure machine name

Edit `mesh.config.json`:
```json
{
  "name": "my-macbook",
  "port": 3456
}
```

Peers are discovered automatically via Tailscale. You can also add manual peers:
```json
{
  "name": "my-macbook",
  "peers": [
    { "name": "desktop", "host": "192.168.1.100", "port": 3456 }
  ]
}
```

### Run manually

```bash
npm start          # production
npm run dev        # with --watch for auto-reload
```

### Run as a persistent service (launchd)

A launchd plist is installed at `~/Library/LaunchAgents/com.andy.agenthub-mobile.plist`. It auto-starts on login and restarts on crash.

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.andy.agenthub-mobile.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.andy.agenthub-mobile.plist

# View logs
tail -f ~/Library/Logs/agenthub-mobile.log
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTHUB_PORT` | `3456` | Server port |

## Access

From any device on your Tailscale network, navigate to `http://<tailscale-ip>:3456`.

## Status Detection

The server captures the last 25 lines of each tmux pane and pattern-matches to determine agent state:

| Status | Detection |
|--------|-----------|
| **Working** | "esc to interrupt", token/timing counters |
| **Needs Input** | "esc to cancel", y/n prompts, Allow/Deny dialogs |
| **Idle** | Shell prompt visible (❯, $, #, %) |

## Speedrun Mode

Speedrun prioritizes sessions needing input across all machines. After you respond to an agent (press Enter), it detects the agent starting to work and shows a 3-second countdown before auto-advancing to the next session. Tap the overlay to skip the countdown.

## Security

- All proxy routes validate the target peer against the discovered/configured peer list
- Arbitrary host proxying is rejected (no open proxy)
- Peer session data is schema-validated (allowlisted fields only)
- tmux target parameters are validated against a strict regex
- WebSocket proxy buffers are capped to prevent memory exhaustion
- Network access is limited to your Tailscale network

## Known Issues

- **node-pty compatibility**: The stable node-pty 1.1.0 fails with `posix_spawnp` on Node 22 / macOS ARM. Must use beta 1.2.0-beta.11.
- **TMUX env stripping**: When the server itself runs inside tmux, the `TMUX` and `TMUX_PANE` env vars must be stripped before spawning `tmux attach`, or it will refuse to nest.
- **tmux format delimiters**: Tab characters in tmux format strings are unreliable under launchd; the server uses `|||` as a delimiter instead.

## Related

- [AgentHub](../AgentHub/) - Native macOS desktop app (Swift) for local tmux session management
