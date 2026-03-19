// --- xterm imports via CDN ---
import { Terminal } from "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm";
import { FitAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm";
import { WebLinksAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/+esm";
import { Unicode11Addon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/+esm";

// --- Host Discovery & Failover ---
// On load, probes the current host + all known peers to find which servers
// are online. If the current host goes down, auto-switches to another.
const HOSTS_STORAGE_KEY = "allmyagents-known-hosts";
const ACTIVE_HOST_KEY = "allmyagents-active-host";

// Base URL for all API calls. Empty string = same origin (default).
let apiBase = "";

function apiUrl(path) {
  return apiBase + path;
}

function wsBase() {
  if (!apiBase) return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  const url = new URL(apiBase);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
}

/** Probe a host's /api/identity with a timeout. Returns identity or null. */
async function probeHost(origin, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/api/identity`, { signal: controller.signal });
    if (!res.ok) return null;
    const identity = await res.json();
    return { origin, name: identity.name, peers: identity.peers || [] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Load known hosts from localStorage. Always includes current origin. */
function loadKnownHosts() {
  const saved = localStorage.getItem(HOSTS_STORAGE_KEY);
  const hosts = saved ? JSON.parse(saved) : [];
  const current = `${location.protocol}//${location.host}`;
  if (!hosts.includes(current)) hosts.unshift(current);
  return [...new Set(hosts)];
}

/** Save known hosts to localStorage. */
function saveKnownHosts(hosts) {
  localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify([...new Set(hosts)]));
}

/**
 * Discover the best available host. Probes all known hosts in parallel,
 * picks the first to respond (preferring the last-used host), and
 * updates the known hosts list with any newly discovered peers.
 */
async function discoverActiveHost() {
  const known = loadKnownHosts();
  const lastActive = localStorage.getItem(ACTIVE_HOST_KEY);

  // Probe all known hosts in parallel
  const results = await Promise.allSettled(known.map((h) => probeHost(h)));
  const alive = results
    .map((r, i) => (r.status === "fulfilled" && r.value ? { ...r.value, idx: i } : null))
    .filter(Boolean);

  if (alive.length === 0) {
    // No hosts reachable — stay on current origin
    apiBase = "";
    return;
  }

  // Prefer last-used host if still alive, otherwise first responder
  const preferred = alive.find((h) => h.origin === lastActive) || alive[0];
  const current = `${location.protocol}//${location.host}`;

  if (preferred.origin === current) {
    apiBase = ""; // same origin, use relative URLs
  } else {
    apiBase = preferred.origin;
  }
  localStorage.setItem(ACTIVE_HOST_KEY, preferred.origin);

  // Discover new hosts from peers reported by alive hosts
  const allHosts = [...known];
  for (const host of alive) {
    for (const peer of host.peers) {
      const peerOrigin = `http://${peer.host}:${peer.port || 3456}`;
      if (!allHosts.includes(peerOrigin)) allHosts.push(peerOrigin);
    }
  }
  saveKnownHosts(allHosts);

  return preferred;
}

/** Check if the active host is still reachable. If not, failover. */
async function healthCheck() {
  const testUrl = apiUrl("/api/identity");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(testUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return true;
  } catch { /* unreachable */ }

  // Active host is down — rediscover
  console.log("[AllMyAgents] Active host unreachable, failing over...");
  await discoverActiveHost();
  await loadSessions();
  return false;
}

// --- State ---
const state = {
  sessions: [],
  activeSession: null,
  activeSessionMeta: null, // { machine, machineHost }
  ws: null,
  terminal: null,
  fitAddon: null,
  pollInterval: null,
  // Mesh
  identity: null,
  peerStatus: {},
  machineFilter: "all",
  hasPeers: false,
  // Speedrun
  speedrunActive: false,
  speedrunQueue: [],
  speedrunIndex: 0,
  speedrunTerminal: null,
  speedrunFit: null,
  speedrunWs: null,
  speedrunPollInterval: null,
  speedrunAutoAdvanceTimer: null,
  speedrunSwitchingTimer: null,
  lastInputTime: 0,
  // Resilience
  sessionsLoadInFlight: false,
  sessionsLoadQueued: false,
  sessionsLastSuccessAt: 0,
  sessionLoadFailures: 0,
  terminalPollFailures: 0,
  terminalLastReconnectAt: 0,
  terminalReconnectTimer: null,
  terminalReconnectAttempts: 0,
  renderedSessionsSignature: "",
};

// --- API ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, { timeoutMs = 5000, retries = 0 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt++;
      await sleep(200 * attempt);
    }
  }
}

