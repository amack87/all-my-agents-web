import test from "node:test";
import assert from "node:assert/strict";
import { SURFACE_TOKEN_ENV, newSurfaceToken, buildLaunchArgs, buildLaunchInputArgs, buildLaunchSubmitArgs } from "../surface-token.js";

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
  assert.deepEqual(buildLaunchArgs({ name: "work" }), [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-s",
    "work",
  ]);
});

test("buildLaunchArgs adds -c when a dir is given", () => {
  assert.deepEqual(buildLaunchArgs({ name: "work", dir: "/repos/x" }), [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-s",
    "work",
    "-c",
    "/repos/x",
  ]);
});

test("buildLaunchArgs exports the surface token into the pane environment", () => {
  const args = buildLaunchArgs({ name: "work", token: "tok_1" });
  assert.deepEqual(args, [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-s",
    "work",
    "-e",
    `${SURFACE_TOKEN_ENV}=tok_1`,
  ]);
});

test("buildLaunchArgs asks tmux for the new pane's id", () => {
  // The command is typed into the pane, so it has to be aimed at that pane.
  // A bare session name that looks like a number resolves as a window index
  // of the current session, so the id is what makes the target unambiguous.
  const args = buildLaunchArgs({ name: "0" });
  assert.ok(args.includes("-P"));
  assert.equal(args[args.indexOf("-F") + 1], "#{pane_id}");
});

test("buildLaunchArgs never makes the command the pane's process", () => {
  // The pane is a shell. If the command were the pane's process then its
  // exit would close the window and destroy the session with it.
  const args = buildLaunchArgs({ name: "work", command: "opencode -c" });
  assert.ok(!args.includes("opencode -c"));
  assert.equal(args.at(-1), "work");
});

test("buildLaunchArgs omits -e when no token is given", () => {
  assert.ok(!buildLaunchArgs({ name: "work" }).includes("-e"));
});

test("buildLaunchInputArgs types the command into the pane literally", () => {
  assert.deepEqual(buildLaunchInputArgs("%3", "opencode -c"), [
    "send-keys",
    "-t",
    "%3",
    "-l",
    "--",
    "opencode -c",
  ]);
});

test("buildLaunchInputArgs keeps a command with spaces and quotes as one argument", () => {
  const args = buildLaunchInputArgs("%3", 'printf "%s" "a b"');
  assert.equal(args.length, 6);
  assert.equal(args.at(-1), 'printf "%s" "a b"');
});

test("buildLaunchInputArgs stops a leading dash being read as an option", () => {
  assert.ok(buildLaunchInputArgs("%3", "-c").includes("--"));
});

test("buildLaunchSubmitArgs presses Enter", () => {
  assert.deepEqual(buildLaunchSubmitArgs("%3"), ["send-keys", "-t", "%3", "Enter"]);
});

test("buildLaunchSubmitArgs does not send Enter literally", () => {
  // `-l` sends characters as typed, so "Enter" in the same call as the
  // command would be typed as the word Enter rather than pressing the key.
  assert.ok(!buildLaunchSubmitArgs("%3").includes("-l"));
});
