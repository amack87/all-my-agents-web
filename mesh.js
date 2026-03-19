import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "mesh.config.json");
const CONFIG_CACHE_TTL_MS = 30_000;
const DISCOVERY_CACHE_TTL_MS = 60_000;
const DEFAULT_PORT = 3456;

let cachedConfig = null;
let cachedConfigMtime = 0;
let configCacheTime = 0;

let cachedPeers = null;
let peersCacheTime = 0;

const DEFAULT_CONFIG = { name: "local", port: DEFAULT_PORT, peers: [] };

/**
 * Load mesh config from file. The config can optionally specify manual peers,
 * but the primary discovery mechanism is Tailscale auto-discovery.
 */
export async function loadMeshConfig() {
  const now = Date.now();
  if (cachedConfig && now - configCacheTime < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const info = await stat(CONFIG_PATH);
    const mtime = info.mtimeMs;

    if (cachedConfig && mtime === cachedConfigMtime) {
      configCacheTime = now;
      return cachedConfig;
    }

    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cachedConfig = {
      name: parsed.name || DEFAULT_CONFIG.name,
      port: parsed.port || DEFAULT_PORT,
      peers: Array.isArray(parsed.peers) ? parsed.peers : [],
    };
    cachedConfigMtime = mtime;
    configCacheTime = now;
    return cachedConfig;
  } catch {
    cachedConfig = DEFAULT_CONFIG;
    configCacheTime = now;
    return cachedConfig;
  }
}

/**
 * Discover peers on the Tailscale network that are running All My Agents.
 * Uses `tailscale status --json` to find online devices, then probes
 * each one's /api/identity endpoint to check if All My Agents is running.
 */
export async function discoverTailscalePeers(config) {
  const now = Date.now();
  if (cachedPeers && now - peersCacheTime < DISCOVERY_CACHE_TTL_MS) {
    return cachedPeers;
  }

  const port = config.port || DEFAULT_PORT;
  let tailscaleData;

  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 5000,
    });
    tailscaleData = JSON.parse(stdout);
  } catch {
    // Tailscale not available — fall back to manual peers from config
    cachedPeers = config.peers;
    peersCacheTime = now;
    return cachedPeers;
  }

  // Collect online peers (exclude self)
  const selfIPs = new Set(tailscaleData.Self?.TailscaleIPs || []);
  const candidates = [];

  for (const peer of Object.values(tailscaleData.Peer || {})) {
    if (!peer.Online) continue;
    const ips = peer.TailscaleIPs || [];
    // Use the IPv4 address
    const ip = ips.find((addr) => !addr.includes(":"));
    if (!ip) continue;
    if (selfIPs.has(ip)) continue;

    candidates.push({
      hostname: peer.HostName,
      ip,
    });
  }

  // Probe each candidate in parallel to see if All My Agents is running
  const probeResults = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const url = `http://${candidate.ip}:${port}/api/identity`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const identity = await res.json();
        return {
          name: identity.name || candidate.hostname,
          host: candidate.ip,
          port,
          hostname: candidate.hostname,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })
  );

  const discovered = probeResults
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);

  // Merge: manual config peers + auto-discovered (deduplicate by host)
  const seenHosts = new Set();
  const merged = [];

  // Manual peers take priority
  for (const p of config.peers) {
    seenHosts.add(p.host);
    merged.push(p);
  }

  // Add discovered peers not already in manual config
  for (const p of discovered) {
    if (!seenHosts.has(p.host)) {
      seenHosts.add(p.host);
      merged.push(p);
    }
  }

  cachedPeers = merged;
  peersCacheTime = now;
  return merged;
}

/**
 * Returns the full resolved config with discovered peers merged in.
 */
export async function resolveConfig() {
  const config = await loadMeshConfig();
  const peers = await discoverTailscalePeers(config);
  return { ...config, peers };
}

export async function fetchPeerSessions(peer, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `http://${peer.host}:${peer.port || DEFAULT_PORT}/api/sessions`;
    const res = await fetch(url, { signal: controller.signal });
    const sessions = await res.json();
    const VALID_STATUSES = new Set(["needsInput", "working", "idle", "unknown"]);
    return {
      peer,
      sessions: sessions.map((s) => ({
        name: String(s.name ?? ""),
        paneId: String(s.paneId ?? ""),
        tty: String(s.tty ?? ""),
        currentCommand: String(s.currentCommand ?? ""),
        windowName: String(s.windowName ?? ""),
        status: VALID_STATUSES.has(s.status) ? s.status : "unknown",
        agent: typeof s.agent === "string" ? s.agent : "shell",
        projectPath: s.projectPath ? String(s.projectPath) : undefined,
        summary: s.summary ? String(s.summary) : undefined,
        lastActivity: typeof s.lastActivity === "number" ? s.lastActivity : 0,
        machine: peer.name,
        machineHost: `${peer.host}:${peer.port || DEFAULT_PORT}`,
      })),
      error: null,
    };
  } catch (err) {
    return {
      peer,
      sessions: [],
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAllMeshSessions(localSessions, config) {
  const tagged = localSessions.map((s) => ({
    ...s,
    machine: config.name,
    machineHost: "local",
  }));

  if (config.peers.length === 0) {
    return { sessions: tagged, peerStatus: {} };
  }

  const results = await Promise.allSettled(
    config.peers.map((peer) => fetchPeerSessions(peer))
  );

  const peerStatus = {};
  let allSessions = [...tagged];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { peer, sessions, error } = result.value;
      peerStatus[peer.name] = error ? `error: ${error}` : "ok";
      allSessions = [...allSessions, ...sessions];
    }
  }

  // Sort: needsInput first, then working, then idle/unknown
  const priority = { needsInput: 0, working: 1, idle: 2, unknown: 3 };
  const sorted = [...allSessions].sort(
    (a, b) => (priority[a.status] ?? 3) - (priority[b.status] ?? 3)
  );

  return { sessions: sorted, peerStatus };
}
