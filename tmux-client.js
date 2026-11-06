// Pure helpers for talking to tmux about the client behind a PTY.
//
// A tmux session can be attached by more than one client: a laptop and a
// phone, or two browser tabs. tmux gives the shared window to the client
// whose size last *changed* ("window-size latest", the tmux default), so a
// client that comes back with the size it already had never gets the window
// back. The server therefore has to name the client it speaks for and ask
// tmux to give the window to it.
//
// tmux names a client by its tty path (`/dev/ttys008`); `switch-client` wants
// that name, not a pid. The pid is how the server finds the right client: the
// tmux client *is* the PTY's child process, so its pid is the PTY's pid.
//
// Everything here is pure: the tmux calls live in the server, the parsing and
// the argv live here, so they can be tested without a tmux server.

/**
 * The format `list-clients` is asked for: the pid, the name and the window of
 * each client. A pipe separates them because a tty path never contains one.
 */
export const CLIENT_LIST_FORMAT = "#{client_pid}|#{client_name}|#{window_id}";

/** The argv that lists the clients attached to a session. */
export function buildListClientsArgs(target) {
  return ["list-clients", "-t", target, "-F", CLIENT_LIST_FORMAT];
}

/**
 * The argv that gives a session's window to one client.
 *
 * The target is the client's own window, so the client stays where it is and
 * only the window's size follows it.
 */
export function buildSwitchClientArgs(clientName, windowId) {
  return ["switch-client", "-c", clientName, "-t", windowId];
}

/**
 * The clients in the output of `list-clients`, or an empty list when there
 * are none (or the output is not what we asked for).
 */
export function parseClientList(output) {
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, name, windowId] = line.split("|");
      return { pid: Number(pid), name, windowId };
    })
    .filter((client) => Number.isInteger(client.pid) && !!client.name);
}

/** The client whose process has this pid, or null when there is none. */
export function findClientByPid(clients, pid) {
  if (!Array.isArray(clients) || !Number.isInteger(pid)) return null;
  return clients.find((client) => client.pid === pid) || null;
}
