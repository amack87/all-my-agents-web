import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOOK_EVENT_MAP,
  mapHookEvent,
  resolveToken,
  resolveBaseUrl,
  buildBody,
} from "../integrations/claude/ama-status-hook.js";

test("maps the plain Claude hook events to the canonical vocabulary", () => {
  assert.equal(mapHookEvent({ hook_event_name: "SessionStart" }), "sessionStart");
  assert.equal(mapHookEvent({ hook_event_name: "UserPromptSubmit" }), "promptSubmit");
  assert.equal(mapHookEvent({ hook_event_name: "PostToolUse", tool_name: "Bash" }), "toolEnd");
  assert.equal(mapHookEvent({ hook_event_name: "Notification" }), "notification");
  assert.equal(mapHookEvent({ hook_event_name: "Stop" }), "stop");
  assert.equal(mapHookEvent({ hook_event_name: "SessionEnd" }), "sessionEnd");
});

test("a normal tool call is telemetry (toolStart)", () => {
  assert.equal(mapHookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "toolStart");
  assert.equal(mapHookEvent({ hook_event_name: "PreToolUse", tool_name: "Edit" }), "toolStart");
});

test("PreToolUse on a prompt tool means the agent is blocked on the user", () => {
  assert.equal(
    mapHookEvent({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    "permissionRequest",
  );
  assert.equal(
    mapHookEvent({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" }),
    "permissionRequest",
  );
});

test("an explicit PermissionRequest hook maps to permissionRequest", () => {
  assert.equal(mapHookEvent({ hook_event_name: "PermissionRequest" }), "permissionRequest");
});

test("events with no canonical equivalent are ignored, not guessed", () => {
  assert.equal(mapHookEvent({ hook_event_name: "SubagentStop" }), null);
  assert.equal(mapHookEvent({ hook_event_name: "PreCompact" }), null);
  assert.equal(mapHookEvent({ hook_event_name: "PostCompact" }), null);
  assert.equal(mapHookEvent({}), null);
  assert.equal(mapHookEvent(null), null);
});

test("token comes from the pane environment", () => {
  assert.equal(resolveToken({ AMA_SURFACE_TOKEN: "abc123" }), "abc123");
  assert.equal(resolveToken({}), null);
  assert.equal(resolveToken(undefined), null);
});

test("base url prefers ALL_MY_AGENTS_URL, then PORT, then 3456", () => {
  assert.equal(resolveBaseUrl({ ALL_MY_AGENTS_URL: "http://host:9/" }), "http://host:9");
  assert.equal(resolveBaseUrl({ ALL_MY_AGENTS_PORT: "4000" }), "http://127.0.0.1:4000");
  assert.equal(resolveBaseUrl({}), "http://127.0.0.1:3456");
});

test("the body carries the surface token and never Claude's own session id", () => {
  assert.deepEqual(buildBody("working", "tok_1"), { event: "working", surfaceToken: "tok_1" });
  const body = buildBody("toolStart", "tok_2");
  assert.equal("sessionId" in body, false);
  assert.equal("session_id" in body, false);
});

test("the mapping table is exactly the canonical set Claude can produce", () => {
  assert.deepEqual(HOOK_EVENT_MAP, {
    SessionStart: "sessionStart",
    UserPromptSubmit: "promptSubmit",
    PreToolUse: "toolStart",
    PostToolUse: "toolEnd",
    PermissionRequest: "permissionRequest",
    Notification: "notification",
    Stop: "stop",
    SessionEnd: "sessionEnd",
  });
});