import express from "express";
import expressWs from "express-ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { accessSync, createWriteStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import { resolveConfig, fetchAllMeshSessions, clearDiscoveryCache } from "./mesh.js";
import { reconcileRegistry, REGISTRY_VERSION } from "./session-registry.js";
import { buildRestorePlan } from "./restore-plan.js";

// --- Logging ---
const LOG_DIR = process.env.ALL_MY_AGENTS_LOG_DIR || join(os.homedir(), ".local", "state", "all-my-agents");
mkdirSync(LOG_DIR, { recursive: true });
const logStream = createWriteStream(join(LOG_DIR, "server.log"), { flags: "a" });

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = extra
    ? `${ts} [${level}] ${msg} ${JSON.stringify(extra)}`
    : `${ts} [${level}] ${msg}`;
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
  logStream.write(line + "\n");
}

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
expressWs(app);

app.use(express.json());
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  // Allow cross-origin requests from other All My Agents instances on the tailnet
  // (needed for client-side failover between hosts)
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.use(express.static(join(__dirname, "public")));

// --- Config ---
const PORT = parseInt(process.env.ALL_MY_AGENTS_PORT || "3456", 10);
const TMUX = findTmux();

function findTmux() {
  const candidates = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];
  for (const p of candidates) {
    try {
      accessSync(p);
      return p;
    } catch {
      /* skip */
    }
  }
  return "tmux";
}

async function tmux(...args) {
  const { stdout } = await execFileAsync(TMUX, args, { timeout: 5000 });
  return stdout.trim();
}

// --- Self-Healing ---
// Tracks spawn/PTY errors. If too many in a sliding window, exits the process
// so launchd (with KeepAlive) restarts cleanly.
let spawnErrorWindow = [];

function recordSpawnError(err) {
  const now = Date.now();
  const WINDOW_MS = 120_000;
  const MAX_ERRORS = 5;

  while (spawnErrorWindow.length > 0 && spawnErrorWindow[0] < now - WINDOW_MS) {
    spawnErrorWindow.shift();
  }
  spawnErrorWindow.push(now);

  log("ERROR", "Spawn error recorded", {
    count: spawnErrorWindow.length, max: MAX_ERRORS, windowSec: WINDOW_MS / 1000, error: err.message,
  });

  if (spawnErrorWindow.length >= MAX_ERRORS) {
    log("FATAL", `${MAX_ERRORS} spawn errors in ${WINDOW_MS / 1000}s — exiting for launchd restart`);
    process.exit(1);
  }
}

async function checkPtyHealth() {
  try {
    const p = pty.spawn("/bin/echo", ["health"], { cols: 80, rows: 24, name: "xterm-256color" });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 3000);
      p.onData((data) => {
        clearTimeout(timer);
        try { p.kill(); } catch {}
        resolve(data.trim() === "health");
      });
      p.onExit(() => { clearTimeout(timer); resolve(false); });
    });
  } catch { return false; }
}

// --- Validation ---
// Allows session names, pane IDs (%123), and tmux target syntax (session:window.pane)
const TMUX_TARGET_RE = /^[a-zA-Z0-9_.%:-]+$/;
const PEER_HOST_RE = /^[\w.\-]+:\d{1,5}$/;

function validateTarget(res, target) {
  if (!target || !TMUX_TARGET_RE.test(target)) {
    res.status(400).json({ error: "Invalid session target" });
    return false;
  }
  return true;
}

function validatePeerHost(res, peerHost, config) {
  if (!PEER_HOST_RE.test(peerHost)) {
    res.status(400).json({ error: "Invalid peer host format" });
    return false;
  }
  const allowed = config.peers.some(
    (p) => `${p.host}:${p.port || PORT}` === peerHost
  );
  if (!allowed) {
    const known = config.peers.map((p) => `${p.host}:${p.port || PORT}`);
    log("WARN", "Peer not in mesh config", { requested: peerHost, knownPeers: known });
    res.status(403).json({ error: "Peer not in mesh config" });
    return false;
  }
  return true;
}

// --- API Routes ---

// List all tmux sessions with pane details
app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await discoverSessions();
    res.json(sessions);
  } catch (err) {
    res.json([]);
  }
});

// Create a new tmux session
app.post("/api/sessions", async (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid session name (alphanumeric, -, _ only)" });
  }
  try {
    await tmux("new-session", "-d", "-s", name);
    res.json({ ok: true, name });
  } catch (err) {
    recordSpawnError(err);
    res.status(500).json({ error: err.message });
  }
});

