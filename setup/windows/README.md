# Setting up a Windows machine as an AMA target

These scripts turn a Windows machine into a **target**: a machine AMA drives over
SSH, on which an agent runs natively. The design rationale is in
[ADR 0002](../../docs/adr/0002-windows-via-ssh-target.md); the launch mechanism
is in [ADR 0004](../../docs/adr/0004-pane-is-a-shell.md).

AMA never runs on Windows. It runs on the Mac. The Mac opens an `ssh` client in a
tmux pane; the agent on the far side runs as a real Windows process, so CRLF
checkouts, `.cmd` shims, `cmd.exe` quoting, Defender and Git Bash all behave the
way they will for an engineer.

---

## Order of operations

Each step depends on the one before it. Steps 2, 4, 5 and 8 run **on the
Windows machine**; the rest run on the Mac.

### 1. Mac — create a keypair for the Windows machine

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ama_windows_ed25519 -N '' -C ama-mac-to-windows-vm
cat ~/.ssh/ama_windows_ed25519.pub
```

Keep the public key handy — the next step installs it on Windows.

### 2. Windows — enable OpenSSH Server and trust the Mac's key

Open an **elevated** PowerShell on the Windows machine and run:

```powershell
powershell -ExecutionPolicy Bypass -File enable-ssh.ps1 -MacPublicKey 'ssh-ed25519 AAAA... your-comment'
```

The script installs the `OpenSSH.Server` capability, starts `sshd`, scopes the
firewall rule to the subnet the guest is actually on, disables password
authentication, and writes the Mac's public key to **both**
`%USERPROFILE%\.ssh\authorized_keys` and
`C:\ProgramData\ssh\administrators_authorized_keys` — Windows routes
administrators to the second file, so writing both makes the key work whether or
not the account is elevated. It finishes by printing the exact `ssh` command to
run from the Mac.

> **Pass the key as one quoted argument, and only that.** `cmd.exe` does not
> understand single quotes, so an unquoted key is split across arguments and
> PowerShell binds the key body to the wrong parameter. The script takes a
> single parameter for exactly this reason — never add a second one.

`enable-ssh-oneliner.txt` is the same thing as a single copy-pasteable line, for
when you would rather not transfer a file. It downloads `enable-ssh.ps1` from the
Mac over HTTP, so the HTTP server below has to be running, and it carries the
key for you — replace `REPLACE_WITH_YOUR_MAC_PUBLIC_KEY` with your public key
first. Run it in the elevated PowerShell:

```powershell
irm http://192.168.64.1:8099/enable-ssh-oneliner.txt | iex
```

### 3. Mac — verify the connection

```bash
ssh -i ~/.ssh/ama_windows_ed25519 <windows-user>@<windows-ip>
```

If you are on a UTM/Parallels VM, the guest is usually `192.168.64.2` and the
Mac is `192.168.64.1`.

### 4. Windows — install the toolchain

Run in an elevated PowerShell. Progress is written to `%TEMP%\ama-toolchain.log`,
so a dropped connection does not lose the trail:

```powershell
irm http://192.168.64.1:8099/install-toolchain.ps1 | iex
```

This installs, with `winget`, into the standard locations and the standard
`PATH`, exactly the way an engineer's machine is set up:

| Tool | Lands at |
|------|----------|
| Git for Windows | `C:\Program Files\Git\` |
| Node.js LTS | `C:\Program Files\nodejs\` |
| Python 3.12 | `%LOCALAPPDATA%\Programs\Python\Python312\` |
| Claude Code | `%USERPROFILE%\.local\bin\claude.exe` |

### 5. Windows — fix the environment the installers leave broken

```powershell
irm http://192.168.64.1:8099/configure-env.ps1 | iex
```

Three things need fixing after a fresh install:

- **Claude Code is not on `PATH`.** It installs to `%USERPROFILE%\.local\bin`
  and the installer does not add it, so `claude` is only runnable by absolute
  path. The script prepends the directory to the *user* `PATH`.
- **`python3` is the Microsoft Store alias stub**, not the real interpreter, so
  anything that calls `python3` fails. The script writes a `python3.cmd` shim in
  `%USERPROFILE%\bin` that forwards to the real `python.exe`.
- **Claude Code runs shell-form hooks through Git Bash**, and will otherwise
  resolve `bash` to some other interpreter with no Git Bash semantics (WSL's
  `C:\Windows\System32\bash.exe`, for instance). The script pins
  `CLAUDE_CODE_GIT_BASH_PATH` to `C:\Program Files\Git\bin\bash.exe`.

### 6. Mac — declare the target

In `mesh.config.json`:

```json
{
  "name": "my-macbook",
  "peers": [],
  "targets": [
    {
      "name": "windows-vm",
      "label": "Windows 11 VM",
      "host": "192.168.64.2",
      "user": "<windows-user>",
      "identityFile": "~/.ssh/ama_windows_ed25519"
    }
  ]
}
```

`port` is optional (default 22). `host` may also be an `~/.ssh/config` alias.
The command is built on the server from this entry — the browser never supplies
a command line — and the target is re-resolved at launch time, so changing a
host or key takes effect without recreating the session.

### 7. Mac — start a session on the target

From the UI, the new-session dialog offers each configured target. Or over the
API:

```bash
curl -X POST http://127.0.0.1:3456/api/sessions \
  -H 'content-type: application/json' \
  -d '{"name":"win-agent","target":"windows-vm"}'
