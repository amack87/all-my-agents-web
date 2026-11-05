// Pure helpers for keeping the browser grid and the server's PTY the same size.
//
// The browser owns the grid: it measures the terminal container and decides
// how many columns and rows fit. The server owns a PTY with a size of its own,
// and tmux sizes the shared pane from the client whose size last *changed*.
//
// The two drift apart whenever the page is not the one being looked at: a
// background tab is not laid out, and a phone that was in another app does not
// report its new viewport until it is shown again. A stale grid never changes,
// so no resize frame is ever sent and the far end keeps the size the page had
// when it went stale - the phone's size, when the user moves to the desktop.
//
// Hence the two rules encoded here:
//   - tell the far end only when the size really changed (tmux ignores a
//     resize that does not change the client's size, and the server has
//     nothing to learn from a repeat);
//   - never let a size that is not positive reach the PTY (node-pty refuses
//     it, and the server would otherwise write the raw frame into the
//     terminal).

/** A size the far end can actually use: positive, whole numbers. */
export function isUsableSize(size) {
  return (
    !!size &&
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols > 0 &&
    size.rows > 0
  );
}

/** True when both sizes describe the same grid. */
export function sameSize(a, b) {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

/**
 * The resize frame to send for `next`, or null when there is nothing to send:
 * the size is unusable, or the far end already has it.
 */
export function resizeFrame(known, next) {
  if (!isUsableSize(next)) return null;
  if (sameSize(known, next)) return null;
  return { type: "resize", cols: next.cols, rows: next.rows };
}

/**
 * The size carried by an untrusted frame, or null when it does not carry a
 * usable one.
 */
export function readSize(msg) {
  if (!msg || typeof msg !== "object") return null;
  const cols = Number(msg.cols);
  const rows = Number(msg.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}