// List all tmux session names (for "add existing" picker)
app.get("/api/tmux-sessions", async (_req, res) => {
  try {
    const output = await tmux("list-sessions", "-F", "#{session_name}");
    const names = output.split("\n").filter((n) => n && !n.startsWith("_ah_")).sort();
    res.json(names);
  } catch {
    res.json([]);
  }
});

// --- Session Registry & Restore ---
// AMA keeps a live registry of every managed agent session (a tmux session
// hosting an opencode TUI) keyed by tmux name. The registry is written on every
// change, so it survives a hard power-off. At startup server.js replays it,
// recreating each tmux session and resuming the opencode conversation directly
// with `opencode -s <id>` — no export/import snapshots involved.
const REGISTRY_PATH = join(LOG_DIR, "active-sessions.json");
const REGISTRY_POLL_MS = parseInt(process.env.ALL_MY_AGENTS_REGISTRY_POLL_MS || "30000", 10);
const RESTORE_DELAY_MS = parseInt(process.env.ALL_MY_AGENTS_RESTORE_DELAY_MS || "10000", 10);
// Not on launchd's PATH, so use the explicit binary (override via OPENCODE_BIN).
const OPENCODE_BIN = process.env.OPENCODE_BIN || join(os.homedir(), ".opencode", "bin", "opencode");

let registryCache = { registry: null };

function loadRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    return parsed && Array.isArray(parsed.sessions) ? parsed : null;
  } catch {
    return null;
  }
}
registryCache.registry = loadRegistry();

function saveRegistry(registry) {
  const tmp = `${REGISTRY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, REGISTRY_PATH);
}

// Best-effort discovery: every tmux pane hosting an opencode process. Never
// throws — an empty set is just "nothing to record right now".
async function discoverManagedSessions() {
  const SEP = "|||";
  let paneOutput = "";
  try {
    paneOutput = await tmux(
      "list-panes", "-a", "-F",
      `#{session_name}${SEP}#{pane_id}${SEP}#{pane_pid}${SEP}#{pane_current_command}${SEP}#{pane_current_path}`,
    );
  } catch {
    return [];
  }
  const out = [];
  for (const line of paneOutput.split("\n").filter(Boolean)) {
    const [name, paneId, panePidRaw, currentCmd, panePath] = line.split(SEP);
    if (!name || name.startsWith("_ah_")) continue;
    const panePid = parseInt(panePidRaw, 10) || null;
    let agent = null;
    try {
      const content = await tmux("capture-pane", "-t", paneId, "-p", "-J").catch(() => "");
      agent = panePid ? await detectAgent(panePid, currentCmd, content) : null;
    } catch { /* ignore */ }
    // Every pane is tracked — not just opencode ones. An unclassified or
    // shell pane stays in the restore set and is recreated as a bare shell at
    // boot; only opencode panes pay for the session-id probe.
    const sessionId = agent === "opencode" && panePid ? await resolvePaneSessionId(panePid) : null;
    out.push({ name, dir: panePath || null, sessionId, agent });
  }
  return out;
}

// The pane's process plus its descendants.
async function paneProcesses(panePid) {
  const seen = new Set();
  const queue = [panePid];
  const pids = [];
  while (queue.length > 0) {
    const ppid = queue.shift();
    if (!ppid || seen.has(ppid)) continue;
    seen.add(ppid);
    pids.push(ppid);
    try {
      const { stdout } = await execFileAsync("pgrep", ["-lP", String(ppid)], { timeout: 2000 });
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (pid) queue.push(pid);
      }
    } catch { /* leaf */ }
  }
  return pids;
}

function parseSessionFlags(args) {
  const m = args.match(/--session[=\s]+(ses_[A-Za-z0-9]+)|(?:^|\s)-s\s+(ses_[A-Za-z0-9]+)/);
  const sessionId = (m && (m[1] || m[2])) || null;
  const p = args.match(/--port[=\s]*(\d+)/);
  return { sessionId, port: p ? parseInt(p[1], 10) : null };
}

