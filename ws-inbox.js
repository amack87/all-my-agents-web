// A mailbox for websocket frames that arrive before the handler is ready.
//
// The first frame a terminal client sends is its resize, and that frame is
// the only thing that tells the server how big the PTY should be. Any await
// between accepting the socket and attaching the message listener loses it:
// the socket discards frames that arrive while no listener is attached, and a
// lost resize means a PTY that is never spawned — a terminal that stays
// black until the user hits reconnect.
//
// The inbox keeps those frames and replays them, in order, once the handler
// declares itself ready.
//
// This module must stay free of ws/fs/network side effects so the rule is
// unit-testable.

export function createInbox() {
  let ready = false;
  let frames = [];

  return {
    get isReady() {
      return ready;
    },
    get size() {
      return frames.length;
    },
    // Hand a frame over. Returns true when the caller should handle it now,
    // false when the inbox kept it for later.
    offer(frame) {
      if (ready) return true;
      frames.push(frame);
      return false;
    },
    // Declare the handler ready and hand back everything kept so far, in the
    // order it arrived. The inbox is empty afterwards.
    open() {
      ready = true;
      const kept = frames;
      frames = [];
      return kept;
    },
  };
}
