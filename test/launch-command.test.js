import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LAUNCH_COMMAND_LENGTH,
  validateLaunchCommand,
  buildSshCommand,
  resolveTargetCommand,
  buildLaunchSpec,
  renderLaunchCommand,
} from "../launch-command.js";

test("an absent launch command means a plain shell pane", () => {
  assert.deepEqual(validateLaunchCommand(undefined), { ok: true, command: null });
  assert.deepEqual(validateLaunchCommand(null), { ok: true, command: null });
});

test("a blank launch command means a plain shell pane", () => {
  assert.deepEqual(validateLaunchCommand(""), { ok: true, command: null });
  assert.deepEqual(validateLaunchCommand("   "), { ok: true, command: null });
});

test("a launch command is kept, trimmed of surrounding whitespace", () => {
  assert.deepEqual(validateLaunchCommand("  ssh win-vm  "), {
    ok: true,
    command: "ssh win-vm",
  });
});

test("a non-string launch command is rejected", () => {
  assert.equal(validateLaunchCommand(42).ok, false);
  assert.equal(validateLaunchCommand({}).ok, false);
});

test("a multi-line launch command is rejected", () => {
  assert.equal(validateLaunchCommand("ssh win-vm\nrm -rf /").ok, false);
  assert.equal(validateLaunchCommand("ssh win-vm\r\nwhoami").ok, false);
});

test("a launch command longer than the limit is rejected", () => {
  const tooLong = "x".repeat(MAX_LAUNCH_COMMAND_LENGTH + 1);
  assert.equal(validateLaunchCommand(tooLong).ok, false);
});

test("a launch command at exactly the limit is accepted", () => {
  const atLimit = "x".repeat(MAX_LAUNCH_COMMAND_LENGTH);
  assert.equal(validateLaunchCommand(atLimit).ok, true);
});

test("buildSshCommand connects to a host", () => {
  assert.equal(buildSshCommand({ host: "win-vm" }), "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 win-vm");
});

test("buildSshCommand qualifies the host with a user", () => {
  assert.equal(buildSshCommand({ host: "192.168.64.2", user: "tester" }), "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 tester@192.168.64.2");
});

test("buildSshCommand carries a non-default port", () => {
  assert.equal(buildSshCommand({ host: "win-vm", port: 2222 }), "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -p 2222 win-vm");
});

test("buildSshCommand carries an identity file", () => {
  assert.equal(
    buildSshCommand({ host: "win-vm", identityFile: "~/.ssh/ama_windows_ed25519" }),
    "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i ~/.ssh/ama_windows_ed25519 win-vm",
  );
});

test("buildSshCommand yields nothing without a host", () => {
  assert.equal(buildSshCommand({}), null);
  assert.equal(buildSshCommand({ user: "tester" }), null);
});

test("resolveTargetCommand builds the command for a named target", () => {
  const targets = [{ name: "win-vm", host: "192.168.64.2", user: "tester" }];
  assert.deepEqual(resolveTargetCommand(targets, "win-vm"), {
    ok: true,
    command: "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 tester@192.168.64.2",
  });
});

test("resolveTargetCommand rejects an unknown target", () => {
  assert.equal(resolveTargetCommand([{ name: "win-vm", host: "h" }], "other").ok, false);
  assert.equal(resolveTargetCommand(undefined, "win-vm").ok, false);
});

test("resolveTargetCommand rejects a target with no host", () => {
  assert.equal(resolveTargetCommand([{ name: "win-vm" }], "win-vm").ok, false);
});

test("a target launch spec names the target rather than the command", () => {
  assert.deepEqual(buildLaunchSpec({ target: "windows-vm" }), {
    kind: "target",
    name: "windows-vm",
  });
});

test("a command launch spec keeps the command it was given", () => {
  assert.deepEqual(buildLaunchSpec({ command: "ssh me@host" }), {
    kind: "command",
    command: "ssh me@host",
  });
});

test("a session with neither a target nor a command has no launch spec", () => {
  assert.equal(buildLaunchSpec({}), null);
});

test("a target spec renders the ssh command for that target", () => {
  const rendered = renderLaunchCommand({ kind: "target", name: "windows-vm" }, {
    targets: [{ name: "windows-vm", host: "192.168.64.2", user: "tester" }],
  });
  assert.equal(rendered.ok, true);
  assert.equal(rendered.command, "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 tester@192.168.64.2");
});

test("a target spec is re-resolved, so a changed host takes effect", () => {
  const rendered = renderLaunchCommand({ kind: "target", name: "windows-vm" }, {
    targets: [{ name: "windows-vm", host: "10.0.0.9", user: "tester" }],
  });
  assert.equal(rendered.command, "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 tester@10.0.0.9");
});

test("a baseUrl is not forwarded over ssh: the connection carries one variable", () => {
  const rendered = renderLaunchCommand({ kind: "target", name: "windows-vm" }, {
    targets: [{ name: "windows-vm", host: "192.168.64.2", user: "tester", baseUrl: "http://192.168.64.1:3456" }],
  });
  assert.equal(rendered.command, "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 tester@192.168.64.2");
});

test("the surface token is forwarded to the far side by name, not by value", () => {
  const rendered = renderLaunchCommand({ kind: "target", name: "windows-vm" }, {
    targets: [{ name: "windows-vm", host: "192.168.64.2", user: "tester" }],
    token: "abc123",
  });
  assert.equal(rendered.command, "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o SendEnv=AMA_SURFACE_TOKEN tester@192.168.64.2");
});

test("the token value never reaches the command line", () => {
  // A command line is echoed into the pane's scrollback, written to the
  // shell's history file and shown in the process table. The value is
  // forwarded by name instead, so the ssh client picks it up out of the pane's
  // own environment.
  const rendered = renderLaunchCommand({ kind: "target", name: "windows-vm" }, {
    targets: [{ name: "windows-vm", host: "192.168.64.2", user: "tester" }],
    token: "abc123",
  });
  assert.ok(!rendered.command.includes("abc123"));
});

test("several environment names can be forwarded at once", () => {
  assert.equal(
    buildSshCommand({ host: "win-vm", forwardEnv: ["AMA_SURFACE_TOKEN", "ALL_MY_AGENTS_URL"] }),
    "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o SendEnv=AMA_SURFACE_TOKEN,ALL_MY_AGENTS_URL win-vm"
  );
});

test("a command spec renders the command it was given", () => {
  const rendered = renderLaunchCommand({ kind: "command", command: "ssh me@host" }, {});
  assert.deepEqual(rendered, { ok: true, command: "ssh me@host" });
});

test("a target spec for an unknown target is refused", () => {
  const rendered = renderLaunchCommand({ kind: "target", name: "nope" }, {
    targets: [{ name: "windows-vm", host: "192.168.64.2" }],
  });
  assert.equal(rendered.ok, false);
  assert.equal(rendered.error, "unknown target: nope");
});

test("a spec of an unknown kind is refused", () => {
  const rendered = renderLaunchCommand({ kind: "bogus" }, {});
  assert.equal(rendered.ok, false);
  assert.equal(rendered.error, "unknown launch spec kind: bogus");
});

test("a spec that is not a spec is refused", () => {
  assert.equal(renderLaunchCommand(null, {}).ok, false);
});
