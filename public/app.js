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

// --- Session Groups (localStorage-backed) ---
const GROUPS_STORAGE_KEY = "allmyagents-session-groups";

function loadGroups() {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { groups: {}, collapsed: {}, order: [] };
}

function saveGroups(data) {
  localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(data));
}

function getGroups() {
  return loadGroups();
}

function createGroup(name) {
  const data = loadGroups();
  if (!data.groups[name]) {
    data.groups[name] = [];
    data.order = [...data.order.filter((n) => n !== name), name];
  }
  saveGroups(data);
}

function deleteGroup(name) {
  const data = loadGroups();
  delete data.groups[name];
  delete data.collapsed[name];
  data.order = data.order.filter((n) => n !== name);
  saveGroups(data);
}

function renameGroup(oldName, newName) {
  if (oldName === newName) return;
  const data = loadGroups();
  data.groups[newName] = data.groups[oldName] || [];
  data.collapsed[newName] = data.collapsed[oldName] || false;
  delete data.groups[oldName];
  delete data.collapsed[oldName];
  data.order = data.order.map((n) => (n === oldName ? newName : n));
  saveGroups(data);
}

function addToGroup(groupName, sKey) {
  const data = loadGroups();
  // Remove from any existing group first
  for (const [gn, members] of Object.entries(data.groups)) {
    data.groups[gn] = members.filter((k) => k !== sKey);
  }
  if (!data.groups[groupName]) {
    data.groups[groupName] = [];
    data.order = [...data.order.filter((n) => n !== groupName), groupName];
  }
  data.groups[groupName] = [...data.groups[groupName], sKey];
  saveGroups(data);
}

function removeFromGroup(sKey) {
  const data = loadGroups();
  for (const [gn, members] of Object.entries(data.groups)) {
    data.groups[gn] = members.filter((k) => k !== sKey);
  }
  saveGroups(data);
}

function toggleGroupCollapsed(groupName) {
  const data = loadGroups();
  data.collapsed[groupName] = !data.collapsed[groupName];
  saveGroups(data);
}

function getSessionGroup(sKey) {
  const data = loadGroups();
  for (const [gn, members] of Object.entries(data.groups)) {
    if (members.includes(sKey)) return gn;
  }
  return null;
}

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
      // Mesh fetch failed — refresh local sessions but keep cached remote sessions
      try {
        const localSessions = await api.getSessions();
        const localTagged = localSessions.map((s) => ({ ...s, machine: "local", machineHost: "local" }));
        if (state.sessionsLastSuccessAt && state.hasPeers) {
          // Preserve remote sessions from the last successful mesh load
          const remoteSessions = state.sessions.filter((s) => s.machineHost !== "local");
          state.sessions = [...localTagged, ...remoteSessions];
        } else {
          state.sessions = localTagged;
          state.peerStatus = {};
          state.hasPeers = false;
        }
      } catch {
        // Even local fetch failed — keep existing state entirely
      }
    }
    renderPeerStatus();
    renderSessions();
    if (state.activeSession) updatePositionIndicator();
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

