// Pure helpers for the Origin allowlist.
//
// The API can create a session that runs a command, and the terminal
// WebSocket can type into one, so neither may be reachable from a page the
// user happens to be visiting. A browser sends an Origin header; a command
// line client sends none. A request is accepted when it carries no Origin, or
// when its Origin names this machine or a mesh peer — the web UI fails over
// to a peer by calling it cross-origin.
//
// The Origin, not the Host header, is the authority. A DNS-rebinding attack
// makes the browser send Host: attacker.example and
// Origin: http://attacker.example: the two agree with each other, and
// neither names this machine, so the Origin check refuses it.
//
// A wildcard would be simpler, and wrong: with one, every web page the user
// visits could drive this API, which is remote code execution against the
// machine hosting AMA.
//
// The port is part of the match. "http://localhost" is not this server: a
// malicious package that starts a web server on some other local port must
// not be able to drive the API on this one.
//
// This module must stay free of fs/tmux/network side effects so the rules are
// unit-testable.

// Tailscale's MagicDNS names end in this suffix. A name under it is only
// trusted when it is this machine's OWN name in full — see isMagicDnsName.
export const MAGIC_DNS_SUFFIX = ".ts.net";

// Normalise a MagicDNS name for comparison: lower case, no trailing dot.
export function normalizeMagicDnsName(name) {
  if (typeof name !== "string") return "";
  return name.trim().toLowerCase().replace(/\.$/, "");
}

// "host:port", with IPv6 addresses bracketed.
export function authority(host, port) {
  const h = String(host ?? "").toLowerCase();
  if (!h) return "";
  const bracketed = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
  return `${bracketed}:${port}`;
}

// Split an origin into its hostname and its host:port authority.
export function parseOrigin(url) {
  if (typeof url !== "string" || url === "") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return {
    hostname: parsed.hostname.toLowerCase(),
    host: parsed.host.toLowerCase(),
    port: parsed.port,
  };
}

// Every name that refers to this machine: the hostname, its short form, the
// loopback spellings, and the address of every local interface.
export function buildLocalHostNames({ hostname, addresses = [] } = {}) {
  const names = new Set(["localhost", "127.0.0.1", "::1"]);
  const host = typeof hostname === "string" ? hostname.toLowerCase() : "";
  if (host) {
    names.add(host);
    names.add(host.split(".")[0]);
  }
  for (const addr of addresses) {
    if (addr && addr.address) names.add(String(addr.address).toLowerCase());
  }
  return names;
}

// The authorities ("host:port") that serve this machine.
export function buildLocalAuthorities({ hostname, addresses = [], port }) {
  const authorities = new Set();
  for (const name of buildLocalHostNames({ hostname, addresses })) {
    authorities.add(authority(name, port));
  }
  return authorities;
}

// The authorities that serve a mesh peer. The client builds a peer's URL the
// same way, so the two agree.
export function buildPeerAuthorities(peers = [], defaultPort) {
  const authorities = new Set();
  for (const peer of peers) {
    if (!peer || typeof peer.host !== "string" || !peer.host) continue;
    authorities.add(authority(peer.host, peer.port || defaultPort));
  }
  return authorities;
}

// Is this hostname one of this machine's own MagicDNS names?
//
// The WHOLE name is matched, not a prefix. A tailnet names a machine
// "<machine>.<tailnet>.ts.net", and both halves are chosen by whoever owns
// the tailnet — so another tailnet can publish "<your-machine>.<their-
// tailnet>.ts.net" and a page served from it would otherwise be trusted to
// drive this API. Matching the full name is what stops that: the tailnet
// segment is the part that cannot be guessed.
export function isMagicDnsName(hostname, { names = new Set() } = {}) {
  if (typeof hostname !== "string" || !hostname) return false;
  const target = normalizeMagicDnsName(hostname);
  if (!target) return false;
  // Every MagicDNS name sits under this suffix. Checking it as well as the
  // exact name means a set that somehow holds something else cannot widen the
  // rule.
  if (!target.endsWith(MAGIC_DNS_SUFFIX)) return false;
  for (const name of names) {
    if (normalizeMagicDnsName(name) === target) return true;
  }
  return false;
}

// Is this Origin allowed to drive the API?
export function isAllowedOrigin(origin, {
  localAuthorities = new Set(),
  peerAuthorities = new Set(),
  magicDnsNames = new Set(),
  magicDnsPort = null,
} = {}) {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  if (localAuthorities.has(parsed.host)) return true;
  if (peerAuthorities.has(parsed.host)) return true;
  // The MagicDNS name is not in the local authority set unless the tailnet
  // name happens to be an interface address, so it is matched by rule. The
  // port is checked too: only this server's own port is this server.
  if (magicDnsPort && parsed.port === String(magicDnsPort)) {
    if (isMagicDnsName(parsed.hostname, { names: magicDnsNames })) {
      return true;
    }
  }
  return false;
}

// Is this request allowed to carry the given Origin? A request with no
// Origin is not from a browser, so it is allowed; the server decides what to
// do with it.
export function isAllowedRequestOrigin(origin, options = {}) {
  if (origin === undefined || origin === null || origin === "") return true;
  return isAllowedOrigin(origin, options);
}
