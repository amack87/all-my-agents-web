#!/usr/bin/env python3
"""PTY helper: allocates a real PTY and relays I/O between stdin/stdout and the child process."""
import sys
import os
import pty
import select
import signal
import struct
import fcntl
import termios
import json

def set_winsize(fd, rows, cols):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def main():
    if len(sys.argv) < 2:
        print("Usage: pty-helper.py <command> [args...]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1:]

    # Create PTY pair
    master_fd, slave_fd = pty.openpty()

    # Set initial size
    set_winsize(master_fd, 24, 80)

    pid = os.fork()
    if pid == 0:
        # Child: become session leader, set controlling terminal
        os.close(master_fd)
        os.setsid()

        # Set slave as controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        # Redirect stdio to slave
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        # Strip TMUX env so attach works from inside tmux
        for var in ("TMUX", "TMUX_PANE"):
            os.environ.pop(var, None)
        os.environ["TERM"] = "xterm-256color"

        os.execvp(cmd[0], cmd)
    else:
        # Parent: relay I/O
        os.close(slave_fd)

        # Make stdin non-blocking
        stdin_fd = sys.stdin.fileno()
        old_flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
        fcntl.fcntl(stdin_fd, fcntl.F_SETFL, old_flags | os.O_NONBLOCK)

        # Make master non-blocking
        old_master_flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, old_master_flags | os.O_NONBLOCK)

        # Handle SIGCHLD
        child_exited = False
        def on_sigchld(signum, frame):
            nonlocal child_exited
            child_exited = True
        signal.signal(signal.SIGCHLD, on_sigchld)

        # Handle resize commands on stderr (JSON: {"resize": [cols, rows]})
        # Actually, we'll read resize commands from stdin as special sequences
        # Protocol: lines starting with \x00R are resize commands: \x00R<cols>,<rows>\n

        try:
            while not child_exited:
                try:
                    rlist, _, _ = select.select([stdin_fd, master_fd], [], [], 0.1)
                except (select.error, InterruptedError):
                    continue

                if stdin_fd in rlist:
                    try:
                        data = os.read(stdin_fd, 4096)
                        if not data:
                            break

                        # Check for resize command: \x00R<cols>,<rows>\n
                        if b"\x00R" in data:
                            parts = data.split(b"\x00R")
                            for i, part in enumerate(parts):
                                if i == 0:
                                    if part:
                                        os.write(master_fd, part)
                                else:
                                    nl = part.find(b"\n")
                                    if nl >= 0:
                                        resize_data = part[:nl]
                                        remaining = part[nl+1:]
                                        try:
                                            cols_s, rows_s = resize_data.split(b",")
                                            set_winsize(master_fd, int(rows_s), int(cols_s))
                                            # Signal the child about the resize
                                            os.kill(pid, signal.SIGWINCH)
                                        except (ValueError, OSError):
                                            pass
                                        if remaining:
                                            os.write(master_fd, remaining)
                                    else:
                                        os.write(master_fd, part)
                        else:
                            os.write(master_fd, data)
                    except OSError:
                        break

                if master_fd in rlist:
                    try:
                        data = os.read(master_fd, 4096)
                        if not data:
                            break
                        os.write(sys.stdout.fileno(), data)
                        sys.stdout.flush()
                    except OSError:
                        break
        finally:
            os.close(master_fd)
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass

if __name__ == "__main__":
    main()
