import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTimestamp, pickWinner } from "../public/sidebar-sync.js";

const empty = () => ({ groups: {}, collapsed: {}, order: [], ungroupedOrder: [] });
const filled = () => ({
  groups: { Work: ["local::a"] },
  collapsed: {},
  order: ["Work"],
  ungroupedOrder: [],
});

test("newer updatedAt wins regardless of side", () => {
  const local = { data: filled(), updatedAt: 100 };
  const remote = { data: empty(), updatedAt: 200 };
  assert.equal(pickWinner(local, remote), "remote");
  assert.equal(pickWinner(remote, local), "local");
});

test("ties keep the local copy", () => {
  const local = { data: filled(), updatedAt: 100 };
  const remote = { data: empty(), updatedAt: 100 };
  assert.equal(pickWinner(local, remote), "local");
});

test("legacy content without a timestamp counts as 1", () => {
  assert.equal(orderTimestamp({ data: filled() }), 1);
  assert.equal(orderTimestamp({ data: empty() }), 0);
  assert.equal(orderTimestamp(null), 0);
});

test("legacy local content beats an empty server copy", () => {
  const local = { data: filled() };
  const remote = { data: empty(), updatedAt: 0 };
  assert.equal(pickWinner(local, remote), "local");
});

test("a timestamped remote write beats legacy local content", () => {
  const local = { data: filled() };
  const remote = { data: filled(), updatedAt: Date.now() };
  assert.equal(pickWinner(local, remote), "remote");
});

test("nothing to do when both sides are empty", () => {
  assert.equal(pickWinner({ data: empty(), updatedAt: 0 }, { data: empty(), updatedAt: 0 }), "none");
  assert.equal(pickWinner(null, null), "none");
});
