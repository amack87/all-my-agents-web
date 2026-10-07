import test from "node:test";
import assert from "node:assert/strict";

import { reconcileRegistry, REGISTRY_VERSION } from "../session-registry.js";

const NOW = "2026-09-01T12:00:00.000Z";

test("adds every live session when there is no prior registry", () => {
  const live = [
    { name: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode" },
    { name: "fix-bug", dir: "/repos/b", sessionId: null, agent: "opencode" },
  ];
  const { registry, changed, removed } = reconcileRegistry(live, null, NOW);

  assert.equal(changed, true);
  assert.deepEqual(removed, []);
  assert.equal(registry.version, REGISTRY_VERSION);
  assert.equal(registry.updatedAt, NOW);
  assert.deepEqual(
    registry.sessions.map((s) => ({ tmux: s.tmux, dir: s.dir, sessionId: s.sessionId, firstSeen: s.firstSeen })),
    [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", firstSeen: NOW },
      { tmux: "fix-bug", dir: "/repos/b", sessionId: null, firstSeen: NOW },
    ],
  );
});

test("unchanged live set produces no change and keeps firstSeen", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode" }];

  const { registry, changed, removed } = reconcileRegistry(live, prior, NOW);

  assert.equal(changed, false);
  assert.deepEqual(removed, []);
  assert.equal(registry.sessions[0].firstSeen, NOW);
  assert.equal(registry.sessions[0].lastActive, NOW);
  assert.ok(registry.updatedAt === NOW, "updatedAt refreshes even when content is unchanged");
});

test("a changed live field marks the registry changed", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/moved", sessionId: "ses_1", agent: "opencode" }];

  const { registry, changed } = reconcileRegistry(live, prior, NOW);

  assert.equal(changed, true);
  assert.equal(registry.sessions[0].dir, "/repos/moved");
  assert.equal(registry.sessions[0].firstSeen, NOW, "firstSeen survives an update");
});

test("keeps the prior sessionId when live temporarily can't resolve one (no-regress)", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: null, agent: "opencode" }];

  const { registry, changed } = reconcileRegistry(live, prior, NOW);

  assert.equal(registry.sessions[0].sessionId, "ses_1", "a transient resolve miss must not burn the id");
  assert.equal(changed, false, "resolving nothing different means nothing to write");
});

test("adopts a new sessionId on positive evidence", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: "ses_2", agent: "opencode" }];

  const { registry, changed } = reconcileRegistry(live, prior, NOW);

  assert.equal(changed, true);
  assert.equal(registry.sessions[0].sessionId, "ses_2");
});

test("removes entries only after a grace window of two consecutive misses", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
      { tmux: "gone", dir: "/repos/g", sessionId: "ses_2", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode" }];

  // Pass 1: "gone" is missed once — it must survive the grace window (the
  // registry would otherwise flicker on any transient discovery miss).
  const pass1 = reconcileRegistry(live, prior, NOW);
  assert.deepEqual(pass1.removed, []);
  assert.equal(pass1.changed, true, "the bumped miss counter must persist");
  assert.deepEqual(pass1.registry.sessions.map((s) => s.tmux), ["ama-stuff", "gone"]);
  assert.equal(pass1.registry.sessions.find((s) => s.tmux === "gone").misses, 1);

  // Pass 2: missed again — now it is genuinely gone and gets pruned.
  const pass2 = reconcileRegistry(live, pass1.registry, NOW);
  assert.deepEqual(pass2.removed, [{ tmux: "gone", reason: "no longer running" }]);
  assert.deepEqual(pass2.registry.sessions.map((s) => s.tmux), ["ama-stuff"]);
});

test("a restore-spawned pane missed by the first post-restore scan survives", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: "2026-09-01T10:00:00.000Z", lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };

  // Restore just spawned the pane; the immediate post-restore reconcile runs
  // before opencode has booted far enough to be classified, so live is empty.
  const pass1 = reconcileRegistry([], prior, NOW);
  assert.deepEqual(pass1.removed, []);
  const survived = pass1.registry.sessions.find((s) => s.tmux === "ama-stuff");
  assert.ok(survived, "the queued-for-restore entry must not be dropped mid-restore");
  assert.equal(survived.sessionId, "ses_1", "keep the id a restart would replay");
  assert.equal(survived.firstSeen, "2026-09-01T10:00:00.000Z");
  assert.equal(survived.misses, 1);

  // Next scan sees the pane live again — the entry heals, miss counter resets.
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode" }];
  const pass2 = reconcileRegistry(live, pass1.registry, NOW);
  assert.deepEqual(pass2.removed, []);
  assert.equal(pass2.registry.sessions[0].misses, 0);
  assert.equal(pass2.registry.sessions[0].firstSeen, "2026-09-01T10:00:00.000Z");
});

test("a stale registry version forces a change", () => {
  const prior = {
    version: 0,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode" }];

  assert.equal(reconcileRegistry(live, prior, NOW).changed, true);
});

test("stores a shell-classified pane with its faithful agent (never upgrades to opencode)", () => {
  const live = [
    { name: "scratch", dir: "/tmp/scratch", sessionId: null, agent: "shell" },
    { name: "helper", dir: null, sessionId: null, agent: null },
  ];

  const { registry, changed } = reconcileRegistry(live, null, NOW);

  assert.equal(changed, true);
  assert.equal(registry.sessions.find((s) => s.tmux === "scratch").agent, "shell");
  assert.equal(registry.sessions.find((s) => s.tmux === "helper").agent, null);
});

test("a grace miss keeps the shell classification (only liveness drives misses)", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "scratch", dir: "/tmp/scratch", sessionId: null, agent: "shell", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
      { tmux: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "ama-stuff", dir: "/repos/a", sessionId: "ses_1", agent: "opencode" }];

  const pass1 = reconcileRegistry(live, prior, NOW);

  assert.deepEqual(pass1.removed, []);
  const scratch = pass1.registry.sessions.find((s) => s.tmux === "scratch");
  assert.equal(scratch.agent, "shell", "classification is not fabricated away on a transient miss");
  assert.equal(scratch.misses, 1);
});

test("updates classification when a shell pane is later identified as opencode", () => {
  const prior = {
    version: REGISTRY_VERSION,
    updatedAt: "2026-09-01T11:00:00.000Z",
    sessions: [
      { tmux: "promoted", dir: "/repos/p", sessionId: null, agent: "shell", firstSeen: NOW, lastActive: "2026-09-01T11:00:00.000Z", misses: 0 },
    ],
  };
  const live = [{ name: "promoted", dir: "/repos/p", sessionId: "ses_9", agent: "opencode" }];

  const { registry, changed } = reconcileRegistry(live, prior, NOW);

  assert.equal(changed, true);
  assert.equal(registry.sessions[0].agent, "opencode");
  assert.equal(registry.sessions[0].sessionId, "ses_9");
  assert.equal(registry.sessions[0].firstSeen, NOW, "firstSeen still survives the promotion");
});