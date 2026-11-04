# 4. A pane is a shell; the launch command is typed into it

Date: 2026-11-02

## Status

Accepted

## Context

AMA launched a session by handing its command to `tmux new-session` as a trailing argument. tmux runs a trailing argument as the pane's *initial process*, so the command became the pane. When that process exits — which is exactly what an agent's `/exit` does — tmux closes the window, and a session with a single window is destroyed along with it. The session then no longer appears in `list-panes -a`, so AMA dropped it from `/api/sessions` and its tile disappeared from the sidebar.

The symptom looked inconsistent because it depended on the path. Every path that carried a command was affected — the restore path (`opencode -s <id>`, `claude -r <id>`, `claude`), a session created with an explicit command, and the target path that sshes to a remote machine. A plain shell session, which is what the New Session button creates, was never affected.

The obvious fix is to wrap the command so a shell outlives it. Two variants were built and tested:

- `sh -c "<command>"; exec "$SHELL" -l`
- `"<command>"; exec "$SHELL" -l`

Both keep the session alive when the command ends. Both also die on Ctrl-C: the wrapper shell sits in the same process group as the command, so the SIGINT meant to interrupt the command also kills the wrapper, and with it the pane. An agent session that cannot be interrupted is worse than one that exits.

## Decision

The pane is a shell. AMA creates the pane, waits for the shell to be ready, then types the launch command into it and presses Enter.

- The pane is created with `new-session -d -P -F '#{pane_id}'`, so the new pane can be addressed unambiguously. tmux resolves a bare target that looks like a number as a *window index of the current session*, not as a session name, so addressing by pane id is not optional.
- The command is sent with `send-keys -l -- <command>`. `-l` sends the characters literally, so spaces and quotes survive; `--` stops a command that begins with a dash from being read as options.
- Enter is a separate `send-keys` call. With `-l`, the word `Enter` would be sent as literal text.
- The shell must have drawn its prompt before anything is typed. Typing earlier echoes the command twice — once by the tty and once by the shell's line editor — so the pane waits for a non-empty `capture-pane`, polling every 25ms up to a 5s cap.

Restored sessions take the same path: the agent command is typed into a fresh shell in the recorded directory.

## Consequences

- `/exit` returns the user to a prompt in the same tile. The session survives, the tile stays in the sidebar, and the shell is still there to type into.
- Ctrl-C interrupts the running command without taking the pane with it.
- A pane's foreground process is the shell for most of its life rather than the agent. Agent detection reads the pane's content and its process tree rather than trusting the foreground command alone — which it already had to do, since a plain shell session is the common case.
- A command that fails to start — a missing binary, a refused ssh — leaves a shell with an error message in it, rather than a dead tile.
- The launch path has a small, bounded race: between the shell becoming ready and the keystrokes landing. The readiness poll closes it in practice; the cost of getting it wrong is a doubled command, which the user sees and can fix.
- `surface-token.js` builds three separate argument vectors now — the session, the input, and the submit — because they are three different tmux invocations.
