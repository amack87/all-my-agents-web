// A launch command is the command a session's pane runs instead of a default
// shell. It is how AMA reaches a machine it cannot host natively: the pane
// runs an ssh client, and the agent on the far side is driven through that
// connection. The command is handed to tmux as a single argv element, so tmux
// runs it through the pane's shell.
//
// A target is a named machine a launch command reaches. Targets are configured
// in mesh.config.json so the command is built on the server, not in the
// browser.
//
// This module must stay free of fs/tmux/network side effects so the rules
// are unit-testable.

export const MAX_LAUNCH_COMMAND_LENGTH = 400;

// Validate a caller-supplied launch command.
// - absent, empty or whitespace -> no launch command (a plain shell pane)
// - one line, at most MAX_LAUNCH_COMMAND_LENGTH characters
// Returns { ok: true, command }, where command is null when there is none,
// or { ok: false, error }.
export function validateLaunchCommand(command) {
  if (command === undefined || command === null) return { ok: true, command: null };
  if (typeof command !== "string") {
    return { ok: false, error: "launch command must be a string" };
  }
  const trimmed = command.trim();
  if (!trimmed) return { ok: true, command: null };
  if (trimmed.length > MAX_LAUNCH_COMMAND_LENGTH) {
    return {
      ok: false,
      error: `launch command must be at most ${MAX_LAUNCH_COMMAND_LENGTH} characters`,
    };
  }
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: "launch command must be a single line" };
  }
  return { ok: true, command: trimmed };
}

// Build the ssh command for a target: { host, user?, port?, identityFile? }.
// `host` is an ssh destination — a ~/.ssh/config alias or a hostname.
export function buildSshCommand({ host, user, port, identityFile, env } = {}) {
  if (!host) return null;
  const entries = Object.entries(env || {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== ""
  );
  if (entries.length > 1) {
    // The ssh client honours only the first SetEnv option and silently drops
    // the rest, so asking for two would look successful and forward one.
    throw new Error("ssh forwards only one environment variable per connection");
  }
  const dest = user ? `${user}@${host}` : host;
  const p = Number(port);
  const parts = ["ssh"];
  // Keepalive: a pane whose connection died silently is worse than one that
  // ended, because the user cannot tell the agent stopped working.
  parts.push("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3");
  // Forward environment to the far side. The receiving sshd only honours
  // names it lists in AcceptEnv, so a target that ignores them just gets a
  // plain shell.
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null || value === "") continue;
      const rendered = String(value).includes(" ") ? `"${value}"` : String(value);
      parts.push("-o", `SetEnv=${key}=${rendered}`);
    }
  }
  if (identityFile) parts.push("-i", identityFile);
  if (Number.isInteger(p) && p > 0) parts.push("-p", String(p));
  parts.push(dest);
  return parts.join(" ");
}

// Resolve a target name from the mesh config into a launch command.
// Returns { ok: true, command } or { ok: false, error }.
export function resolveTargetCommand(targets, name) {
  const list = Array.isArray(targets) ? targets : [];
  const target = list.find((t) => t && t.name === name);
  if (!target) return { ok: false, error: `unknown target: ${name}` };
  const command = buildSshCommand(target);
  if (!command) return { ok: false, error: `target ${name} has no host` };
  return { ok: true, command };
}

// A launch spec is the token-free description of how a session was launched.
// It is safe to persist: the surface token is minted per launch and is never
// written to disk.
export function buildLaunchSpec({ command, target } = {}) {
  if (target) return { kind: "target", name: target };
  if (command) return { kind: "command", command };
  return null;
}

// Render a launch spec into the command to run.
// A target is re-resolved against the current target list, so a changed host
// or identity takes effect without recreating the session. `token` is minted
// per launch and forwarded so the far side can report its status back.
// Returns { ok: true, command } or { ok: false, error }.
export function renderLaunchCommand(spec, { targets = [], token = null } = {}) {
  if (!spec || typeof spec !== "object") return { ok: false, error: "no launch spec" };
  if (spec.kind === "command") {
    if (typeof spec.command !== "string" || !spec.command) {
      return { ok: false, error: "launch spec has no command" };
    }
    return { ok: true, command: spec.command };
  }
  if (spec.kind === "target") {
    const list = Array.isArray(targets) ? targets : [];
    const target = list.find((t) => t && t.name === spec.name);
    if (!target) return { ok: false, error: `unknown target: ${spec.name}` };
    // Only the surface token is forwarded. The ssh client honours a single
    // SetEnv option, and where to report status is a property of the far
    // side's machine, not of this session — so the far side configures it.
    const env = token ? { AMA_SURFACE_TOKEN: token } : {};
    const command = buildSshCommand({ ...target, env });
    if (!command) return { ok: false, error: `target ${spec.name} has no host` };
    return { ok: true, command };
  }
  return { ok: false, error: `unknown launch spec kind: ${spec.kind}` };
}