```

`GET /api/targets` lists what is configured.

### 8. Windows — install the status adapter

Run **over SSH**, from an Administrator PowerShell on the Mac:

```bash
scp ~/.ssh/ama_windows_ed25519 <windows-user>@192.168.64.2:/C:/Users/<windows-user>/
ssh -i ~/.ssh/ama_windows_ed25519 <windows-user>@192.168.64.2 \
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\<windows-user>\\install-adapter.ps1 C:\\Users\\<windows-user>\\ama-status-hook.js"
```

Copy the adapter across first, then run the script with its path as the argument:

```bash
scp integrations/claude/ama-status-hook.js <windows-user>@192.168.64.2:/C:/Users/<windows-user>/
```

The script does two halves:

- **The far side must accept the forwarded environment.** It appends
  `AcceptEnv AMA_SURFACE_TOKEN ALL_MY_AGENTS_URL` to `C:\ProgramData\ssh\sshd_config`
  — **above the first `Match` block**, or it applies to nothing. It then
  schedules an `sshd` restart, because `sshd` only reads its config at startup
  and restarting it inline would drop the SSH connection the script is running
  over.
- **Claude Code must run the adapter as a hook.** It copies the adapter to
  `%USERPROFILE%\ama\ama-status-hook.js` and merges the `hooks` block into
  `%USERPROFILE%\.claude\settings.json` (backing up the original to
  `settings.json.bak`).

The script is idempotent — re-run it freely.

### 9. Windows — authenticate the agent

```powershell
claude setup-token
```

or sign in interactively. Until the agent is authenticated it will not start a
session.

The first launch in a new directory stops on a trust prompt — *"Is this a
project you created or one you trust?"* — with **No, exit** highlighted by
default. An agent driving the TUI has to answer it, so either answer it once
per working directory, or pre-trust the directory. The same prompt appears in
the terminal on the Mac, so it is not a Windows quirk; it is just easier to miss
when the agent is driving.

---

## Recovering SSH access

If the Mac can no longer log in but the VM is still running, the cause is almost
always a broken `authorized_keys` — a key written with a mangled argument, or a
key file whose ACL let sshd refuse it. The guest agent is not a way out: UTM's
SPICE server refuses a second client, so it cannot be driven from the host.

The repair runs **in the guest console**, in an elevated PowerShell:

```powershell
iwr http://192.168.64.1:8099/repair-ssh.ps1 -OutFile $env:TEMP\repair-ssh.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\repair-ssh.ps1
```

It fetches the Mac's public key from the bridge, writes both
`authorized_keys` files with the ACL sshd insists on, restarts `sshd` inline and
prints `=== AMA_SSH_FIXED ===`. It takes the key URL from `-KeyUrl` (default
`http://192.168.64.1:8099/ama_windows_ed25519.pub`) or the key itself from
`-MacPublicKey`, so the HTTP server has to be serving that file.

The key arrives over plain HTTP, so anything running on the machine could squat
that port and serve a key of its own — which the VM would then trust. Pass the
Mac's own fingerprint to close that hole:

```bash
ssh-keygen -lf ~/.ssh/ama_windows_ed25519.pub | awk '{print $2}'
```

```powershell
iwr http://192.168.64.1:8099/repair-ssh.ps1 -OutFile $env:TEMP\repair-ssh.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\repair-ssh.ps1 -ExpectedFingerprint 'SHA256:...'
```

With `-ExpectedFingerprint` set, the script refuses to write anything unless
the key hashes to that value, and exits non-zero on a mismatch. The fingerprint
it computed is always printed, so you can compare it by eye when you did not
pass one.

Two traps, both handled inside the script but worth knowing:

- `Invoke-WebRequest` returns `Content` as a **byte array**, not a string, when
  the server does not label the response as text — and `python -m http.server`
  serves a `.pub` file as `application/x-mspublisher`. Calling `.Trim()` on
  that fails with *"Method invocation failed because [System.Byte] does not
  contain a method called 'Trim'"*. Decode the bytes first.
- `SHA256.HashData` is .NET 5+; Windows PowerShell 5.1 is .NET Framework and
  does not have it. Use `SHA256.Create()` + `ComputeHash()`.

