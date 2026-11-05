# 8. OpenCode plugins export a default, and third-party integrations are driven, not patched

Date: 2026-11-05

## Status

Accepted

## Context

AMA ships two opencode integrations: the status adapter that reports a
session's lifecycle to the server, and the per-session Superwhisper gate.
Both are copied into `~/.config/opencode/plugin/`, where opencode loads every
file in that directory.

opencode 1.19 changed how it loads them. It reads a module's **default**
export and ignores the named ones. A plugin file that exports only a named
function is rejected with:

```
Plugin must export a default definition with an id and an effect or setup
function. (cause: SchemaError(Missing key at ["default"])))
```

The failure is silent in the UI — it appears only in
`~/.local/share/opencode/log/opencode.log`. The status adapter's copy in
`~/.config/opencode/plugin/` had been failing this way since 2026-10-24,
which is exactly the copy the README tells users to make. AMA's opencode
status still appeared to work, but only because a second, byte-identical
copy was being loaded through the `opencode-synced` plugin.

The Superwhisper integration has the opposite constraint: the plugin it
gates is a third-party bundle that AMA does not own, and it is updated by
npm. Patching it would be overwritten on every upgrade.

## Decision

Every plugin AMA ships exports its plugin function **both ways** — as the
default export and as a named export:

```js
export const AmaStatusPlugin = async () => { /* ... */ };
export default AmaStatusPlugin;
```

The default export is what opencode loads; the named export is what the
unit tests import. opencode ignores the named exports, so nothing is
loaded twice.

A third-party integration is **driven through the contract the third party
already exposes**, never patched. The Superwhisper plugin already decides
whether to notify by asking whether
`/tmp/superwhisper-agent/disabled-<session id>` exists, on every handler.
Writing or deleting that file is therefore the whole control surface, and an
npm update of the third-party bundle changes nothing.

## Consequences

- A plugin that only exports a name fails to load on opencode 1.19 and
  later, with no visible error. Any plugin AMA ships or documents must
  export a default.
- The failure mode is silent, so it has to be read out of the log. The
  README now says where to look.
- The Superwhisper gate depends on a file path in a third-party plugin's
  private state directory. If that plugin changes the convention, the gate
  stops working — but it fails safe: the sessions stay muted, so the
  annoyance returns but no notification is missed.
- The opt-in is per session id and survives a restart, because the marker
  is a file. A new session starts opted out.
