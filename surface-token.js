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

// Build the tmux `new-session` argv for a pane. `-e` must precede any trailing
// command (tmux treats later args as the command's argv), so the token and dir
// options are emitted before `command`.
export function buildLaunchArgs({ name, dir, token, command } = {}) {
  const args = ["new-session", "-d", "-s", name];
  if (dir) args.push("-c", dir);
  if (token) args.push("-e", `${SURFACE_TOKEN_ENV}=${token}`);
  if (command) args.push(command);
  return args;
}