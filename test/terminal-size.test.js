import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUsableSize,
  sameSize,
  resizeFrame,
  readSize,
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
