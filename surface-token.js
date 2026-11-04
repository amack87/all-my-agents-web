// Surface tokens bind a live pane to its AMA session. The server mints one
// when it launches a pane and exports it into the pane environment
// (SURFACE_TOKEN_ENV). An agent adapter running inside that pane reads the
// token and POSTs it to /api/events, so identity resolves without any
// title/mtime/output matching — the same binding rule cmux uses with
// CMUX_SURFACE_ID. See docs/adr and agent-events.js resolveIdentity.
import { randomBytes } from "node:crypto";

export const SURFACE_TOKEN_ENV = "AMA_SURFACE_TOKEN";

// A token is opaque and unguessable; only its uniqueness within a run matters.
export function newSurfaceToken(mint = () => randomBytes(16).toString("hex")) {
  return mint();
}

// Build the tmux `new-session` argv for a pane.
//
// The pane is a shell, not a program. `new-session` with a trailing command
// makes that command the pane's initial process: when it exits, the window
// closes and — if it was the only window — the tmux session is destroyed with
// it. That is what made an agent's /exit take its tile out of the sidebar.
// Instead the shell is created first and the command is typed into it, so a
// command that ends leaves the shell, and the session, standing.
//
// `-P -F` prints the new pane's id. Targeting the pane by id rather than by
// name keeps send-keys unambiguous: a bare name that looks like a number is
// resolved as a window index of the current session, not as a session name.
export function buildLaunchArgs({ name, dir, token } = {}) {
  const args = ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name];
  if (dir) args.push("-c", dir);
  if (token) args.push("-e", `${SURFACE_TOKEN_ENV}=${token}`);
  return args;
}

// Type a command into a pane's shell. `-l` sends the characters literally, so
// a command containing spaces or quotes is not read as a list of key names;
// `--` stops a command that begins with a dash being read as options.
export function buildLaunchInputArgs(paneId, command) {
  return ["send-keys", "-t", paneId, "-l", "--", command];
}

// Press Enter. A separate call, because `-l` would send the word "Enter" as
// literal text.
export function buildLaunchSubmitArgs(paneId) {
  return ["send-keys", "-t", paneId, "Enter"];
}