function renderSessionCard(s, showMachineLabel) {
  return `
    <div class="session-card${isActiveSession(s.name, s.machineHost) ? " active" : ""}"
         data-name="${esc(s.name)}"
         data-pane="${esc(s.paneId)}"
         data-machine="${esc(s.machine)}"
         data-machine-host="${esc(s.machineHost)}"
         data-session-key="${esc(sessionKey(s.name, s.machineHost))}">
      <div class="status-dot ${s.status}" style="${activityDotStyle(s)}"></div>
      <div class="session-info">
        <div class="session-top-row">
          <span class="session-name">${esc(s.name)}</span>
          ${showMachineLabel ? `<span class="machine-badge" style="background:${machineColor(s.machine).bg};color:${machineColor(s.machine).fg}">${esc(s.machine)}</span>` : ""}
          <span class="session-status-label ${s.status}">${statusLabel(s.status)}</span>
        </div>
        <div class="session-bottom-row">
          <span class="session-agent">${esc(s.agent || "shell")}</span>
          ${isInterestingCommand(s.currentCommand, s.agent) ? `<span class="session-command">${esc(s.currentCommand)}</span>` : ""}
          ${s.projectPath ? `<span class="session-project">${esc(s.projectPath)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

function renderSessions() {
  const container = $("#sessions-container");

  const filtered = state.machineFilter === "all"
    ? state.sessions
    : state.sessions.filter((s) => s.machine === state.machineFilter);

  const groupData = getGroups();
  const signature = [
    state.machineFilter,
    state.hasPeers ? "peers" : "local",
    state.activeSession || "",
    JSON.stringify(groupData),
    ...filtered.map((s) => [
      s.name,
      s.machine || "",
      s.machineHost || "",
      s.status || "",
      s.agent || "",
      s.projectPath || "",
      s.currentCommand || "",
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

  // Partition sessions into groups and ungrouped
  const sessionsByKey = new Map(filtered.map((s) => [sessionKey(s.name, s.machineHost), s]));
  // Also index by name for fuzzy matching when machineHost changes
  const sessionsByName = new Map();
  for (const s of filtered) {
    if (!sessionsByName.has(s.name)) sessionsByName.set(s.name, s);
  }
  const groupedKeys = new Set();
  const html = [];

  // Render groups in order
  for (const groupName of groupData.order) {
    const storedKeys = groupData.groups[groupName] || [];
    // Resolve stored keys: try exact match first, then fall back to name match
    const resolvedSessions = [];
    for (const k of storedKeys) {
      if (sessionsByKey.has(k)) {
        resolvedSessions.push({ key: k, session: sessionsByKey.get(k) });
      } else {
        // Try matching by name (part after "::")
        const name = k.includes("::") ? k.split("::").slice(1).join("::") : k;
        const s = sessionsByName.get(name);
        if (s) {
          resolvedSessions.push({ key: sessionKey(s.name, s.machineHost), session: s });
        }
      }
    }
    if (resolvedSessions.length === 0) continue;
    // Self-heal: update stored keys if they changed (e.g. machineHost changed)
    const resolvedKeys = resolvedSessions.map(({ key }) => key);
    if (JSON.stringify(resolvedKeys) !== JSON.stringify(storedKeys)) {
      groupData.groups[groupName] = resolvedKeys;
      saveGroups(groupData);
    }
    resolvedSessions.forEach(({ key }) => groupedKeys.add(key));

    const isCollapsed = groupData.collapsed[groupName] || false;
    html.push(`
      <div class="session-group" data-group="${esc(groupName)}">
        <div class="session-group-header" data-group="${esc(groupName)}">
          <span class="group-chevron${isCollapsed ? " collapsed" : ""}">&#9662;</span>
          <span class="group-name">${esc(groupName)}</span>
          <span class="group-count">${resolvedSessions.length}</span>
        </div>
        ${isCollapsed ? "" : `<div class="session-group-body">
          ${resolvedSessions.map(({ session }) => renderSessionCard(session, showMachineLabel)).join("")}
        </div>`}
      </div>`);
  }

  // Render ungrouped sessions
  const ungrouped = filtered.filter((s) => !groupedKeys.has(sessionKey(s.name, s.machineHost)));
  html.push(...ungrouped.map((s) => renderSessionCard(s, showMachineLabel)));

  container.innerHTML = html.join("");

  // Bind group header toggle
  container.querySelectorAll(".session-group-header").forEach((header) => {
    header.addEventListener("click", () => {
      toggleGroupCollapsed(header.dataset.group);
      state.renderedSessionsSignature = ""; // force re-render
      renderSessions();
    });
    // Right-click / long-press on group header for group actions
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showGroupContextMenu(e, header.dataset.group);
    });
    let pressTimer;
    header.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => {
        e.preventDefault();
        showGroupContextMenu(e, header.dataset.group);
      }, 600);
    });
    header.addEventListener("touchend", () => clearTimeout(pressTimer));
    header.addEventListener("touchmove", () => clearTimeout(pressTimer));
  });

  // Bind session card events
  container.querySelectorAll(".session-card").forEach((card) => {
    card.addEventListener("click", () => {
      openTerminal(card.dataset.name, card.dataset.machineHost);
    });

    // Right-click context menu
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showSessionContextMenu(e, card.dataset.name, card.dataset.machineHost);
    });

    // Long-press context menu (replaces old long-press-to-delete)
    let pressTimer;
    card.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => {
        e.preventDefault();
        showSessionContextMenu(e, card.dataset.name, card.dataset.machineHost);
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

const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "dash", "tcsh", "csh", "login"]);

