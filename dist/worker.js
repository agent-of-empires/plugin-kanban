// src/shared/board-config.ts
var signal = (id, title, rules) => ({
  id,
  title,
  kind: "signal",
  rules,
  on_enter: "none"
});
var stage = (id, title) => ({ id, title, kind: "stage", rules: [], on_enter: "none" });
var anyTone = (value) => [
  { field: { plugin_id: "*", slot_id: "*", attr: "tone" }, op: "is", value }
];
var DEFAULT_CONFIG = {
  version: 1,
  columns: [
    signal("action-needed", "Action needed", [
      [{ field: "status", op: "is", value: "Waiting" }],
      [{ field: "urgent", op: "is", value: true }],
      [{ field: "pending_approvals", op: "is set" }],
      anyTone("danger"),
      anyTone("warn")
    ]),
    signal("error", "Error", [
      [{ field: "status", op: "is", value: "Error" }],
      [{ field: "last_error", op: "is set" }]
    ]),
    stage("in-progress", "In progress"),
    stage("needs-testing", "Needs testing"),
    stage("waiting-for-review", "Waiting for review"),
    stage("done", "Done")
  ]
};
var SESSION_FIELDS = ["status", "urgent", "unread", "pending_approvals", "last_error"];
var OPS = ["is", "is not", "is set", "is empty"];
var ON_ENTER = ["none", "archive", "trash"];
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isName = (v) => typeof v === "string" && v.length > 0;
function onlyKeys(obj, keys, where) {
  const extra = Object.keys(obj).find((k) => !keys.includes(k));
  if (extra !== void 0) throw new Error(`${where}: unknown key "${extra}"`);
}
function checkField(field, where) {
  if (SESSION_FIELDS.includes(field)) return;
  if (!isRecord(field)) throw new Error(`${where}: unknown field`);
  if ("facet_id" in field) {
    onlyKeys(field, ["plugin_id", "facet_id"], where);
    if (!isName(field.plugin_id) || !isName(field.facet_id)) throw new Error(`${where}: plugin_id and facet_id required`);
    return;
  }
  onlyKeys(field, ["plugin_id", "slot_id", "attr"], where);
  if (!isName(field.plugin_id) || !isName(field.slot_id)) throw new Error(`${where}: plugin_id and slot_id required`);
  if (field.attr !== "tone" && field.attr !== "text") throw new Error(`${where}: attr must be tone or text`);
}
function checkCondition(c, where) {
  if (!isRecord(c)) throw new Error(`${where}: not an object`);
  onlyKeys(c, ["field", "op", "value"], where);
  checkField(c.field, where);
  if (!OPS.includes(c.op)) throw new Error(`${where}: unknown op`);
  const needsValue = c.op === "is" || c.op === "is not";
  const hasValue = ["string", "number", "boolean"].includes(typeof c.value);
  if (needsValue !== hasValue) throw new Error(`${where}: "${String(c.op)}" ${needsValue ? "needs" : "takes no"} value`);
  if (typeof c.value === "number" && !Number.isFinite(c.value)) throw new Error(`${where}: value must be a finite number`);
}
function checkColumn(col, where) {
  if (!isRecord(col)) throw new Error(`${where}: not an object`);
  onlyKeys(col, ["id", "title", "kind", "rules", "on_enter"], where);
  if (!isName(col.id)) throw new Error(`${where}: id required`);
  if (!isName(col.title)) throw new Error(`${where}: title required`);
  if (col.kind !== "stage" && col.kind !== "signal") throw new Error(`${where}: kind must be stage or signal`);
  if (!ON_ENTER.includes(col.on_enter)) throw new Error(`${where}: on_enter must be none, archive or trash`);
  if (!Array.isArray(col.rules)) throw new Error(`${where}: rules must be an array`);
  if (col.kind === "stage" && col.rules.length > 0) throw new Error(`${where}: Stage columns take no rules`);
  col.rules.forEach((rule, r) => {
    if (!Array.isArray(rule) || rule.length === 0) throw new Error(`${where} rule ${r}: needs conditions`);
    rule.forEach((c, i) => checkCondition(c, `${where} rule ${r} condition ${i}`));
  });
}
function parseConfig(value) {
  try {
    if (!isRecord(value)) throw new Error("config: not an object");
    onlyKeys(value, ["version", "columns"], "config");
    if (value.version !== 1) throw new Error("config: unsupported version");
    if (!Array.isArray(value.columns)) throw new Error("config: columns must be an array");
    value.columns.forEach((col, i) => checkColumn(col, `column ${i}`));
    const columns = value.columns;
    if (new Set(columns.map((c) => c.id)).size !== columns.length) throw new Error("config: duplicate column id");
    if (!columns.some((c) => c.kind === "stage")) throw new Error("config: needs at least one Stage column");
    return { ok: true, config: value };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// src/worker/rpc.ts
import { createInterface } from "node:readline";
var TIMEOUT_MS = Number(process.env.KANBAN_RPC_TIMEOUT_MS) || 1e4;
var isRecord2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function connect(log2, onNotification2, onClose) {
  let nextId = 1;
  const pending = /* @__PURE__ */ new Map();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log2("ignored a line that is not JSON");
      return;
    }
    if (!isRecord2(msg)) {
      log2("ignored a message that is not an object");
      return;
    }
    if (typeof msg.method === "string") {
      onNotification2(msg.method, msg.params);
      return;
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : void 0;
    if (!p) {
      log2("ignored a reply to no pending request");
      return;
    }
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (isRecord2(msg.error)) p.reject(new Error(String(msg.error.message ?? "host error")));
    else p.resolve(msg.result);
  });
  lines.on("close", onClose);
  return (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
  });
}

