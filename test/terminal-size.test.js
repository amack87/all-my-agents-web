import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUsableSize,
  sameSize,
  resizeFrame,
  readSize,
  claimFrame,
  CLAIM_FRAME_TYPE,
  CLAIM_HEARTBEAT_MS,
  shouldHeartbeat,
} from "../public/terminal-size.js";

test("isUsableSize accepts positive whole sizes", () => {
  assert.equal(isUsableSize({ cols: 120, rows: 40 }), true);
  assert.equal(isUsableSize({ cols: 1, rows: 1 }), true);
});

test("isUsableSize rejects sizes the PTY cannot take", () => {
  // node-pty throws on cols/rows <= 0, and a size that is not a whole number
  // would be truncated somewhere along the way.
  assert.equal(isUsableSize({ cols: 0, rows: 40 }), false);
  assert.equal(isUsableSize({ cols: 120, rows: 0 }), false);
  assert.equal(isUsableSize({ cols: -1, rows: 40 }), false);
  assert.equal(isUsableSize({ cols: 12.5, rows: 40 }), false);
  assert.equal(isUsableSize({ cols: NaN, rows: 40 }), false);
  assert.equal(isUsableSize(null), false);
});

test("sameSize compares both dimensions", () => {
  assert.equal(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), true);
  assert.equal(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 25 }), false);
  assert.equal(sameSize({ cols: 80, rows: 24 }, { cols: 40, rows: 24 }), false);
  assert.equal(sameSize(null, { cols: 80, rows: 24 }), false);
});

test("resizeFrame sends a frame when the size changed", () => {
  assert.deepEqual(resizeFrame({ cols: 40, rows: 19 }, { cols: 200, rows: 49 }), {
    type: "resize",
    cols: 200,
    rows: 49,
  });
});

test("resizeFrame sends nothing when the size is unchanged", () => {
  // tmux only re-lays-out a pane when a client's size changes, so a repeat of
  // the size the server already has is worth nothing.
  assert.equal(resizeFrame({ cols: 200, rows: 49 }, { cols: 200, rows: 49 }), null);
});

test("resizeFrame sends a frame for the first size the server hears about", () => {
  assert.deepEqual(resizeFrame(null, { cols: 80, rows: 24 }), {
    type: "resize",
    cols: 80,
    rows: 24,
  });
});

test("resizeFrame refuses an unusable size", () => {
  assert.equal(resizeFrame({ cols: 80, rows: 24 }, { cols: 0, rows: 0 }), null);
  assert.equal(resizeFrame({ cols: 80, rows: 24 }, { cols: -5, rows: 10 }), null);
  assert.equal(resizeFrame(null, null), null);
});

test("readSize reads a size out of an untrusted frame", () => {
  assert.deepEqual(readSize({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
  assert.deepEqual(readSize({ cols: "120", rows: "40" }), { cols: 120, rows: 40 });
});

test("readSize rejects a frame without a usable size", () => {
  assert.equal(readSize({ cols: 0, rows: 40 }), null);
  assert.equal(readSize({ cols: 120, rows: 0 }), null);
  assert.equal(readSize({ cols: -120, rows: 40 }), null);
  assert.equal(readSize({ cols: 12.5, rows: 40 }), null);
  assert.equal(readSize({}), null);
  assert.equal(readSize(null), null);
});

test("claimFrame says which device is being looked at, and carries the grid", () => {
  // The grid travels with the claim because it may have changed while the
  // page was in the background.
  assert.deepEqual(claimFrame({ cols: 120, rows: 40 }), {
    type: CLAIM_FRAME_TYPE,
    cols: 120,
    rows: 40,
  });
});

test("claimFrame refuses a size the PTY cannot take", () => {
  assert.equal(claimFrame({ cols: 0, rows: 40 }), null);
  assert.equal(claimFrame({ cols: 120, rows: 0 }), null);
  assert.equal(claimFrame({ cols: 12.5, rows: 40 }), null);
  assert.equal(claimFrame(null), null);
});

test("a claim is sent even when the size did not change", () => {
  // This is the whole point of the claim: tmux ignores a repeat of the size
  // it already has, so a device that comes back has to say so separately.
  assert.equal(resizeFrame({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), null);
  assert.deepEqual(claimFrame({ cols: 80, rows: 24 }), {
    type: CLAIM_FRAME_TYPE,
    cols: 80,
    rows: 24,
  });
});

test("a touch claim says the user has just used this device", () => {
  // A touch wins the pane from whatever device was holding it: the user
  // just said which device this is.
  assert.deepEqual(claimFrame({ cols: 80, rows: 24 }, { touch: true }), {
    type: CLAIM_FRAME_TYPE,
    cols: 80,
    rows: 24,
    touch: true,
  });
});

test("a plain claim is a heartbeat, not a touch", () => {
  assert.equal(claimFrame({ cols: 80, rows: 24 }).touch, undefined);
  assert.equal(claimFrame({ cols: 80, rows: 24 }, { touch: false }).touch, undefined);
});

test("the heartbeat is quick enough to be cheap and slow enough to be quiet", () => {
  assert.ok(CLAIM_HEARTBEAT_MS >= 1000 && CLAIM_HEARTBEAT_MS <= 5000);
});

test("shouldHeartbeat only claims while the page is in front", () => {
  // A page in the background is not being looked at, so it must not claim:
  // two devices claiming at once is how the pane ends up on the wrong one.
  assert.equal(shouldHeartbeat({ open: true, visible: true, focused: true }), true);
  assert.equal(shouldHeartbeat({ open: true, visible: false, focused: true }), false);
  assert.equal(shouldHeartbeat({ open: true, visible: true, focused: false }), false);
  assert.equal(shouldHeartbeat({ open: false, visible: true, focused: true }), false);
});