function isInterestingCommand(cmd, agent) {
  if (!cmd) return false;
  const base = cmd.split("/").pop().toLowerCase();
  if (SHELL_COMMANDS.has(base)) return false;
  // Skip version strings (e.g. "2.1.81")
  if (/^\d[\d.]*$/.test(base)) return false;
  // Skip if it just duplicates the agent label
  if (agent && base === agent.toLowerCase()) return false;
  return true;
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
  // Deterministic hash (djb2) so every AMA server assigns the same color
  // to the same machine name, regardless of discovery order.
  let hash = 5381;
  for (let i = 0; i < machineName.length; i++) {
    hash = ((hash * 33) ^ machineName.charCodeAt(i)) >>> 0;
  }
  const idx = hash % MACHINE_COLORS.length;
  const color = MACHINE_COLORS[idx];
  machineColorMap.set(machineName, color);
  return color;
}

/** Unique key for a session across machines. */
function sessionKey(name, machineHost) {
  return `${machineHost || "local"}::${name}`;
}

/** Check if a session matches the currently active session. */
function isActiveSession(name, machineHost) {
  return name === state.activeSession
    && (machineHost || "local") === (state.activeSessionMeta?.machineHost || "local");
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

// --- Paste Support ---
// navigator.clipboard.readText() requires HTTPS and fails on HTTP (Tailscale).
// Instead, listen for the browser's native paste event which works everywhere,
// including mobile long-press → Paste and desktop Ctrl+V/Cmd+V.
function patchPaste(term, getWs) {
  const textarea = term.element?.querySelector(".xterm-helper-textarea");
  if (!textarea) return;

  textarea.addEventListener("paste", (e) => {
    const ws = getWs();
    if (!ws || ws.readyState !== 1) return;

    const text = e.clipboardData?.getData("text");
    if (text) {
      ws.send(JSON.stringify({ type: "input", data: text }));
      e.preventDefault();
      // Stop xterm's own paste handler from also sending the text
      e.stopImmediatePropagation();
    }
  }, { capture: true });
}

// --- Session Navigation ---
// Navigate to the "next" session using priority ordering: needsInput > working > idle.
// state.sessions is already sorted by this priority from the server.
function isAgentSession(s) {
  return s.agent && s.agent !== "shell";
}

function navigateNextSession() {
  const sessions = state.sessions.filter((s) => s.paneId && isAgentSession(s));
  if (sessions.length === 0) return;

  const currentIdx = sessions.findIndex((s) => isActiveSession(s.name, s.machineHost));
  const nextIdx = (currentIdx + 1) % sessions.length;
  const next = sessions[nextIdx];
  openTerminal(next.name, next.machineHost);
}

function navigatePrevSession() {
  const sessions = state.sessions.filter((s) => s.paneId && isAgentSession(s));
  if (sessions.length === 0) return;

  const currentIdx = sessions.findIndex((s) => isActiveSession(s.name, s.machineHost));
  const prevIdx = (currentIdx - 1 + sessions.length) % sessions.length;
  const prev = sessions[prevIdx];
  openTerminal(prev.name, prev.machineHost);
}

function updatePositionIndicator() {
  const sessions = state.sessions.filter((s) => s.paneId && isAgentSession(s));
  const el = $("#terminal-position");
  if (!el || sessions.length <= 1) {
    if (el) el.textContent = "";
    return;
  }
  const idx = sessions.findIndex((s) => isActiveSession(s.name, s.machineHost));
  el.textContent = idx >= 0 ? `${idx + 1} of ${sessions.length}` : "";
}

// --- Terminal ---
function openTerminal(sessionName, machineHost = "local") {
  state.activeSession = sessionName;
  state.activeSessionMeta = { machineHost };
  $("#terminal-session-name").textContent = sessionName;

  showView("terminal");

  // Highlight active card on desktop
  const activeKey = sessionKey(sessionName, machineHost);
  document.querySelectorAll(".session-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.sessionKey === activeKey);
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
    scrollback: 0,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = "11";

  // Intercept Tab key for session navigation, but only when appropriate:
  // - AI agent sessions (Claude, Codex, Cursor): always navigate (Tab has no use in their prompts)
  // - Shell sessions: only navigate if the command line is empty (preserve Tab-completion)
  const AI_AGENTS = new Set(["Claude Code", "Codex", "Cursor Agent"]);

  term.attachCustomKeyEventHandler((event) => {
    if (event.key === "Tab" && event.type === "keydown" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const session = state.sessions.find((s) => isActiveSession(s.name, s.machineHost));
      const isAgent = session && AI_AGENTS.has(session.agent);

      if (!isAgent) {
        // Shell session: check if the cursor line has text after the prompt
        const cursorY = term.buffer.active.cursorY;
        const line = term.buffer.active.getLine(cursorY);
        const lineText = line ? line.translateToString(true).trim() : "";
        // If there's content (prompt + typed text), let Tab through for shell completion
        // A bare prompt like "❯" or "$" or "%" is <= 1 char — allow navigate
        const promptChars = /^[❯›$%#>]?\s*$/;
        if (!promptChars.test(lineText)) {
          return true; // pass Tab to terminal for shell completion
        }
      }

      event.preventDefault();
      if (event.shiftKey) {
        navigatePrevSession();
      } else {
        navigateNextSession();
      }
      return false;
    }
    return true;
  });

  const container = $("#terminal-container");
  container.innerHTML = "";
  container.style.opacity = "0";
  term.open(container);

  // Block wheel/trackpad scroll — scrollback should use arrow keys or tmux copy mode only.
  // Use capture phase on both the container and xterm's viewport to intercept before xterm handles it.
  container.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false, capture: true });
  const xtermViewport = container.querySelector(".xterm-viewport");
  if (xtermViewport) {
    xtermViewport.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false, capture: true });
  }

  // Short delay for DOM to settle before fitting
  requestAnimationFrame(() => {
    fitAddon.fit();
    connectWebSocket(sessionName, term, fitAddon, machineHost, container);
  });

  updatePositionIndicator();

  state.terminal = term;
  state.fitAddon = fitAddon;

  // Patch mobile backspace key repeat
  patchMobileInput(term, () => state.ws);
  // Patch paste (native browser paste event works on HTTP, unlike clipboard API)
  patchPaste(term, () => state.ws);

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
      const session = state.sessions.find((s) => s.name === sessionName && (s.machineHost || "local") === machineHost);
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
      const ws = state.ws;

      if (action === "next-session") {
        navigateNextSession();
        return;
      } else if (action === "paste") {
        // Focus the terminal's hidden textarea and use execCommand("paste")
        // to trigger the native paste flow. This works on HTTP (unlike
        // navigator.clipboard.readText which requires HTTPS).
        const term = state.terminal;
        const textarea = term?.element?.querySelector(".xterm-helper-textarea");
        if (textarea) {
          textarea.focus();
          document.execCommand("paste");
        } else {
          // Last resort fallback: prompt
          const text = prompt("Paste text:");
          if (text && ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "input", data: text }));
          }
        }
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
    populateMachinePicker();
    setTimeout(() => input.focus(), 100);
  }
}

