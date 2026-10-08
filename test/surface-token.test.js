import test from "node:test";
import assert from "node:assert/strict";
import { SURFACE_TOKEN_ENV, newSurfaceToken, buildLaunchArgs } from "../surface-token.js";

test("newSurfaceToken returns whatever the injected mint yields", () => {
  assert.equal(newSurfaceToken(() => "abc123"), "abc123");
});

test("default mint is a 32-char hex string", () => {
  assert.match(newSurfaceToken(), /^[0-9a-f]{32}$/);
});

test("default mint is unique per call", () => {
  assert.notEqual(newSurfaceToken(), newSurfaceToken());
});

test("buildLaunchArgs builds a plain detached new-session", () => {
  assert.deepEqual(buildLaunchArgs({ name: "work" }), ["new-session", "-d", "-s", "work"]);
});

test("buildLaunchArgs adds -c when a dir is given", () => {
  assert.deepEqual(buildLaunchArgs({ name: "work", dir: "/repos/x" }), [
    "new-session",
    "-d",
    "-s",
    "work",
    "-c",
    "/repos/x",
  ]);
});

test("buildLaunchArgs exports the surface token into the pane environment", () => {
  const args = buildLaunchArgs({ name: "work", token: "tok_1" });
  assert.deepEqual(args, ["new-session", "-d", "-s", "work", "-e", `${SURFACE_TOKEN_ENV}=tok_1`]);
});

test("buildLaunchArgs keeps the -e option before the trailing command", () => {
  const args = buildLaunchArgs({ name: "work", dir: "/d", token: "tok_1", command: "opencode -c" });
  assert.ok(args.indexOf("-e") < args.indexOf("opencode -c"));
  assert.equal(args.at(-1), "opencode -c");
});

test("buildLaunchArgs omits -e when no token is given", () => {
  assert.ok(!buildLaunchArgs({ name: "work", command: "claude" }).includes("-e"));
});