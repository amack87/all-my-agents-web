import test from "node:test";
import assert from "node:assert/strict";

import { indexClaudeSessions, paneIdFromTmuxTarget } from "../claude-session-index.js";

test("parses the pane id from a Claude tmux target", () => {
  assert.equal(paneIdFromTmuxTarget("questions:@6.%6"), "%6");
  assert.equal(paneIdFromTmuxTarget("claude-testing:@11.%11"), "%11");
  assert.equal(paneIdFromTmuxTarget("pong-2:@4.%15"), "%15");
});

test("returns null for targets without a trailing pane token", () => {
  assert.equal(paneIdFromTmuxTarget(null), null);
  assert.equal(paneIdFromTmuxTarget("questions:@6"), null);
  assert.equal(paneIdFromTmuxTarget(""), null);
});

test("does not confuse %1 with %15", () => {
  // The pane token is anchored to the end of the target, so a record for %15
  // can never be indexed as %1 — the substring trap found during research.
  const index = indexClaudeSessions([
    { pid: 42085, sessionId: "7d8dc142-0228-45d9-94da-5def1613518b", tmux: "pong-2:@4.%15" },
  ]);

  assert.equal(index.has("%1"), false);
  assert.deepEqual(index.get("%15"), { pid: 42085, sessionId: "7d8dc142-0228-45d9-94da-5def1613518b" });
});

test("indexes valid records by pane id", () => {
  const index = indexClaudeSessions([
    { pid: 10059, sessionId: "0d78b2d1-52d2-47c9-9de2-0e7e21622269", tmux: "questions:@6.%6" },
    { pid: 51349, sessionId: "3dcf13c1-ce89-4146-8b3d-035655370f87", tmux: "slide-builder:@7.%7" },
  ]);

  assert.equal(index.size, 2);
  assert.equal(index.get("%6").pid, 10059);
  assert.equal(index.get("%7").sessionId, "3dcf13c1-ce89-4146-8b3d-035655370f87");
});

test("drops malformed, incomplete, and non-Claude records", () => {
  const index = indexClaudeSessions([
    null,
    "nope",
    { pid: 1, sessionId: "not-a-uuid", tmux: "x:@1.%1" },
    { pid: 0, sessionId: "0d78b2d1-52d2-47c9-9de2-0e7e21622269", tmux: "x:@1.%1" },
    { pid: 2, sessionId: "0d78b2d1-52d2-47c9-9de2-0e7e21622269", tmux: "no-pane-token" },
    { pid: 3, sessionId: "ses_opencode", tmux: "x:@1.%1" },
  ]);

  assert.equal(index.size, 0);
});
