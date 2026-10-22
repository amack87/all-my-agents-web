# Agent session restore research for AMA

## TL;DR per-agent verdict

| Agent | Session-id discovery | Exact resume command | Degrade fallback | Verdict |
| --- | --- | --- | --- | --- |
| `opencode` | Read explicit `-s/--session` from process args; else query `http://127.0.0.1:<port>/session/status` (preferring single/busy key). Stored as `ses_*` in registry; probed via `opencode export <id> --sanitize` at boot. | `opencode -s <sessionId>` (launch as initial pane command). Also supports `-c/--continue` (last session) and `--fork`. | `opencode -c` in recorded `dir` (`continueBest: true`, `reason: "degrade"`). Never silently skip. | **Native resumable** (already implemented). |
| `Claude Code` | Live per-process registry at `~/.claude/sessions/<pid>.json` gives `{pid, sessionId, cwd, tmux, ...}` (undocumented/internal; observed on this machine). Transcripts at `~/.claude/projects/<slug>/<uuid>.jsonl` start with records carrying `sessionId`/`cwd`; slug ≠ always process cwd (one dir grouped scratch workspaces). `CLAUDE_CODE_SESSION_ID` is injected into subprocesses/hooks (documented) but no `CLAUDE_SESSION_ID` env var found in binary; no mapping into AMA registry today. Hooks receive `session_id` in payload (SessionStart includes `source` in {startup,resume,clear,compact,fork}, also `resume/fork` fields like `seconds_since_last_response`). | `claude -r <session-id-or-name>` (resume by ID or name; interactive picker if omitted) or `claude -c` (continue most recent in current directory). `--fork-session` with `--resume`/`--continue` creates new ID. `-p` non-interactive forms exist. On resume/fork in background contexts behavior varies. | If no discoverable session id/name or resume fails, fall back to launching `claude` in recorded dir (new session). Must not depend on screen-scrape only for identity if registry/hook/session files available. | **Resumable with discovery** (not wired). Needs adapter to capture `session_id` from `SessionStart` (hooks) or from `~/.claude/sessions/*.json` / project transcripts. |
| `Codex` | Sessions stored as rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>[ _<rollout_id> ].jsonl` (source). First record is `SessionMeta` with `session_id` (== root thread id) and `id` (ThreadId), `cwd`, etc. `codex resume` takes `[SESSION_ID]` (UUID or name), `--last` to continue most recent without picker; subcommand `resume`. Also `codex exec` has resume/fork variants. Env vars `CODEX_SESSION_ID`/`CODEX_THREAD_ID` injected into spawned shells. | `codex resume <session_id-or-name>` or `codex resume --last` (non-interactive/flag forms depend on context). Can also be resumed via TUI picker. | Fall back to `codex` in recorded dir (new session). | **Resumable with discovery** (not installed here; needs rollout file discovery by cwd/recent mtime + SessionMeta). |
| `Cursor CLI` (`agent`) | Docs show `agent ls` to list previous chats, `agent resume` (latest), `agent --continue` (alias for `--resume=-1`), `agent --resume <chatId>`. Stored under project/worktree context (mentions `~/.cursor/worktrees/...`); specific global session store layout not fully surfaced in fetched docs. | `agent --resume <chatId>` or `agent resume` / `agent --continue`. | Fall back to `agent` in recorded dir. | **Resumable with discovery** (CLI exists in docs; store layout needs verification). |
| `Aider` | No global "resume session id" command equivalent to others surfaced; supports `--restore-chat-history` (restores previous chat history messages) with chat history file (`.aider.chat.history.md` by default, configurable via `--chat-history-file`). | `aider --restore-chat-history` (in project dir) or configure history file. No UUID session id API clearly documented in fetched docs. | Fall back to `aider` in recorded dir (history restoration best-effort if files exist). | **Partly resumable** (history restore, not full session-id resume like others). |
| `Gemini/Copilot` | Not found/undocumented in this codebase; treat as non-resumable by id. | Launch as-is in recorded dir. | Recreate shell/new process in dir. | **Not resumable by id** (no hooks/registry discovery). |

## Capability table (concrete)

| Agent | Session-id discovery (evidence) | Exact resume command | Degrade fallback | Source |
| --- | --- | --- | --- | --- |
| opencode | process args `-s`/`--session` or `GET /session/status` → single/busy key; `opencode export <id>` validates. `session list` shows `ses_*`. | `opencode -s <id>` or `opencode -c` (continue last). `--fork` supported. | `opencode -c` in `entry.dir` (continueBest). | `server.js:372-402`, `restore-plan.js:26-45`, `~/.opencode/bin/opencode --help`, `opencode session list`. |
| Claude Code | `~/.claude/sessions/<pid>.json` has `sessionId` + `tmux` + `cwd` (live). Transcripts `~/.claude/projects/<slug>/*.jsonl` contain `sessionId` (first records). Hooks payload includes `session_id`; `SessionStart.source` in {startup,resume,clear,compact,fork}. `CLAUDE_CODE_SESSION_ID` env injected to subprocesses/hooks. | `claude -r <id-or-name>` or `claude -c` (current dir). `--fork-session` with resume/continue. `--session-id <uuid>` to set ID. | Launch `claude` in `dir` (new session). If id known from hook/session file, prefer `-r <id>`. | `~/.claude/sessions/*.json` (observed), `~/.claude/projects/*/*.jsonl` (observed), Claude Code CLI help/env vars (fetched), hooks docs (fetched). |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>[ _<uuid> ].jsonl`, first line `SessionMeta` with `session_id`/`id`/`cwd`. `CODEX_SESSION_ID`/`CODEX_THREAD_ID` injected. | `codex resume <session_id-or-name>` or `codex resume --last` (picker if omitted). | Launch `codex` in `dir`. | Codex source: `codex-rs/rollout/src/rollout_file_name.rs`, `codex-rs/rollout/src/list.rs` (paths), `codex-rs/protocol/src/protocol.rs` (SessionMeta), `codex-rs/cli/src/main.rs` (Resume subcommand), `codex-rs/utils/cli/src/resume_command.rs`. |
| Cursor CLI | `agent ls`, `agent resume`, `agent --continue` (`--resume=-1`), `agent --resume <chatId>`. | `agent --resume <chatId>` or `agent resume`/`agent --continue`. | Launch `agent` in `dir`. | Cursor CLI docs (fetched). |
| Aider | `--restore-chat-history`, history file `.aider.chat.history.md` (configurable). | `aider --restore-chat-history [--chat-history-file <path>]` in project dir. | Launch `aider` in `dir`. | Aider docs (fetched). |

