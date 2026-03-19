import express from "express";
import expressWs from "express-ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { accessSync } from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import { resolveConfig, fetchAllMeshSessions } from "./mesh.js";

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
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

// List hibernated sessions (claude-hibernator — optional)
// Set HIBERNATOR_CLI to the path of claude-hibernator's cli.py to enable.
const HIBERNATOR_CLI = process.env.HIBERNATOR_CLI || null;

app.get("/api/hibernated-sessions", async (_req, res) => {
  if (!HIBERNATOR_CLI) return res.json([]);
  try {
    const { stdout } = await execFileAsync("python3", [
      HIBERNATOR_CLI, "list", "--json",
    ], { timeout: 5000 });
    const sessions = JSON.parse(stdout.trim());
    res.json(sessions);
  } catch {
    res.json([]);
  }
});

// Restore a hibernated session
app.post("/api/hibernated-sessions/:name/restore", async (req, res) => {
  if (!HIBERNATOR_CLI) return res.status(503).json({ error: "claude-hibernator not configured" });
  const name = req.params.name;
  if (!TMUX_TARGET_RE.test(name)) {
    return res.status(400).json({ error: "Invalid session name" });
  }
  try {
    const { stdout } = await execFileAsync("python3", [
      HIBERNATOR_CLI, "restore", "--json", name,
    ], { timeout: 30000 });
    const result = JSON.parse(stdout.trim());
    res.json(result);
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

  if (!TMUX_TARGET_RE.test(target)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid session target" }));
    ws.close();
    return;
  }

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
      console.error("Terminal spawn error:", err.message);
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

  ws.on("close", () => {
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
// Identifies what agent/tool is running in a tmux pane by inspecting
// the process tree rooted at the pane's shell PID.
async function detectAgent(panePid) {
  if (!panePid) return "shell";
  try {
    // Get child processes of the pane's shell
    const { stdout } = await execFileAsync("pgrep", ["-lP", panePid], { timeout: 2000 });
    const children = stdout.trim().split("\n").filter(Boolean);

    for (const child of children) {
      const parts = child.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const [childPid, childName] = parts;

      // Direct match on process name
      if (childName === "claude") return "Claude Code";
      if (childName === "cursor") return "Cursor";
      if (childName === "aider") return "Aider";
      if (childName === "copilot") return "Copilot";

      // Node-based agents: check the args
      if (childName === "node") {
        try {
          const { stdout: args } = await execFileAsync("ps", ["-o", "args=", "-p", childPid], { timeout: 1000 });
          const argsStr = args.trim().toLowerCase();
          if (argsStr.includes("codex")) return "Codex";
          if (argsStr.includes("claude")) return "Claude Code";
          if (argsStr.includes("cursor")) return "Cursor";
          if (argsStr.includes("aider")) return "Aider";
        } catch { /* ignore */ }
      }

      // Claude Code shows its version as the process name (e.g. "2.1.77")
      if (/^\d+\.\d+\.\d+$/.test(childName)) {
        try {
          const { stdout: comm } = await execFileAsync("ps", ["-o", "comm=", "-p", childPid], { timeout: 1000 });
          if (comm.trim() === "claude") return "Claude Code";
        } catch { /* ignore */ }
      }
    }

    return "shell";
  } catch {
    return "shell";
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
  const sessions = [];

  for (const line of lines) {
    const [sessionName, sessionGroup, paneId, paneTty, currentCmd, windowName, sessionActivity, panePid] = line.split("|||");

    // Skip All My Agents helper sessions
    if (sessionName.startsWith("_ah_")) continue;

    // Deduplicate by session group
    const groupKey = sessionGroup || sessionName;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);

    // Detect status and agent in parallel
    let status = "unknown";
    let agent = "shell";
    try {
      const [content, detectedAgent] = await Promise.all([
        tmux("capture-pane", "-t", paneId, "-p", "-J").catch(() => ""),
        detectAgent(panePid),
      ]);
      status = content ? detectStatus(content) : "unknown";
      agent = detectedAgent;
    } catch { /* ignore */ }

    sessions.push({
      name: sessionName,
      paneId,
      tty: paneTty,
      currentCommand: currentCmd,
      windowName,
      status,
      agent,
      lastActivity: parseInt(sessionActivity, 10) || 0,
    });
  }

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
  const lines = content.split("\n").slice(-25);
  const text = lines.join("\n");

  // Strong working signals
  if (text.includes("esc to interrupt")) return "working";
  if (/\d+ tokens/.test(text) && /\d+[ms]/.test(text)) return "working";

  // Needs input signals
  if (text.includes("esc to cancel")) return "needsInput";
  if (/❯\s+\d+\./.test(text)) return "needsInput";      // numbered list selection
  if (/\d+\.\s+Yes/.test(text)) return "needsInput";     // plan confirmation prompts
  if (/\(y\/n\)/.test(text)) return "needsInput";
  if (/Allow/.test(text) && /Deny/.test(text)) return "needsInput";
  if (text.includes("ctrl-g to edit")) return "needsInput"; // plan mode prompt
  if (text.includes("Type here to tell")) return "needsInput";

  // Idle - prompt visible
  const lastLines = lines.slice(-5).join("\n");
  if (/[❯$#%]\s*$/.test(lastLines)) return "idle";

  return "unknown";
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

// WebSocket proxy: terminal on a peer machine
app.ws("/ws/proxy/:peerHost/:target", async (clientWs, req) => {
  const config = await resolveConfig();
  const peerHost = req.params.peerHost;
  const target = req.params.target;

  if (!PEER_HOST_RE.test(peerHost) || !config.peers.some((p) => `${p.host}:${p.port || PORT}` === peerHost)) {
    clientWs.send(JSON.stringify({ type: "error", message: "Invalid or unauthorized peer" }));
    clientWs.close();
    return;
  }

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
    console.error("Mesh proxy remote error:", err.message);
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

  clientWs.on("close", () => {
    if (remoteWs.readyState === 1) {
      remoteWs.close();
    }
  });
});

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`All My Agents Mobile running on http://0.0.0.0:${PORT}`);
  console.log(`Access from phone via Tailscale IP on port ${PORT}`);
});
