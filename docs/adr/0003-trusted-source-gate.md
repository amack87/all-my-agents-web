# 3. Connections are accepted only from trusted sources

Date: 2026-11-02

## Status

Accepted

## Context

AMA drives terminals. Anyone who can reach the server can open a shell on the machine hosting it, so the server's exposure is the security boundary.

The server binds `0.0.0.0` on purpose: it has to keep working when Tailscale comes up after boot or changes address, and it has to be reachable from the Windows VM. But binding to all interfaces also puts the server on the Wi-Fi LAN, where anyone at the coffee shop can drive a terminal. The README previously claimed "network access is limited to your Tailscale network — do not expose to the public internet" — that described an intent the code did not enforce. Nothing checked where a connection came from; the only gate was a list of known peers checked *after* the connection had already been accepted.

Three sources need to reach the server:

- **loopback** — local agent adapters post status events to `http://127.0.0.1:3456`.
- **Tailscale** — `100.64.0.0/10` and `fd7a:115c:a1e0::/48`: the phone, and mesh peers.
- **the virtualization bridge** — `192.168.64.0/24`, Apple's NAT range for the UTM Windows VM, whose adapter posts to `http://192.168.64.1:3456`.

Binding to `127.0.0.1` was not an option: that breaks the late-Tailscale case and the VM case.

## Decision

The server binds `0.0.0.0`, and every TCP connection is checked by its source address before HTTP or WebSocket handling sees it. A connection from an untrusted source is destroyed at the socket level.

Trusted sources:

- `::1` and `127.0.0.0/8` — loopback.
- `100.64.0.0/10` and `fd7a:115c:a1e0::/48` — Tailscale.
- `192.168.64.0/24` — the virtualization bridge.

The bridge range is trusted only when the connection actually *landed on the bridge*: the connection's local address must equal this machine's own address on that bridge. A Wi-Fi LAN that happens to reuse `192.168.64.0/24` would otherwise inherit the VM's trust wholesale. Loopback and Tailscale connections are trusted wherever they land.

The bridge address is discovered at startup from the network interfaces whose name matches `/^(bridge|vmnet|vnet)/i`. If no such interface exists, the bridge range is not trusted at all — the server fails closed, and the log says so.

The gate sits at the TCP level rather than in route handlers because a rejected route still completes the handshake and still consumes a socket; the point is to not have the connection at all.

## Consequences

- The Wi-Fi LAN is refused. The server log records `Refused connection from untrusted address` with the offending address, and the client sees a closed connection rather than an error page.
- Binding to `0.0.0.0` is now safe to keep, which is what lets the server survive Tailscale arriving late or changing address.
- Trust is a property of the *address*, not of the network. A machine whose address falls in one of the trusted ranges is trusted — the ranges are the boundary.
- The server no longer depends on the surrounding network being the right one. Tailscale's network-level isolation becomes defence in depth rather than the only defence.
- If the machine has no virtualization bridge, that source is simply absent. The failure mode is "the VM cannot reach the server", never "the server is exposed".
- `network-access.js` holds the rules and is free of side effects, so they are unit-testable; `test/network-access.test.js` covers the range membership and the local-address pin.
