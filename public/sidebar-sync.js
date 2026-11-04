// Pure merge helpers for local-first sidebar sync.
//
// Each surface (browser localStorage, macOS UserDefaults) keeps its own copy of
// the sidebar order and syncs opportunistically with the server so the two
// converge. An entry is { data: <sidebar order>, updatedAt: <ms epoch> }.
//
// Resolution is last-writer-wins by updatedAt, with one exception: group
// definitions are the user's work, not app state, so a copy with no groups
// cannot erase a copy that has them unless it says it meant to. A copy says so
// with `groupsCleared: true`, set only when the user deletes their last group.
// Without that exception, opening AMA in a fresh browser (or clicking "reset
// app data") wipes the groups on every surface.
//
// A legacy copy that has real content but no timestamp counts as "1": it beats
// an empty server copy but loses to any timestamped write from the other surface.

function orderHasContent(data) {
  if (!data || typeof data !== "object") return false;
  return (
    Object.keys(data.groups || {}).length > 0 ||
    (data.order || []).length > 0 ||
    (data.ungroupedOrder || []).length > 0
  );
}

// Does this copy define any groups?
export function orderHasGroups(data) {
  if (!data || typeof data !== "object") return false;
  return Object.keys(data.groups || {}).length > 0;
}

// Did the user deliberately delete their last group? Only then may a copy
// without groups erase one that has them.
export function orderClearedGroups(data) {
  if (!data || typeof data !== "object") return false;
  return data.groupsCleared === true;
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
  // A copy with no groups never erases a copy that has them, unless it declared
  // the erasure. The client and the server both resolve with this rule, so a
  // blank copy cannot win the race against a grouped one.
  if (orderHasGroups(remote?.data) && !orderHasGroups(local?.data) && !orderClearedGroups(local?.data)) {
    return "remote";
  }
  if (orderHasGroups(local?.data) && !orderHasGroups(remote?.data) && !orderClearedGroups(remote?.data)) {
    return "local";
  }
  if (remoteTs > localTs) return "remote";
  if (localTs > remoteTs) return "local";
  return localTs > 0 ? "local" : "none";
}
