// The server listens on 0.0.0.0 so it keeps working when Tailscale comes up
// after boot or changes address, but it must not be reachable from the Wi-Fi
// LAN: anyone there could drive a terminal. Each TCP connection is checked by
// its source address before HTTP or WebSocket handling sees it.
//
// Trusted sources:
//   - loopback: local agent adapters post to http://127.0.0.1:3456
//   - Tailscale: 100.64.0.0/10 and fd7a:115c:a1e0::/48 (phone, mesh peers)
//   - Apple Virtualization NAT 192.168.64.0/24: the Windows VM adapter posts
//     to http://192.168.64.1:3456 (setup/windows/install-adapter.ps1)
// A LAN host cannot spoof these sources, because replies route over lo0,
// the Tailscale interface or the VM bridge, so the TCP handshake never completes.
//
// The bridge range is trusted only when the connection actually landed on the
// bridge. A Wi-Fi LAN that happens to use 192.168.64.0/24 would otherwise
// inherit the VM's trust, so the bridge address is checked as well.

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inIpv4Cidr(ip, base, bits) {
  const n = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (n === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

function normalizeAddress(address) {
  if (typeof address !== "string" || address === "") return null;
  return address.toLowerCase().replace(/^::ffff:/, "");
}

export function isTrustedRemoteAddress(address) {
  const addr = normalizeAddress(address);
  if (!addr) return false;
  if (addr === "::1") return true;
  if (addr.startsWith("fd7a:115c:a1e0:")) return true;
  return (
    inIpv4Cidr(addr, "127.0.0.0", 8) ||
    inIpv4Cidr(addr, "100.64.0.0", 10) ||
    inIpv4Cidr(addr, "192.168.64.0", 24)
  );
}

// Is this connection allowed? The bridge range is trusted only when the
// connection landed on the bridge itself, so a Wi-Fi LAN that reuses the same
// addresses gains nothing from the VM's trust.
export function isTrustedConnection({ remoteAddress, localAddress, bridgeAddress } = {}) {
  if (!isTrustedRemoteAddress(remoteAddress)) return false;
  const addr = normalizeAddress(remoteAddress);
  if (!inIpv4Cidr(addr, "192.168.64.0", 24)) return true;
  const bridge = normalizeAddress(bridgeAddress);
  return Boolean(bridge) && normalizeAddress(localAddress) === bridge;
}
