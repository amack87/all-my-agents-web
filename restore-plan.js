// Pure builder for the boot-time restore plan.
//
// Input: the persisted active-session registry plus what the environment tells
// us at boot (which tmux sessions already exist, and which opencode session ids
// actually resolve). Output: an ordered list of actions the thin executor in
// server.js turns into real process calls.
//
// The boot-degrade rule lives here so it is testable: an entry whose sessionId
// is unknown or unresolvable still gets launched, degraded to `opencode -c`
// (continue-last) in its recorded project dir. Non-opencode entries (shells,
// unclassifiable panes) are recreated as bare tmux sessions — the window comes
// back, not the process state; classification is retried on every live poll,
// so an unclassified pane can still upgrade to a resumed opencode later. We
// never silently skip an entry — that is the 2-of-20 silent-failure lesson.
//
// This module must stay free of fs/tmux/network side effects.

export function buildRestorePlan({ registry, existingTmux = [], resolvable = new Set() }) {
  const existing = new Set(existingTmux);
  const actions = [];
  for (const entry of registry?.sessions ?? []) {
    // A tmux session that already exists is left alone: relaunching it would
    // duplicate panes on the user's screen.
    if (existing.has(entry.tmux)) continue;
    const isOpencode = entry.agent === "opencode";
    const canResume = isOpencode && Boolean(entry.sessionId && resolvable.has(entry.sessionId));
    if (canResume) {
      actions.push({
        kind: "launch-opencode",
        name: entry.tmux,
        dir: entry.dir,
        sessionId: entry.sessionId,
        continueBest: false,
        reason: "resume",
      });
    } else if (isOpencode) {
      actions.push({
        kind: "launch-opencode",
        name: entry.tmux,
        dir: entry.dir,
        sessionId: null,
        continueBest: true,
        reason: "degrade",
      });
    } else {
      actions.push({
        kind: "recreate-shell",
        name: entry.tmux,
        dir: entry.dir,
        agent: entry.agent ?? null,
        reason: "recreate-shell",
      });
    }
  }
  return actions;
}