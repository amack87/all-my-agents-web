# 2. Windows machines are reached over SSH; AMA does not host them natively

Date: 2026-11-01

## Status

Accepted

## Context

The goal was to run agents against a real Windows environment, so that plugins being built for Claude Code could be developed and tested on Windows before they rolled out to engineers who work on a mix of Windows and macOS.

Two plans were considered and both failed on inspection:

- **WSL2 as the agent host.** WSL2 needs nested virtualization. The host is an Apple Silicon Mac and the Windows guest runs under Apple Virtualization.framework, where nested virtualization does not exist — Broadcom, Parallels and Red Hat all document WSL2 as unsupported in this configuration. WSL1 was rejected as the fallback: no systemd, unreliable pty behaviour for tmux and node-pty, and less fidelity than a native Windows agent.
- **AMA running natively on Windows.** AMA's session model *is* tmux: session creation, pane capture, rename and kill are all tmux calls. Supporting Windows natively means replacing tmux with a Windows session manager that reproduces detached sessions, pane capture and scrollback — weeks of work, and it buys nothing that the SSH path does not already give.

A third option was to run the agent in Linux and shell out to Windows tooling. That produces worse fidelity than a native Windows agent, because the interesting failures live in the code and its dependencies, not in the agent.

## Decision

AMA stays on the machine that can host it. A session may run a **launch command** instead of a default shell, and a **target** is a named remote machine that a launch command reaches. Targets are configured in `mesh.config.json`, and the command is built on the server so the browser never supplies a command line.

The pane runs an `ssh` client; the agent on the far side runs natively. A Windows session is therefore a real Windows process, on real Windows, with Git Bash, CRLF checkouts, `.cmd` shims, `cmd.exe` quoting and Defender behaving exactly as they will for an engineer.

Supporting decisions:

- The launch command is described by a **launch spec** — `{kind: "target", name}` or `{kind: "command", command}` — that is token-free and safe to persist. The registry carries the spec so a target session is rebuilt after a restart, with a freshly minted surface token.
- A target spec is re-resolved against the current target list at launch time, so changing a host or identity takes effect without recreating the session.
- The surface token is forwarded to the far side **by name, not by value**. The pane's environment already holds `AMA_SURFACE_TOKEN`, and `ssh -o SendEnv=AMA_SURFACE_TOKEN` asks the client to copy that variable across. The value never appears on the command line, so it cannot leak into the pane's scrollback, the shell history, `ps` or an error message. Where the far side reports status is a property of that machine, so it is configured in the far side's own environment.

## Consequences

- A target session is a local tmux pane whose contents live on another machine. The session's *agent* runs remotely; the session itself is hosted locally. The sidebar shows the session under this machine.
- Remote agents are identified by an adapter that posts status events back over the connection. Without it, a remote agent is inferred from screen text alone, which is weaker than an event.
- A remote agent's session id lives on the far side, so restoring a target session re-establishes the connection rather than resuming the remote conversation.
- Peers remain the model for full control of a remote machine. A target is for reaching a machine that does not run AMA.
- The macOS `launchd` service is the only supported host for the AMA server. The Windows side carries only the agent and its adapter.
