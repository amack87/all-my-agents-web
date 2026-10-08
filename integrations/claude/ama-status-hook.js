// AMA status hook for Claude Code.
//
// Claude Code invokes this command for each configured hook event, passing the
// hook payload as JSON on stdin. We translate the Claude event name into AMA's
// canonical status vocabulary and POST it to the local AMA server, carrying the
// surface token that the pane was launched with. Claude Code has no session id
// that maps into AMA's registry, so the surface token *is* the identity.
//
// This file is standalone (no imports) and fails open: if there is no token, or
// the server is unreachable, it prints nothing and exits 0 so the agent is
// never blocked. The pane's screen-scraping fallback covers any gap.
//
// Install: point Claude's hook settings at this file (see
// integrations/claude/settings.example.json and the README). The running
// process inherits AMA_SURFACE_TOKEN from the tmux pane environment.

import { pathToFileURL } from "node:url";

// Must match SURFACE_TOKEN_ENV in ../../surface-token.js. Declared locally so
// the hook stays a self-contained drop-in with no relative imports.
const SURFACE_TOKEN_ENV = "AMA_SURFACE_TOKEN";

const POST_TIMEOUT_MS = 1500;

// Claude hook event name -> canonical AMA event. Anything absent is ignored.
const HOOK_EVENT_MAP = {
  SessionStart: "sessionStart",
  UserPromptSubmit: "promptSubmit",
  PreToolUse: "toolStart",
  PostToolUse: "toolEnd",
  PermissionRequest: "permissionRequest",
  Notification: "notification",
  Stop: "stop",
  SessionEnd: "sessionEnd",
};

// Tools that mean Claude is asking the user a question or waiting on approval —
// those turn a PreToolUse into a "needs input" signal rather than telemetry.
const ATTENTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function mapHookEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const name = payload.hook_event_name || payload.event;
  if (name === "PreToolUse" && ATTENTION_TOOLS.has(payload.tool_name)) {
    return "permissionRequest";
  }
  return HOOK_EVENT_MAP[name] || null;
}

function resolveToken(env = globalThis.process?.env) {
  if (!env) return null;
  const token = env[SURFACE_TOKEN_ENV];
  return typeof token === "string" && token.length > 0 ? token : null;
}

function resolveBaseUrl(env = globalThis.process?.env ?? {}) {
  if (env.ALL_MY_AGENTS_URL) {
    return env.ALL_MY_AGENTS_URL.replace(/\/+$/, "");
  }
  return `http://127.0.0.1:${env.ALL_MY_AGENTS_PORT ?? 3456}`;
}

function buildBody(event, token) {
  return { event, surfaceToken: token };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const event = mapHookEvent(payload);
  const token = resolveToken();
  if (!event || !token) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(`${resolveBaseUrl()}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(event, token)),
      signal: controller.signal,
    });
  } catch {
    // fail open — never block or error the agent
  } finally {
    clearTimeout(timer);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(() => {}).finally(() => process.exit(0));
}

export { HOOK_EVENT_MAP, mapHookEvent, resolveToken, resolveBaseUrl, buildBody };