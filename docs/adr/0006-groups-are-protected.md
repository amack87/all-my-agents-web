# 6. Group definitions are protected; only an explicit erase may remove them

Date: 2026-11-04

## Status

Accepted

## Context

The sidebar's groups and order are stored per browser and synced to the server, which every other surface (another browser, the macOS app) adopts. Resolution was last-writer-wins by `updatedAt`, and nothing distinguished a copy that *has* groups from a copy that has none.

Two ways that destroyed the user's groups, both reproduced:

- **The reset button.** `#reset-btn` (the power icon) called `resetAppState()`, which deleted `allmyagents-session-groups` and `allmyagents-session-groups-updated-at` from localStorage. The next render reconciled the now-empty copy against the live sessions, seeding every session into the ungrouped region, stamped it with a fresh `updatedAt`, and pushed it up. Because it was newer, it replaced the server's grouped copy — and every other surface adopted the empty one.
- **The init race.** `init()` awaited `loadSessions()` before `syncGroups()`. The reconcile stamped the local copy with `Date.now()` first, so a blank local copy arrived at the comparison with the newest timestamp of all and won — pushing an empty copy over the server's groups from any browser that had never seen them.

Both ended with the server holding `{groups:{}, order:[], ungroupedOrder:[…every session]}`, which is indistinguishable from a deliberate "I removed all my groups". The groups were not recoverable afterwards.

## Decision

Group definitions are the user's work, not app state. A copy that has **no** groups can never erase a copy that **has** them, unless it says it meant to.

- A copy declares the erasure with `groupsCleared: true`, set only when the user deletes their last group, and cleared again when a group is created. The flag travels with the data, so it survives a reconcile and the sync.
- `pickWinner` in `public/sidebar-sync.js` applies the rule, and **the server resolves with the same function** (`POST /api/sidebar-groups`), so both sides agree on who won. Otherwise the client and the server can disagree and the copy bounces.
- Within the rule, the usual last-writer-wins by `updatedAt` still decides the order.
- The reset button no longer touches the group keys at all, and now asks for confirmation before clearing the host list, zoom and sidebar width.
- `init()` awaits `syncGroups()` **before** `loadSessions()`, so the shared copy is adopted before any local reconcile can stamp it.

## Consequences

- A fresh browser, a cleared site cache or a device that has never seen the groups now adopts the server's groups instead of erasing them. That is the common case, and it was the dangerous one.
- A user who deletes their last group still gets that deletion through: the copy carries `groupsCleared`, which is what lets it replace a copy that has groups.
- The server may keep an older copy whole when the newer one has no groups. The order in the losing copy is discarded with it. This is the deliberate trade: preserving the user's groups beats preserving an order written by a copy that had no groups.
- The rule is self-healing. If any surface still holds the old groups while the server has lost them, that surface's copy wins and the groups come back.
- `groupsCleared` is a new field in the synced payload. `loadGroups()`, `session-order.js`'s `normalize()` and the server's `sanitizeSidebarOrder()` all have to carry it, or the intent is lost on the next render.
- Resolution is no longer a pure function of timestamps, so "newer wins" is no longer the whole story. The rule lives in one pure module with unit tests; keep it there.