const api = {
  async getSessions() {
    return fetchJson(apiUrl("/api/sessions"), {}, { timeoutMs: 5000, retries: 1 });
  },
  async createSession(name) {
    return fetchJson(apiUrl("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }, { timeoutMs: 7000 });
  },
  async deleteSession(name, machineHost) {
    const url = machineHost && machineHost !== "local"
      ? apiUrl(`/api/proxy/${encodeURIComponent(machineHost)}/sessions/${encodeURIComponent(name)}`)
      : apiUrl(`/api/sessions/${encodeURIComponent(name)}`);
    return fetchJson(url, { method: "DELETE" }, { timeoutMs: 7000 });
  },
  async capturePane(target, machineHost) {
    const url = machineHost && machineHost !== "local"
      ? apiUrl(`/api/proxy/${encodeURIComponent(machineHost)}/sessions/${encodeURIComponent(target)}/capture`)
      : apiUrl(`/api/sessions/${encodeURIComponent(target)}/capture`);
    return fetchJson(url, {}, { timeoutMs: 3500, retries: 1 });
  },
  async getMeshSessions() {
    return fetchJson(apiUrl("/api/mesh/sessions"), {}, { timeoutMs: 6000, retries: 1 });
  },
  async getIdentity() {
    return fetchJson(apiUrl("/api/identity"), {}, { timeoutMs: 4000, retries: 1 });
  },
};

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const views = {
  sessionList: $("#session-list-view"),
  terminal: $("#terminal-view"),
  speedrun: $("#speedrun-view"),
};

// --- Helpers ---
function isDesktop() {
  return window.matchMedia("(min-width: 768px)").matches;
}

// --- View Navigation ---
function showView(name) {
  if (isDesktop() && (name === "terminal" || name === "sessionList")) {
    // On desktop, both session list and terminal are always visible
    views.sessionList.classList.add("active");
    views.terminal.classList.add("active");
    views.speedrun.classList.remove("active");
    return;
  }
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

// --- Session List ---
async function loadSessions() {
  if (state.sessionsLoadInFlight) {
    state.sessionsLoadQueued = true;
    return;
  }

  state.sessionsLoadInFlight = true;
  try {
    try {
      const result = await api.getMeshSessions();
      state.sessions = result.sessions || [];
      state.peerStatus = result.peerStatus || {};
      state.hasPeers = Object.keys(state.peerStatus).length > 0;
      state.sessionsLastSuccessAt = Date.now();
      state.sessionLoadFailures = 0;
    } catch {
      // Fallback to local-only
      const sessions = await api.getSessions();
      state.sessions = sessions.map((s) => ({ ...s, machine: "local", machineHost: "local" }));
      state.peerStatus = {};
      state.hasPeers = false;
      state.sessionsLastSuccessAt = Date.now();
      state.sessionLoadFailures = 0;
    }
    renderPeerStatus();
    renderSessions();
  } catch {
    state.sessionLoadFailures++;
  } finally {
    state.sessionsLoadInFlight = false;
    if (state.sessionsLoadQueued) {
      state.sessionsLoadQueued = false;
      loadSessions();
    }
  }
}

function renderSessions() {
  const container = $("#sessions-container");

  const filtered = state.machineFilter === "all"
    ? state.sessions
    : state.sessions.filter((s) => s.machine === state.machineFilter);

  const signature = [
    state.machineFilter,
    state.hasPeers ? "peers" : "local",
    state.activeSession || "",
    ...filtered.map((s) => [
      s.name,
      s.machine || "",
      s.machineHost || "",
      s.status || "",
      s.agent || "",
      s.projectPath || "",
      s.paneId || "",
      s.lastActivity || 0,
    ].join("|")),
  ].join("||");

  if (signature === state.renderedSessionsSignature) return;
  state.renderedSessionsSignature = signature;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No tmux sessions found</div>';
    return;
  }

  const showMachineLabel = state.hasPeers;

  container.innerHTML = filtered
    .map(
      (s) => `
    <div class="session-card${state.activeSession === s.name ? " active" : ""}"
         data-name="${esc(s.name)}"
         data-pane="${esc(s.paneId)}"
         data-machine="${esc(s.machine)}"
         data-machine-host="${esc(s.machineHost)}">
      <div class="status-dot ${s.status}" style="${activityDotStyle(s)}"></div>
      <div class="session-info">
        <div class="session-top-row">
          <span class="session-name">${esc(s.name)}</span>
          ${showMachineLabel ? `<span class="machine-badge" style="background:${machineColor(s.machine).bg};color:${machineColor(s.machine).fg}">${esc(s.machine)}</span>` : ""}
          <span class="session-status-label ${s.status}">${statusLabel(s.status)}</span>
        </div>
        <div class="session-bottom-row">
          <span class="session-agent">${esc(s.agent || "shell")}</span>
          ${s.projectPath ? `<span class="session-project">${esc(s.projectPath)}</span>` : ""}
        </div>
      </div>
    </div>
  `
    )
    .join("");

  container.querySelectorAll(".session-card").forEach((card) => {
    card.addEventListener("click", () => {
      openTerminal(card.dataset.name, card.dataset.machineHost);
    });

    // Long-press to delete
    let pressTimer;
    card.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => {
        e.preventDefault();
        confirmDelete(card.dataset.name, card.dataset.machineHost);
      }, 600);
    });
    card.addEventListener("touchend", () => clearTimeout(pressTimer));
    card.addEventListener("touchmove", () => clearTimeout(pressTimer));
  });
}

function renderPeerStatus() {
  const bar = $("#peer-status-bar");
  if (!state.hasPeers) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");
  const entries = Object.entries(state.peerStatus)
    .map(([name, status]) => {
      const ok = status === "ok";
      return `<span class="peer-indicator ${ok ? "ok" : "error"}" title="${esc(status)}">${esc(name)}</span>`;
    })
    .join("");
  bar.innerHTML = entries;

  // Update machine filter dropdown
  const filter = $("#machine-filter");
  const currentVal = filter.value;
  const machines = new Set(state.sessions.map((s) => s.machine));
  filter.innerHTML = '<option value="all">All Machines</option>';
  for (const m of machines) {
    filter.innerHTML += `<option value="${esc(m)}"${m === currentVal ? " selected" : ""}>${esc(m)}</option>`;
  }
  filter.classList.toggle("hidden", machines.size <= 1);
}

