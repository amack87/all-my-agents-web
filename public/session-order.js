// Pure ordering model for the sidebar (groups + ungrouped region).
//
// DOM-free on purpose: public/app.js owns all Pointer Events wiring and passes
// session objects plus a keyOf(session) callback; this module only transforms
// the persisted group-data structure:
//
//   { groups: { name: [key, ...] }, collapsed: { name: bool },
//     order: [groupName, ...], ungroupedOrder: [key, ...] }
//
// Manual order wins: nothing here reads a session's status, so tiles never move
// themselves. See CONTEXT.md and docs/adr/0001-manual-sidebar-order.md.

export function createEmptyOrder() {
  return { groups: {}, collapsed: {}, order: [], ungroupedOrder: [] };
}

function normalize(data) {
  const src = data && typeof data === "object" ? data : {};
  const groups = {};
  if (src.groups && typeof src.groups === "object") {
    for (const [name, members] of Object.entries(src.groups)) {
      groups[name] = Array.isArray(members) ? [...members] : [];
    }
  }
  const collapsed = {};
  if (src.collapsed && typeof src.collapsed === "object") {
    for (const [name, value] of Object.entries(src.collapsed)) collapsed[name] = !!value;
  }
  const order = Array.isArray(src.order) ? src.order.filter((n) => typeof n === "string") : [];
  const ungroupedOrder = Array.isArray(src.ungroupedOrder)
    ? src.ungroupedOrder.filter((k) => typeof k === "string")
    : [];
  return { groups, collapsed, order, ungroupedOrder };
}

function clamp(index, length) {
  const i = Number.isInteger(index) ? index : length;
  return Math.max(0, Math.min(i, length));
}

function nameOfKey(key) {
  return key.includes("::") ? key.split("::").slice(1).join("::") : key;
}

/**
 * Move a session key to `target` (a group name, or null/undefined for the
 * ungrouped region) at position `index`. Returns a new data object.
 */
export function moveSession(data, key, target, index) {
  const next = normalize(data);

  for (const name of Object.keys(next.groups)) {
    next.groups[name] = next.groups[name].filter((k) => k !== key);
  }
  next.ungroupedOrder = next.ungroupedOrder.filter((k) => k !== key);

  if (target == null) {
    const at = clamp(index, next.ungroupedOrder.length);
    next.ungroupedOrder.splice(at, 0, key);
  } else {
    if (!next.groups[target]) {
      next.groups[target] = [];
      if (!next.order.includes(target)) next.order.push(target);
    }
    const at = clamp(index, next.groups[target].length);
    next.groups[target].splice(at, 0, key);
  }
  return next;
}

/** Reorder a group among its peers. Returns a new data object. */
export function moveGroup(data, name, index) {
  const next = normalize(data);
  next.order = next.order.filter((n) => n !== name);
  for (const groupName of Object.keys(next.groups)) {
    if (groupName !== name && !next.order.includes(groupName)) next.order.push(groupName);
  }
  const at = clamp(index, next.order.length);
  next.order.splice(at, 0, name);
  return next;
}

/**
 * Reconcile stored keys against the live sessions and resolve the render view.
 *
 * - stored keys whose session is absent are kept (so a returning session gets
 *   its old slot back)
 * - a stored key whose session reappears under a different machine host is
 *   rewritten to the new key, keeping its slot
 * - sessions never seen before are seeded at the top of the ungrouped region
 * - group names missing from `order` are appended
 *
 * Returns { data, groups, ungrouped, changed } where `groups` is
 * [{ name, collapsed, sessions }] in render order (empty groups included).
 */
export function resolveOrder(data, sessions, keyOf = (s) => s.key) {
  const next = normalize(data);
  const list = Array.isArray(sessions) ? sessions : [];

  const keyToSession = new Map();
  const nameToSession = new Map();
  for (const session of list) {
    const k = keyOf(session);
    if (!keyToSession.has(k)) keyToSession.set(k, session);
    if (session && typeof session.name === "string" && !nameToSession.has(session.name)) {
      nameToSession.set(session.name, session);
    }
  }

  let changed = false;

  const reconcileKey = (storedKey) => {
    if (keyToSession.has(storedKey)) return storedKey;
    const match = nameToSession.get(nameOfKey(storedKey));
    if (!match) return storedKey;
    const newKey = keyOf(match);
    if (newKey !== storedKey) changed = true;
    return newKey;
  };

  const seen = new Set();

  for (const name of Object.keys(next.groups)) {
    const resolved = [];
    for (const k of next.groups[name]) {
      const rk = reconcileKey(k);
      if (seen.has(rk)) {
        changed = true;
        continue;
      }
      seen.add(rk);
      resolved.push(rk);
    }
    if (resolved.length !== next.groups[name].length) changed = true;
    next.groups[name] = resolved;
  }

  const ungroupedResolved = [];
  for (const k of next.ungroupedOrder) {
    const rk = reconcileKey(k);
    if (seen.has(rk)) {
      changed = true;
      continue;
    }
    seen.add(rk);
    ungroupedResolved.push(rk);
  }
  if (ungroupedResolved.length !== next.ungroupedOrder.length) changed = true;
  next.ungroupedOrder = ungroupedResolved;

  const fresh = [];
  for (const session of list) {
    const k = keyOf(session);
    if (!seen.has(k)) {
      seen.add(k);
      fresh.push(k);
    }
  }
  if (fresh.length) {
    next.ungroupedOrder = [...fresh, ...next.ungroupedOrder];
    changed = true;
  }

  for (const groupName of Object.keys(next.groups)) {
    if (!next.order.includes(groupName)) {
      next.order.push(groupName);
      changed = true;
    }
  }

  const groups = next.order.map((name) => ({
    name,
    collapsed: !!next.collapsed[name],
    sessions: (next.groups[name] || []).map((k) => keyToSession.get(k)).filter(Boolean),
  }));

  const ungrouped = next.ungroupedOrder.map((k) => keyToSession.get(k)).filter(Boolean);

  return { data: next, groups, ungrouped, changed };
}