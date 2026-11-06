import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_LIST_FORMAT,
  buildListClientsArgs,
  buildSwitchClientArgs,
  parseClientList,
  findClientByPid,
} from "../tmux-client.js";

test("parseClientList reads the pid, the name and the window of each client", () => {
  const clients = parseClientList(
    "4213|/dev/ttys008|@5\n4214|/dev/ttys009|@5\n",
  );
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[0], { pid: 4213, name: "/dev/ttys008", windowId: "@5" });
  assert.deepEqual(clients[1], { pid: 4214, name: "/dev/ttys009", windowId: "@5" });
});

test("parseClientList has nothing to say when there are no clients", () => {
  // An empty session has no client line at all.
  assert.deepEqual(parseClientList(""), []);
  assert.deepEqual(parseClientList("\n\n"), []);
  assert.deepEqual(parseClientList(null), []);
});

test("parseClientList drops a line it cannot read", () => {
  const clients = parseClientList("not-a-client\n4213|/dev/ttys008|@5");
  assert.equal(clients.length, 1);
  assert.equal(clients[0].name, "/dev/ttys008");
});

test("findClientByPid finds the client behind a PTY", () => {
  // The tmux client is the PTY's child process, so its pid is the PTY's pid.
  const clients = parseClientList("4213|/dev/ttys008|@5\n4214|/dev/ttys009|@5");
  assert.equal(findClientByPid(clients, 4214).name, "/dev/ttys009");
  assert.equal(findClientByPid(clients, 9999), null);
  assert.equal(findClientByPid(clients, null), null);
  assert.equal(findClientByPid(null, 4213), null);
});

test("buildListClientsArgs asks for the clients of one session", () => {
  const args = buildListClientsArgs("work");
  assert.deepEqual(args, ["list-clients", "-t", "work", "-F", CLIENT_LIST_FORMAT]);
  assert.equal(CLIENT_LIST_FORMAT, "#{client_pid}|#{client_name}|#{window_id}");
});

test("buildSwitchClientArgs names the client and keeps it on its own window", () => {
  // tmux names a client by its tty path, and the target is the window the
  // client is already on - so the client does not jump to another window,
  // the window just takes the client's size.
  assert.deepEqual(buildSwitchClientArgs("/dev/ttys008", "@5"), [
    "switch-client",
    "-c",
    "/dev/ttys008",
    "-t",
    "@5",
  ]);
});
