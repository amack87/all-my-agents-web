import { test } from "node:test";
import assert from "node:assert/strict";

import { AmaStatusPlugin } from "../integrations/opencode/ama-status.js";

const { canonicalBusEvent, sessionIdFromBusProps, resolveBaseUrl, HOOK_EVENTS } =
  AmaStatusPlugin.helpers;

test("bus events map to the canonical status vocabulary", () => {
  assert.equal(canonicalBusEvent("session.created"), "sessionStart");
  assert.equal(canonicalBusEvent("session.idle"), "stop");
  assert.equal(canonicalBusEvent("session.deleted"), "sessionEnd");
  assert.equal(canonicalBusEvent("permission.updated"), "permissionRequest");
  assert.equal(canonicalBusEvent("permission.asked"), "permissionRequest");
});

test("unrelated bus events are ignored", () => {
  assert.equal(canonicalBusEvent("message.updated"), null);
  assert.equal(canonicalBusEvent("message.part.updated"), null);
  assert.equal(canonicalBusEvent("session.status"), null);
  assert.equal(canonicalBusEvent(undefined), null);
});

test("hook names map to the canonical status vocabulary", () => {
  assert.equal(HOOK_EVENTS["chat.message"], "promptSubmit");
  assert.equal(HOOK_EVENTS["tool.execute.before"], "toolStart");
  assert.equal(HOOK_EVENTS["tool.execute.after"], "toolEnd");
  assert.equal(HOOK_EVENTS["permission.ask"], "permissionRequest");
});

test("session id is read from a plain session event", () => {
  assert.equal(
    sessionIdFromBusProps({ type: "session.idle", properties: { sessionID: "ses_a" } }),
    "ses_a"
  );
});

test("session id is read from session.created / session.deleted info", () => {
  assert.equal(
    sessionIdFromBusProps({ type: "session.created", properties: { info: { id: "ses_b" } } }),
    "ses_b"
  );
  assert.equal(
    sessionIdFromBusProps({ type: "session.deleted", properties: { info: { id: "ses_b" } } }),
    "ses_b"
  );
});

test("session id is read from message and part payloads", () => {
  assert.equal(
    sessionIdFromBusProps({ type: "message.updated", properties: { info: { sessionID: "ses_c" } } }),
    "ses_c"
  );
  assert.equal(
    sessionIdFromBusProps({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses_d" } },
    }),
    "ses_d"
  );
});

test("session id is read from a permission event", () => {
  assert.equal(
    sessionIdFromBusProps({ type: "permission.updated", properties: { sessionID: "ses_e" } }),
    "ses_e"
  );
});

test("a payload with no session id yields null", () => {
  assert.equal(sessionIdFromBusProps({ type: "session.idle", properties: {} }), null);
  assert.equal(sessionIdFromBusProps({ type: "session.idle" }), null);
  assert.equal(sessionIdFromBusProps(undefined), null);
});

test("base url prefers an explicit AMA url", () => {
  assert.equal(resolveBaseUrl({ ALL_MY_AGENTS_URL: "http://host:9999/" }), "http://host:9999");
});

test("base url falls back to the AMA port", () => {
  assert.equal(resolveBaseUrl({ ALL_MY_AGENTS_PORT: "4000" }), "http://127.0.0.1:4000");
});

test("base url defaults to the standard AMA port", () => {
  assert.equal(resolveBaseUrl({}), "http://127.0.0.1:3456");
});

test("the module exposes exactly one plugin function for the loader", async () => {
  assert.equal(typeof AmaStatusPlugin, "function");
});