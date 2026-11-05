# 5. Cross-origin requests are refused unless the Origin is a known authority

Date: 2026-11-02

## Status

Accepted

## Context

The API can create a session that runs a command, and the terminal WebSocket can type into one. Nothing on it is authenticated: whatever can reach the server can drive a terminal. ADR 0003 restricts that by source address, which closes the network route in — but a page in the user's own browser reaches the server without ever leaving the machine, and a browser will happily send requests to `http://127.0.0.1:3456` from any site the user visits.

The server answered with `Access-Control-Allow-Origin: *`. That is the worst of both worlds: it tells every site that may read the response, *and* it does nothing to stop the side effect. A request that creates a session has already done the damage by the time the response is written; whether the attacker can read the reply is irrelevant. Because the API takes JSON, a `POST` with `Content-Type: application/json` triggers a CORS preflight, and the wildcard answered that preflight too — so a page could drive the whole API. That is remote code execution against the machine hosting AMA, from a page the user merely visited.

CORS is a response-reading control, not an authorization control. Something else has to decide who may make the request in the first place.

The first version of this decision had a hole in it, and it was found before the code was pushed. The MagicDNS rule matched any name that *started with* the machine's short name and ended in `.ts.net` — without looking at the tailnet segment. Tailscale tailnet names are chosen by whoever owns the tailnet, so an attacker could create their own tailnet, name a node after this machine, and serve a page from `amer-cy4dq52l6c.evil.ts.net`. The server accepted that origin and the attacker's page created a session running a command on this machine: the drive-by remote code execution this decision exists to prevent. The rule now matches the machine's own full MagicDNS name and nothing else.

## Decision

A request is accepted when it carries **no** `Origin` header, or when its `Origin` names an authority the server already knows.

- **No Origin ⇒ allowed.** Command-line clients, the agent status adapters and health checks are not browsers and send none.
- **Local authorities.** The machine's hostname, its short form, the loopback spellings and every local interface address, each at the server's own port.
- **Peer authorities.** Each configured mesh peer's `host:port`, in the same form the browser client builds, so the two agree. The web UI fails over to a peer by calling it cross-origin, so peers must be allowed.
- **This machine's MagicDNS name**, matched by its **full** name — machine *and* tailnet — and nothing else. A tailnet names a machine `<machine>.<tailnet>.ts.net`, and both halves are chosen by whoever owns the tailnet. Matching a prefix would let any other tailnet publish `<this-machine>.<their-tailnet>.ts.net`, a name that resolves to a host the attacker controls; matching the whole name does not, because the tailnet segment is the part that cannot be guessed. The name is read from Tailscale itself (`Self.DNSName`), and when Tailscale cannot be asked, no MagicDNS name is trusted at all.
- **The port is part of the match.** `http://localhost:9999` is a different server. A malicious package that starts a web server on another local port must not be able to drive the API on this one.
- **The `Origin`, not the `Host`, is the authority.** Under DNS rebinding the browser sends `Host: attacker.example` and `Origin: http://attacker.example`: the two agree with each other, and neither names this machine, so the check refuses it.

A refused origin gets `403` and a warning in the log. An allowed origin is echoed back with `Vary: Origin`; the wildcard is gone. A preflight `OPTIONS` returns `204` with the CORS headers — it used to fall through to `404`, which meant a cross-origin failover `POST` could never have worked.

WebSocket upgrades are checked the same way, because CORS does not apply to them.

The rules live in `origin-allowlist.js`, a pure module with no filesystem, network or process side effects, so they are unit-testable in isolation.

## Consequences

- A browser at an origin the server does not know is refused. The fix is to open the UI from one of the allowed origins — the machine's own names, or a peer. A tunnel or reverse proxy in front of the server must add its own origin.
- Adding a peer to `mesh.config.json` adds its origin automatically; the list is derived, not maintained by hand.
- This is a second layer, not a replacement for ADR 0003. The source gate stops the network route in; the origin allowlist stops the browser route in. A local process can still talk to the server, and always could.
- Because there is no authentication, neither layer may be relaxed to make something reachable. Loosening the origin list to a wildcard would hand the API to every page the user visits.
- The allowlist can only refuse. It cannot distinguish two people sharing a machine, and it does not protect the API from a caller already inside the allowed set.
