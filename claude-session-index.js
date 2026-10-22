// Claude Code drops one file per live process at ~/.claude/sessions/<pid>.json
// containing the conversation id and the tmux target it is running in
// ("session:@window.%pane"). That target is how a pane is bound to the
// conversation it was hosting, so a reboot can resume the right one.
//
// The directory is internal to Claude Code and may change; parsing is isolated
// here so a format change degrades to "no session id" instead of breaking
// discovery. This module must stay free of fs side effects so it is testable.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANE_TOKEN_RE = /\.(%\d+)$/;

export function isClaudeSessionId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// "questions:@6.%6" -> "%6"; anything without a trailing pane token -> null.
// Matching the exact trailing token avoids the substring trap where "%1"
// would also match "%15".
export function paneIdFromTmuxTarget(target) {
  if (typeof target !== "string") return null;
  const match = PANE_TOKEN_RE.exec(target);
  return match ? match[1] : null;
}

// Build a pane-id -> { pid, sessionId } index from parsed session files.
// Incomplete or malformed records are dropped rather than guessed at.
export function indexClaudeSessions(records) {
  const index = new Map();
  for (const record of records ?? []) {
    if (!record || typeof record !== "object") continue;
    const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
    const sessionId = isClaudeSessionId(record.sessionId) ? record.sessionId : null;
    const paneId = paneIdFromTmuxTarget(record.tmux);
    if (!pid || !sessionId || !paneId) continue;
    index.set(paneId, { pid, sessionId });
  }
  return index;
}
