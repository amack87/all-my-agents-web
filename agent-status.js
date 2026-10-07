// Screen-derived session status.
//
// Pure: takes captured pane text plus a signal for whether that pane has
// produced output recently, and returns a status string. No I/O — the caller
// (server.js) captures the pane and tracks output activity between polls.

export function detectStatusFromScreen(content, recentOutput = true) {
  // Strip trailing blank lines — capture-pane includes empty pane padding
  const allLines = content.split("\n");
  while (allLines.length > 0 && allLines[allLines.length - 1].trim() === "") {
    allLines.pop();
  }
  const lines = allLines.slice(-25);

  // The Claude Code UI renders a status bar in the last ~4 lines of the pane:
  //   ───────────────────
  //   ❯ (input area)
  //   ───────────────────
  //   ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt  (when working)
  //   ⏵⏵ accept edits on (shift+tab to cycle)                     (when idle — mode indicator only)
  // Only check these bottom lines for status-bar keywords to avoid matching
  // conversation history that happens to contain words like "Generating".
  // Use last 8 lines to account for trailing blank lines, "Checking for updates", etc.
  const statusBarLines = lines.slice(-8);

  // --- Pass 1: Status bar signals (last 5 lines only) ---
  for (const line of statusBarLines) {
    const lower = line.toLowerCase();

    // "esc to interrupt" = agent is actively working on a tool call
    if (lower.includes("esc to interrupt")) return "working";

    // "esc to cancel" = tool approval dialog awaiting input
    if (lower.includes("esc to cancel")) return "needsInput";
  }

  // --- Pass 2: Activity indicators in the content area ---
  // These appear as standalone lines with a leading indicator character,
  // e.g. "· Generating…" or "✻ Computing…" — NOT inside conversation text.
  for (const line of lines) {
    const trimmed = line.trim();

    // Progress indicator with token count (e.g. "✽ 1234 tokens · 5s")
    if (/token/.test(trimmed) && /\d+[ms]/.test(trimmed)) return "working";

    // Activity spinner lines: "✻ Gusting…", "✽ Swirling…", "✢ Befuddling…", "· Generating…"
    // Claude Code uses various Unicode ornament chars as spinners:
    //   ✻ ✽ ✢ ✣ ✤ ✥ · • ○ ◎ ◇ ◈ ☆ ★ ♦ ♢ ✦ ✧ ✩ ✪ ✫ ✬ ✭ ✮ ✯ ✰ ✱ ✲ ✳ ✴ ✵ ✶ ✷ ✸ ✹ ✺ ✼ ❂ ❃ ❇ ❈ ❉ ❊ ❋
    // Pattern: non-ASCII ornament char + space + word + ellipsis.
    // ⏺ is Claude Code's output bullet (NOT a spinner) — excluded via the \u2600-\u2767 range.
    if (/^[\u00B7\u2022\u2600-\u2767\u2720-\u2767\u25CB\u25CE\u25C7\u25C8\u2606\u2605\u2666\u2662]\s+\S+…/.test(trimmed)) return "working";

    // Status bar progress: "Auto · 55.5% · 2 files edited"
    // Only match lines that look like a status bar (start with a keyword, contain middle-dot)
    if (/^(auto|manual)\s+·/i.test(trimmed) && trimmed.includes("%")) return "working";
  }

  // --- Pass 3: Input signals in recent content ---
  for (const line of lines) {
    const lower = line.toLowerCase();

    // Permission prompts
    if (/\(y\/n\)/i.test(lower)) return "needsInput";
    if (lower.includes("allow") && lower.includes("deny")) return "needsInput";
  }

  if (statusBarLines.some((l) => l.includes("ctrl-g to edit"))) return "needsInput";
  if (lines.some((l) => l.includes("Type here to tell"))) return "needsInput";

  // --- Pass 4: Check for command prompt and selection UI (per-line) ---
  // ❯ = Claude Code prompt, › = Codex prompt
  const PROMPT_CHARS = ["❯", "›"];
  let hasCommandPrompt = false;
  let hasSelectionCursor = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const promptChar = PROMPT_CHARS.find((c) => trimmed.startsWith(c));
    if (!promptChar) continue;

    const afterCursor = trimmed.slice(promptChar.length).trim();

    // Selection cursor: prompt char followed by digit + "." on the SAME line (e.g. "❯ 1. Yes")
    if (/^\d+\./.test(afterCursor)) {
      hasSelectionCursor = true;
    } else {
      hasCommandPrompt = true;
    }
  }

  if (hasSelectionCursor) return "needsInput";

  // Prompt visible with no active signals = idle
  if (hasCommandPrompt) return "idle";

  // --- Pass 5: No prompt visible — decide from pane output activity ---
  // A quiet pane with no prompt is at rest (or hung); a pane still producing
  // output is working. Without this signal every non-Claude agent — and any
  // pane whose prompt scrolled out of view — read as "working" forever.
  return recentOutput ? "working" : "idle";
}
