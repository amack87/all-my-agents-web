import test from "node:test";
import assert from "node:assert/strict";
import { createInbox } from "../ws-inbox.js";

// The bug this module exists to prevent: a websocket frame that arrives
// before the handler attaches its listener is dropped by the socket, and the
// client's first frame — its resize — is the only thing that spawns the PTY.
// A dropped resize means a terminal that never paints.

test("a frame offered before the inbox is open is kept, not handled", () => {
  const inbox = createInbox();
  assert.equal(inbox.offer("resize"), false);
  assert.equal(inbox.size, 1);
  assert.equal(inbox.isReady, false);
});

test("opening the inbox hands back the frames in the order they arrived", () => {
  const inbox = createInbox();
  inbox.offer("first");
  inbox.offer("second");
  inbox.offer("third");
  assert.deepEqual(inbox.open(), ["first", "second", "third"]);
});

test("no frame is dropped: everything offered before opening comes back", () => {
  const inbox = createInbox();
  for (let i = 0; i < 10; i++) inbox.offer(`frame-${i}`);
  const kept = inbox.open();
  assert.equal(kept.length, 10);
  assert.equal(inbox.size, 0);
});

test("a frame offered after the inbox is open is handled immediately", () => {
  const inbox = createInbox();
  inbox.open();
  assert.equal(inbox.offer("resize"), true);
  assert.equal(inbox.size, 0);
});

test("opening the inbox twice does not replay the frames twice", () => {
  const inbox = createInbox();
  inbox.offer("first");
  assert.deepEqual(inbox.open(), ["first"]);
  assert.deepEqual(inbox.open(), []);
});

test("the inbox remembers that it is ready", () => {
  const inbox = createInbox();
  assert.equal(inbox.isReady, false);
  inbox.open();
  assert.equal(inbox.isReady, true);
});
