# 11. The device being looked at keeps asserting; the pane is granted by a lease

Date: 2026-11-06

## Status

Accepted

## Context

ADR-0010 made the shared pane a thing the browser asks for: the browser sends a claim, and the server hands tmux's window to that client. It works, but a claim was a one-off event — sent when the page came back, and then never again.

That is not enough, because the pane can be taken away at any moment and nothing in the claim says the device is still there:

- a device that attaches — a second tab, a phone whose page reloads — makes tmux give the session's window that client's size, and the window keeps that size after the client goes away. The device the user is looking at does not notice: its own grid did not change, so it has nothing to say, and the pane stays at the wrong size;
- a client whose size changes takes the pane with it, even if it is not the client the user is typing into.

Measured on tmux 3.6b: a desktop client attached at 93x43, a phone client attached at 40x19. The phone's attach gave the pane 40x18. The desktop's next claim took it back to 93x42 — but only because the desktop claimed *again*. Left alone, the desktop kept the phone's pane.

The symptom was a terminal that "regularly resizes to a much smaller size" on the machine the user was actually looking at, with the phone not even in use: the pane had been sized by a device that was no longer there, and nothing ever asked for it back.

## Decision

The device being looked at keeps saying so, and the server decides who may move the pane.

- **The claim repeats.** The browser sends a claim every two seconds while the page is in front — visible and focused. A page in the background never claims: nobody is looking at it, and a device that is not looked at must not fight for the pane.
- **Not every claim is the same.** A claim that follows an interaction — a key, a tap, a scroll — or a return to the page is a *touch*: the user has just said which device this is. A plain claim is a heartbeat: "I am still here".
- **The server grants the pane by a lease** (`pane-lease.js`). The lease belongs to the tmux session, because the pane does. It names one connection as the holder. A touch claim takes the lease from whoever holds it; a heartbeat only holds it while no other device has a fresher claim. The lease expires when its holder stops claiming, so a device that goes away cannot keep the pane.
- **The interaction time is the server's.** The browser says *this is a touch*; the server stamps the time. Two devices never have to agree on a clock, and the device the user touched most recently holds the pane.
- **A device that does not hold the pane may not change its size.** In tmux a client that changes size takes the pane with it, so a size frame from a device that does not hold the lease is ignored. The device still renders — clipped to its old grid — and it takes the pane, and its own size, the moment it is touched.
- A claim that is refused still opens the terminal if it is not open yet: a device that is not looking at the pane still deserves a terminal.

## Alternatives considered

- **The server picks the winner itself.** The server can see every client's size but not which device the user is looking at. It cannot tell a phone propped up on the desk from a laptop in use.
- **Let the last claim win, with no lease.** Two devices that both claim would take the pane from each other, and the pane would flap every two seconds.
- **Use the browser's own clock.** Two phones and a laptop have clocks that disagree by minutes. The lease compares timestamps, so they have to be the server's.
- **Let tmux decide, by making every device claim with its real size.** That is what tmux does today, and it is the bug: a device that is not looked at wins the pane by changing size.
- **Detach the client that does not hold the lease.** It would keep the pane safe, but it would also kill the terminal on a device the user may be about to pick up.

## Consequences

- The pane belongs to the device the user is looking at, and it comes back within two seconds if another device takes it.
- A device that is merely attached — a phone in a pocket, a tab in the background — cannot steal the pane and cannot hold it.
- The user picks the device by touching it. The first keystroke after switching devices takes the pane for that device.
- A device that attaches still takes the pane for as long as it takes the holder's next heartbeat, because tmux sizes the window from the client that attaches. The window is handed back within two seconds.
- The heartbeat is a frame every two seconds per open terminal, and a touch claim is throttled to one per second. The server does two tmux calls for a granted claim, and none for a refused one.
- The rules live in `pane-lease.js` and `public/terminal-size.js`, both pure and shared with the browser, so the browser and the server cannot disagree about what a claim or a touch is.
