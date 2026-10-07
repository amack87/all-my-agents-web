import test from "node:test";
import assert from "node:assert/strict";

import { buildRestorePlan } from "../restore-plan.js";

const REGISTRY = {
  version: 1,
  updatedAt: "2026-09-01T12:00:00.000Z",
  sessions: [
    { tmux: "ama-stuff", dir: "/repos/all-my-agents-web", sessionId: "ses_aaa", agent: "opencode", firstSeen: "x", lastActive: "x" },
    { tmux: "fix-bug", dir: "/repos/other", sessionId: "ses_bbb", agent: "opencode", firstSeen: "x", lastActive: "x" },
  ],
};

test("resumes each entry when its session id resolves", () => {
  const actions = buildRestorePlan({
    registry: REGISTRY,
    existingTmux: [],
    resolvable: new Set(["ses_aaa", "ses_bbb"]),
  });

  assert.deepEqual(actions, [
    { kind: "launch-opencode", name: "ama-stuff", dir: "/repos/all-my-agents-web", sessionId: "ses_aaa", continueBest: false, reason: "resume" },
    { kind: "launch-opencode", name: "fix-bug", dir: "/repos/other", sessionId: "ses_bbb", continueBest: false, reason: "resume" },
  ]);
});

test("degrades to continue-last when a session id is unresolvable", () => {
  const actions = buildRestorePlan({
    registry: REGISTRY,
    existingTmux: [],
    resolvable: new Set(["ses_aaa"]),
  });

  const degraded = actions.find((a) => a.name === "fix-bug");
  assert.ok(degraded);
  assert.equal(degraded.continueBest, true);
  assert.equal(degraded.sessionId, null);
  assert.equal(degraded.reason, "degrade");
});

test("degrades when the entry never had a session id", () => {
  const registry = {
    version: 1,
    updatedAt: "x",
    sessions: [
      { tmux: "fresh", dir: "/repos/fresh", sessionId: null, agent: "opencode", firstSeen: "x", lastActive: "x" },
    ],
  };

  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "launch-opencode", name: "fresh", dir: "/repos/fresh", sessionId: null, continueBest: true, reason: "degrade" },
  ]);
});

test("skips entries whose tmux session already exists (idempotent boot)", () => {
  const actions = buildRestorePlan({
    registry: REGISTRY,
    existingTmux: ["ama-stuff"],
    resolvable: new Set(["ses_bbb"]),
  });

  assert.deepEqual(actions.map((a) => a.name), ["fix-bug"]);
});

test("returns an empty plan for an empty registry", () => {
  const actions = buildRestorePlan({ registry: { version: 1, updatedAt: "x", sessions: [] }, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, []);
});

test("returns an empty plan for a missing registry", () => {
  assert.deepEqual(buildRestorePlan({ registry: null, existingTmux: [], resolvable: new Set() }), []);
});

test("plans a bare-shell recreate for a non-opencode entry", () => {
  const registry = {
    version: 1,
    updatedAt: "x",
    sessions: [
      { tmux: "scratch", dir: "/tmp/scratch", sessionId: null, agent: "shell", firstSeen: "x", lastActive: "x" },
    ],
  };

  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "recreate-shell", name: "scratch", dir: "/tmp/scratch", agent: "shell", reason: "recreate-shell" },
  ]);
});

test("plans a bare-shell recreate for a still-unclassified entry", () => {
  const registry = {
    version: 1,
    updatedAt: "x",
    sessions: [
      { tmux: "unclear", dir: null, sessionId: null, agent: null, firstSeen: "x", lastActive: "x" },
    ],
  };

  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "recreate-shell", name: "unclear", dir: null, agent: null, reason: "recreate-shell" },
  ]);
});

test("a shell entry is never resumed even when it carries a session id", () => {
  // Only opencode-classified panes are resumable. A stale session id on a
  // shell entry must not be treated as a conversation to re-attach.
  const registry = {
    version: 1,
    updatedAt: "x",
    sessions: [
      { tmux: "stale", dir: "/repos/x", sessionId: "ses_stale", agent: "shell", firstSeen: "x", lastActive: "x" },
    ],
  };

  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set(["ses_stale"]) });
  assert.deepEqual(actions, [
    { kind: "recreate-shell", name: "stale", dir: "/repos/x", agent: "shell", reason: "recreate-shell" },
  ]);
});