function statusLabel(status) {
  const labels = {
    needsInput: "Input",
    working: "Working",
    idle: "Idle",
    unknown: "...",
  };
  return labels[status] || status;
}

// Returns a CSS color for inactive sessions: blue (#6366f1) fading to dark (#1a1a2e)
// over 12 hours based on last activity timestamp.
function activityDotColor(lastActivity) {
  if (!lastActivity) return "#1a1a2e";
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - lastActivity;
  const FADE_DURATION = 4 * 60 * 60; // 4 hours in seconds
  const t = Math.min(ageSec / FADE_DURATION, 1); // 0 = just now, 1 = 12h+ ago

  // Lerp from blue (99,102,241) to dark (26,26,46)
  const r = Math.round(99 + (26 - 99) * t);
  const g = Math.round(102 + (26 - 102) * t);
  const b = Math.round(241 + (46 - 241) * t);
  return `rgb(${r},${g},${b})`;
}

function activityDotStyle(session) {
  // Active statuses keep their existing colors
  if (session.status === "needsInput" || session.status === "working") return "";
  const color = activityDotColor(session.lastActivity);
  return `background:${color}; box-shadow: 0 0 6px ${color};`;
}

// --- Machine Color Palette ---
// 12 visually distinct, dark-theme-friendly colors for machine badges.
const MACHINE_COLORS = [
  { bg: "rgba(99,102,241,0.15)",  fg: "#818cf8" },  // indigo
  { bg: "rgba(52,211,153,0.15)",  fg: "#6ee7b7" },  // emerald
  { bg: "rgba(251,146,60,0.15)",  fg: "#fb923c" },  // orange
  { bg: "rgba(147,51,234,0.15)",  fg: "#a78bfa" },  // purple
  { bg: "rgba(14,165,233,0.15)",  fg: "#38bdf8" },  // sky
  { bg: "rgba(244,63,94,0.15)",   fg: "#fb7185" },  // rose
  { bg: "rgba(234,179,8,0.15)",   fg: "#facc15" },  // yellow
  { bg: "rgba(45,212,191,0.15)",  fg: "#5eead4" },  // teal
  { bg: "rgba(249,115,22,0.15)",  fg: "#f97316" },  // amber
  { bg: "rgba(168,85,247,0.15)",  fg: "#c084fc" },  // violet
  { bg: "rgba(34,211,238,0.15)",  fg: "#22d3ee" },  // cyan
  { bg: "rgba(163,230,53,0.15)",  fg: "#a3e635" },  // lime
];

const machineColorMap = new Map();

function machineColor(machineName) {
  if (!machineName) return MACHINE_COLORS[0];
  if (machineColorMap.has(machineName)) return machineColorMap.get(machineName);
  const idx = machineColorMap.size % MACHINE_COLORS.length;
  const color = MACHINE_COLORS[idx];
  machineColorMap.set(machineName, color);
  return color;
}

