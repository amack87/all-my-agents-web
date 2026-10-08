import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TYPES,
  nextStatus,
  applyEvent,
  eventStatus,
  resolveIdentity,
} from "../agent-events.js";

// --- Canonical vocabulary ---------------------------------------------------

test("vocabulary contains exactly the eight canonical events", () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [
    "notification",
    "permissionRequest",
    "promptSubmit",
    "sessionEnd",
    "sessionStart",
    "stop",
    "toolEnd",
    "toolStart",
  ]);
});

// --- Transition table -------------------------------------------------------

test("sessionStart from no prior state lands idle", () => {
  assert.equal(nextStatus(null, "sessionStart"), "idle");
});

test("work events move any state to working", () => {
  for (const prev of [null, "idle", "working", "needsInput"]) {
    for (const event of ["promptSubmit", "toolStart", "toolEnd"]) {
      assert.equal(nextStatus(prev, event), "working", `${prev} + ${event}`);
    }
  }
});

test("attention events move any state to needsInput", () => {
  for (const prev of [null, "idle", "working", "needsInput"]) {
    for (const event of ["permissionRequest", "notification"]) {
      assert.equal(nextStatus(prev, event), "needsInput", `${prev} + ${event}`);
    }
  }
});

test("stop moves any non-ended state to idle", () => {
  for (const prev of [null, "working", "needsInput", "idle"]) {
    assert.equal(nextStatus(prev, "stop"), "idle", `${prev} + stop`);
  }
});

test("sessionEnd moves any state to ended", () => {
  for (const prev of [null, "working", "needsInput", "idle"]) {
    assert.equal(nextStatus(prev, "sessionEnd"), "ended", `${prev} + sessionEnd`);
  }
});

test("ended is sticky against every event except sessionStart", () => {
  for (const event of [...EVENT_TYPES]) {
    if (event === "sessionStart") continue;
    assert.equal(nextStatus("ended", event), "ended", `ended + ${event}`);
  }
});

test("sessionStart reopens an ended session", () => {
  assert.equal(nextStatus("ended", "sessionStart"), "idle");
});

test("unknown events leave the current state unchanged", () => {
  assert.equal(nextStatus("working", "telemetryPing"), "working");
  assert.equal(nextStatus("needsInput", "telemetryPing"), "needsInput");
  assert.equal(nextStatus("ended", "telemetryPing"), "ended");
  assert.equal(nextStatus(null, "telemetryPing"), null);
});

// --- applyEvent (state container) ------------------------------------------

test("applyEvent records the event status and timestamp", () => {
  const state = applyEvent(null, "toolStart", 1000);
  assert.deepEqual(state, { status: "working", updatedAt: 1000 });
});

test("applyEvent advances an existing state", () => {
  const prev = { status: "working", updatedAt: 1000 };
  const next = applyEvent(prev, "permissionRequest", 2000);
  assert.deepEqual(next, { status: "needsInput", updatedAt: 2000 });
});

test("applyEvent is a no-op for unknown events, even from empty state", () => {
  const prev = { status: "working", updatedAt: 1000 };
  assert.equal(applyEvent(prev, "telemetryPing", 2000), prev);
  assert.equal(applyEvent(null, "telemetryPing", 2000), null);
});

// --- Staleness --------------------------------------------------------------

test("fresh working event status is served", () => {
  const state = { status: "working", updatedAt: 1000 };
  assert.equal(eventStatus(state, 1000 + 5_000, 120_000), "working");
});

test("stale working event status expires so the screen fallback wins", () => {
  const state = { status: "working", updatedAt: 1000 };
  assert.equal(eventStatus(state, 1000 + 120_001, 120_000), null);
});

test("stale idle event status expires too", () => {
  const state = { status: "idle", updatedAt: 1000 };
  assert.equal(eventStatus(state, 1000 + 120_001, 120_000), null);
});

test("needsInput never expires", () => {
  const state = { status: "needsInput", updatedAt: 1000 };
  assert.equal(eventStatus(state, 1000 + 10 * 24 * 3_600_000, 120_000), "needsInput");
});

test("ended never expires", () => {
  const state = { status: "ended", updatedAt: 1000 };
  assert.equal(eventStatus(state, 1000 + 10 * 24 * 3_600_000, 120_000), "ended");
});

test("no event state means no event status", () => {
  assert.equal(eventStatus(null, 1000, 120_000), null);
});

// --- Identity resolution ----------------------------------------------------

const registry = [
  { tmux: "llc", sessionId: "ses_aaa" },
  { tmux: "weather-trading", sessionId: "ses_bbb" },
];

test("surface token wins over session id", () => {
  const result = resolveIdentity(
    { surfaceToken: "tok_1", sessionId: "ses_bbb" },
    { surfaceTokens: new Map([["tok_1", "llc"]]), registrySessions: registry },
  );
  assert.deepEqual(result, { ok: true, name: "llc" });
});

test("unknown surface token falls through to registry session id", () => {
  const result = resolveIdentity(
    { surfaceToken: "tok_gone", sessionId: "ses_bbb" },
    { surfaceTokens: new Map(), registrySessions: registry },
  );
  assert.deepEqual(result, { ok: true, name: "weather-trading" });
});

test("registry session id alone resolves to the tmux name", () => {
  const result = resolveIdentity(
    { sessionId: "ses_aaa" },
    { surfaceTokens: new Map(), registrySessions: registry },
  );
  assert.deepEqual(result, { ok: true, name: "llc" });
});

test("no identity at all is rejected unmatched", () => {
  const result = resolveIdentity(
    {},
    { surfaceTokens: new Map(), registrySessions: registry },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unmatched");
});

test("session id absent from the registry is rejected unmatched", () => {
  const result = resolveIdentity(
    { sessionId: "ses_zzz" },
    { surfaceTokens: new Map(), registrySessions: registry },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unmatched");
});

test("a session id claimed by two registry entries is rejected ambiguous", () => {
  const dupes = [
    { tmux: "a", sessionId: "ses_same" },
    { tmux: "b", sessionId: "ses_same" },
  ];
  const result = resolveIdentity(
    { sessionId: "ses_same" },
    { surfaceTokens: new Map(), registrySessions: dupes },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous");
});
