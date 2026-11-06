import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEASE_TTL_MS,
  createLease,
  requestLease,
  releaseLease,
} from "../pane-lease.js";

test("the first device to ask gets the pane", () => {
  const lease = createLease();
  const result = requestLease(lease, { holder: "a", interactedAt: null }, 1000);
  assert.equal(result.granted, true);
  assert.equal(result.lease.holder, "a");
});

test("the holder keeps the pane when it asks again", () => {
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 100 }, 1000).lease;
  const result = requestLease(lease, { holder: "a", interactedAt: 100 }, 2000);
  assert.equal(result.granted, true);
  assert.equal(result.lease.holder, "a");
});

test("a device that was never touched cannot take the pane", () => {
  // The phone propped up on the desk is connected but nobody used it, so it
  // must not take the pane away from the device in front of the user.
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  const result = requestLease(lease, { holder: "b", interactedAt: null }, 1500);
  assert.equal(result.granted, false);
  assert.equal(result.lease.holder, "a");
});

test("the device the user touched most recently takes the pane", () => {
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  const result = requestLease(lease, { holder: "b", interactedAt: 900 }, 1500);
  assert.equal(result.granted, true);
  assert.equal(result.lease.holder, "b");
});

test("a tie leaves the pane where it is", () => {
  // Two devices claiming at the same moment must not take the pane from each
  // other in turn.
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  const result = requestLease(lease, { holder: "b", interactedAt: 500 }, 1500);
  assert.equal(result.granted, false);
  assert.equal(result.lease.holder, "a");
});

test("the pane is up for grabs when the holder goes quiet", () => {
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  const later = 1000 + LEASE_TTL_MS;
  const result = requestLease(lease, { holder: "b", interactedAt: null }, later);
  assert.equal(result.granted, true);
  assert.equal(result.lease.holder, "b");
});

test("a holder that renews keeps the later interaction time", () => {
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  const result = requestLease(lease, { holder: "a", interactedAt: 700 }, 1200);
  assert.equal(result.granted, true);
  assert.equal(result.lease.holderAt, 700);
});

test("giving the pane up lets another device take it at once", () => {
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  lease = releaseLease(lease, "a");
  assert.equal(lease.holder, null);
  const result = requestLease(lease, { holder: "b", interactedAt: null }, 1100);
  assert.equal(result.granted, true);
  assert.equal(result.lease.holder, "b");
});

test("giving the pane up does not touch somebody else's lease", () => {
  let lease = createLease();
  lease = requestLease(lease, { holder: "a", interactedAt: 500 }, 1000).lease;
  const after = releaseLease(lease, "b");
  assert.equal(after.holder, "a");
});
