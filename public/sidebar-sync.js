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

// A group name that collides with Object.prototype cannot be stored on a plain
// object: assigning it changes the object's prototype instead of adding a key,
// so the group silently disappears and the map loses Object.prototype. Such a
// name is refused wherever a group name becomes an object key — on the server,
// in the client, and in the ordering model — so both sides agree on what a
// group is.
export function isSafeGroupName(name) {
  if (typeof name !== "string" || name === "") return false;
  return name !== "__proto__" && name !== "constructor" && name !== "prototype";
}

/**
 * Normalise a sidebar order into the shape both sides store.
 *
 * This is the single definition of "a group" and "a session key": the server
 * runs it on everything it receives, the client runs it on everything it
 * reads. A group name that collides with Object.prototype is dropped rather
 * than assigned, because assigning it would change the object's prototype
 * instead of adding a key — the group would silently vanish.
 */
export function sanitizeSidebarOrder(data) {
  const src = data && typeof data === "object" ? data : {};
  const groups = {};
  if (src.groups && typeof src.groups === "object") {
    for (const [name, members] of Object.entries(src.groups)) {
      if (!isSafeGroupName(name)) continue;
      if (Array.isArray(members)) groups[name] = members.filter((k) => typeof k === "string");
    }
  }
  const collapsed = {};
  if (src.collapsed && typeof src.collapsed === "object") {
    for (const [name, value] of Object.entries(src.collapsed)) {
      if (!isSafeGroupName(name)) continue;
      collapsed[name] = !!value;
    }
  }
  const order = {
    groups,
    collapsed,
    order: Array.isArray(src.order)
      ? src.order.filter((n) => typeof n === "string" && isSafeGroupName(n))
      : [],
    ungroupedOrder: Array.isArray(src.ungroupedOrder)
      ? src.ungroupedOrder.filter((k) => typeof k === "string")
      : [],
  };
  // The flag records that the user deliberately deleted their last group. It is
  // the only thing that lets a copy without groups replace one that has them.
  if (src.groupsCleared === true) order.groupsCleared = true;
  return order;
}

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
