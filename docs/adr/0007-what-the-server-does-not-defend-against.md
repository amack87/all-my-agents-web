# 7. Access control is the origin allowlist, not authentication

Date: 2026-11-05

## Status

Accepted

## Context

AMA drives terminals. There is no authentication: the server is a personal tool on a private network, and every layer that would stand between a caller and a shell has to be justified against that.

Two questions kept coming back, and both had an answer that looks wrong until the alternatives are laid out.

**Should session creation be capped?** `POST /api/sessions` is unauthenticated and unbounded, so anyone who can reach it can create tmux sessions without limit.

**Should the surface token be hidden from `ps`?** It is passed to tmux as `tmux new-session -e AMA_SURFACE_TOKEN=…`, so its value sits in the process arguments for as long as the pane lives.

There is also a third, smaller case: the event endpoint identifies a session by its surface token when it has one, and otherwise falls back to matching the session id against the registry.

## Decision

AMA has no authentication and no per-caller identity. The trusted-source gate ([ADR 0003](0003-trusted-source-gate.md)) and the origin allowlist ([ADR 0005](0005-origin-allowlist.md)) are the access control. Three specific gaps are left open deliberately.

**No cap on session creation.** The same endpoint accepts a `command` that is typed into a pane, so a caller who may create sessions may already run code. Capping the *number* of sessions bounds nothing that matters — the first one is enough — and it would break legitimate use, because a person running twenty agents would hit it. The origin allowlist is the control. A cap here would be security theatre.

**The surface token stays in tmux's argv.** tmux offers no way to set a pane environment variable without passing the value on the command line. The alternatives are worse: typing `export AMA_SURFACE_TOKEN=…` into the pane puts the value in the scrollback and the shell history, where it survives the pane and is visible to anything that reads the history file. The value in argv is visible only to the same user, through `ps`, and only while the pane lives. A stolen token can post status events for that one session. It cannot run commands and cannot read the terminal.

**The event endpoint keeps its session-id fallback.** A pane that survives a server restart keeps its old token: restore deliberately skips sessions that already exist in tmux, so no new token is minted for them. Failing closed on an unmatched token would therefore permanently lose event status for exactly those panes and drop them back to screen detection. So the fallback stays — and the opencode adapter now sends the surface token when the pane has one, which makes AMA-launched panes token-identified in the common case. The residual risk is a caller who knows an opencode session id; such a caller can post a misleading status for that session, and nothing more.

## Consequences

- Anything that can reach the server and present an allowed origin can run commands. That is the product, not a gap.
- A token read out of `ps` by the same user can post status events for one session. It cannot run commands, and it cannot read the terminal.
- A caller who knows an opencode session id can post a status event for that session, which can make a tile show a misleading status. It cannot run commands and cannot read the terminal.
- These risks are recorded here so that a future change does not "fix" one of them in a way that makes things worse. If AMA ever grows a real authentication story, the trade-offs above are the ones to revisit first.
