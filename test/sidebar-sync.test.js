import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTimestamp, orderHasGroups, orderClearedGroups, pickWinner } from "../public/sidebar-sync.js";

const empty = () => ({ groups: {}, collapsed: {}, order: [], ungroupedOrder: [] });
const filled = () => ({
  groups: { Work: ["local::a"] },
  collapsed: {},
  order: ["Work"],
  ungroupedOrder: [],
});
const cleared = () => ({
  groups: {},
  collapsed: {},
  order: [],
  ungroupedOrder: [],
  groupsCleared: true,
});

test("a copy with groups is not erased by a newer copy without them", () => {
  const local = { data: filled(), updatedAt: 100 };
  const remote = { data: empty(), updatedAt: 200 };
  assert.equal(pickWinner(local, remote), "local");
  assert.equal(pickWinner(remote, local), "remote");
});

test("when both copies have groups, the newer one wins", () => {
  const local = { data: filled(), updatedAt: 100 };
  const remote = { data: filled(), updatedAt: 200 };
  assert.equal(pickWinner(local, remote), "remote");
  assert.equal(pickWinner(remote, local), "local");
});

test("a blank copy never erases the server's groups", () => {
  assert.equal(pickWinner({ data: empty(), updatedAt: 0 }, { data: filled(), updatedAt: 1000 }), "remote");
});

test("a copy that declares it cleared its groups may replace one that has them", () => {
  const local = { data: cleared(), updatedAt: 200 };
  const remote = { data: filled(), updatedAt: 100 };
  assert.equal(pickWinner(local, remote), "local");
});

test("orderHasGroups and orderClearedGroups read the group set", () => {
  assert.equal(orderHasGroups(filled()), true);
  assert.equal(orderHasGroups(empty()), false);
  assert.equal(orderHasGroups(null), false);
  assert.equal(orderClearedGroups(cleared()), true);
  assert.equal(orderClearedGroups(empty()), false);
  assert.equal(orderClearedGroups(null), false);
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
