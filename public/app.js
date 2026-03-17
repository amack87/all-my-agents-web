// --- xterm imports via CDN ---
import { Terminal } from "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm";
import { FitAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm";
import { WebLinksAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/+esm";
import { Unicode11Addon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/+esm";

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
};

// --- API ---
const api = {
  async getSessions() {
    const res = await fetch("/api/sessions");
    return res.json();
  },
  async createSession(name) {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.json();
  },
  async deleteSession(name, machineHost) {
    const url = machineHost && machineHost !== "local"
      ? `/api/proxy/${encodeURIComponent(machineHost)}/sessions/${encodeURIComponent(name)}`
      : `/api/sessions/${encodeURIComponent(name)}`;
    const res = await fetch(url, { method: "DELETE" });
    return res.json();
  },
  async capturePane(target, machineHost) {
    const url = machineHost && machineHost !== "local"
      ? `/api/proxy/${encodeURIComponent(machineHost)}/sessions/${encodeURIComponent(target)}/capture`
      : `/api/sessions/${encodeURIComponent(target)}/capture`;
    const res = await fetch(url);
    return res.json();
  },
  async getMeshSessions() {
    const res = await fetch("/api/mesh/sessions");
    return res.json();
  },
  async getIdentity() {
    const res = await fetch("/api/identity");
    return res.json();
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
  try {
    const result = await api.getMeshSessions();
    state.sessions = result.sessions || [];
    state.peerStatus = result.peerStatus || {};
    state.hasPeers = Object.keys(state.peerStatus).length > 0;
  } catch {
    // Fallback to local-only
    const sessions = await api.getSessions();
    state.sessions = sessions.map((s) => ({ ...s, machine: "local", machineHost: "local" }));
    state.peerStatus = {};
    state.hasPeers = false;
  }
  renderPeerStatus();
  renderSessions();
}

function renderSessions() {
  const container = $("#sessions-container");

  const filtered = state.machineFilter === "all"
    ? state.sessions
    : state.sessions.filter((s) => s.machine === state.machineFilter);

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
        <div class="session-name">${esc(s.name)}</div>
        <div class="session-meta">${esc(s.projectPath || s.currentCommand || s.paneId)}</div>
      </div>
      ${showMachineLabel ? `<span class="machine-badge">${esc(s.machine)}</span>` : ""}
      <span class="session-status-label ${s.status}">${statusLabel(s.status)}</span>
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

function esc(str) {
  if (!str) return "";
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
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
  const term = new Terminal({
    fontFamily: '"JetBrains Mono NF", monospace',
    fontSize: 14,
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
    } catch { /* ignore */ }
  }, 2000);

  // Setup toolbar
  setupToolbar("#terminal-view .terminal-toolbar", term);
}

function connectWebSocket(sessionName, term, fitAddon, machineHost = "local", visContainer = null) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsPath = machineHost && machineHost !== "local"
    ? `/ws/proxy/${encodeURIComponent(machineHost)}/${encodeURIComponent(sessionName)}`
    : `/ws/terminal/${encodeURIComponent(sessionName)}`;
  const ws = new WebSocket(`${protocol}//${location.host}${wsPath}`);

  // Batched writer: collects all output within a window and writes
  // as a single chunk. Prevents visible incremental rendering during
  // screen redraws (Claude Code UI transitions, permission prompts, etc).
  // 50ms base is imperceptible but catches most multi-message bursts.
  let frameBuf = [];
  let flushTimer = null;
  const BASE_BATCH_MS = 50;
  let batchMs = BASE_BATCH_MS;

  const flushFrameBuf = () => {
    flushTimer = null;
    const combined = frameBuf.join("");
    frameBuf = [];
    term.write(combined);
  };

  const writeBuffered = (data) => {
    frameBuf.push(data);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushFrameBuf, batchMs);
  };

  // After user sends Enter, widen batch window to catch full redraws
  const onUserInput = (data) => {
    if (data === "\r" || data === "\n") {
      batchMs = 120;
      setTimeout(() => { batchMs = BASE_BATCH_MS; }, 500);
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
      term.write(evt.data);
    }
  };

  ws.onclose = () => {
    state._wsDisconnected = true;
    term.write("\r\n[Disconnected — tap reconnect or switch back to this app]\r\n");
  };

  ws.onerror = () => {
    state._wsDisconnected = true;
    term.write("\r\n[Connection error]\r\n");
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
  if (state.ws) {
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
  const term = new Terminal({
    fontFamily: '"JetBrains Mono NF", monospace',
    fontSize: 14,
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
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsPath = machineHost && machineHost !== "local"
      ? `/ws/proxy/${encodeURIComponent(machineHost)}/${encodeURIComponent(target)}`
      : `/ws/terminal/${encodeURIComponent(target)}`;
    const ws = new WebSocket(`${protocol}//${location.host}${wsPath}`);

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

// --- Modals ---
function showNewSessionModal() {
  const modal = $("#new-session-modal");
  const input = $("#new-session-name");
  input.value = "";
  modal.classList.remove("hidden");
  setTimeout(() => input.focus(), 100);
}

function hideNewSessionModal() {
  $("#new-session-modal").classList.add("hidden");
}

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
      loadSessions();
    }
  }, 3000);
}

function stopListPolling() {
  if (listPollInterval) clearInterval(listPollInterval);
}

// --- Init ---
async function init() {
  // Pre-load terminal font before any terminal opens
  try {
    await document.fonts.load('14px "JetBrains Mono NF"');
  } catch { /* font API may not be available */ }

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