function esc(str) {
  if (!str) return "";
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// --- Mobile Input Fix ---
// iOS virtual keyboards fire `beforeinput` with inputType "deleteContentBackward"
// for long-press backspace, but xterm.js doesn't always translate repeated events
// into key-repeat. This patches xterm's internal textarea to forward those events.
function patchMobileInput(term, getWs) {
  // xterm.js creates a textarea inside .xterm-helper-textarea
  const textarea = term.element?.querySelector(".xterm-helper-textarea");
  if (!textarea) return;

  textarea.addEventListener("beforeinput", (e) => {
    const ws = getWs();
    if (!ws || ws.readyState !== 1) return;

    if (e.inputType === "deleteContentBackward") {
      ws.send(JSON.stringify({ type: "input", data: "\x7f" })); // DEL (backspace)
      e.preventDefault();
    } else if (e.inputType === "deleteContentForward") {
      ws.send(JSON.stringify({ type: "input", data: "\x1b[3~" })); // Forward delete
      e.preventDefault();
    }
  });
}

// --- Terminal ---
function openTerminal(sessionName, machineHost = "local") {
  state.activeSession = sessionName;
  state.activeSessionMeta = { machineHost };
  $("#terminal-session-name").textContent = sessionName;

  showView("terminal");

  // Highlight active card on desktop
  document.querySelectorAll(".session-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.name === sessionName);
  });

  // Cleanup previous
  cleanupTerminal();

  // Create terminal
  const termZoom = ZOOM_STEPS[zoomIndex];
  const term = new Terminal({
    fontFamily: '"JetBrains Mono NF", monospace',
    fontSize: Math.round(14 * termZoom),
    theme: {
      background: "#000000",
      foreground: "#e4e4e4",
      cursor: "#e4e4e4",
      selectionBackground: "rgba(99, 102, 241, 0.3)",
    },
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";

  const container = $("#terminal-container");
  container.innerHTML = "";
  container.style.opacity = "0";
  term.open(container);

  // Short delay for DOM to settle before fitting
  requestAnimationFrame(() => {
    fitAddon.fit();
    connectWebSocket(sessionName, term, fitAddon, machineHost, container);
  });

  state.terminal = term;
  state.fitAddon = fitAddon;

  // Patch mobile backspace key repeat
  patchMobileInput(term, () => state.ws);

  // Handle resize
  const resizeHandler = () => {
    fitAddon.fit();
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };
  window.addEventListener("resize", resizeHandler);
  state._resizeHandler = resizeHandler;

  // Poll for status updates
  state.pollInterval = setInterval(async () => {
    try {
      const session = state.sessions.find((s) => s.name === sessionName);
      const target = session?.paneId || sessionName;
      const { status } = await api.capturePane(target, machineHost);
      const dot = $("#terminal-status-dot");
      dot.className = `status-dot ${status}`;
      state.terminalPollFailures = 0;
    } catch {
      state.terminalPollFailures++;
      // If pane/status polling repeatedly fails, reopen the terminal automatically.
      if (state.terminalPollFailures >= 3 && Date.now() - state.terminalLastReconnectAt > 10_000) {
        reconnectTerminal();
      }
    }
  }, 2000);

  // Setup toolbar
  setupToolbar("#terminal-view .terminal-toolbar", term);
}

function scheduleTerminalReconnect(sessionName, machineHost) {
  if (!state.activeSession || state.activeSession !== sessionName) return;
  if ((state.activeSessionMeta?.machineHost || "local") !== machineHost) return;
  if (state.terminalReconnectTimer) return;

  const attempt = Math.min(state.terminalReconnectAttempts, 4);
  const delayMs = 1000 * (2 ** attempt);
  state.terminalReconnectAttempts++;

  state.terminalReconnectTimer = setTimeout(() => {
    state.terminalReconnectTimer = null;
    if (!state.activeSession || state.activeSession !== sessionName) return;
    if ((state.activeSessionMeta?.machineHost || "local") !== machineHost) return;
    reconnectTerminal();
  }, delayMs);
}

function connectWebSocket(sessionName, term, fitAddon, machineHost = "local", visContainer = null) {
  const wsPath = machineHost && machineHost !== "local"
    ? `/ws/proxy/${encodeURIComponent(machineHost)}/${encodeURIComponent(sessionName)}`
    : `/ws/terminal/${encodeURIComponent(sessionName)}`;
  const ws = new WebSocket(`${wsBase()}${wsPath}`);
  let connectFinished = false;

  // Backpressured writer: keep only one xterm write in flight.
  // This avoids event-loop stalls under heavy output bursts.
  let pendingOutput = "";
  let writeInFlight = false;
  let flushScheduled = false;
  let boostBatchUntil = 0;

  const flushOutput = () => {
    flushScheduled = false;
    if (writeInFlight || pendingOutput.length === 0) return;

    const isBoosted = Date.now() < boostBatchUntil;
    const chunkSize = isBoosted ? 96_000 : 48_000;
    const chunk = pendingOutput.slice(0, chunkSize);
    pendingOutput = pendingOutput.slice(chunk.length);

    writeInFlight = true;
    term.write(chunk, () => {
      writeInFlight = false;
      if (pendingOutput.length > 0) scheduleFlush();
    });
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flushOutput);
  };

  const writeBuffered = (data) => {
    pendingOutput += data;
    scheduleFlush();
  };

  // After user sends Enter, widen batch window to catch full redraws
  const onUserInput = (data) => {
    if (data === "\r" || data === "\n") {
      boostBatchUntil = Date.now() + 500;
    }
  };

  // Buffer the initial PTY redraw, write all at once, then reveal.
  let settled = false;
  let initBuf = [];
  let quietTimer = null;

  const flush = () => {
    if (settled) return;
    settled = true;
    const combined = initBuf.join("");
    initBuf = [];
    if (combined.length > 0) {
      term.write(combined, () => {
        term.scrollToBottom();
        if (visContainer) visContainer.style.opacity = "1";
        term.focus();
      });
    } else {
      if (visContainer) visContainer.style.opacity = "1";
      term.focus();
    }
  };

  // Safety: reveal after 2s no matter what
  setTimeout(flush, 2000);

  ws.onopen = () => {
    connectFinished = true;
    state.terminalReconnectAttempts = 0;
    if (state.terminalReconnectTimer) {
      clearTimeout(state.terminalReconnectTimer);
      state.terminalReconnectTimer = null;
    }
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === "output") {
        if (!settled) {
          initBuf.push(msg.data);
          clearTimeout(quietTimer);
          quietTimer = setTimeout(flush, 200);
        } else {
          writeBuffered(msg.data);
        }
      } else if (msg.type === "exit") {
        if (!settled) flush();
        term.write("\r\n[Session ended]\r\n");
      }
    } catch {
      writeBuffered(evt.data);
    }
  };

  ws.onclose = () => {
    state._wsDisconnected = true;
    if (ws._expectedClose) return;
    term.write("\r\n[Disconnected — tap reconnect or switch back to this app]\r\n");
    scheduleTerminalReconnect(sessionName, machineHost);
  };

  ws.onerror = () => {
    state._wsDisconnected = true;
    if (ws._expectedClose) return;
    if (!connectFinished) {
      term.write("\r\n[Connection error]\r\n");
    }
    scheduleTerminalReconnect(sessionName, machineHost);
  };

  // Send terminal input to server
  term.onData((data) => {
    if (ws.readyState === 1) {
      onUserInput(data);
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  state.ws = ws;
  return ws;
}

function cleanupTerminal() {
  if (state.terminalReconnectTimer) {
    clearTimeout(state.terminalReconnectTimer);
    state.terminalReconnectTimer = null;
  }
  state.terminalReconnectAttempts = 0;
  state.terminalPollFailures = 0;
  if (state.ws) {
    state.ws._expectedClose = true;
    state.ws.close();
    state.ws = null;
  }
  if (state.terminal) {
    state.terminal.dispose();
    state.terminal = null;
  }
  if (state.fitAddon) {
    state.fitAddon = null;
  }
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
  if (state._resizeHandler) {
    window.removeEventListener("resize", state._resizeHandler);
    state._resizeHandler = null;
  }
}

function reconnectTerminal() {
  if (!state.activeSession) return;
  const { activeSession, activeSessionMeta } = state;
  const machineHost = activeSessionMeta?.machineHost || "local";
  state.terminalLastReconnectAt = Date.now();
  // Full reopen — disposes old terminal + WebSocket, creates fresh ones
  openTerminal(activeSession, machineHost);
}

function closeTerminal() {
  cleanupTerminal();
  state.activeSession = null;
  state.activeSessionMeta = null;
  document.querySelectorAll(".session-card.active").forEach((c) => c.classList.remove("active"));
  if (isDesktop()) {
    // On desktop, clear the terminal panel but keep sidebar visible
    $("#terminal-container").innerHTML = '<div class="empty-state">Select a session</div>';
  } else {
    showView("sessionList");
  }
  loadSessions();
}

// --- Speedrun Mode ---
function startSpeedrun() {
  // Build queue: needsInput first, then all others with panes
  const waiting = state.sessions.filter((s) => s.status === "needsInput");
  const rest = state.sessions.filter((s) => s.status !== "needsInput" && s.paneId);

  const queue = waiting.length > 0 ? waiting : state.sessions.filter((s) => s.paneId);
  if (queue.length === 0) {
    alert("No sessions available for speedrun");
    return;
  }

  state.speedrunActive = true;
  state.speedrunQueue = queue;
  state.speedrunIndex = 0;

  showView("speedrun");
  openSpeedrunSession(0);
}

function openSpeedrunSession(index) {
  cleanupSpeedrunTerminal();

  const session = state.speedrunQueue[index];
  if (!session) return;

  state.speedrunIndex = index;

  $("#speedrun-session-name").textContent = session.name;
  $("#speedrun-position").textContent = `${index + 1} of ${state.speedrunQueue.length}`;

  // Create terminal
  const srZoom = ZOOM_STEPS[zoomIndex];
  const term = new Terminal({
    fontFamily: '"JetBrains Mono NF", monospace',
    fontSize: Math.round(14 * srZoom),
    theme: {
      background: "#000000",
      foreground: "#e4e4e4",
      cursor: "#e4e4e4",
      selectionBackground: "rgba(99, 102, 241, 0.3)",
    },
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";

  const container = $("#speedrun-terminal-container");
  container.innerHTML = "";
  container.style.opacity = "0";
  term.open(container);

  requestAnimationFrame(() => {
    fitAddon.fit();

    const target = session.name;
    const machineHost = session.machineHost || "local";
    const wsPath = machineHost && machineHost !== "local"
      ? `/ws/proxy/${encodeURIComponent(machineHost)}/${encodeURIComponent(target)}`
      : `/ws/terminal/${encodeURIComponent(target)}`;
    const ws = new WebSocket(`${wsBase()}${wsPath}`);

    // Batched writer for smooth ongoing output
    let srFrameBuf = [];
    let srFlushTimer = null;
    const srWriteBuffered = (data) => {
      srFrameBuf.push(data);
      clearTimeout(srFlushTimer);
      srFlushTimer = setTimeout(() => {
        srFlushTimer = null;
        const combined = srFrameBuf.join("");
        srFrameBuf = [];
        term.write(combined);
      }, 50);
    };

    let settled = false;
    let srInitBuf = [];
    let srQuietTimer = null;

    const srFlush = () => {
      if (settled) return;
      settled = true;
      const combined = srInitBuf.join("");
      srInitBuf = [];
      if (combined.length > 0) {
        term.write(combined, () => {
          term.scrollToBottom();
          container.style.opacity = "1";
          term.focus();
        });
      } else {
        container.style.opacity = "1";
        term.focus();
      }
    };
    setTimeout(srFlush, 2000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "output") {
          if (!settled) {
            srInitBuf.push(msg.data);
            clearTimeout(srQuietTimer);
            srQuietTimer = setTimeout(srFlush, 200);
          } else {
            srWriteBuffered(msg.data);
          }
        }
      } catch {
        term.write(evt.data);
      }
    };

    term.onData((data) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "input", data }));
        // Track when user sends input (for auto-advance detection)
        if (data === "\r" || data === "\n") {
          state.lastInputTime = Date.now();
        }
      }
    });

    state.speedrunWs = ws;
  });

  state.speedrunTerminal = term;
  state.speedrunFit = fitAddon;

  // Patch mobile backspace key repeat
  patchMobileInput(term, () => state.speedrunWs);

  // Setup toolbar
  setupToolbar("#speedrun-view .terminal-toolbar", term);

  // Resize handler
  const resizeHandler = () => {
    fitAddon.fit();
    if (state.speedrunWs?.readyState === 1) {
      state.speedrunWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };
  window.addEventListener("resize", resizeHandler);
  state._speedrunResizeHandler = resizeHandler;

  // Auto-advance polling
  startSpeedrunPolling(session);
}

