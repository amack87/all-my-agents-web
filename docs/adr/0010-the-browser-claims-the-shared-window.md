# 10. The browser claims the shared window when it comes back

Date: 2026-11-05

## Status

Accepted. Extended by [ADR-0011](0011-the-device-being-looked-at-keeps-asserting.md): a claim became something the device being looked at keeps sending, and the server grants the pane by a lease.

## Context

ADR-0009 made the browser the owner of the terminal grid and told the server only when the grid really changed. That is the right rule for a *resize*, and it is wrong for the case it was written for.

tmux gives the shared pane to the client whose size last *changed* (`window-size latest`, the tmux default). A frame that repeats the client's current size is ignored. So the device the user is looking at — the desktop, after a phone was looking at the same session — sends its unchanged 100x30, and the pane stays at the phone's 40x19. The size is right and the pane is still wrong. Measured on tmux 3.6b with two clients on one session:

- a client that re-sends its unchanged size does not move the pane;
- a client whose size changes moves the pane immediately, even if it is not the current client;
- typing moves the pane to the client that typed;
- `tmux switch-client -c <client> -t <window>` moves the pane to that client's grid immediately, without moving the client to another window, and does not break the follow-the-typer rule.

ADR-0009 rejected "let the server tell tmux to resize the pane" on the premise that "the server cannot know which device the user is looking at; only the browser that is being looked at can". The premise is right and the conclusion was wrong: the server does not have to know, because the browser can say so. What was missing was a way for the browser to say it that tmux will act on — a repeated size is not such a way.

## Decision

The browser *claims* the window when it comes back. A claim is a new frame, `{type: "claim", cols, rows}`, carrying the grid the browser is showing now.

- The browser sends a claim whenever it comes back — on `visibilitychange` to *visible*, on window `focus`, and before the first keystroke after the grid went stale — and as part of the first frame of a connection. A claim is sent even when the grid did not change: an unchanged grid is exactly the case tmux ignores.
- The server treats a claim like a resize for the PTY (the grid may have changed while the page was hidden, so the PTY is resized or spawned at the claimed size) and then tells tmux to give the shared window to that client: `tmux switch-client -c <client> -t <window>`.
- The server finds its own tmux client by pid: `tmux list-clients -t <target>` reports each client's pid and name, and the name is the tty path. node-pty's child pid is the tmux client's pid. The window id in the same record is used as the target, so a client that is sitting in a window the user is not looking at is not moved to another one — only the pane's shared size changes.
- A claim that arrives before the tmux client has registered is retried (every 200ms, up to 25 times) until the client appears.
- Ordinary resize frames are unchanged: tmux already follows a client whose size changed, so they need no tmux call.

The decision logic stays in `public/terminal-size.js`, shared by the browser and the server. The tmux plumbing lives in `tmux-client.js`, a pure module of argv builders and parsers.

## Alternatives considered

- **`tmux resize-window -t <session> -x W -y H`.** Sets the pane exactly, but it needs the status-line arithmetic (a 30-row client wants a 29-row window) and it breaks the follow-the-typer rule: after a manual resize the pane stops following the client that types. `#{status_height}` would remove the arithmetic, but tmux 3.6b does not support it.
- **Resize the PTY away and back ("wiggle" the client).** The client may coalesce the two SIGWINCHes and report the same size, so it is a race, and it redraws the screen for nothing.
- **Have the server pick a winner on its own.** The server can see every client's size, but it cannot see which one the user is looking at. Guessing would give the pane to whichever device connected last, or to whichever typed last — the behaviour that made the bug hard to diagnose.
- **Keep ADR-0009 and let typing fix it.** The first keystroke moves the pane, but it moves it to the client that typed, which after a device switch is the *other* device's client if the user is looking at a different window. The symptom the user sees is a terminal at the wrong size before they type, and the wrong pane afterwards.

## Consequences

- The pane follows the device the user is looking at: it takes that device's grid when the page comes back, even when the grid never changed, and without waiting for a keystroke.
- The claim does not steal the pane from whoever is typing: tmux's follow-the-typer rule still applies afterwards.
- The client is never moved to another window — only the shared pane's size is handed over.
- A claim costs two tmux calls (list-clients, switch-client) per return to the page. They are cheap, but they happen on every focus change, so the client name is looked up per claim rather than cached across claims.
- The browser sends a claim on focus whether or not the grid changed. The extra frames are small and they are what makes the behaviour correct; suppressing them would reintroduce the bug.
