// The lease on the shared pane.
//
// A tmux session can be watched by several devices at once. tmux gives the
// shared window to the client whose size last *changed*, so a device that
// attaches - a second tab, a phone that wakes up - takes the pane away from
// the device the user is actually looking at, and the pane keeps that size
// until somebody re-asserts.
//
// The lease is the server's answer to that: one device holds the pane, and it
// holds it until another device says the user has just been there. The device
// the user touched most recently wins; a device that has never been touched
// never takes the pane from one that has.
//
// Pure module: the server keeps the lease, this file decides who holds it.

/** How long a holder may be silent before its lease is up for grabs. */
export const LEASE_TTL_MS = 8000;

/** A lease nobody holds. */
export function createLease() {
  return { holder: null, holderAt: null, seenAt: 0 };
}

/**
 * Ask for the pane.
 *
 * `request.holder` identifies the asking device. `request.interactedAt` is the
 * server-clock time of that device's last interaction with the page, or null
 * when the user has not touched it. `now` is the current server time.
 *
 * Returns whether the request wins and the lease that follows from it.
 */
export function requestLease(lease, request, now) {
  const holder = lease.holder;
  const sameHolder = holder !== null && holder === request.holder;
  const expired = holder === null || now - lease.seenAt >= LEASE_TTL_MS;

  if (expired || sameHolder) {
    return {
      granted: true,
      lease: {
        holder: request.holder,
        holderAt: sameHolder ? later(lease.holderAt, request.interactedAt) : request.interactedAt ?? null,
        seenAt: now,
      },
    };
  }

  // Somebody else holds the pane. The device the user touched most recently
  // takes it; a tie leaves it where it is, so two devices claiming at the same
  // moment do not take the pane from each other in turn.
  const mine = request.interactedAt;
  const theirs = lease.holderAt;
  if (mine !== null && mine !== undefined && (theirs === null || theirs === undefined || mine > theirs)) {
    return {
      granted: true,
      lease: { holder: request.holder, holderAt: mine, seenAt: now },
    };
  }

  return { granted: false, lease };
}

/**
 * Give the pane up, so that another device can take it without waiting for
 * the lease to time out.
 */
export function releaseLease(lease, holder) {
  if (lease.holder !== holder) return lease;
  return { holder: null, holderAt: null, seenAt: 0 };
}

/** The later of two interaction times; null means "never touched". */
function later(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}