function startSpeedrunPolling(session) {
  if (state.speedrunPollInterval) clearInterval(state.speedrunPollInterval);

  state.speedrunPollInterval = setInterval(async () => {
    try {
      const target = session.paneId || session.name;
      const { status } = await api.capturePane(target, session.machineHost);

      // Auto-advance: if agent started working after user sent input
      if (status === "working" && Date.now() - state.lastInputTime < 5000) {
        showSwitchingOverlay();
      }
    } catch { /* ignore */ }
  }, 1500);
}

function showSwitchingOverlay() {
  if (state.speedrunSwitchingTimer) return; // Already switching

  const overlay = $("#speedrun-switching-overlay");
  const countdownEl = $("#switching-countdown");
  const nextIndex = (state.speedrunIndex + 1) % state.speedrunQueue.length;
  const nextSession = state.speedrunQueue[nextIndex];

  $("#switching-text").textContent = `Switching to ${nextSession?.name || "next"}...`;
  overlay.classList.remove("hidden");

  let count = 3;
  countdownEl.textContent = count;

  state.speedrunSwitchingTimer = setInterval(() => {
    count--;
    countdownEl.textContent = count;
    if (count <= 0) {
      clearInterval(state.speedrunSwitchingTimer);
      state.speedrunSwitchingTimer = null;
      overlay.classList.add("hidden");
      speedrunNext();
    }
  }, 1000);

  // Tap to skip countdown
  const skipHandler = () => {
    clearInterval(state.speedrunSwitchingTimer);
    state.speedrunSwitchingTimer = null;
    overlay.classList.add("hidden");
    overlay.removeEventListener("click", skipHandler);
    speedrunNext();
  };
  overlay.addEventListener("click", skipHandler);
}

