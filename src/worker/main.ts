import { type Config, DEFAULT_CONFIG, parseConfig } from "../shared/board-config";
import { connect, isRecord } from "./rpc";

// Diagnostics go to stderr, which the host writes to this worker's log file.
const log = (msg: string) => console.error(`[kanban] ${msg}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Stage lives in session.meta under STAGE_KEY (namespaced per plugin by the
// host), the Board config in plugin.storage under CONFIG_KEY. Both are read
// once at start; this worker is their only writer, so memory stays in sync.
const STAGE_KEY = "stage";
const CONFIG_KEY = "config";
// Host cap on a page slot's ui-state payload, measured on the serialized JSON.
const SNAPSHOT_MAX_BYTES = 64 * 1024;

let config: Config = DEFAULT_CONFIG;
let stages = new Map<string, string>();
// False until a full scan succeeds, and again after a failed write; the next
// status change then reloads config and stages from the host.
let hydrated = false;
let lastPublished: string | undefined;

const snapshotJson = (s: Map<string, string>, c: Config) => JSON.stringify({ stages: Object.fromEntries(s), config: c });
const tooBig = (json: string) => Buffer.byteLength(json) > SNAPSHOT_MAX_BYTES;

log(`worker started (plugin ${process.env.AOE_PLUGIN_ID ?? "unknown"})`);

const call = connect(log, onNotification, () => {
  log("stdin closed, exiting");
  process.exit(0);
});

// Writes always publish, so the dashboard sees the UI revision move after an
// action; resyncs publish only when something changed.
function publish(force: boolean) {
  const json = snapshotJson(stages, config);
  if (!force && json === lastPublished) return;
  if (tooBig(json)) {
    log(`snapshot is ${Buffer.byteLength(json)} bytes, over the ${SNAPSHOT_MAX_BYTES} byte cap; not published`);
    return;
  }
  lastPublished = json;
  call("ui.state.set", { slot: "page", id: "board", payload: JSON.parse(json) }).catch((e) =>
    log(`publishing the snapshot failed: ${errorText(e)}`),
  );
}

// undefined when the host fails or answers with a malformed list, so callers
// never prune live state from a bad answer.
async function listSessionIds(): Promise<Set<string> | undefined> {
  const result = await call("sessions.list", {}).catch((e) => log(`sessions.list failed: ${errorText(e)}`));
  const sessions = isRecord(result) ? result.sessions : undefined;
  if (!Array.isArray(sessions) || !sessions.every((s) => isRecord(s) && typeof s.id === "string")) {
    if (result !== undefined) log("sessions.list returned a malformed list");
    return undefined;
  }
  return new Set(sessions.map((s) => s.id as string));
}

async function loadConfig() {
  try {
    const result = await call("plugin.storage.get", { key: CONFIG_KEY });
    const value = isRecord(result) ? result.value : undefined;
    if (value === null || value === undefined) return;
    const parsed = parseConfig(value);
    if (parsed.ok) config = parsed.config;
    else log(`stored config is invalid (${parsed.error}); using the default`);
  } catch (e) {
    log(`reading the config failed (${errorText(e)}); using the default`);
  }
}

async function hydrate() {
  const ids = await listSessionIds();
  if (!ids) return;
  const next = new Map<string, string>();
  // ponytail: one meta read at a time, so start costs one host round trip per
  // Session; read through a small pool if start gets slow with many Sessions.
  for (const id of ids) {
    try {
      const result = await call("session.meta.get", { session_id: id, key: STAGE_KEY });
      const value = isRecord(result) ? result.value : undefined;
      if (typeof value === "string" && value) next.set(id, value);
    } catch (e) {
      log(`reading the stage of ${id} failed: ${errorText(e)}`);
    }
  }
  stages = next;
  hydrated = true;
}

async function resync() {
  if (!hydrated) {
    await loadConfig();
    await hydrate();
  } else {
    const ids = await listSessionIds();
    if (!ids) return;
    for (const id of stages.keys()) if (!ids.has(id)) stages.delete(id);
  }
  publish(false);
}

// A failed write may still land on the host (a timed-out request can apply
// late), so memory is marked stale for the next resync to reload.
async function write(method: string, params: unknown) {
  try {
    await call(method, params);
  } catch (e) {
    hydrated = false;
    throw e;
  }
}

async function setStage(params: unknown) {
  const { sessionId, columnId } = isRecord(params) ? params : {};
  if (typeof sessionId !== "string" || !sessionId || (columnId !== null && typeof columnId !== "string")) {
    log("ignored stage.set: expected {sessionId, columnId|null}");
    return;
  }
  if (columnId !== null && !config.columns.some((c) => c.id === columnId && c.kind === "stage")) {
    log(`ignored stage.set: "${columnId}" is not a Stage column`);
    return;
  }
  const next = new Map(stages);
  if (columnId === null) next.delete(sessionId);
  else next.set(sessionId, columnId);
  if (tooBig(snapshotJson(next, config))) {
    log("ignored stage.set: the snapshot would exceed its size cap");
    return;
  }
  await write("session.meta.set", { session_id: sessionId, key: STAGE_KEY, value: columnId });
  stages = next;
  publish(true);
}

async function setConfig(params: unknown) {
  const parsed = parseConfig(isRecord(params) ? params.config : undefined);
  if (!parsed.ok) {
    log(`ignored config.set: ${parsed.error}`);
    return;
  }
  // The snapshot embeds the config, so this also bounds the stored value under
  // the host's 64 KiB plugin.storage cap.
  if (tooBig(snapshotJson(stages, parsed.config))) {
    log("ignored config.set: the snapshot would exceed its size cap");
    return;
  }
  await write("plugin.storage.set", { key: CONFIG_KEY, value: parsed.config });
  config = parsed.config;
  publish(true);
}

// The message text comes from the stored Column, never from the page, so the
// page cannot make this worker send arbitrary text. Sessions are messaged one
// at a time; a failure is logged and the rest still go. Delivery failures reach
// the log only. ponytail: surface per-Session results in the snapshot if the
// log proves too hidden.
async function sendMessage(params: unknown) {
  const { columnId, sessionIds } = isRecord(params) ? params : {};
  const send = config.columns.find((c) => c.id === columnId)?.send;
  if (!send || !Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === "string" && id)) {
    log("ignored message.send: expected {columnId with a message, sessionIds}");
    return;
  }
  const moveTo = config.columns.some((c) => c.id === send.stage && c.kind === "stage") ? send.stage : undefined;
  for (const sessionId of sessionIds as string[]) {
    try {
      await call("sessions.message.send", { session_id: sessionId, message: send.message });
    } catch (e) {
      log(`messaging ${sessionId} failed: ${errorText(e)}`);
      continue;
    }
    if (moveTo) await setStage({ sessionId, columnId: moveTo }).catch((e) => log(`moving ${sessionId} failed: ${errorText(e)}`));
  }
}

const handlers = new Map<string, (params: unknown) => Promise<void>>([
  ["stage.set", setStage],
  ["config.set", setConfig],
  ["message.send", sendMessage],
  ["session.status.changed", resync],
]);

// One task at a time, so a write never interleaves with the start scan or a
// resync. A failed task is logged and the queue moves on.
let queue = Promise.resolve();
function enqueue(name: string, task: () => Promise<void>) {
  queue = queue.then(task).catch((e) => log(`${name} failed: ${errorText(e)}`));
}

function onNotification(method: string, params: unknown) {
  const handler = handlers.get(method);
  if (!handler) {
    log(`ignored unknown method ${method}`);
    return;
  }
  enqueue(method, () => handler(params));
}

enqueue("start", async () => {
  await loadConfig();
  await hydrate();
  publish(true);
});
