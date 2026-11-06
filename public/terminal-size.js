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
// Hence the three rules encoded here:
//   - tell the far end the new size when the size really changed (tmux
//     ignores a resize that does not change the client's size, and the server
//     has nothing to learn from a repeat);
//   - say out loud which device is being looked at, with a claim frame, when
//     the page comes back - an unchanged size never reaches tmux, so the pane
//     would stay with the device that is not being looked at;
//   - never let a size that is not positive reach the PTY (node-pty refuses
//     it, and the server would otherwise write the raw frame into the
//     terminal).
//
// A claim is not a one-off event: another device can take the pane at any
// moment - a second tab, a phone that wakes up - so the device that is being
// looked at keeps saying so. The claim repeats while the page is in front
// (visible and focused); a page in the background never claims, because it is
// not being looked at.
//
// Two claims are not the same. A claim that follows an interaction (a key, a
// tap, a scroll) or a return to the page is a *touch*: the user has just said
// which device this is, so it wins the pane from whatever device was holding
// it. A plain claim is a heartbeat: "I am still here", and it only holds the
// pane as long as no other device has a fresher claim.

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

/**
 * The frame a browser sends to say "this is the device being looked at".
 *
 * A claim carries the grid as well as the claim, because the grid may have
 * changed while the page was in the background.
 */
export const CLAIM_FRAME_TYPE = "claim";

/**
 * The claim frame for a size, or null when the size is unusable.
 *
 * A touch is a claim that follows an interaction or a return to the page: the
 * user has just said which device this is, so it wins the pane from whatever
 * device was holding it.
 */
export function claimFrame(size, { touch = false } = {}) {
  if (!isUsableSize(size)) return null;
  const frame = { type: CLAIM_FRAME_TYPE, cols: size.cols, rows: size.rows };
  if (touch) frame.touch = true;
  return frame;
}

/** How often a browser that is in front repeats its claim. */
export const CLAIM_HEARTBEAT_MS = 2000;

/**
 * Whether a browser should repeat its claim now.
 *
 * Only a page that is in front (open, visible and focused) may keep claiming.
 * A page in the background is not being looked at, and must not fight the
 * device the user is working on for the shared pane. Who wins a claim that
 * two devices make at the same time is the server's business, not the
 * browser's.
 */
export function shouldHeartbeat({ open, visible, focused }) {
  return !!open && !!visible && !!focused;
}

/**
 * How long a page keeps saying "the user just used this device" after the
 * last interaction.
 */
export const TOUCH_TTL_MS = 15000;

/**
 * Whether the user has used this page recently enough that its claims count
 * as a touch.
 *
 * A touch wins the shared pane from whatever device was holding it. A page
 * that has not been touched says only that it is still here.
 */
export function isTouched(lastInputAt, now = Date.now()) {
  if (!Number.isFinite(lastInputAt)) return false;
  return now - lastInputAt <= TOUCH_TTL_MS;
}
