# Context

Ubiquitous language for All My Agents. Definitions only — no implementation detail.

## Core concepts

- **Session** — one tmux session surfaced by AMA as a single sidebar entry. A session lives on exactly one machine.
- **Tile** (session tile) — the sidebar row representing one session. The unit the user clicks to open a terminal.
- **Session key** — a tile's stable identity: `<machineHost>::<name>` — host first, so a local session reads `local::slice`. Two machines may host sessions with the same name; the key disambiguates them. Order and group membership are stored against the session key, not the display name.
- **Agent** — the coding agent detected inside a session (for example opencode, Claude Code, Codex). A session with no detected agent reads as `shell`.
- **Status** — a session's live working state: `needsInput`, `working`, `idle`, `ended`, or `unknown`.
- **Status source** — where the current status came from: `event` (reported by an agent adapter) or `screen` (inferred from the terminal's rendered text). An `event` status wins while fresh; otherwise the screen inference applies.
- **Peer** — another AMA instance reachable over the mesh, contributing its sessions to the same sidebar.
- **Pane** — the tmux pane a session is made of. A pane is always a shell; anything a session runs is typed into that shell, so the pane outlives whatever it was running.
- **Surface token** — a per-session secret that binds a pane to its AMA session. An agent adapter inside the pane reads it from the environment and presents it when reporting status, so the server can tell which session an event came from without matching on screen text.
- **Launch command** — the command a session's pane runs instead of a default shell. It lets a session reach a machine other than the one hosting it.
- **Target** — a named remote machine a launch command reaches. A session aimed at a target is hosted by the local machine, but the agent inside it runs on the target.

## Sidebar arrangement

- **Group** — a named, ordered collection of tiles. A tile belongs to at most one group.
- **Ungrouped region** — the area below all groups, holding every tile that belongs to no group.
- **Manual order** — the user-defined position of tiles and groups, persisted per browser. It is the sidebar's sole ordering authority: status never moves a tile.
- **Drag handle** — the per-tile affordance the user grabs to rearrange a tile, leaving tap-to-open and the context menu untouched.
- **Drop target** — where a dragged tile can land: into a group (at a position) or into the ungrouped region (at a position). A group with no members still shows a header so it remains a drop target.