## Trimmed verified command outputs

- `opencode --help` (relevant): `-c, --continue`, `-s, --session <id>`, `--fork`; `opencode session list` lists sessions with IDs/titles.
- `claude --help` (relevant): `-c, --continue` (current dir), `-r, --resume [value]` (by ID/name or picker), `--fork-session` (with resume/continue), `--session-id <uuid>`. Env: `CLAUDE_CODE_SESSION_ID` documented (subprocesses/hooks updated on /clear; on resume may receive resumed ID).
- `codex` (source): `Resume` subcommand takes `session_id` (UUID or name) or `--last`; rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl` with `SessionMeta.session_id`/`cwd`.
- `agent` (Cursor docs): `agent ls`, `agent resume`, `agent --continue`, `agent --resume <chatId>`.
- `aider` (docs): `--restore-chat-history` / `AIDER_RESTORE_CHAT_HISTORY`, `--chat-history-file` default `.aider.chat.history.md`.

## Concrete code sketches

### `restore-plan.js` (extend per-agent)
```js
// Pure builder for boot-time restore plan (extend).
export function buildRestorePlan({ registry, existingTmux = [], resolvable = new Set() }) {
  const existing = new Set(existingTmux);
  const actions = [];
  for (const entry of registry?.sessions ?? []) {
    if (existing.has(entry.tmux)) continue;
    const agent = entry.agent;
    // opencode: existing behavior
    if (agent === "opencode") {
      const canResume = Boolean(entry.sessionId && resolvable.has(entry.sessionId));
      if (canResume) {
        actions.push({ kind: "launch-opencode", name: entry.tmux, dir: entry.dir, sessionId: entry.sessionId, continueBest: false, reason: "resume" });
      } else {
        actions.push({ kind: "launch-opencode", name: entry.tmux, dir: entry.dir, sessionId: null, continueBest: true, reason: "degrade" });
      }
      continue;
    }
    // Claude Code
    if (agent === "Claude Code") {
      const sid = entry.sessionId || entry.claudeSessionId || null;
      if (sid) {
        actions.push({ kind: "launch-claude", name: entry.tmux, dir: entry.dir, sessionId: sid, mode: "resume", reason: "resume" });
      } else {
        actions.push({ kind: "launch-claude", name: entry.tmux, dir: entry.dir, sessionId: null, mode: "continue-or-new", reason: "degrade" });
      }
      continue;
    }
    // Codex
    if (agent === "Codex") {
      const sid = entry.sessionId || entry.codexSessionId || null;
      if (sid) {
        actions.push({ kind: "launch-codex", name: entry.tmux, dir: entry.dir, sessionId: sid, mode: "resume", reason: "resume" });
      } else {
        actions.push({ kind: "launch-codex", name: entry.tmux, dir: entry.dir, sessionId: null, mode: "resume-last-or-new", reason: "degrade" });
      }
      continue;
    }
    // Cursor
    if (agent === "Cursor") {
      const cid = entry.sessionId || entry.cursorChatId || null;
      if (cid) {
        actions.push({ kind: "launch-cursor", name: entry.tmux, dir: entry.dir, sessionId: cid, mode: "resume", reason: "resume" });
      } else {
        actions.push({ kind: "launch-cursor", name: entry.tmux, dir: entry.dir, sessionId: null, mode: "continue-or-new", reason: "degrade" });
      }
      continue;
    }
    // Aider
    if (agent === "Aider") {
      actions.push({ kind: "launch-aider", name: entry.tmux, dir: entry.dir, restoreHistory: true, reason: "restore-history" });
      continue;
    }
    // Default
    actions.push({ kind: "recreate-shell", name: entry.tmux, dir: entry.dir, agent, reason: "recreate-shell" });
  }
  return actions;
}
```

### `session-registry.js` (discovery + retention)
```js
// Extend discovery to populate agent-specific session ids.
// - opencode: as now (resolvePaneSessionId) or from flags.
// - Claude Code: read ~/.claude/sessions/*.json by tmux/pid mapping; or update from hooks (store sessionId on events).
// - Codex: scan ~/.codex/sessions/YYYY/MM/DD for most recent rollout by cwd (read SessionMeta.session_id).
// - Cursor/Aider: best-effort from known paths/env if available.