// Which opencode session is this pane's TUI on? Prefer an explicit
// -s/--session flag in the process argv; otherwise ask the pane's opencode
// server which session it is serving.
async function resolvePaneSessionId(panePid) {
  const opencodeProcs = [];
  for (const pid of await paneProcesses(panePid)) {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(pid)], { timeout: 1000 });
      const args = stdout.trim();
      if (/\bopencode\b/.test(args) && !/tmux/.test(args)) opencodeProcs.push(args);
    } catch { /* ignore */ }
  }
  let port = null;
  for (const args of opencodeProcs) {
    const flags = parseSessionFlags(args);
    if (flags.sessionId) return flags.sessionId;
    if (flags.port) port = flags.port;
  }
  if (opencodeProcs.length === 0) return null;
  const targetPort = port || 4096;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${targetPort}/session/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const status = await res.json();
    const keys = Object.keys(status || {});
    if (keys.length === 1) return keys[0];
    const busy = keys.filter((k) => status[k]?.type === "busy");
    return busy.length === 1 ? busy[0] : null;
  } catch {
    return null;
  }
}

async function maintainRegistry() {
  const live = await discoverManagedSessions();
  const now = new Date().toISOString();
  const { registry, changed, removed } = reconcileRegistry(live, registryCache.registry, now);
  registryCache.registry = registry;
  if (!changed) return;
  saveRegistry(registry);
  log("INFO", "Active session registry updated", { sessions: registry.sessions.length, removed: removed.length });
  for (const r of removed) log("INFO", "Registry prune", r);
  if (registry.sessions.length > 0) {
    log("INFO", "Registry contents", registry.sessions.map(
      (s) => `${s.tmux} → ${s.agent === "opencode"
        ? (s.sessionId ? `resume ${s.sessionId.slice(0, 24)}` : "no-session-id (will resume -c)")
        : `recreate-shell (${s.agent || "unclassified"})`}`,
    ));
  }
}