function speedrunNext() {
  const next = (state.speedrunIndex + 1) % state.speedrunQueue.length;
  openSpeedrunSession(next);
}

function speedrunPrev() {
  const prev = (state.speedrunIndex - 1 + state.speedrunQueue.length) % state.speedrunQueue.length;
  openSpeedrunSession(prev);
}

function stopSpeedrun() {
  cleanupSpeedrunTerminal();
  state.speedrunActive = false;
  showView("sessionList");
  loadSessions();
}

function cleanupSpeedrunTerminal() {
  if (state.speedrunWs) {
    state.speedrunWs.close();
    state.speedrunWs = null;
  }
  if (state.speedrunTerminal) {
    state.speedrunTerminal.dispose();
    state.speedrunTerminal = null;
  }
  state.speedrunFit = null;
  if (state.speedrunPollInterval) {
    clearInterval(state.speedrunPollInterval);
    state.speedrunPollInterval = null;
  }
  if (state.speedrunSwitchingTimer) {
    clearInterval(state.speedrunSwitchingTimer);
    state.speedrunSwitchingTimer = null;
  }
  if (state._speedrunResizeHandler) {
    window.removeEventListener("resize", state._speedrunResizeHandler);
    state._speedrunResizeHandler = null;
  }
}

// --- Toolbar ---
function setToolbarMode(toolbar, mode) {
  toolbar.dataset.mode = mode;
}

function setupToolbar(selector, term) {
  const toolbar = document.querySelector(selector);

  toolbar.querySelectorAll(".toolbar-btn").forEach((btn) => {
    // Remove old listeners by cloning
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const key = newBtn.dataset.key;
      const send = newBtn.dataset.send;
      const action = newBtn.dataset.action;
      const ws = state.speedrunActive ? state.speedrunWs : state.ws;

      if (action === "paste") {
        navigator.clipboard.readText().then((text) => {
          if (text && ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "input", data: text }));
          }
        }).catch(() => {
          // Fallback: prompt user to paste
          const text = prompt("Paste text:");
          if (text && ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "input", data: text }));
          }
        });
      } else if (action === "enter-scroll") {
        // Send Ctrl-B [ to enter tmux copy mode, then switch toolbar
        if (ws?.readyState === 1) {
          ws.send(JSON.stringify({ type: "input", data: "\x02[" }));
        }
        setToolbarMode(toolbar, "scroll");
      } else if (action === "exit-scroll") {
        // Send Esc to exit tmux copy mode, then switch toolbar back
        if (ws?.readyState === 1) {
          ws.send(JSON.stringify({ type: "input", data: "\x1b" }));
        }
        setToolbarMode(toolbar, "normal");
      } else if (send) {
        // Parse \xNN escape sequences from HTML data attributes into real control chars
        const data = send.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
        if (ws?.readyState === 1) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      } else if (key) {
        const keyMap = {
          Escape: "\x1b",
          Tab: "\t",
          ArrowUp: "\x1b[A",
          ArrowDown: "\x1b[B",
          ArrowLeft: "\x1b[D",
          ArrowRight: "\x1b[C",
          PageUp: "\x1b[5~",
          PageDown: "\x1b[6~",
        };
        const data = keyMap[key] || key;
        if (ws?.readyState === 1) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      }

      term.focus();
    });
  });
}

// --- Swipe to go back ---
function setupSwipeBack(viewEl, goBackFn) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  viewEl.addEventListener("touchstart", (e) => {
    const touch = e.touches[0];
    // Only trigger from left edge (within 30px)
    if (touch.clientX < 30) {
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  viewEl.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    // Swipe right at least 80px, mostly horizontal
    if (dx > 80 && dy < dx * 0.5) {
      goBackFn();
    }
  }, { passive: true });

  viewEl.addEventListener("touchmove", () => {}, { passive: true });
}

setupSwipeBack(views.terminal, closeTerminal);
setupSwipeBack(views.speedrun, stopSpeedrun);

// --- Add Session Modal ---
let addSessionMode = "pick"; // pick | new | existing | hibernated

function showNewSessionModal() {
  const modal = $("#new-session-modal");
  modal.classList.remove("hidden");
  setAddSessionMode("pick");
}

function hideNewSessionModal() {
  $("#new-session-modal").classList.add("hidden");
}