export function reconcileRegistry(live, prior, now) {
  // existing logic...
  // When liveEntry.sessionId exists and differs from prev.sessionId -> take liveEntry.sessionId (positive evidence)
  // When liveEntry.sessionId missing but prev.sessionId exists -> keep prev.sessionId (do NOT null on transient miss) per current policy
  // When we have positive evidence of replacement (different id observed) -> update
}
```

Notes:
- Keep `MISSES_TO_PRUNE=2`, retain stale id via `??` as now (line ~73). Only replace on positive evidence (different id observed live).
- Extend registry schema to allow agent-specific keys if needed (e.g. `claudeSessionId`) but prefer unified `sessionId` where format matches; be explicit in serialization.

### `server.js` (executor)
```js
async function executeRestoreAction(action) {
  const token = newSurfaceToken();
  surfaceTokens.set(token, action.name);
  const tmuxArgs = buildLaunchArgs({ name: action.name, dir: action.dir, token });
  if (action.kind === "recreate-shell") { /* same as now */ return; }
  if (action.kind === "launch-opencode") {
    const cmd = action.continueBest ? `${OPENCODE_BIN} -c` : `${OPENCODE_BIN} -s ${action.sessionId}`;
    tmuxArgs.push(cmd); await execFileAsync(TMUX, tmuxArgs, {timeout:15000}); return;
  }
  if (action.kind === "launch-claude") {
    const cmd = action.mode === "resume" && action.sessionId ? `claude -r ${shQuote(action.sessionId)}` : `claude`;
    tmuxArgs.push(cmd); await execFileAsync(TMUX, tmuxArgs, {timeout:15000}); return;
  }
  if (action.kind === "launch-codex") {
    const cmd = action.mode === "resume" && action.sessionId ? `codex resume ${shQuote(action.sessionId)}` : `codex resume --last || codex`; // degrade carefully
    // better: try resume with id/last, else codex
    tmuxArgs.push(cmd); await execFileAsync(TMUX, tmuxArgs, {timeout:15000}); return;
  }
  if (action.kind === "launch-cursor") {
    const cmd = action.mode === "resume" && action.sessionId ? `agent --resume ${shQuote(action.sessionId)}` : `agent --continue || agent`;
    tmuxArgs.push(cmd); await execFileAsync(TMUX, tmuxArgs, {timeout:15000}); return;
  }
  if (action.kind === "launch-aider") {
    const cmd = action.restoreHistory ? `aider --restore-chat-history` : `aider`;
    tmuxArgs.push(cmd); await execFileAsync(TMUX, tmuxArgs, {timeout:15000}); return;
  }
}
```

Also extend `discoverManagedSessions()` to:
1. Detect agent for all panes (already done).
2. For Claude Code: look up `~/.claude/sessions/*.json` by matching `tmux` target or by pid/cwd; prefer live session file. Also update from hooks (`/api/events` can store `session_id` from Claude hooks if we extend hook adapter to forward it).
3. For Codex: if not installed, skip discovery but allow registry to carry id if seen elsewhere; else scan rollouts by cwd.
4. For Cursor/Aider: best-effort discovery.

Extend `integrations/claude/ama-status-hook.js` to forward `session_id` from payload when present (Claude hooks provide `session_id`): include it in POST body to `/api/events` (e.g. `{ event, surfaceToken, sessionId: payload.session_id }`) so `resolveIdentity` can fall back to registry by sessionId and server can record/update mapping.

### `agent-events.js` / server
- `resolveIdentity` already supports `sessionId` fallback (registry). Ensure Claude sessions get registered with their `sessionId`.
- When storing event state, also index by `sessionId` if known.

## New test cases

### `test/restore-plan.test.js`
```js
test("plans resume for Claude Code when sessionId present", () => {
  const registry = { version: 2, updatedAt: "x", sessions: [
    { tmux: "cc1", dir: "/repo", sessionId: "abc123-uuid", agent: "Claude Code", firstSeen:"x", lastActive:"x" }
  ]};
  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "launch-claude", name: "cc1", dir: "/repo", sessionId: "abc123-uuid", mode: "resume", reason: "resume" }
  ]);
});

test("degrades Claude Code when no sessionId", () => {
  const registry = { version: 2, updatedAt: "x", sessions: [
    { tmux: "cc2", dir: "/repo", sessionId: null, agent: "Claude Code", firstSeen:"x", lastActive:"x" }
  ]};
  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "launch-claude", name: "cc2", dir: "/repo", sessionId: null, mode: "continue-or-new", reason: "degrade" }
  ]);
});

test("plans resume for Codex when sessionId present", () => {
  const registry = { version: 2, updatedAt: "x", sessions: [
    { tmux: "codex1", dir: "/repo", sessionId: "thread-uuid", agent: "Codex", firstSeen:"x", lastActive:"x" }
  ]};
  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "launch-codex", name: "codex1", dir: "/repo", sessionId: "thread-uuid", mode: "resume", reason: "resume" }
  ]);
});

test("plans Cursor resume by chatId", () => {
  const registry = { version: 2, updatedAt: "x", sessions: [
    { tmux: "cur1", dir: "/repo", sessionId: "chat-123", agent: "Cursor", firstSeen:"x", lastActive:"x" }
  ]};
  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "launch-cursor", name: "cur1", dir: "/repo", sessionId: "chat-123", mode: "resume", reason: "resume" }
  ]);
});

test("plans Aider with history restore", () => {
  const registry = { version: 2, updatedAt: "x", sessions: [
    { tmux: "aid1", dir: "/repo", sessionId: null, agent: "Aider", firstSeen:"x", lastActive:"x" }
  ]};
  const actions = buildRestorePlan({ registry, existingTmux: [], resolvable: new Set() });
  assert.deepEqual(actions, [
    { kind: "launch-aider", name: "aid1", dir: "/repo", restoreHistory: true, reason: "restore-history" }
  ]);
});
```

### `test/session-registry.test.js`
```js
test("keeps previous sessionId when live entry loses it (transient)", () => {
  const prior = { version: 2, updatedAt: "t0", sessions: [
    { tmux: "cc1", dir: "/repo", sessionId: "abc123", agent: "Claude Code", firstSeen:"t0", lastActive:"t0", misses: 0 }
  ]};
  const live = [{ name: "cc1", dir: "/repo", sessionId: null, agent: "Claude Code" }];
  const { registry } = reconcileRegistry(live, prior, "t1");
  assert.equal(registry.sessions[0].sessionId, "abc123");
});

test("updates sessionId on positive evidence of change", () => {
  const prior = { version: 2, updatedAt: "t0", sessions: [
    { tmux: "cc1", dir: "/repo", sessionId: "old", agent: "Claude Code", firstSeen:"t0", lastActive:"t0", misses: 0 }
  ]};
  const live = [{ name: "cc1", dir: "/repo", sessionId: "new", agent: "Claude Code" }];
  const { registry } = reconcileRegistry(live, prior, "t1");
  assert.equal(registry.sessions[0].sessionId, "new");
});

test("retains Claude sessionId from live discovery", () => {
  const prior = { version: 2, updatedAt: "t0", sessions: [] };
  const live = [{ name: "cc1", dir: "/repo", sessionId: "abc123", agent: "Claude Code" }];
  const { registry } = reconcileRegistry(live, prior, "t1");
  assert.equal(registry.sessions[0].sessionId, "abc123");
  assert.equal(registry.sessions[0].agent, "Claude Code");
});
```

## Stale-session-id policy

- **Keep on transient null**: if live discovery can't resolve id this pass but entry existed before, keep `prev.sessionId ?? null` (current behavior). Do not prune just for missing id.
- **Replace on positive evidence**: if live provides a different sessionId, update to live id.
- **Clear only on positive evidence of replacement/invalid**: clear id if we observe a new session started under same tmux/name with different id, or if probe confirms id invalid AND we see a new conversation started (hard evidence). Never clear solely because `isSessionResolvable` fails transiently.
- **Grace window**: `MISSES_TO_PRUNE=2` consecutive misses before pruning entry entirely (keeps restore replay safe across restarts).
- **Opencode-specific**: boot probe via `opencode export <id> --sanitize` decides degrade to `-c` (don't drop id from registry unless positive evidence of replacement).

## Risks/open questions

- **Claude `~/.claude/sessions/*.json` is undocumented/internal** (verified on this machine, may change across versions). Treat as best-effort discovery; fall back to hooks/transcripts.
- **Claude slug mapping**: `~/.claude/projects/<slug>/*.jsonl` slug from cwd with non-alphanumerics → `-`; one project dir can group sessions from different locations (scratch workspaces) — can't rely on slug==cwd alone.
- **Claude resume semantics**: behavior of `claude -r <id>` when session running in another terminal/TUI or in background; `--continue` is current-dir only. On reboot, TTY/PTY context differs — test in tmux (PTY) is target case (marked UNVERIFIED for interactive edge cases).
- **Codex not installed** on this machine — rollout paths/SessionMeta inferred from source only (UNVERIFIED at runtime).
- **Cursor CLI**: chat id discovery/storage layout needs verification (docs show flags but store paths not fully confirmed).
- **Aider**: no true session-id resume, only history restore — limited.
- **Env injection timing**: `AMA_SURFACE_TOKEN` passed via `tmux -e` before command (correct per `buildLaunchArgs`). Claude hooks need token env to be present.
- **Port assumptions**: opencode status probe defaults to 4096 if no port flag found.
- **Race conditions**: pane just spawned may not have session registered yet; grace window + retries needed.

## Sources

- Repo: `server.js` (discovery 311-339, resolvePaneSessionId 372-403, restore 437-499), `restore-plan.js` (1-56), `session-registry.js` (1-111), `surface-token.js` (1-25), `integrations/claude/ama-status-hook.js` (1-107), `agent-events.js` (resolveIdentity), `README.md` (118-159), tests `test/restore-plan.test.js`, `test/session-registry.test.js`.
- Local state: `~/.local/state/all-my-agents/active-sessions.json`, `~/.claude/sessions/*.json` (observed), `~/.claude/projects/*/*.jsonl` (observed), `~/.opencode/bin/opencode` 1.18.35, `~/.local/bin/claude` 2.1.306.
- Claude Code: CLI help/env vars/docs (fetched), hooks payload fields (SessionStart/source/session_id/fields).
- Codex: GitHub source `openai/codex` — `codex-rs/rollout/src/{rollout_file_name.rs,list.rs,lib.rs,writer_lock.rs}`, `codex-rs/protocol/src/protocol.rs` (SessionMeta), `codex-rs/cli/src/main.rs` (Resume), `codex-rs/utils/cli/src/resume_command.rs`, `codex-rs/core/src/exec_env.rs`.
- Cursor CLI: docs.cursor.com (overview/using/reference/parameters) — `agent ls/resume/--continue/--resume`.
- Aider: aider.chat docs (options `--restore-chat-history`).
- tmux: man page 3.6b (new-session/respawn-pane `-e`).