// An opencode session id is resolvable if the binary knows the session. This
// is the probe that decides between `-s <id>` and the degraded `-c`.
async function isSessionResolvable(sessionId) {
  try {
    await execFileAsync(OPENCODE_BIN, ["export", sessionId, "--sanitize"], {
      timeout: 60000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function executeRestoreAction(action) {
  const tmuxArgs = ["new-session", "-d", "-s", action.name];
  if (action.dir) tmuxArgs.push("-c", action.dir);
  if (action.kind === "recreate-shell") {
    // No command: the pane gets a plain shell in the recorded directory. The
    // window comes back even when the process state is gone.
    try {
      await execFileAsync(TMUX, tmuxArgs, { timeout: 15000 });
      log("INFO", "Restored shell session", {
        name: action.name,
        mode: "recreate-shell",
        dir: action.dir || null,
      });
    } catch (err) {
      log("ERROR", "Restore failed", { name: action.name, error: err.message });
    }
    return;
  }
  const cmd = action.continueBest
    ? `${OPENCODE_BIN} -c`
    : `${OPENCODE_BIN} -s ${action.sessionId}`;
  // tmux runs the trailing arg as the pane's initial command, so opencode
  // starts directly in the new pane — a self-restoring pane, no keystrokes.
  tmuxArgs.push(cmd);
  try {
    await execFileAsync(TMUX, tmuxArgs, { timeout: 15000 });
    log("INFO", "Restored agent session", {
      name: action.name,
      mode: action.continueBest ? "continue-last" : "resume",
      sessionId: action.sessionId ? action.sessionId.slice(0, 24) : null,
      dir: action.dir || null,
    });
  } catch (err) {
    log("ERROR", "Restore failed", { name: action.name, error: err.message });
  }
}

async function runStartupRestore() {
  const registry = loadRegistry();
  registryCache.registry = registry;
  if (!registry || registry.sessions.length === 0) {
    log("INFO", "Startup restore: no active-session registry — nothing to restore");
    return;
  }
  const ids = [...new Set(registry.sessions.map((s) => s.sessionId).filter(Boolean))];
  const resolvable = new Set();
  for (const id of ids) {
    if (await isSessionResolvable(id)) resolvable.add(id);
  }
  let existingTmux = [];
  try {
    existingTmux = (await tmux("list-sessions", "-F", "#{session_name}")).split("\n").filter(Boolean);
  } catch { /* no tmux */ }
  const actions = buildRestorePlan({ registry, existingTmux, resolvable });
  const unresolved = ids.length - resolvable.size;
  log("INFO", "Startup restore plan", {
    planSize: actions.length,
    resolved: resolvable.size,
    unresolved: unresolved > 0 ? unresolved : undefined,
  });
  for (const action of actions) await executeRestoreAction(action);
  await maintainRegistry();
}

app.get("/api/registry", (_req, res) => {
  res.json(registryCache.registry || { version: REGISTRY_VERSION, updatedAt: null, sessions: [] });
});

// Rename a tmux session
app.post("/api/sessions/:name/rename", async (req, res) => {
  if (!validateTarget(res, req.params.name)) return;
  const { newName } = req.body;
  if (!newName || !TMUX_TARGET_RE.test(newName)) {
    return res.status(400).json({ error: "Invalid new session name" });
  }
  try {
    await tmux("rename-session", "-t", req.params.name, newName);
    res.json({ ok: true, oldName: req.params.name, newName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kill a tmux session
app.delete("/api/sessions/:name", async (req, res) => {
  if (!validateTarget(res, req.params.name)) return;
  try {
    await tmux("kill-session", "-t", req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pane content (for status detection)
app.get("/api/sessions/:target/capture", async (req, res) => {
  if (!validateTarget(res, req.params.target)) return;
  try {
    const content = await tmux("capture-pane", "-t", req.params.target, "-p", "-J");
    const status = detectStatus(content);
    res.json({ content, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enrichment: read Claude session metadata
app.get("/api/claude-sessions", async (_req, res) => {
  try {
    const meta = await readClaudeSessionMeta();
    res.json(meta);
  } catch {
    res.json({});
  }
});

// --- WebSocket Terminal ---
// Uses node-pty (beta) for proper PTY allocation
import pty from "node-pty";

app.ws("/ws/terminal/:target", async (ws, req) => {
  const target = req.params.target;
  log("INFO", "WS connect", { target, remoteAddr: req.ip });

  if (!TMUX_TARGET_RE.test(target)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid session target" }));
    ws.close();
    return;
  }

  // Heartbeat: server pings every 30s, terminates if no pong within 10s
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) {
      log("WARN", "WS pong timeout, terminating", { target });
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 30_000);
  ws.on("pong", () => { alive = true; });

  // Strip TMUX env var so tmux attach works when server runs inside tmux
  const cleanEnv = { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
  delete cleanEnv.TMUX;
  delete cleanEnv.TMUX_PANE;

  // Wait for client to send initial resize before spawning PTY,
  // so tmux attaches at the correct size from the start
  let ptyProcess = null;
  let pendingMessages = [];

  function spawnPty(cols, rows) {
    try {
      ptyProcess = pty.spawn(TMUX, ["attach-session", "-t", target], {
        name: "xterm-256color",
        cols: cols || 80,
        rows: rows || 24,
        cwd: os.homedir(),
        env: cleanEnv,
      });
    } catch (err) {
      log("ERROR", "Terminal spawn error", { target, error: err.message });
      recordSpawnError(err);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
        ws.close();
      }
      return;
    }

    ptyProcess.onData((data) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });

    // Flush any messages that arrived before PTY was ready
    for (const msg of pendingMessages) {
      handleMessage(msg);
    }
    pendingMessages = [];
  }

  function handleMessage(msg) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "input") {
        if (ptyProcess) {
          ptyProcess.write(parsed.data);
        }
      } else if (parsed.type === "resize") {
        if (ptyProcess) {
          ptyProcess.resize(parsed.cols, parsed.rows);
        } else {
          // First resize — spawn PTY at correct size
          spawnPty(parsed.cols, parsed.rows);
        }
      }
    } catch {
      if (ptyProcess) ptyProcess.write(msg.toString());
    }
  }

  ws.on("message", (msg) => {
    if (ptyProcess) {
      handleMessage(msg.toString());
    } else {
      // Buffer until PTY spawns (waiting for initial resize)
      const str = msg.toString();
      try {
        const parsed = JSON.parse(str);
        if (parsed.type === "resize") {
          spawnPty(parsed.cols, parsed.rows);
          return;
        }
      } catch { /* not JSON */ }
      pendingMessages.push(str);
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(heartbeat);
    log("INFO", "WS disconnect", { target, code, reason: reason?.toString() });
    if (ptyProcess) {
      // Detach cleanly instead of killing the tmux session
      try { ptyProcess.write("\x02d"); } catch { /* ignore */ }
      setTimeout(() => {
        try { ptyProcess.kill(); } catch { /* ignore */ }
      }, 500);
    }
  });
});

// --- Agent Detection ---
function detectAgentFromCommand(command) {
  if (!command) return null;
  const normalized = command.trim().toLowerCase();
  if (normalized === "opencode") return "opencode";
  if (normalized === "codex") return "Codex";
  if (normalized === "claude") return "Claude Code";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "aider") return "Aider";
  if (normalized === "copilot") return "Copilot";
  return null;
}

function detectAgentFromArgs(args) {
  if (!args) return null;
  const normalized = args.trim().toLowerCase();
  // opencode must come before claude: `opencode --model claude-...` would
  // otherwise match the claude substring check.
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("claude")) return "Claude Code";
  if (normalized.includes("cursor")) return "Cursor";
  if (normalized.includes("aider")) return "Aider";
  if (normalized.includes("copilot")) return "Copilot";
  return null;
}

function detectAgentFromContent(content) {
  if (!content) return null;
  const normalized = content.toLowerCase();

  // Check opencode before claude: opencode's UI shows the Anthropic provider
  // and model name when using Claude models, which would otherwise win.
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("openai codex")) return "Codex";
  if (normalized.includes("anthropic claude")) return "Claude Code";
  if (normalized.includes("cursor")) return "Cursor";
  if (normalized.includes("aider")) return "Aider";
  if (normalized.includes("copilot")) return "Copilot";

  return null;
}

// Identifies what agent/tool is running in a tmux pane by inspecting
// the pane command, process tree rooted at the pane's shell PID, and
// finally the captured pane content for TUI-only fingerprints.
async function detectAgent(panePid, currentCmd, content = "") {
  const directMatch = detectAgentFromCommand(currentCmd);
  if (directMatch) return directMatch;
  if (!panePid) return detectAgentFromContent(content) || "shell";
  try {
    const pending = [panePid];
    const visited = new Set();

    while (pending.length > 0) {
      const parentPid = pending.shift();
      if (!parentPid || visited.has(parentPid)) continue;
      visited.add(parentPid);

      let children = [];
      try {
        const { stdout } = await execFileAsync("pgrep", ["-lP", parentPid], { timeout: 2000 });
        children = stdout.trim().split("\n").filter(Boolean);
      } catch {
        continue;
      }

      for (const child of children) {
        const parts = child.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [childPid, childName] = parts;
        pending.push(childPid);

        const nameMatch = detectAgentFromCommand(childName);
        if (nameMatch) return nameMatch;

        try {
          const { stdout: args } = await execFileAsync("ps", ["-o", "args=", "-p", childPid], { timeout: 1000 });
          const argsMatch = detectAgentFromArgs(args);
          if (argsMatch) return argsMatch;
        } catch { /* ignore */ }

        // Claude Code sometimes shows its version as the process name (e.g. "2.1.77")
        if (!/^\d+\.\d+\.\d+$/.test(childName)) continue;
        try {
          const { stdout: comm } = await execFileAsync("ps", ["-o", "comm=", "-p", childPid], { timeout: 1000 });
          if (comm.trim() === "claude") return "Claude Code";
        } catch { /* ignore */ }
      }
    }

    return detectAgentFromContent(content) || "shell";
  } catch {
    return detectAgentFromContent(content) || "shell";
  }
}

// --- Session Discovery ---
async function discoverSessions() {
  // Get all tmux sessions and panes
  let paneOutput;
  try {
    const SEP = "|||";
    paneOutput = await tmux(
      "list-panes", "-a", "-F",
      `#{session_name}${SEP}#{session_group}${SEP}#{pane_id}${SEP}#{pane_tty}${SEP}#{pane_current_command}${SEP}#{window_name}${SEP}#{session_activity}${SEP}#{pane_pid}`
    );
  } catch {
    return [];
  }

  const lines = paneOutput.split("\n").filter(Boolean);
  const seen = new Set();
  const entries = [];

  for (const line of lines) {
    const [sessionName, sessionGroup, paneId, paneTty, currentCmd, windowName, sessionActivity, panePid] = line.split("|||");

    if (sessionName.startsWith("_ah_")) continue;

    const groupKey = sessionGroup || sessionName;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);

    entries.push({
      sessionName, paneId, paneTty, currentCmd, windowName, sessionActivity, panePid
    });
  }

  const sessions = await Promise.all(entries.map(async (e) => {
    let status = "unknown";
    let agent = "shell";
    try {
      const content = await tmux("capture-pane", "-t", e.paneId, "-p", "-J").catch(() => "");
      const detectedAgent = await detectAgent(e.panePid, e.currentCmd, content);
      status = content ? detectStatus(content) : "unknown";
      agent = detectedAgent;
    } catch { /* ignore */ }

    return {
      name: e.sessionName,
      paneId: e.paneId,
      tty: e.paneTty,
      currentCommand: e.currentCmd,
      windowName: e.windowName,
      status,
      agent,
      lastActivity: parseInt(e.sessionActivity, 10) || 0,
    };
  }));

  // Enrich with Claude session metadata
  const meta = await readClaudeSessionMeta();
  for (const session of sessions) {
    const enrichment = meta[session.name];
    if (enrichment) {
      session.projectPath = enrichment.projectPath;
      session.summary = enrichment.summary;
    }
  }

  // Sort: needsInput first, then working, then idle/unknown by most recent activity
  const priority = { needsInput: 0, working: 1, idle: 2, unknown: 3 };
  sessions.sort((a, b) => {
    const pa = priority[a.status] ?? 3;
    const pb = priority[b.status] ?? 3;
    if (pa !== pb) return pa - pb;
    // Within same priority, sort by most recent activity first
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  return sessions;
}

function detectStatus(content) {
  // Strip trailing blank lines — capture-pane includes empty pane padding
  const allLines = content.split("\n");
  while (allLines.length > 0 && allLines[allLines.length - 1].trim() === "") {
    allLines.pop();
  }
  const lines = allLines.slice(-25);

  // The Claude Code UI renders a status bar in the last ~4 lines of the pane:
  //   ───────────────────
  //   ❯ (input area)
  //   ───────────────────
  //   ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt  (when working)
  //   ⏵⏵ accept edits on (shift+tab to cycle)                     (when idle — mode indicator only)
  // Only check these bottom lines for status-bar keywords to avoid matching
  // conversation history that happens to contain words like "Generating".
  // Use last 8 lines to account for trailing blank lines, "Checking for updates", etc.
  const statusBarLines = lines.slice(-8);

  // --- Pass 1: Status bar signals (last 5 lines only) ---
  for (const line of statusBarLines) {
    const lower = line.toLowerCase();

    // "esc to interrupt" = agent is actively working on a tool call
    if (lower.includes("esc to interrupt")) return "working";

    // "esc to cancel" = tool approval dialog awaiting input
    if (lower.includes("esc to cancel")) return "needsInput";
  }

  // --- Pass 2: Activity indicators in the content area ---
  // These appear as standalone lines with a leading indicator character,
  // e.g. "· Generating…" or "✻ Computing…" — NOT inside conversation text.
  for (const line of lines) {
    const trimmed = line.trim();

    // Progress indicator with token count (e.g. "✽ 1234 tokens · 5s")
    if (/token/.test(trimmed) && /\d+[ms]/.test(trimmed)) return "working";

    // Activity spinner lines: "✻ Gusting…", "✽ Swirling…", "✢ Befuddling…", "· Generating…"
    // Claude Code uses various Unicode ornament chars as spinners:
    //   ✻ ✽ ✢ ✣ ✤ ✥ · • ○ ◎ ◇ ◈ ☆ ★ ♦ ♢ ✦ ✧ ✩ ✪ ✫ ✬ ✭ ✮ ✯ ✰ ✱ ✲ ✳ ✴ ✵ ✶ ✷ ✸ ✹ ✺ ✼ ❂ ❃ ❇ ❈ ❉ ❊ ❋
    // Pattern: non-ASCII ornament char + space + word + ellipsis.
    // ⏺ is Claude Code's output bullet (NOT a spinner) — excluded via the \u2600-\u2767 range.
    if (/^[\u00B7\u2022\u2600-\u2767\u2720-\u2767\u25CB\u25CE\u25C7\u25C8\u2606\u2605\u2666\u2662]\s+\S+…/.test(trimmed)) return "working";

    // Status bar progress: "Auto · 55.5% · 2 files edited"
    // Only match lines that look like a status bar (start with a keyword, contain middle-dot)
    if (/^(auto|manual)\s+·/i.test(trimmed) && trimmed.includes("%")) return "working";
  }

  // --- Pass 3: Input signals in recent content ---
  for (const line of lines) {
    const lower = line.toLowerCase();

    // Permission prompts
    if (/\(y\/n\)/i.test(lower)) return "needsInput";
    if (lower.includes("allow") && lower.includes("deny")) return "needsInput";
  }

  if (statusBarLines.some((l) => l.includes("ctrl-g to edit"))) return "needsInput";
  if (lines.some((l) => l.includes("Type here to tell"))) return "needsInput";

  // --- Pass 4: Check for command prompt and selection UI (per-line) ---
  // ❯ = Claude Code prompt, › = Codex prompt
  const PROMPT_CHARS = ["❯", "›"];
  let hasCommandPrompt = false;
  let hasSelectionCursor = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const promptChar = PROMPT_CHARS.find((c) => trimmed.startsWith(c));
    if (!promptChar) continue;

    const afterCursor = trimmed.slice(promptChar.length).trim();

    // Selection cursor: prompt char followed by digit + "." on the SAME line (e.g. "❯ 1. Yes")
    if (/^\d+\./.test(afterCursor)) {
      hasSelectionCursor = true;
    } else {
      hasCommandPrompt = true;
    }
  }

  if (hasSelectionCursor) return "needsInput";

  // No prompt at all = still working
  if (!hasCommandPrompt) return "working";

  // Prompt visible with no active signals = idle
  return "idle";
}

async function readClaudeSessionMeta() {
  const meta = {};
  const claudeDir = join(os.homedir(), ".claude", "projects");
  try {
    const projects = await readdir(claudeDir, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      try {
        const indexPath = join(claudeDir, proj.name, "sessions-index.json");
        const raw = await readFile(indexPath, "utf8");
        const index = JSON.parse(raw);
        for (const [sessionId, entry] of Object.entries(index)) {
          if (entry.session_name) {
            meta[entry.session_name] = {
              projectPath: entry.project_path || proj.name,
              summary: entry.summary || "",
              sessionId,
            };
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return meta;
}

// --- Mesh API Routes ---

// Machine identity
app.get("/api/identity", async (_req, res) => {
  const config = await resolveConfig();
  res.json({
    name: config.name,
    peers: config.peers.map((p) => ({ name: p.name, host: p.host, port: p.port || PORT })),
  });
});

// Aggregated sessions from all mesh peers
app.get("/api/mesh/sessions", async (_req, res) => {
  try {
    const config = await resolveConfig();
    const localSessions = await discoverSessions();
    const result = await fetchAllMeshSessions(localSessions, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force-refresh mesh discovery (clears cache, re-probes all peers)
app.post("/api/mesh/refresh", async (_req, res) => {
  try {
    clearDiscoveryCache();
    const config = await resolveConfig();
    const localSessions = await discoverSessions();
    const result = await fetchAllMeshSessions(localSessions, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy: capture pane from a peer
app.get("/api/proxy/:peerHost/sessions/:target/capture", async (req, res) => {
  const config = await resolveConfig();
  if (!validatePeerHost(res, req.params.peerHost, config)) return;

  try {
    const url = `http://${req.params.peerHost}/api/sessions/${encodeURIComponent(req.params.target)}/capture`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const peerRes = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const data = await peerRes.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: "Peer request failed" });
  }
});

// Proxy: create session on a peer
app.post("/api/proxy/:peerHost/sessions", async (req, res) => {
  const config = await resolveConfig();
  if (!validatePeerHost(res, req.params.peerHost, config)) return;

  try {
    const url = `http://${req.params.peerHost}/api/sessions`;
    const peerRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await peerRes.json();
    res.status(peerRes.status).json(data);
  } catch {
    res.status(502).json({ error: "Peer request failed" });
  }
});

// Proxy: delete session on a peer
app.delete("/api/proxy/:peerHost/sessions/:name", async (req, res) => {
  const config = await resolveConfig();
  if (!validatePeerHost(res, req.params.peerHost, config)) return;

  try {
    const url = `http://${req.params.peerHost}/api/sessions/${encodeURIComponent(req.params.name)}`;
    const peerRes = await fetch(url, { method: "DELETE" });
    const data = await peerRes.json();
    res.status(peerRes.status).json(data);
  } catch {
    res.status(502).json({ error: "Peer request failed" });
  }
});

// Proxy: rename session on a peer
app.post("/api/proxy/:peerHost/sessions/:name/rename", async (req, res) => {
  const config = await resolveConfig();
  if (!validatePeerHost(res, req.params.peerHost, config)) return;

  try {
    const url = `http://${req.params.peerHost}/api/sessions/${encodeURIComponent(req.params.name)}/rename`;
    const peerRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await peerRes.json();
    res.status(peerRes.status).json(data);
  } catch {
    res.status(502).json({ error: "Peer request failed" });
  }
});

// WebSocket proxy: terminal on a peer machine
app.ws("/ws/proxy/:peerHost/:target", async (clientWs, req) => {
  const config = await resolveConfig();
  const peerHost = req.params.peerHost;
  const target = req.params.target;
  log("INFO", "WS proxy connect", { peer: peerHost, target, remoteAddr: req.ip });

  if (!PEER_HOST_RE.test(peerHost) || !config.peers.some((p) => `${p.host}:${p.port || PORT}` === peerHost)) {
    clientWs.send(JSON.stringify({ type: "error", message: "Invalid or unauthorized peer" }));
    clientWs.close();
    return;
  }

  // Heartbeat on client-facing side of the proxy
  let proxyAlive = true;
  const proxyHeartbeat = setInterval(() => {
    if (!proxyAlive) {
      log("WARN", "WS proxy pong timeout", { peer: peerHost, target });
      clearInterval(proxyHeartbeat);
      clientWs.terminate();
      return;
    }
    proxyAlive = false;
    clientWs.ping();
  }, 30_000);
  clientWs.on("pong", () => { proxyAlive = true; });

  const remoteUrl = `ws://${peerHost}/ws/terminal/${encodeURIComponent(target)}`;
  let remoteWs;

  try {
    remoteWs = new WebSocket(remoteUrl, { handshakeTimeout: 5000 });
  } catch {
    clientWs.send(JSON.stringify({ type: "error", message: "Failed to connect to peer" }));
    clientWs.close();
    return;
  }

  let remoteOpen = false;
  const buffered = [];
  const MAX_BUFFER = 64;

  remoteWs.on("open", () => {
    remoteOpen = true;
    for (const msg of buffered) {
      remoteWs.send(msg);
    }
    buffered.length = 0;
  });

  remoteWs.on("message", (data) => {
    if (clientWs.readyState === 1) {
      clientWs.send(data.toString());
    }
  });

  remoteWs.on("close", () => {
    if (clientWs.readyState === 1) {
      clientWs.close();
    }
  });

  remoteWs.on("error", (err) => {
    log("ERROR", "Mesh proxy remote error", { peer: peerHost, error: err.message });
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: "error", message: `Remote: ${err.message}` }));
      clientWs.close();
    }
  });

  clientWs.on("message", (msg) => {
    if (remoteOpen && remoteWs.readyState === 1) {
      remoteWs.send(msg.toString());
    } else if (!remoteOpen && buffered.length < MAX_BUFFER) {
      buffered.push(msg.toString());
    }
  });

  clientWs.on("close", (code, reason) => {
    clearInterval(proxyHeartbeat);
    log("INFO", "WS proxy disconnect", { peer: peerHost, target, code, reason: reason?.toString() });
    if (remoteWs.readyState === 1) {
      remoteWs.close();
    }
  });
});

// --- Health & Self-Healing ---

app.get("/api/health", async (_req, res) => {
  const ptyOk = await checkPtyHealth();
  let tmuxOk = false;
  try { await tmux("list-sessions"); tmuxOk = true; } catch {}

  res.json({
    status: ptyOk && tmuxOk ? "ok" : "degraded",
    ptyAllocation: ptyOk,
    tmuxAccess: tmuxOk,
    spawnErrors: spawnErrorWindow.length,
    uptimeMs: process.uptime() * 1000,
    pid: process.pid,
  });
});

app.post("/api/health/restart", (_req, res) => {
  res.json({ ok: true, message: "Restarting..." });
  log("INFO", "Restart requested via /api/health/restart");
  setTimeout(() => process.exit(0), 100);
});

// --- Start ---
function startMaintenance() {
  setTimeout(() => {
    runStartupRestore().catch((err) => log("ERROR", "Startup restore failed", { error: err.message }));
  }, RESTORE_DELAY_MS).unref();
  // No reconcile before restore: the restore must replay the on-disk registry
  // (recreating dead-known sessions) before the first live scan can prune
  // entries that are momentarily absent.
  setInterval(() => maintainRegistry().catch(() => {}), REGISTRY_POLL_MS).unref();
}

export { app };
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, "0.0.0.0", () => {
    log("INFO", `Server started on http://0.0.0.0:${PORT}`);
    log("INFO", `Log file: ${join(LOG_DIR, "server.log")}`);
    startMaintenance();
  });
}
