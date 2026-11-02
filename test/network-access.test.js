import test from "node:test";
import assert from "node:assert/strict";
import { isTrustedRemoteAddress, isTrustedConnection } from "../network-access.js";

// The server drives real terminals, so anything on the Wi-Fi LAN must be refused.
test("Wi-Fi LAN and public addresses are refused", () => {
  for (const ip of ["192.168.1.50", "::ffff:192.168.1.50", "10.0.0.7", "172.16.4.2", "8.8.8.8", "fe80::1"]) {
    assert.equal(isTrustedRemoteAddress(ip), false, ip);
  }
});

// Local agent adapters post status to http://127.0.0.1:3456.
test("loopback is trusted so local adapters keep reporting", () => {
  for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
    assert.equal(isTrustedRemoteAddress(ip), true, ip);
  }
});

// Phone and mesh peers arrive over Tailscale.
test("Tailscale addresses are trusted, and the range stops at 100.127.255.255", () => {
  for (const ip of ["100.64.35.46", "::ffff:100.101.2.3", "100.127.255.255", "fd7a:115c:a1e0::1234"]) {
    assert.equal(isTrustedRemoteAddress(ip), true, ip);
  }
  for (const ip of ["100.63.255.255", "100.128.0.1"]) {
    assert.equal(isTrustedRemoteAddress(ip), false, ip);
  }
});

// The Windows VM adapter posts to http://192.168.64.1:3456 over the VM NAT bridge.
test("the Windows VM network is trusted but a neighbouring /24 is not", () => {
  assert.equal(isTrustedRemoteAddress("192.168.64.2"), true);
  assert.equal(isTrustedRemoteAddress("192.168.65.2"), false);
});

test("missing or malformed addresses are refused", () => {
  for (const ip of [undefined, null, "", "not-an-ip", "300.1.1.1"]) {
    assert.equal(isTrustedRemoteAddress(ip), false, String(ip));
  }
});

// The VM bridge range is only trusted when the connection landed on the
// bridge. A Wi-Fi LAN that reuses 192.168.64.0/24 must not inherit that trust.
test("a VM bridge connection is trusted when it landed on the bridge", () => {
  assert.equal(
    isTrustedConnection({
      remoteAddress: "192.168.64.2",
      localAddress: "192.168.64.1",
      bridgeAddress: "192.168.64.1",
    }),
    true
  );
});

test("a LAN host reusing the bridge range is refused", () => {
  assert.equal(
    isTrustedConnection({
      remoteAddress: "192.168.64.2",
      localAddress: "192.168.1.198",
      bridgeAddress: "192.168.64.1",
    }),
    false
  );
});

test("the bridge range is refused when no bridge address is known", () => {
  assert.equal(
    isTrustedConnection({
      remoteAddress: "192.168.64.2",
      localAddress: "192.168.64.1",
      bridgeAddress: null,
    }),
    false
  );
});

test("loopback and Tailscale are trusted wherever they land", () => {
  for (const remoteAddress of ["127.0.0.1", "::1", "100.64.35.46", "fd7a:115c:a1e0::f035:232f"]) {
    assert.equal(
      isTrustedConnection({ remoteAddress, localAddress: "192.168.1.198", bridgeAddress: "192.168.64.1" }),
      true,
      remoteAddress
    );
  }
});

test("an untrusted address is refused however it arrives", () => {
  assert.equal(
    isTrustedConnection({
      remoteAddress: "192.168.1.50",
      localAddress: "192.168.1.198",
      bridgeAddress: "192.168.64.1",
    }),
    false
  );
  assert.equal(isTrustedConnection({}), false);
});