function setAddSessionMode(mode) {
  addSessionMode = mode;

  // Toggle panels
  $("#modal-pick").classList.toggle("hidden", mode !== "pick");
  $("#modal-new").classList.toggle("hidden", mode !== "new");
  $("#modal-existing").classList.toggle("hidden", mode !== "existing");
  $("#modal-hibernated").classList.toggle("hidden", mode !== "hibernated");

  // Back button
  $("#modal-back").classList.toggle("hidden", mode === "pick");

  // Title
  const titles = { pick: "Add Session", new: "New Session", existing: "Existing Sessions", hibernated: "Hibernated" };
  $("#modal-title").textContent = titles[mode] || "Add Session";

  // Load data when switching to list modes
  if (mode === "existing") loadExistingSessions();
  if (mode === "hibernated") loadHibernatedSessions();
  if (mode === "new") {
    const input = $("#new-session-name");
    input.value = "";
    setTimeout(() => input.focus(), 100);
  }
}

// Pick mode buttons
document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setAddSessionMode(btn.dataset.mode));
});

$("#modal-back").addEventListener("click", () => setAddSessionMode("pick"));

async function createSession() {
  const name = $("#new-session-name").value.trim();
  if (!name) return;

  const result = await api.createSession(name);
  if (result.error) {
    alert(result.error);
    return;
  }

  hideNewSessionModal();
  await loadSessions();
  // Auto-open the new session
  openTerminal(name);
}

async function loadExistingSessions() {
  const container = $("#existing-sessions-list");
  container.innerHTML = '<div class="empty-state" style="height:100px">Loading...</div>';

  try {
    const res = await fetch(apiUrl("/api/tmux-sessions"));
    const names = await res.json();

    if (names.length === 0) {
      container.innerHTML = '<div class="empty-state" style="height:100px">No tmux sessions found</div>';
      return;
    }

    // Sessions already visible in the sidebar
    const visibleNames = new Set(state.sessions.map((s) => s.name));

    container.innerHTML = names.map((name) => {
      const isVisible = visibleNames.has(name);
      return `<div class="modal-list-item" data-session-name="${esc(name)}">
        <span class="item-name">${esc(name)}</span>
        ${isVisible ? '<span class="item-meta">visible</span>' : ""}
      </div>`;
    }).join("");

    container.querySelectorAll(".modal-list-item").forEach((item) => {
      item.addEventListener("click", () => {
        const name = item.dataset.sessionName;
        hideNewSessionModal();
        openTerminal(name);
      });
    });
  } catch {
    container.innerHTML = '<div class="empty-state" style="height:100px">Failed to load</div>';
  }
}

async function loadHibernatedSessions() {
  const container = $("#hibernated-sessions-list");
  container.innerHTML = '<div class="empty-state" style="height:100px">Loading...</div>';

  try {
    const res = await fetch(apiUrl("/api/hibernated-sessions"));
    const sessions = await res.json();

    if (sessions.length === 0) {
      container.innerHTML = '<div class="empty-state" style="height:100px">No hibernated sessions</div>';
      return;
    }

    container.innerHTML = sessions.map((s) => {
      const dir = s.working_directory ? s.working_directory.split("/").pop() : "";
      const date = (s.hibernated_at || "").substring(0, 16).replace("T", " ");
      return `<div class="modal-list-item" data-session-name="${esc(s.session_name)}">
        <span class="item-name">${esc(s.session_name)}</span>
        <span class="item-meta">${esc(dir || date)}</span>
      </div>`;
    }).join("");

    container.querySelectorAll(".modal-list-item").forEach((item) => {
      item.addEventListener("click", async () => {
        const name = item.dataset.sessionName;
        item.querySelector(".item-meta").textContent = "Restoring...";

        try {
          const res = await fetch(apiUrl(`/api/hibernated-sessions/${encodeURIComponent(name)}/restore`), { method: "POST" });
          const result = await res.json();
          if (result.success) {
            hideNewSessionModal();
            await loadSessions();
            openTerminal(name);
          } else {
            item.querySelector(".item-meta").textContent = result.error || "Failed";
          }
        } catch {
          item.querySelector(".item-meta").textContent = "Error";
        }
      });
    });
  } catch {
    container.innerHTML = '<div class="empty-state" style="height:100px">Failed to load</div>';
  }
}

function confirmDelete(sessionName, machineHost = "local") {
  state._deleteTarget = sessionName;
  state._deleteTargetHost = machineHost;
  $("#delete-session-text").textContent = `Kill session "${sessionName}"?`;
  $("#delete-modal").classList.remove("hidden");
}

function hideDeleteModal() {
  $("#delete-modal").classList.add("hidden");
  state._deleteTarget = null;
  state._deleteTargetHost = null;
}

async function doDelete() {
  if (!state._deleteTarget) return;
  await api.deleteSession(state._deleteTarget, state._deleteTargetHost);
  hideDeleteModal();
  await loadSessions();
}

// --- Event Bindings ---
$("#back-btn").addEventListener("click", closeTerminal);
$("#refresh-btn").addEventListener("click", loadSessions);
$("#add-session-btn").addEventListener("click", showNewSessionModal);
$("#speedrun-btn").addEventListener("click", startSpeedrun);
$("#speedrun-exit-btn").addEventListener("click", stopSpeedrun);
$("#speedrun-next").addEventListener("click", speedrunNext);
$("#speedrun-prev").addEventListener("click", speedrunPrev);
$("#modal-cancel").addEventListener("click", hideNewSessionModal);
$("#modal-create").addEventListener("click", createSession);
$("#delete-cancel").addEventListener("click", hideDeleteModal);
$("#delete-confirm").addEventListener("click", doDelete);
$("#terminal-reconnect-btn").addEventListener("click", reconnectTerminal);
$("#terminal-kill-btn").addEventListener("click", () => {
  if (state.activeSession) {
    confirmDelete(state.activeSession, state.activeSessionMeta?.machineHost);
  }
});

