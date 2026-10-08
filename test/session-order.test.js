import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyOrder,
  moveSession,
  moveGroup,
  resolveOrder,
} from "../public/session-order.js";

const key = (machineHost, name) => `${machineHost || "local"}::${name}`;

function sess(name, machineHost = "local") {
  return { key: key(machineHost, name), name };
}

const data = (over = {}) => ({
  groups: {},
  collapsed: {},
  order: [],
  ungroupedOrder: [],
  ...over,
});

test("createEmptyOrder returns the canonical empty structure", () => {
  assert.deepEqual(createEmptyOrder(), {
    groups: {},
    collapsed: {},
    order: [],
    ungroupedOrder: [],
  });
});

test("moveSession reorders within the ungrouped region", () => {
  const input = data({ ungroupedOrder: ["a", "b", "c", "d"] });
  const out = moveSession(input, "a", null, 2);
  assert.deepEqual(out.ungroupedOrder, ["b", "c", "a", "d"]);
});

test("moveSession moves a key from a group into the ungrouped region at an index", () => {
  const input = data({
    groups: { G: ["x", "y"] },
    order: ["G"],
    ungroupedOrder: ["a", "b"],
  });
  const out = moveSession(input, "x", null, 1);
  assert.deepEqual(out.groups.G, ["y"]);
  assert.deepEqual(out.ungroupedOrder, ["a", "x", "b"]);
});

test("moveSession moves a key from the ungrouped region into a group at an index", () => {
  const input = data({
    groups: { G: ["x", "y"] },
    order: ["G"],
    ungroupedOrder: ["a", "b"],
  });
  const out = moveSession(input, "b", "G", 1);
  assert.deepEqual(out.groups.G, ["x", "b", "y"]);
  assert.deepEqual(out.ungroupedOrder, ["a"]);
});

test("moveSession moves a key between groups", () => {
  const input = data({
    groups: { G: ["x", "y"], H: ["p", "q"] },
    order: ["G", "H"],
  });
  const out = moveSession(input, "x", "H", 2);
  assert.deepEqual(out.groups.G, ["y"]);
  assert.deepEqual(out.groups.H, ["p", "q", "x"]);
});

test("moveSession clamps an out-of-range index", () => {
  const input = data({ groups: { G: ["x"] }, order: ["G"], ungroupedOrder: ["a"] });
  assert.deepEqual(moveSession(input, "a", "G", 99).groups.G, ["x", "a"]);
  assert.deepEqual(moveSession(input, "a", null, -5).ungroupedOrder, ["a"]);
});

test("moveSession does not mutate its input", () => {
  const input = data({ ungroupedOrder: ["a", "b"] });
  const snapshot = JSON.parse(JSON.stringify(input));
  moveSession(input, "a", null, 1);
  assert.deepEqual(input, snapshot);
});

test("moveGroup reorders the group order array", () => {
  const input = data({ groups: { A: [], B: [], C: [] }, order: ["A", "B", "C"] });
  const out = moveGroup(input, "C", 0);
  assert.deepEqual(out.order, ["C", "A", "B"]);
});

test("moveGroup clamps an out-of-range index", () => {
  const input = data({ groups: { A: {}, B: {} }, order: ["A", "B"] });
  assert.deepEqual(moveGroup(input, "A", 99).order, ["B", "A"]);
});

test("moveGroup inserts at the post-removal index (callers pre-shift rendered indices)", () => {
  // Dragging A below C renders at index 3 in [A,B,C,D]; the caller shifts
  // 3 -> 2 because A is removed first, landing A between C and D.
  const input = data({ groups: { A: [], B: [], C: [], D: [] }, order: ["A", "B", "C", "D"] });
  assert.deepEqual(moveGroup(input, "A", 2).order, ["B", "C", "A", "D"]);
  assert.deepEqual(moveGroup(input, "D", 1).order, ["A", "D", "B", "C"]);
});

test("resolveOrder seeds unseen keys at the top of the ungrouped region", () => {
  const input = data({ ungroupedOrder: ["local::old"] });
  const out = resolveOrder(input, [sess("new1"), sess("old")], (s) => s.key);
  assert.deepEqual(out.data.ungroupedOrder, ["local::new1", "local::old"]);
  assert.deepEqual(out.ungrouped.map((s) => s.name), ["new1", "old"]);
  assert.equal(out.changed, true);
});

test("resolveOrder keeps absent keys so returning sessions keep their slot", () => {
  const input = data({ ungroupedOrder: [key("local", "a"), key("local", "gone"), key("local", "b")] });
  const out = resolveOrder(input, [sess("a"), sess("b")], (s) => s.key);
  assert.deepEqual(out.data.ungroupedOrder, [
    key("local", "a"),
    key("local", "gone"),
    key("local", "b"),
  ]);
  assert.deepEqual(out.ungrouped.map((s) => s.name), ["a", "b"]);
  // When "gone" comes back it lands in its old slot.
  const back = resolveOrder(out.data, [sess("a"), sess("gone"), sess("b")], (s) => s.key);
  assert.deepEqual(back.ungrouped.map((s) => s.name), ["a", "gone", "b"]);
});

test("resolveOrder rewrites a stored key when the machine host changes", () => {
  const input = data({ groups: { G: [key("oldhost", "web")] }, order: ["G"] });
  const out = resolveOrder(input, [sess("web", "newhost")], (s) => s.key);
  assert.deepEqual(out.groups[0].sessions.map((s) => s.name), ["web"]);
  assert.deepEqual(out.data.groups.G, [key("newhost", "web")]);
});

test("resolveOrder returns groups in stored order including empty ones", () => {
  const input = data({
    groups: { G: ["a"], Empty: [] },
    order: ["G", "Empty"],
    ungroupedOrder: [],
  });
  const out = resolveOrder(input, [sess("a")], (s) => s.key);
  assert.deepEqual(out.groups.map((g) => g.name), ["G", "Empty"]);
  assert.deepEqual(out.groups[1].sessions, []);
});

test("resolveOrder appends group names missing from the order array", () => {
  const input = data({ groups: { G: [], Lost: [] }, order: ["G"] });
  const out = resolveOrder(input, [], (s) => s.key);
  assert.deepEqual(out.groups.map((g) => g.name), ["G", "Lost"]);
});

test("resolveOrder seeds a brand-new session at the top of ungrouped", () => {
  const input = data({ groups: { G: ["g1"] }, order: ["G"], ungroupedOrder: ["u1"] });
  const out = resolveOrder(input, [sess("g1"), sess("u1"), sess("fresh")], (s) => s.key);
  assert.deepEqual(out.ungrouped.map((s) => s.name), ["fresh", "u1"]);
});

test("resolveOrder does not mutate its input", () => {
  const input = data({ groups: { G: ["a"] }, order: ["G"], ungroupedOrder: ["b"] });
  const snapshot = JSON.parse(JSON.stringify(input));
  resolveOrder(input, [sess("a"), sess("b"), sess("c")], (s) => s.key);
  assert.deepEqual(input, snapshot);
});