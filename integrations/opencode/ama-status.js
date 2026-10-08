// All My Agents — opencode status adapter
//
// opencode plugin that reports opencode session lifecycle as All My Agents
// "canonical status events", so the sidebar reflects working / needs-input /
// idle without scraping the screen.
//
// Install: copy this file into opencode's global plugin directory, e.g.
//   ~/.config/opencode/plugin/ama-status.js      (older opencode: singular)
//   ~/.config/opencode/plugins/ama-status.js     (newer opencode: plural)
// On this machine opencode 1.18.35 loads `~/.config/opencode/plugin/`.
// A project-local `.opencode/plugin(s)/` copy works the same way.
//
// It is standalone and dependency-free. It fails open: if AMA is unreachable
// (or rejects the event because the session is unknown), opencode is
// completely unaffected.
//
// NOTE ON SHAPE: opencode's legacy plugin loader iterates every export of the
// module and throws unless each one is a plugin function. So this module
// exports exactly one function. The pure mapping helpers used by the unit
// tests hang off that function as `AmaStatusPlugin.helpers` — visible to
// `import`, invisible to the loader.

const POST_TIMEOUT_MS = 1500;

const BUS_EVENTS = {
  "session.created": "sessionStart",
  "session.idle": "stop",
  "session.deleted": "sessionEnd",
  "permission.updated": "permissionRequest",
  "permission.asked": "permissionRequest",
};

const HOOK_EVENTS = {
  "chat.message": "promptSubmit",
  "tool.execute.before": "toolStart",
  "tool.execute.after": "toolEnd",
  "permission.ask": "permissionRequest",
};

function canonicalBusEvent(type) {
  return BUS_EVENTS[type] ?? null;
}

function sessionIdFromBusProps(event) {
  const properties = event?.properties;
  if (!properties || typeof properties !== "object") return null;
  if (typeof properties.sessionID === "string") return properties.sessionID;

  const info = properties.info;
  if (info && typeof info === "object") {
    if (typeof info.sessionID === "string") return info.sessionID;
    if (typeof info.id === "string") return info.id;
  }

  const part = properties.part;
  if (part && typeof part === "object" && typeof part.sessionID === "string") {
    return part.sessionID;
  }

  return null;
}

function resolveBaseUrl(env = globalThis.process?.env ?? {}) {
  if (env.ALL_MY_AGENTS_URL) return String(env.ALL_MY_AGENTS_URL).replace(/\/+$/, "");
  return `http://127.0.0.1:${env.ALL_MY_AGENTS_PORT ?? 3456}`;
}

export const AmaStatusPlugin = async () => {
  const baseUrl = resolveBaseUrl();

  const started = new Set();
  const chains = new Map();

  async function post(event, sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, sessionId }),
        signal: controller.signal,
      });
    } catch {
      // fail open: network error, timeout, or non-2xx all ignored
    } finally {
      clearTimeout(timer);
    }
  }

  function enqueue(sessionId, event) {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => post(event, sessionId)).catch(() => {});
    chains.set(sessionId, next);
    return next;
  }

  function emit(sessionId, event) {
    if (!sessionId || !event) return;

    if (event === "sessionStart") {
      if (!started.has(sessionId)) {
        started.add(sessionId);
        enqueue(sessionId, "sessionStart");
      }
      return;
    }

    if (event === "sessionEnd") {
      if (started.has(sessionId)) {
        started.delete(sessionId);
        enqueue(sessionId, "sessionEnd");
      }
      return;
    }

    // Any other event implies the session exists: announce it first so the
    // server never sees a prompt/tool event before its sessionStart.
    if (!started.has(sessionId)) {
      started.add(sessionId);
      enqueue(sessionId, "sessionStart");
    }
    enqueue(sessionId, event);
  }

  return {
    event: async ({ event }) => {
      const canonical = canonicalBusEvent(event?.type);
      if (!canonical) return;
      emit(sessionIdFromBusProps(event), canonical);
    },
    "chat.message": async (input) => {
      emit(input?.sessionID, HOOK_EVENTS["chat.message"]);
    },
    "tool.execute.before": async (input) => {
      emit(input?.sessionID, HOOK_EVENTS["tool.execute.before"]);
    },
    "tool.execute.after": async (input) => {
      emit(input?.sessionID, HOOK_EVENTS["tool.execute.after"]);
    },
    "permission.ask": async (input) => {
      emit(input?.sessionID, HOOK_EVENTS["permission.ask"]);
    },
    dispose: async () => {
      for (const sessionId of [...started]) emit(sessionId, "sessionEnd");
      await Promise.allSettled([...chains.values()]);
    },
  };
};

AmaStatusPlugin.helpers = {
  canonicalBusEvent,
  sessionIdFromBusProps,
  resolveBaseUrl,
  HOOK_EVENTS,
};