// Pick mode buttons
document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setAddSessionMode(btn.dataset.mode));
});

$("#modal-back").addEventListener("click", () => setAddSessionMode("pick"));

function populateMachinePicker() {
  const select = $("#new-session-machine");
  const localName = state.identity?.name || "This machine";

  // Collect known machines from current sessions + identity peers
  const machines = [{ name: localName, host: "local" }];
  const seenHosts = new Set(["local"]);

  // Add peers from identity
  if (state.identity?.peers) {
    for (const peer of state.identity.peers) {
      const host = `${peer.host}:${peer.port || 3456}`;
      if (!seenHosts.has(host)) {
        seenHosts.add(host);
        machines.push({ name: peer.name || peer.host, host });
      }
    }
  }

  // Add any machines we've seen in sessions but aren't in identity peers
  for (const s of state.sessions) {
    if (s.machineHost && !seenHosts.has(s.machineHost)) {
      seenHosts.add(s.machineHost);
      machines.push({ name: s.machine || s.machineHost, host: s.machineHost });
    }
  }

  select.innerHTML = machines
    .map((m) => `<option value="${m.host}">${esc(m.name)}</option>`)
    .join("");

  // Only show if there are multiple machines
  select.classList.toggle("hidden", machines.length <= 1);
}

async function createSession() {
  const name = $("#new-session-name").value.trim();
  if (!name) return;

  const machineHost = $("#new-session-machine").value || "local";

  let result;
  if (machineHost && machineHost !== "local") {
    // Create on remote machine via proxy
    result = await fetchJson(
      apiUrl(`/api/proxy/${encodeURIComponent(machineHost)}/sessions`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
      { timeoutMs: 7000 }
    );
  } else {
    result = await api.createSession(name);
  }

  if (result.error) {
    alert(result.error);
    return;
  }

  hideNewSessionModal();
  await loadSessions();
  // Auto-open the new session (with machine context for remote)
  openTerminal(name, machineHost !== "local" ? machineHost : undefined);
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

// --- Context Menus ---
function hideContextMenu() {
  const menu = $("#context-menu");
  menu.classList.add("hidden");
  menu.innerHTML = "";
}

function positionContextMenu(e) {
  const menu = $("#context-menu");
  // Use touch position or mouse position
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const y = e.touches ? e.touches[0].clientY : e.clientY;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove("hidden");
  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

function showSessionContextMenu(e, sessionName, machineHost) {
  const menu = $("#context-menu");
  const sKey = sessionKey(sessionName, machineHost);
  const groupData = getGroups();
  const currentGroup = getSessionGroup(sKey);
  const groupNames = groupData.order.filter((n) => (groupData.groups[n] || []).length > 0 || n === currentGroup);

  const items = [];

  // "Add to group" submenu
  if (groupNames.length > 0) {
    for (const gn of groupNames) {
      if (gn === currentGroup) continue;
      items.push(`<div class="ctx-item" data-action="move-to-group" data-group="${esc(gn)}">Move to "${esc(gn)}"</div>`);
    }
  }
  items.push(`<div class="ctx-item" data-action="new-group">Add to new group...</div>`);

  if (currentGroup) {
    items.push(`<div class="ctx-item" data-action="remove-from-group">Remove from "${esc(currentGroup)}"</div>`);
  }

  items.push(`<div class="ctx-divider"></div>`);
  items.push(`<div class="ctx-item danger" data-action="kill">Kill session</div>`);

  menu.innerHTML = items.join("");
  positionContextMenu(e);

  // Bind actions
  menu.querySelectorAll(".ctx-item").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      if (action === "kill") {
        confirmDelete(sessionName, machineHost);
      } else if (action === "new-group") {
        const name = prompt("Group name:");
        if (name && name.trim()) {
          addToGroup(name.trim(), sKey);
          state.renderedSessionsSignature = "";
          renderSessions();
        }
      } else if (action === "move-to-group") {
        addToGroup(item.dataset.group, sKey);
        state.renderedSessionsSignature = "";
        renderSessions();
      } else if (action === "remove-from-group") {
        removeFromGroup(sKey);
        state.renderedSessionsSignature = "";
        renderSessions();
      }
      hideContextMenu();
    });
  });
}

