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

// Tailscale's MagicDNS names end in this suffix. Only names under it count:
// a name that merely starts with this machine's short name could be an
// attacker's own domain, and letting that through hands the API to whoever
// controls it.
export const MAGIC_DNS_SUFFIX = ".ts.net";

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

// Is this hostname this machine's MagicDNS name? It must be under the
// machine's short name AND under the Tailscale suffix.
export function isMagicDnsName(hostname, { shortName, suffix = MAGIC_DNS_SUFFIX } = {}) {
  if (typeof hostname !== "string" || !hostname) return false;
  if (typeof shortName !== "string" || !shortName) return false;
  const short = shortName.toLowerCase();
  if (!hostname.startsWith(`${short}.`)) return false;
  return hostname.endsWith(suffix);
}

// Is this Origin allowed to drive the API?
export function isAllowedOrigin(origin, {
  localAuthorities = new Set(),
  peerAuthorities = new Set(),
  magicDnsShortName = "",
  magicDnsPort = null,
  magicDnsSuffix = MAGIC_DNS_SUFFIX,
} = {}) {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  if (localAuthorities.has(parsed.host)) return true;
  if (peerAuthorities.has(parsed.host)) return true;
  // The MagicDNS name is not in the local authority set unless the tailnet
  // name happens to be an interface address, so it is matched by rule. The
  // port is checked too: only this server's own port is this server.
  if (magicDnsPort && parsed.port === String(magicDnsPort)) {
    if (isMagicDnsName(parsed.hostname, { shortName: magicDnsShortName, suffix: magicDnsSuffix })) {
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
