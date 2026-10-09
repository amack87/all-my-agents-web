// Pure merge helpers for local-first sidebar sync.
//
// Each surface (browser localStorage, macOS UserDefaults) keeps its own copy of
// the sidebar order and syncs opportunistically with the server so the two
// converge. An entry is { data: <sidebar order>, updatedAt: <ms epoch> }.
//
// Resolution is last-writer-wins by updatedAt. A legacy copy that has real
// content but no timestamp counts as "1": it beats an empty server copy but
// loses to any timestamped write from the other surface.

function orderHasContent(data) {
  if (!data || typeof data !== "object") return false;
  return (
    Object.keys(data.groups || {}).length > 0 ||
    (data.order || []).length > 0 ||
    (data.ungroupedOrder || []).length > 0
  );
}

export function orderTimestamp(entry) {
  if (!entry || !entry.data) return 0;
  const t = Number(entry.updatedAt);
  if (Number.isFinite(t) && t > 0) return t;
  return orderHasContent(entry.data) ? 1 : 0;
}

// "remote" when the server copy is strictly newer, otherwise "local" (ties keep
// the local copy), or "none" when neither side has anything to sync.
export function pickWinner(local, remote) {
  const localTs = orderTimestamp(local);
  const remoteTs = orderTimestamp(remote);
  if (remoteTs > localTs) return "remote";
  if (localTs > remoteTs) return "local";
  return localTs > 0 ? "local" : "none";
}