// src/worker/main.ts
var log = (msg) => console.error(`[kanban] ${msg}`);
var errorText = (e) => e instanceof Error ? e.message : String(e);
var STAGE_KEY = "stage";
var CONFIG_KEY = "config";
var SNAPSHOT_MAX_BYTES = 64 * 1024;
var config = DEFAULT_CONFIG;
var stages = /* @__PURE__ */ new Map();
var hydrated = false;
var lastPublished;
var snapshotJson = (s, c) => JSON.stringify({ stages: Object.fromEntries(s), config: c });
var tooBig = (json) => Buffer.byteLength(json) > SNAPSHOT_MAX_BYTES;
log(`worker started (plugin ${process.env.AOE_PLUGIN_ID ?? "unknown"})`);
var call = connect(log, onNotification, () => {
  log("stdin closed, exiting");
  process.exit(0);
});
function publish(force) {
  const json = snapshotJson(stages, config);
  if (!force && json === lastPublished) return;
  if (tooBig(json)) {
    log(`snapshot is ${Buffer.byteLength(json)} bytes, over the ${SNAPSHOT_MAX_BYTES} byte cap; not published`);
    return;
  }
  lastPublished = json;
  call("ui.state.set", { slot: "page", id: "board", payload: JSON.parse(json) }).catch(
    (e) => log(`publishing the snapshot failed: ${errorText(e)}`)
  );
}
async function listSessionIds() {
  const result = await call("sessions.list", {}).catch((e) => log(`sessions.list failed: ${errorText(e)}`));
  const sessions = isRecord2(result) ? result.sessions : void 0;
  if (!Array.isArray(sessions) || !sessions.every((s) => isRecord2(s) && typeof s.id === "string")) {
    if (result !== void 0) log("sessions.list returned a malformed list");
    return void 0;
  }
  return new Set(sessions.map((s) => s.id));
}
async function loadConfig() {
  try {
    const result = await call("plugin.storage.get", { key: CONFIG_KEY });
    const value = isRecord2(result) ? result.value : void 0;
    if (value === null || value === void 0) return;
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
  const next = /* @__PURE__ */ new Map();
  for (const id of ids) {
    try {
      const result = await call("session.meta.get", { session_id: id, key: STAGE_KEY });
      const value = isRecord2(result) ? result.value : void 0;
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
async function write(method, params) {
  try {
    await call(method, params);
  } catch (e) {
    hydrated = false;
    throw e;
  }
}
async function setStage(params) {
  const { sessionId, columnId } = isRecord2(params) ? params : {};
  if (typeof sessionId !== "string" || !sessionId || columnId !== null && typeof columnId !== "string") {
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
async function setConfig(params) {
  const parsed = parseConfig(isRecord2(params) ? params.config : void 0);
  if (!parsed.ok) {
    log(`ignored config.set: ${parsed.error}`);
    return;
  }
  if (tooBig(snapshotJson(stages, parsed.config))) {
    log("ignored config.set: the snapshot would exceed its size cap");
    return;
  }
  await write("plugin.storage.set", { key: CONFIG_KEY, value: parsed.config });
  config = parsed.config;
  publish(true);
}
var handlers = /* @__PURE__ */ new Map([
  ["stage.set", setStage],
  ["config.set", setConfig],
  ["session.status.changed", resync]
]);
var queue = Promise.resolve();
function enqueue(name, task) {
  queue = queue.then(task).catch((e) => log(`${name} failed: ${errorText(e)}`));
}
function onNotification(method, params) {
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
