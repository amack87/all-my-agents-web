# 1. Sidebar order is manual; status no longer sorts tiles

Date: 2026-10-07

## Status

Accepted

## Context

The sidebar was ordered live by status on every poll — `needsInput → working → idle → ended → unknown`, ties broken by activity. The intent was an attention-first dashboard, but in practice tiles jumped position whenever any session changed state, which is disorienting. Users want to decide where their tiles sit.

The arrangement is stored per browser, alongside groups, in `localStorage` (key `allmyagents-session-groups`).

## Decision

Manual order is the sidebar's sole ordering authority. A tile's position is whatever the user set; status is shown by the status dot and label only and never reflows the list.

Specifics:

- Persisted order covers both group contents (each group's ordered member list) and the ungrouped region (a dedicated ordered list).
- Groups themselves are ordered and reorderable by dragging their header.
- A brand-new, never-placed session appears at the top of the ungrouped region.
- A session that was previously placed and momentarily disappears returns to its stored position.
- Tiles are rearranged by dragging a dedicated **drag handle** (Pointer Events, so mouse and touch share one path), which preserves tap-to-open and the long-press/right-click context menu.

## Consequences

- The sidebar loses automatic attention-ordering. Mitigation: status remains visible on every tile, and a future "sort by status" action could re-seed the manual order on demand.
- Order is per-browser (`localStorage`), not synced across devices or peers — consistent with how groups already behave.
- The persisted order must tolerate churn: stale keys are pruned, keys whose machine host changed are re-resolved by name, and new keys are seeded (top of ungrouped).
- Tile status-sort priority (`needsInput → working → idle → ended → unknown`) still governs the `/api/sessions` response and mesh aggregation; it is simply no longer what positions tiles in the sidebar.