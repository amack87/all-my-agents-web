// Superwhisper notifications, per session, on demand.
//
// The official @superwhisper/opencode plugin notifies you whenever an agent
// finishes. That is right when you are waiting on one agent and wrong when
// you have five. This plugin makes the notification opt-in per session:
//
//   /enable-superwhisper   notifications for THIS session
//   /disable-superwhisper  no notifications for this session
//
// It does not patch the third-party bundle. The official plugin keeps its
// per-session state in files under /tmp/superwhisper-agent, and its
// isSessionDisabled() reads `disabled-<sessionId>` on every notification
// handler. Writing or deleting that file is the entire control surface, so
// updating the official plugin keeps working.
//
// The opt-in is recorded in `optin-<sessionId>` next to it, so it survives a
// restart of opencode. It is per session id: a new session starts opted out.
//
// A session is opted out by default, and the flag is written as soon as we
// hear about the session at all — on any bus event that carries its id. That
// is always before the first notification the official plugin could send,
// because an agent cannot finish before it has been prompted.
//
// NOTE ON SHAPE: opencode's plugin loader reads the module's DEFAULT export
// (opencode 1.19 and later) and ignores the named ones, so the plugin is
// exported both ways: the default is what opencode loads, the named export
// is what the unit tests import. The pure helpers the tests need hang off
// that function as `SuperwhisperOptInPlugin.helpers`.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MESSAGE_DIR = "/tmp/superwhisper-agent";

const ENABLE_COMMAND = "enable-superwhisper";
const DISABLE_COMMAND = "disable-superwhisper";

// The official plugin's own file names. Writing `disabled-<id>` is what it
// reads to decide whether a session is muted.
function disabledPath(dir, sessionId) {
  return join(dir, `disabled-${sessionId}`);
}

// Our own marker: this session is opted in. It is separate from the
// official plugin's file so the two can never be confused.
function optinPath(dir, sessionId) {
  return join(dir, `optin-${sessionId}`);
}

// A session id is a path segment in a file name, so it has to be a plain
// string with no separators. Opencode's ids look like `ses_abc123`.
function isUsableSessionId(sessionId) {
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function writeMarker(path) {
  writeFileSync(path, "1");
}

// The bus event shape carries the session id in `properties.sessionID`.
function sessionIdFromEvent(event) {
  const properties = event?.properties;
  if (!properties || typeof properties !== "object") return null;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (properties.info && typeof properties.info.sessionID === "string") {
    return properties.info.sessionID;
  }
  return null;
}

function createState({ dir = DEFAULT_MESSAGE_DIR } = {}) {
  function isOptedIn(sessionId) {
    if (!isUsableSessionId(sessionId)) return false;
    return existsSync(optinPath(dir, sessionId));
  }

  // Mute a session: the official plugin skips every notification for it.
  function setOptedIn(sessionId, optedIn) {
    if (!isUsableSessionId(sessionId)) return;
    mkdirSync(dir, { recursive: true });
    if (optedIn) {
      rmSync(disabledPath(dir, sessionId), { force: true });
      writeMarker(optinPath(dir, sessionId));
    } else {
      rmSync(optinPath(dir, sessionId), { force: true });
      writeMarker(disabledPath(dir, sessionId));
    }
  }

  // Make sure a session that is not opted in is muted. Called as soon as we
  // hear about the session, which is before it can produce any notification.
  function ensureMuted(sessionId) {
    if (!isUsableSessionId(sessionId)) return;
    if (isOptedIn(sessionId)) return;
    mkdirSync(dir, { recursive: true });
    writeMarker(disabledPath(dir, sessionId));
  }

  return { dir, isOptedIn, setOptedIn, ensureMuted, isMuted: (id) => existsSync(disabledPath(dir, id)) };
}

export const SuperwhisperOptInPlugin = async (input) => {
  const env = globalThis.process?.env ?? {};
  const dir = env.SUPERWHISPER_MESSAGE_DIR || DEFAULT_MESSAGE_DIR;
  const state = createState({ dir });

  // A session that already existed when opencode started (a resumed one) may
  // not produce an event before its first notification, so mute the known
  // sessions up front. Best effort: if the client cannot answer, the event
  // hook below still mutes a session the moment it is heard about.
  //
  // This MUST NOT be awaited. opencode builds its plugins before its server
  // answers, and `client` talks to that server, so awaiting here waits on a
  // server that is waiting on this plugin: opencode hangs on a black screen,
  // and a try/catch cannot help because the promise never settles. Start it,
  // return, and let it finish once the server is up.
  Promise.resolve()
    .then(() => input?.client?.session?.list?.())
    .then((listed) => {
      const sessions = Array.isArray(listed) ? listed : (listed?.data ?? []);
      for (const session of sessions) {
        const id = session?.id ?? session?.sessionID;
        if (isUsableSessionId(id)) state.ensureMuted(id);
      }
    })
    .catch(() => {
      // The client is not ready, or the shape is different. The event hook
      // is the real guarantee; this is only a head start.
    });

  return {
    // Any bus event that mentions a session is enough to mute it. Session
    // creation and updates arrive long before the first idle, so the mute is
    // always in place before the official plugin could notify.
    event: async ({ event } = {}) => {
      state.ensureMuted(sessionIdFromEvent(event));
    },

    // The user's first message in a session is a second, independent trigger.
    "chat.message": async (message) => {
      state.ensureMuted(message?.sessionID);
    },

    // The slash command. The opt-in is recorded here so that the message the
    // command itself produces (if it produces one) cannot re-mute the
    // session.
    "command.execute.before": async (command) => {
      const name = String(command?.command ?? "").replace(/^\//, "");
      const sessionId = command?.sessionID;
      if (!sessionId) return;
      if (name === ENABLE_COMMAND) state.setOptedIn(sessionId, true);
      else if (name === DISABLE_COMMAND) state.setOptedIn(sessionId, false);
    },
  };
};

SuperwhisperOptInPlugin.helpers = {
  createState,
  isUsableSessionId,
  sessionIdFromEvent,
  DEFAULT_MESSAGE_DIR,
  ENABLE_COMMAND,
  DISABLE_COMMAND,
};

export default SuperwhisperOptInPlugin;
