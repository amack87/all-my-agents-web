# 9. The browser owns the terminal size; the server is told only when it changes

Date: 2026-11-05

## Status

Accepted

## Context

The browser owns the terminal grid — how many columns and rows fit the terminal container. The server owns a PTY with a size of its own, and tmux gives the shared pane the size of the client whose size last *changed* (`window-size latest`, the tmux default).

The two drift apart whenever the page is not the one being looked at. A background tab is not laid out, `requestAnimationFrame` is throttled while it is hidden, and a phone that was in another app does not report its new viewport until it is shown again. A grid fitted in that state keeps a size that belongs to no viewport.

Because a stale grid never changes, no resize frame is sent for it, so the far end keeps the size the page had when it went stale. The symptom: the user moves from the phone to the desktop, starts typing, and the terminal is still the phone's size. The same happened on a desktop when the window was resized while another app had focus.

Measured on tmux 3.6b, with two clients attached to one session:

- a resize frame that repeats the client's current size does not move the pane — the desktop client re-sent its size unchanged and the pane stayed at the phone's 40x19;
- a resize frame with a genuinely different size moves the pane immediately, with no typing;
- typing moves the pane to the client that typed.

So an unchanged size is not worth sending — tmux ignores it — and a changed size is worth sending even before the user types.

AMA web used to resize the terminal when the user came back to the window. That behaviour is gone, and nothing in this repo's history explains it, so it is re-implemented from scratch rather than restored.

## Decision

The browser grid is the source of truth for the terminal size, and the server is told only when the size really changed.

- The grid is re-fitted when the page comes back: on `visibilitychange` to *visible*, and on window `focus`. Switching to another desktop application changes focus, not visibility, so both are needed. A window that is hidden or loses focus is marked stale.
- A stale grid is re-fitted before the first keystroke is forwarded, so the resize frame reaches tmux before the keystroke that would otherwise be processed against the old size.
- A resize frame is sent only when the new size differs from the size the server was last told. The one exception is the first frame of a connection: the server starts the PTY at the size of that frame, so it is always sent — after a fresh fit, so the PTY starts at the size the browser is actually showing.
- The server validates the size in a resize frame and ignores one it cannot use. node-pty refuses a size that is not positive, and the frame would otherwise be written into the terminal as text.

## Alternatives considered

- **Re-fit on every keystroke.** Always right, but it measures the DOM on every key press and re-sends a size tmux ignores. The stale flag reaches the same result with one fit.
- **A `ResizeObserver` on the terminal container.** Catches a container that changes size without the window changing — the sidebar width, for instance. The sidebar already forces a fit by dispatching a `resize` event, so an observer would be a second mechanism for the same thing.
- **Let the server tell tmux to resize the pane.** The pane is shared between clients and tmux already decides which client it follows. The server cannot know which device the user is looking at; only the browser that is being looked at can.

## Consequences

- The terminal is sized for the viewport it is back in — the phone, the desktop, or a window that was resized while it was in the background.
- tmux's pane follows the device the user is actually looking at: a changed size moves it, without waiting for a keystroke.
- The decision logic lives in `public/terminal-size.js` and is shared by the browser and the server, so the two cannot disagree about what a usable size is.
- A grid that cannot be measured — a container that is not laid out — keeps its old size, and the next fit (on focus, on visibility, on the first keystroke) picks it up. That is what the stale flag is for.
