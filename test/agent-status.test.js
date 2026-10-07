import test from "node:test";
import assert from "node:assert/strict";

import { detectStatusFromScreen } from "../agent-status.js";

const PROMPTLESS = "building the thing\ncompiling module a\ncompiling module b\n";
const CLAUDE_AT_REST = "last assistant message\n\n─────────────────\n❯ \n";
const INTERRUPT_BAR = "tool output\n\n─────────────────\n❯ \n⏵⏵ esc to interrupt\n";

test("promptless pane with recent output reads working", () => {
  assert.equal(detectStatusFromScreen(PROMPTLESS, true), "working");
});

test("promptless pane that has gone quiet reads idle", () => {
  assert.equal(detectStatusFromScreen(PROMPTLESS, false), "idle");
});

test("promptless pane with no activity history defaults to working", () => {
  assert.equal(detectStatusFromScreen(PROMPTLESS), "working");
});

test("visible prompt at rest reads idle regardless of activity", () => {
  assert.equal(detectStatusFromScreen(CLAUDE_AT_REST, false), "idle");
  assert.equal(detectStatusFromScreen(CLAUDE_AT_REST, true), "idle");
});

test("interrupt status bar wins over silence", () => {
  assert.equal(detectStatusFromScreen(INTERRUPT_BAR, false), "working");
});

test("permission signal wins over silence", () => {
  const content = "Run this command? (y/n)\n";
  assert.equal(detectStatusFromScreen(content, false), "needsInput");
});

test("spinner line wins over silence", () => {
  const content = "· Generating…\n";
  assert.equal(detectStatusFromScreen(content, false), "working");
});

test("selection list reads needsInput", () => {
  const content = "❯ 1. Yes\n❯ 2. No\n";
  assert.equal(detectStatusFromScreen(content, false), "needsInput");
});

test("token timing counter reads working", () => {
  const content = "✽ 1234 tokens · 5s\n";
  assert.equal(detectStatusFromScreen(content, false), "working");
});

test("cancel status bar reads needsInput", () => {
  const content = "tool output\n\n─────────────────\n❯ \n⏵⏵ esc to cancel\n";
  assert.equal(detectStatusFromScreen(content, false), "needsInput");
});

test("codex prompt at rest reads idle", () => {
  const content = "done\n\n› ";
  assert.equal(detectStatusFromScreen(content, false), "idle");
});
