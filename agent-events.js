// Canonical agent lifecycle state machine.
//
// Adapters (opencode plugin, Claude hooks, …) translate agent-native signals
// into the canonical event vocabulary below and POST them to the server; this
// module is the single reducer that turns (previous status, event) into the
// next status. Adapters never branch inside the reducer — they only choose
// which canonical event to emit.
//
// Derived from cmux's `nextState` (manaflow-ai/cmux):
// - `ended` is sticky: only a fresh `sessionStart` reopens the session.
// - unknown event names are accepted as no-ops (telemetry), never errors.
// - `needsInput`/`ended` are sticky states that only explicit events clear;
//   ordinary `working`/`idle` event state decays after a TTL so a dead or
//   silent adapter falls back to screen detection instead of pinning a status
//   forever.
//
// Must stay pure: no fs/tmux/network, no clock reads (now is a parameter).

export const EVENT_TYPES = Object.freeze([
  "sessionStart",
  "promptSubmit",
  "toolStart",
  "toolEnd",
  "permissionRequest",
  "notification",
  "stop",
  "sessionEnd",
]);

const KNOWN = new Set(EVENT_TYPES);

const WORK_EVENTS = new Set(["promptSubmit", "toolStart", "toolEnd"]);
const ATTENTION_EVENTS = new Set(["permissionRequest", "notification"]);

// States that survive staleness indefinitely — they clear only on an
// explicit event, never by the clock.
const STICKY_STATES = new Set(["needsInput", "ended"]);

// nextStatus(previous, event) → next status (or null for "no state").
// Transition table:
//   any      + sessionStart                  → idle
//   any      + promptSubmit|toolStart|toolEnd → working
//   any      + permissionRequest|notification → needsInput
//   any      + stop                          → idle
//   any      + sessionEnd                    → ended
//   ended    + anything but sessionStart     → ended (sticky)
//   unknown  event                           → unchanged
export function nextStatus(previous, event) {
  if (!KNOWN.has(event)) return previous;
  if (previous === "ended" && event !== "sessionStart") return "ended";
  if (event === "sessionStart") return "idle";
  if (event === "sessionEnd") return "ended";
  if (event === "stop") return "idle";
  if (WORK_EVENTS.has(event)) return "working";
  if (ATTENTION_EVENTS.has(event)) return "needsInput";
  return previous;
}

// applyEvent(state, event, now) → state | state-unchanged.
// state is `{ status, updatedAt }` or null. Unknown events return the input
// unchanged (same reference) so callers can detect a no-op.
export function applyEvent(state, event, now) {
  if (!KNOWN.has(event)) return state;
  const next = nextStatus(state?.status ?? null, event);
  if (next === null) return null;
  return { status: next, updatedAt: now };
}

// eventStatus(state, now, ttlMs) → status | null.
// Returns the event-derived status while it is authoritative, or null when
// the caller should fall back to screen detection: no state at all, or a
// non-sticky state older than ttlMs.
export function eventStatus(state, now, ttlMs) {
  if (!state) return null;
  if (STICKY_STATES.has(state.status)) return state.status;
  if (now - state.updatedAt > ttlMs) return null;
  return state.status;
}

// resolveIdentity(payload, lookup) → { ok: true, name } | { ok: false, reason }.
// Precedence: surface token → registry session id → rejected. No title,
// output, or mtime matching — ever. reason is "unmatched" (nothing resolved)
// or "ambiguous" (a session id claimed by multiple registry entries).
export function resolveIdentity(payload, lookup) {
  const surfaceTokens = lookup.surfaceTokens ?? new Map();
  const registrySessions = lookup.registrySessions ?? [];

  const token = payload?.surfaceToken;
  if (typeof token === "string" && token.length > 0) {
    const name = surfaceTokens.get(token);
    if (name) return { ok: true, name };
  }

  const sessionId = payload?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const matches = registrySessions.filter((s) => s.sessionId === sessionId);
    if (matches.length === 1) return { ok: true, name: matches[0].tmux };
    if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  }

  return { ok: false, reason: "unmatched" };
}
