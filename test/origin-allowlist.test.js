import test from "node:test";
import assert from "node:assert/strict";
import {
  authority,
  parseOrigin,
  buildLocalHostNames,
  buildLocalAuthorities,
  buildPeerAuthorities,
  isMagicDnsName,
  normalizeMagicDnsName,
  isAllowedOrigin,
  isAllowedRequestOrigin,
} from "../origin-allowlist.js";

// The machine running the tests. Every local name is derived from it so the
// tests describe one concrete deployment.
const HOSTNAME = "andys-macbook-pro";
const PORT = 3456;
const LOCAL_AUTHORITIES = buildLocalAuthorities({
  hostname: HOSTNAME,
  addresses: [{ address: "192.168.64.1" }, { address: "100.101.102.103" }],
  port: PORT,
});
const PEER_AUTHORITIES = buildPeerAuthorities(
  [{ name: "desktop", host: "desktop.tailnet.ts.net", port: 3456 }],
  PORT
);
// The machine's own MagicDNS name, in full: the machine name AND the tailnet
// it belongs to. The tailnet segment is chosen by whoever owns the tailnet, so
// only the whole name identifies this machine unambiguously.
const MAGIC_DNS_NAME = `${HOSTNAME}.tailnet.ts.net`;
const OPTIONS = {
  localAuthorities: LOCAL_AUTHORITIES,
  peerAuthorities: PEER_AUTHORITIES,
  magicDnsNames: new Set([MAGIC_DNS_NAME]),
  magicDnsPort: PORT,
};

test("a page on an unrelated site cannot drive the API", () => {
  // The API can create a session that runs a command and the terminal socket
  // can type into one. Any page the user visits being able to do that is
  // remote code execution on the machine hosting AMA.
  assert.equal(isAllowedOrigin("https://evil.example", OPTIONS), false);
  assert.equal(isAllowedOrigin("http://evil.example:3456", OPTIONS), false);
});

test("the web UI's own origin is allowed", () => {
  assert.equal(isAllowedOrigin("http://localhost:3456", OPTIONS), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:3456", OPTIONS), true);
  assert.equal(isAllowedOrigin(`http://${HOSTNAME}:3456`, OPTIONS), true);
});

test("a mesh peer's origin is allowed", () => {
  // The web UI fails over to a peer by calling it cross-origin, so a peer is
  // a legitimate origin even though it is a different machine.
  assert.equal(isAllowedOrigin("http://desktop.tailnet.ts.net:3456", OPTIONS), true);
});

test("the machine's MagicDNS name is allowed", () => {
  // The user reaches the machine by its tailnet name, which is not an
  // interface address and not the hostname.
  assert.equal(isAllowedOrigin(`http://${MAGIC_DNS_NAME}:3456`, OPTIONS), true);
});

test("another tailnet cannot publish this machine's name", () => {
  // A tailnet names a machine "<machine>.<tailnet>.ts.net", and BOTH halves are
  // chosen by whoever owns the tailnet. So an attacker who creates their own
  // tailnet can publish "<this-machine>.<their-tailnet>.ts.net" — a name that
  // resolves to a host they control. A page served from there would otherwise
  // be trusted to drive this API, which is remote code execution. Matching the
  // whole name is what stops it: the tailnet segment is the part that cannot
  // be guessed.
  assert.equal(isAllowedOrigin(`http://${HOSTNAME}.evil.ts.net:3456`, OPTIONS), false);
  assert.equal(isAllowedOrigin(`http://${HOSTNAME}.attacker.ts.net:3456`, OPTIONS), false);
  assert.equal(isAllowedOrigin(`http://${HOSTNAME}.x.ts.net:3456`, OPTIONS), false);
  // The machine's own name is still allowed.
  assert.equal(isAllowedOrigin(`http://${MAGIC_DNS_NAME}:3456`, OPTIONS), true);
});

test("a host that merely resembles the local name is refused", () => {
  // The MagicDNS rule accepts a name only under the Tailscale suffix. A
  // subdomain of an attacker's own domain that happens to start with this
  // machine's name must not pass.
  assert.equal(isAllowedOrigin(`http://${HOSTNAME}.evil.example:3456`, OPTIONS), false);
  assert.equal(isAllowedOrigin("http://andys-macbook-prox.tailnet.ts.net:3456", OPTIONS), false);
});

test("another local port cannot drive the API", () => {
  // "http://localhost" is not this server. A malicious package that starts a
  // web server on some other local port must not be able to reach the API.
  assert.equal(isAllowedOrigin("http://localhost:9999", OPTIONS), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9999", OPTIONS), false);
  assert.equal(isAllowedOrigin("http://localhost", OPTIONS), false);
});

test("a request with no Origin is allowed", () => {
  // curl, the status adapters and the launchd health check are not browsers.
  assert.equal(isAllowedRequestOrigin(undefined, OPTIONS), true);
  assert.equal(isAllowedRequestOrigin("", OPTIONS), true);
});

test("a malformed Origin is refused", () => {
  assert.equal(isAllowedOrigin("not a url", OPTIONS), false);
  assert.equal(isAllowedOrigin("", OPTIONS), false);
  assert.equal(parseOrigin("not a url"), null);
});

test("local names include the hostname, its short form and every interface address", () => {
  const names = buildLocalHostNames({
    hostname: HOSTNAME,
    addresses: [{ address: "192.168.64.1" }],
  });
  assert.ok(names.has(HOSTNAME));
  assert.ok(names.has("andys-macbook-pro"));
  assert.ok(names.has("192.168.64.1"));
  assert.ok(names.has("::1"));
});

test("the MagicDNS rule matches the whole name, not a prefix", () => {
  const names = new Set([MAGIC_DNS_NAME]);
  assert.equal(isMagicDnsName(MAGIC_DNS_NAME, { names }), true);
  // A different tailnet, publishing a name that starts with this machine's.
  assert.equal(isMagicDnsName(`${HOSTNAME}.evil.ts.net`, { names }), false);
  assert.equal(isMagicDnsName("other.tailnet.ts.net", { names }), false);
  // A name that does not even look like a MagicDNS name.
  assert.equal(isMagicDnsName(`${HOSTNAME}.evil.example`, { names }), false);
  // A trailing dot is the same name.
  assert.equal(isMagicDnsName(`${MAGIC_DNS_NAME}.`, { names }), true);
});

test("MagicDNS names are normalised before comparison", () => {
  assert.equal(normalizeMagicDnsName("  ANDYS-MacBook-Pro.Tailnet.TS.NET.  "), "andys-macbook-pro.tailnet.ts.net");
  assert.equal(normalizeMagicDnsName(undefined), "");
});

test("an IPv6 authority is bracketed", () => {
  assert.equal(authority("::1", 3456), "[::1]:3456");
  assert.equal(authority("localhost", 3456), "localhost:3456");
});
