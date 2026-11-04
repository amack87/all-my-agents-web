import test from "node:test";
import assert from "node:assert/strict";
import {
  authority,
  parseOrigin,
  buildLocalHostNames,
  buildLocalAuthorities,
  buildPeerAuthorities,
  isMagicDnsName,
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
const OPTIONS = {
  localAuthorities: LOCAL_AUTHORITIES,
  peerAuthorities: PEER_AUTHORITIES,
  magicDnsShortName: "andys-macbook-pro",
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
  assert.equal(isAllowedOrigin(`http://${HOSTNAME}.tailnet.ts.net:3456`, OPTIONS), true);
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

test("the MagicDNS rule needs the Tailscale suffix", () => {
  assert.equal(isMagicDnsName("andys-macbook-pro.tailnet.ts.net", { shortName: "andys-macbook-pro" }), true);
  assert.equal(isMagicDnsName("andys-macbook-pro.evil.example", { shortName: "andys-macbook-pro" }), false);
  assert.equal(isMagicDnsName("other.tailnet.ts.net", { shortName: "andys-macbook-pro" }), false);
});

test("an IPv6 authority is bracketed", () => {
  assert.equal(authority("::1", 3456), "[::1]:3456");
  assert.equal(authority("localhost", 3456), "localhost:3456");
});