function showGroupContextMenu(e, groupName) {
  const menu = $("#context-menu");
  menu.innerHTML = `
    <div class="ctx-item" data-action="rename">Rename group</div>
    <div class="ctx-item" data-action="ungroup">Ungroup all</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item danger" data-action="delete">Delete group</div>
  `;
  positionContextMenu(e);

  menu.querySelectorAll(".ctx-item").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      if (action === "rename") {
        const newName = prompt("New group name:", groupName);
        if (newName && newName.trim() && newName.trim() !== groupName) {
          renameGroup(groupName, newName.trim());
        }
      } else if (action === "ungroup") {
        const data = loadGroups();
        // Remove all members but keep nothing
        deleteGroup(groupName);
      } else if (action === "delete") {
        deleteGroup(groupName);
      }
      hideContextMenu();
      state.renderedSessionsSignature = "";
      renderSessions();
    });
  });
}

// Close context menu on outside click
document.addEventListener("click", (e) => {
  const menu = $("#context-menu");
  if (!menu.contains(e.target)) hideContextMenu();
});

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
  const deleteName = state._deleteTarget;
  const deleteHost = state._deleteTargetHost;
  const wasActive = deleteName === state.activeSession;
  await api.deleteSession(deleteName, deleteHost);
  // Eagerly remove the killed session so it disappears even if the next mesh fetch fails
  state.sessions = state.sessions.filter(
    (s) => !(s.name === deleteName && s.machineHost === deleteHost)
  );
  renderSessions();
  hideDeleteModal();
  if (wasActive) {
    closeTerminal();
  } else {
    await loadSessions();
  }
}

// --- Event Bindings ---
$("#back-btn").addEventListener("click", closeTerminal);
$("#refresh-btn").addEventListener("click", loadSessions);
$("#add-session-btn").addEventListener("click", showNewSessionModal);
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
  }
});
