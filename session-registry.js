// Pure reconciler for the active-session registry.
//
// The registry is the source of truth for what should be restored at boot.
// It records every tmux session observed live, keyed by tmux session name —
// classified or not. Only opencode-classified sessions are resumed at boot;
// unclassified or non-opencode sessions are recreated as bare shells (the
// classification is retried on every poll, so a momentarily unclassifiable
// pane is never dropped). The web server writes it continuously on every
// change, so a hard power-off never loses state: the registry always reflects
// the most recent observation, and opencode itself persists conversations in
// its own database.
//
// This module must stay free of fs/tmux/network side effects so the reconcile
// rules are unit-testable.

export const REGISTRY_VERSION = 2;

// Discovery is best-effort and races the real world: a freshly-spawned restored
// pane or a mid-restart opencode can be momentarily undetectable. An entry must
// be absent for this many consecutive reconciles before we prune it, so a
// single transient miss never drops a session that restore should replay.
const MISSES_TO_PRUNE = 2;

// live entries come from discovery: { name, dir, sessionId, agent }
// registry entries are:               { tmux, dir, sessionId, agent, firstSeen, lastActive, misses }
//
// Returns { registry, changed, removed }.
// - `removed` lists prior entries pruned as no longer running (absent across
//   MISSES_TO_PRUNE consecutive reconciles).
// - An entry whose sessionId can no longer be resolved keeps its previous
//   sessionId rather than regressing to null: once we degrade to `opencode -c`,
//   the mid-rollover conversation is gone, so we only ever throw an id away on
//   positive evidence (a different id observed live), never on a transient
//   resolve failure.
export function reconcileRegistry(live, prior, now) {
  const prevSessions = Array.isArray(prior?.sessions) ? prior.sessions : [];
  const prevByTmux = new Map(prevSessions.map((s) => [s.tmux, s]));
  const liveByTmux = new Map(live.map((s) => [s.name, s]));

  const removed = [];
  const seen = new Set();
  const next = [];

  for (const prev of prevSessions) {
    const liveEntry = liveByTmux.get(prev.tmux);
    if (!liveEntry) {
      // Not observed this pass. Give the entry a grace window before pruning:
      // live discovery can transiently miss a pane that is actually running
      // (e.g. one just spawned by restore, mid-restart), and pruning on a
      // single miss makes the registry flicker and can drop what restore is
      // about to replay.
      const misses = (prev.misses ?? 0) + 1;
      if (misses >= MISSES_TO_PRUNE) {
        removed.push({ tmux: prev.tmux, reason: "no longer running" });
        continue;
      }
      seen.add(prev.tmux);
      next.push({
        tmux: prev.tmux,
        dir: prev.dir ?? null,
        sessionId: prev.sessionId ?? null,
        agent: prev.agent ?? null,
        firstSeen: prev.firstSeen ?? now,
        lastActive: prev.lastActive ?? now,
        misses,
      });
      continue;
    }
    seen.add(prev.tmux);
    next.push({
      tmux: prev.tmux,
      dir: liveEntry.dir ?? prev.dir ?? null,
      sessionId: liveEntry.sessionId ?? prev.sessionId ?? null,
      agent: liveEntry.agent ?? prev.agent,
      firstSeen: prev.firstSeen ?? now,
      lastActive: now,
      misses: 0,
    });
  }

  for (const liveEntry of live) {
    if (seen.has(liveEntry.name)) continue;
    next.push({
      tmux: liveEntry.name,
      dir: liveEntry.dir ?? null,
      sessionId: liveEntry.sessionId ?? null,
      agent: liveEntry.agent ?? null,
      firstSeen: now,
      lastActive: now,
      misses: 0,
    });
  }

  next.sort((a, b) => (a.tmux < b.tmux ? -1 : a.tmux > b.tmux ? 1 : 0));

  const registry = { version: REGISTRY_VERSION, updatedAt: now, sessions: next };
  const changed =
    !prior ||
    prior.version !== REGISTRY_VERSION ||
    removed.length > 0 ||
    JSON.stringify(sessionsSnapshot(registry)) !== JSON.stringify(sessionsSnapshot(prior));

  return { registry, changed, removed };
}

// Compare sessions ignoring the volatile lastActive timestamp. `misses` is
// intentionally not ignored: a bumped grace counter must change `changed` so
// the increment persists to disk.
function sessionsSnapshot(registry) {
  return registry.sessions.map((s) => ({ ...s, lastActive: undefined }));
}