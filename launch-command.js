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

import { SURFACE_TOKEN_ENV } from "./surface-token.js";

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
export function buildSshCommand({ host, user, port, identityFile, forwardEnv } = {}) {
  if (!host) return null;
  const dest = user ? `${user}@${host}` : host;
  const p = Number(port);
  const parts = ["ssh"];
  // Keepalive: a pane whose connection died silently is worse than one that
  // ended, because the user cannot tell the agent stopped working.
  parts.push("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3");
  // Forward environment by NAME, not by value. `SendEnv` asks the client to
  // send the named variables out of its own environment, so the value never
  // appears in the command line — and a command line is echoed into the
  // shell's history, into the pane's scrollback and into the process table.
  // The receiving sshd must list the name in AcceptEnv or it drops it.
  const names = Array.isArray(forwardEnv)
    ? forwardEnv.filter((n) => typeof n === "string" && n)
    : [];
  if (names.length > 0) parts.push("-o", `SendEnv=${names.join(",")}`);
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
    // The spec may have been replayed from the on-disk registry, so it is
    // validated again rather than trusted: a hand-edited registry must not
    // be able to smuggle a command past the launch rules.
    const validated = validateLaunchCommand(spec.command);
    if (!validated.ok) return { ok: false, error: validated.error };
    return { ok: true, command: validated.command };
  }
  if (spec.kind === "target") {
    const list = Array.isArray(targets) ? targets : [];
    const target = list.find((t) => t && t.name === spec.name);
    if (!target) return { ok: false, error: `unknown target: ${spec.name}` };
    // The surface token is forwarded by NAME. The pane's own environment
    // already carries it — AMA exports AMA_SURFACE_TOKEN into the pane — so
    // the ssh client sends it out of that environment. The value is never
    // placed on the command line, so it never reaches the shell's history,
    // the pane's scrollback, the process table or an error message.
    //
    // Only the surface token is forwarded. Where the far side reports status
    // is a property of that machine, so it is configured in the far side's
    // own environment.
    const forwardEnv = token ? [SURFACE_TOKEN_ENV] : [];
    const command = buildSshCommand({ ...target, forwardEnv });
    if (!command) return { ok: false, error: `target ${spec.name} has no host` };
    return { ok: true, command };
  }
  return { ok: false, error: `unknown launch spec kind: ${spec.kind}` };
}