// Machine filter
$("#machine-filter").addEventListener("change", (e) => {
  state.machineFilter = e.target.value;
  renderSessions();
});

// Enter to create in modal
$("#new-session-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createSession();
  if (e.key === "Escape") hideNewSessionModal();
});

// Backdrop closes modals
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", () => {
    hideNewSessionModal();
    hideDeleteModal();
  });
});

// --- Auto-refresh session list ---
let listPollInterval;
function startListPolling() {
  stopListPolling();
  listPollInterval = setInterval(() => {
    if (views.sessionList.classList.contains("active")) {
      // On desktop, avoid constant list re-renders while a terminal is actively streaming.
      if (isDesktop() && state.activeSession && state.ws?.readyState === 1) return;
      loadSessions();
    }
  }, 3000);
}

function stopListPolling() {
  if (listPollInterval) clearInterval(listPollInterval);
}

// --- Zoom ---
const ZOOM_STEPS = [0.75, 0.85, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
const ZOOM_STORAGE_KEY = "allmyagents-zoom";

function getZoomIndex() {
  const saved = localStorage.getItem(ZOOM_STORAGE_KEY);
  if (saved !== null) {
    const idx = ZOOM_STEPS.indexOf(parseFloat(saved));
    if (idx !== -1) return idx;
  }
  return ZOOM_STEPS.indexOf(1);
}

let zoomIndex = getZoomIndex();

function applyZoom() {
  const zoom = ZOOM_STEPS[zoomIndex];
  document.documentElement.style.setProperty("--zoom", zoom);
  $("#zoom-level").textContent = `${Math.round(zoom * 100)}%`;
  localStorage.setItem(ZOOM_STORAGE_KEY, zoom);

  // Also scale terminal font size
  const termFontSize = Math.round(14 * zoom);
  if (state.terminal) {
    state.terminal.options.fontSize = termFontSize;
    state.fitAddon?.fit();
  }
  if (state.speedrunTerminal) {
    state.speedrunTerminal.options.fontSize = termFontSize;
    state.speedrunFit?.fit();
  }
}

function zoomUp() {
  if (zoomIndex < ZOOM_STEPS.length - 1) {
    zoomIndex++;
    applyZoom();
  }
}

function zoomDown() {
  if (zoomIndex > 0) {
    zoomIndex--;
    applyZoom();
  }
}

function zoomReset() {
  zoomIndex = ZOOM_STEPS.indexOf(1);
  applyZoom();
}

function toggleZoomPopup() {
  $("#zoom-popup").classList.toggle("hidden");
}

// Close zoom popup when tapping elsewhere
document.addEventListener("click", (e) => {
  const popup = $("#zoom-popup");
  const btn = $("#zoom-btn");
  if (!popup.classList.contains("hidden") && !popup.contains(e.target) && !btn.contains(e.target)) {
    popup.classList.add("hidden");
  }
});

$("#zoom-btn").addEventListener("click", toggleZoomPopup);
$("#zoom-up").addEventListener("click", zoomUp);
$("#zoom-down").addEventListener("click", zoomDown);
$("#zoom-reset").addEventListener("click", zoomReset);

// --- Init ---
async function init() {
  // Pre-load terminal font before any terminal opens
  try {
    await document.fonts.load('14px "JetBrains Mono NF"');
  } catch { /* font API may not be available */ }

  // Apply saved zoom level
  applyZoom();

  // Discover best available host (failover if current is down)
  await discoverActiveHost();

  try {
    state.identity = await api.getIdentity();
  } catch { /* standalone mode */ }
  await loadSessions();

  // On desktop, show placeholder in terminal panel
  if (isDesktop()) {
    showView("sessionList");
    $("#terminal-container").innerHTML = '<div class="empty-state">Select a session</div>';
  }
}

init();
startListPolling();

// Periodic health check — failover if active host goes down
setInterval(healthCheck, 30_000);

// Recovery watchdog: refresh stalled list view + reconnect dead terminals.
setInterval(() => {
  if (document.visibilityState !== "visible") return;

  if (views.sessionList.classList.contains("active")) {
    // Same skip rule as polling: keep sidebar recovery quiet while live terminal is active.
    if (!(isDesktop() && state.activeSession && state.ws?.readyState === 1)) {
      const staleMs = Date.now() - (state.sessionsLastSuccessAt || 0);
      if (staleMs > 12_000 || state.sessionLoadFailures >= 3) {
        loadSessions();
      }
    }
  }

  if (state.activeSession && state.ws && state.ws.readyState !== 1) {
    if (Date.now() - state.terminalLastReconnectAt > 4_000) {
      reconnectTerminal();
    }
  }
}, 5000);

// Handle visibility change (phone lock/unlock, app switching)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (views.sessionList.classList.contains("active")) {
      loadSessions();
    }
    // Auto-reconnect terminal if WebSocket dropped while app was backgrounded
    if (state.activeSession && state.ws?.readyState !== 1) {
      reconnectTerminal();
    }
    // Auto-reconnect speedrun terminal
    if (state.speedrunActive && state.speedrunWs?.readyState !== 1) {
      const session = state.speedrunQueue[state.speedrunIndex];
      if (session) {
        openSpeedrunSession(state.speedrunIndex);
      }
    }
  }
});