If the restart is what worries you, pass `-NoRestart`: `sshd` re-reads
`authorized_keys` on every authentication attempt, so rewriting the key is
enough to restore access, and the script then leaves the running service
alone. The script also backs up `sshd_config` before restarting and puts it
back if `sshd` does not come up listening.

---

## Do not rely on the clipboard

The UTM VM's clipboard sharing is configured on both sides — `Sharing.ClipboardSharing`
is on in the VM's config, the guest has a `virtio-serial` bus with a SPICE
`vdagent` channel, and the UTM guest-tools services (`vdservice`, `qemu-ga`,
`spice-webdavd`) are running — and the clipboard still does not sync in
practice. This matches the upstream report
[utmapp/UTM#6526](https://github.com/utmapp/UTM/issues/6526) ("Clipboard sharing
stops working or works intermittently" on Windows 11 ARM), where reinstalling the
guest tools or rebooting usually restores it.

So the setup does not assume you can paste anything into the VM. Instead,
**serve this directory over HTTP from the Mac**, bound to the bridge address so
it is not reachable from the Wi-Fi LAN:

```bash
cd /path/to/all-my-agents-web
nohup python3 -m http.server 8099 --bind 192.168.64.1 --directory setup/windows \
  > /tmp/ama-http.log 2>&1 &
```

Then in the VM: `irm http://192.168.64.1:8099/<script>.ps1 | iex`.

Folder sharing does work (it rides `spice-webdavd`, not the clipboard), so an
alternative is to drop the scripts into the shared folder and run them from
there.

---

## Script reference

| Script | Runs on | Run as | What it does |
|--------|---------|--------|--------------|
| `enable-ssh.ps1` | Windows | Elevated PowerShell | Installs OpenSSH Server, starts `sshd`, scopes the firewall to the guest's subnet, disables password auth, installs the Mac's key, prints the `ssh` command |
| `enable-ssh-oneliner.txt` | Windows | Elevated PowerShell | The same thing as one copy-pasteable line |
| `repair-ssh.ps1` | Windows | Elevated PowerShell | Recovers SSH access when `authorized_keys` is broken: fetches the Mac's key over HTTP (verify it with `-ExpectedFingerprint`), rewrites both files with the right ACLs, restarts `sshd` |
| `install-toolchain.ps1` | Windows | Elevated PowerShell | Installs Git, Node, Python and Claude Code with `winget`; logs to `%TEMP%\ama-toolchain.log` |
| `configure-env.ps1` | Windows | Any PowerShell | Puts Claude Code on `PATH`, creates a working `python3`, pins `CLAUDE_CODE_GIT_BASH_PATH` |
| `install-adapter.ps1` | Windows | Administrator PowerShell, over SSH | Adds `AcceptEnv` to `sshd_config`, restarts `sshd`, installs the adapter and wires up Claude Code hooks |
| `diagnose.ps1` | Windows | Elevated PowerShell | Read-only environment diagnostic; changes nothing |

---

## Gotchas worth knowing before you start

- **Run the scripts synchronously over SSH.** A detached
  `Start-Process powershell -ArgumentList '...'` produced no log at all — the
  script appears never to have started. The same script run synchronously over
  SSH printed a clean step-by-step log.
- **Avoid `|` in a remote `ssh` command.** `cmd.exe` intercepts the pipe and the
  command fails with `exec request failed on channel 0`. Use two commands:
  download with `Invoke-WebRequest -OutFile`, then run with `-File`.
- **The surface token is forwarded by name, never by value.** AMA asks ssh to
  copy one variable across with `-o SendEnv=AMA_SURFACE_TOKEN`; the value is
  picked up from the pane's own environment, so it never appears on the command
  line and cannot leak into the scrollback, the shell history or `ps`. The far
  side's `sshd_config` must list the name in `AcceptEnv` or it is dropped.
  Where the far side reports status is a property of that machine, so it is
  configured in the far side's own environment (`ALL_MY_AGENTS_URL`).
- **The far side's `sshd_config` must list `AcceptEnv` above the first `Match`
  block.** `AcceptEnv` inside `Match Group administrators` applies to nothing.
- **Scripts shipped with a Git checkout must not have CRLF endings.** Git for
  Windows defaults to `core.autocrlf=true`, which rewrites shebang scripts and
  breaks them with `bad interpreter: /usr/bin/env bash^M`. Add a
  `.gitattributes` with `* text=auto eol=lf`.
- **MCP servers need a `cmd /c` wrapper on Windows.** `npx` resolves to
  `npx.cmd`, a batch shim that Node's `child_process.spawn` cannot execute. Use
  `{"command":"cmd","args":["/c","npx", ...]}` — otherwise the server appears
  in `claude mcp list` but never connects.
