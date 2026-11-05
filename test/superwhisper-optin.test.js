import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuperwhisperOptInPlugin } from "../integrations/opencode/superwhisper-optin.js";

const { createState, isUsableSessionId } = SuperwhisperOptInPlugin.helpers;

function freshState() {
  const dir = mkdtempSync(join(tmpdir(), "sw-optin-"));
  return { dir, state: createState({ dir }) };
}

test("a session starts muted, so the official plugin skips its notifications", () => {
  const { dir, state } = freshState();
  state.ensureMuted("ses_abc123");
  assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
  rmSync(dir, { recursive: true, force: true });
});

test("a muted session is not opted in", () => {
  const { dir, state } = freshState();
  state.ensureMuted("ses_abc123");
  assert.equal(state.isOptedIn("ses_abc123"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("opting in removes the mute and leaves an opt-in marker", () => {
  const { dir, state } = freshState();
  state.ensureMuted("ses_abc123");
  state.setOptedIn("ses_abc123", true);
  assert.equal(existsSync(join(dir, "disabled-ses_abc123")), false);
  assert.equal(existsSync(join(dir, "optin-ses_abc123")), true);
  assert.equal(state.isOptedIn("ses_abc123"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("opting out mutes the session and removes the opt-in marker", () => {
  const { dir, state } = freshState();
  state.setOptedIn("ses_abc123", true);
  state.setOptedIn("ses_abc123", false);
  assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
  assert.equal(existsSync(join(dir, "optin-ses_abc123")), false);
  assert.equal(state.isOptedIn("ses_abc123"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("an opted-in session stays unmuted when a message is sent", () => {
  const { dir, state } = freshState();
  state.setOptedIn("ses_abc123", true);
  state.ensureMuted("ses_abc123");
  assert.equal(existsSync(join(dir, "disabled-ses_abc123")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("the opt-in survives a restart, because it is a file", () => {
  const { dir, state } = freshState();
  state.setOptedIn("ses_abc123", true);
  const reopened = createState({ dir });
  assert.equal(reopened.isOptedIn("ses_abc123"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("a session id that could escape the directory is refused", () => {
  assert.equal(isUsableSessionId("../etc/passwd"), false);
  assert.equal(isUsableSessionId("ses/abc"), false);
  assert.equal(isUsableSessionId(""), false);
  assert.equal(isUsableSessionId(undefined), false);
  assert.equal(isUsableSessionId("ses_abc123"), true);
});

test("a hostile session id writes nothing", () => {
  const { dir, state } = freshState();
  state.setOptedIn("../escape", true);
  state.ensureMuted("../../escape");
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("the plugin mutes a session on its first message", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks["chat.message"]({ sessionID: "ses_abc123" });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
    assert.equal(existsSync(join(dir, "optin-ses_abc123")), false);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the enable command opts the session in and unmutes it", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks["chat.message"]({ sessionID: "ses_abc123" });
    await hooks["command.execute.before"]({ command: "/enable-superwhisper", sessionID: "ses_abc123" });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), false);
    assert.equal(existsSync(join(dir, "optin-ses_abc123")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the disable command opts the session out and mutes it", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks["command.execute.before"]({ command: "/enable-superwhisper", sessionID: "ses_abc123" });
    await hooks["command.execute.before"]({ command: "/disable-superwhisper", sessionID: "ses_abc123" });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
    assert.equal(existsSync(join(dir, "optin-ses_abc123")), false);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plugin mutes a session as soon as it hears about it", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks.event({
      event: { type: "session.created", properties: { sessionID: "ses_abc123" } },
    });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session id nested under properties.info is found too", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks.event({
      event: { type: "session.idle", properties: { info: { sessionID: "ses_abc123" } } },
    });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an event with no session id mutes nothing", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks.event({ event: { type: "server.connected", properties: {} } });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an opted-in session is not re-muted by an event", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin();
    await hooks["command.execute.before"]({ command: "/enable-superwhisper", sessionID: "ses_abc123" });
    await hooks.event({
      event: { type: "session.created", properties: { sessionID: "ses_abc123" } },
    });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), false);
    assert.equal(existsSync(join(dir, "optin-ses_abc123")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions that already existed are muted at startup", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    await SuperwhisperOptInPlugin({
      client: { session: { list: async () => ({ data: [{ id: "ses_older" }] }) } },
    });
    // The head start runs in the background so it cannot block startup.
    for (let i = 0; i < 20 && !existsSync(join(dir, "disabled-ses_older")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(join(dir, "disabled-ses_older")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: opencode builds plugins before its server answers, and the
// client talks to that server. Awaiting session.list() during init therefore
// waits on a server that is waiting on us, and opencode hangs on a black
// screen. The call must never gate plugin initialisation.
test("a client that never answers does not block the plugin loading", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const never = new Promise(() => {});
    const loaded = SuperwhisperOptInPlugin({ client: { session: { list: () => never } } });
    const outcome = await Promise.race([
      loaded.then(() => "loaded"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    assert.equal(outcome, "loaded");
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a client that answers late still gets its sessions muted", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    let answer;
    const late = new Promise((resolve) => { answer = resolve; });
    await SuperwhisperOptInPlugin({ client: { session: { list: () => late } } });
    answer({ data: [{ id: "ses_late" }] });
    for (let i = 0; i < 20 && !existsSync(join(dir, "disabled-ses_late")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(join(dir, "disabled-ses_late")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a client that cannot answer does not stop the plugin loading", async () => {
  const { dir } = freshState();
  const previous = process.env.SUPERWHISPER_MESSAGE_DIR;
  process.env.SUPERWHISPER_MESSAGE_DIR = dir;
  try {
    const hooks = await SuperwhisperOptInPlugin({
      client: { session: { list: async () => { throw new Error("not ready"); } } },
    });
    await hooks.event({
      event: { type: "session.created", properties: { sessionID: "ses_abc123" } },
    });
    assert.equal(existsSync(join(dir, "disabled-ses_abc123")), true);
  } finally {
    if (previous === undefined) delete process.env.SUPERWHISPER_MESSAGE_DIR;
    else process.env.SUPERWHISPER_MESSAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
