// Board config: the Columns and their Rules. Shared by the worker, which
// validates and persists it, and the page, which edits and evaluates it. No
// Node or DOM imports.

export type SessionField = "status" | "urgent" | "unread" | "pending_approvals" | "last_error";

// A plugin row-column value; "*" matches any plugin or slot.
export interface PluginField {
  plugin_id: string;
  slot_id: string;
  attr: "tone" | "text";
}

// One of a plugin's `filter-facet` entries, such as GitHub's "CI": the values
// its row column lists in `filter_values` among the facet's options.
export interface FacetField {
  plugin_id: string;
  facet_id: string;
}

export type Op = "is" | "is not" | "is set" | "is empty";

export interface Condition {
  field: SessionField | PluginField | FacetField;
  op: Op;
  // Present only for "is" and "is not".
  value?: string | number | boolean;
}

export interface Column {
  id: string;
  title: string;
  kind: "stage" | "signal";
  // Flat DNF: conditions AND inside a Rule, Rules OR on a Column. Always empty
  // on Stage columns.
  rules: Condition[][];
  on_enter: "none" | "archive" | "trash";
}

export interface Config {
  version: 1;
  columns: Column[];
}

const signal = (id: string, title: string, rules: Condition[][]): Column => ({
  id,
  title,
  kind: "signal",
  rules,
  on_enter: "none",
});
const stage = (id: string, title: string): Column => ({ id, title, kind: "stage", rules: [], on_enter: "none" });
const anyTone = (value: string): Condition[] => [
  { field: { plugin_id: "*", slot_id: "*", attr: "tone" }, op: "is", value },
];

export const DEFAULT_CONFIG: Config = {
  version: 1,
  columns: [
    signal("action-needed", "Action needed", [
      [{ field: "status", op: "is", value: "Waiting" }],
      [{ field: "urgent", op: "is", value: true }],
      [{ field: "pending_approvals", op: "is set" }],
      [{ field: "unread", op: "is", value: true }],
      anyTone("danger"),
      anyTone("warn"),
    ]),
    signal("error", "Error", [
      [{ field: "status", op: "is", value: "Error" }],
      [{ field: "last_error", op: "is set" }],
    ]),
    stage("in-progress", "In progress"),
    stage("needs-testing", "Needs testing"),
    stage("waiting-for-review", "Waiting for review"),
    stage("done", "Done"),
  ],
};

// Column edits made by the page. Each returns a new config and keeps every
// field it does not change, so the shipped Rules survive a rename or a move.

// Opaque and never derived from the title: Sessions keep a deleted Stage
// column's id in their metadata, so a reused id would pull them back in.
export function newColumnId(taken: readonly string[]): string {
  let id: string;
  do id = `col-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  while (taken.includes(id));
  return id;
}

export function addColumn(
  config: Config,
  title: string,
  kind: Column["kind"],
  on_enter: Column["on_enter"] = "none",
  rules: Condition[][] = [],
): Config {
  const id = newColumnId(config.columns.map((c) => c.id));
  return { ...config, columns: [...config.columns, { id, title, kind, rules, on_enter }] };
}

export const editColumn = (config: Config, id: string, changes: Partial<Pick<Column, "title" | "on_enter" | "rules">>): Config => ({
  ...config,
  columns: config.columns.map((c) => (c.id === id ? { ...c, ...changes } : c)),
});

// The bridge method a Card dropped onto `column` triggers. Only Stage columns
// take drops, so a Signal column's on_enter never fires.
export function enterAction(column: Column | undefined): "session.archive" | "session.trash" | undefined {
  if (column?.kind !== "stage" || column.on_enter === "none") return undefined;
  return column.on_enter === "archive" ? "session.archive" : "session.trash";
}

// undefined when `id` is the last Stage column, which the Board cannot lose.
export function deleteColumn(config: Config, id: string): Config | undefined {
  const columns = config.columns.filter((c) => c.id !== id);
  return columns.some((c) => c.kind === "stage") ? { ...config, columns } : undefined;
}

export function moveColumn(config: Config, id: string, to: number): Config {
  const columns = config.columns.filter((c) => c.id !== id);
  const moved = config.columns.find((c) => c.id === id);
  if (!moved) return config;
  columns.splice(to, 0, moved);
  return { ...config, columns };
}

export type ParseResult ={ ok: true; config: Config } | { ok: false; error: string };

const SESSION_FIELDS: readonly unknown[] = ["status", "urgent", "unread", "pending_approvals", "last_error"];
export const OPS: readonly Op[] = ["is", "is not", "is set", "is empty"];
const ON_ENTER: readonly unknown[] = ["none", "archive", "trash"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Throws a message naming the first unexpected key.
function onlyKeys(obj: Record<string, unknown>, keys: readonly string[], where: string) {
  const extra = Object.keys(obj).find((k) => !keys.includes(k));
  if (extra !== undefined) throw new Error(`${where}: unknown key "${extra}"`);
}

function checkField(field: unknown, where: string) {
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

function checkCondition(c: unknown, where: string) {
  if (!isRecord(c)) throw new Error(`${where}: not an object`);
  onlyKeys(c, ["field", "op", "value"], where);
  checkField(c.field, where);
  if (!(OPS as readonly unknown[]).includes(c.op)) throw new Error(`${where}: unknown op`);
  const needsValue = c.op === "is" || c.op === "is not";
  const hasValue = ["string", "number", "boolean"].includes(typeof c.value);
  if (needsValue !== hasValue) throw new Error(`${where}: "${String(c.op)}" ${needsValue ? "needs" : "takes no"} value`);
  // JSON.parse reads 1e400 as Infinity, which JSON.stringify then writes as null.
  if (typeof c.value === "number" && !Number.isFinite(c.value)) throw new Error(`${where}: value must be a finite number`);
}

function checkColumn(col: unknown, where: string) {
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

export function parseConfig(value: unknown): ParseResult {
  try {
    if (!isRecord(value)) throw new Error("config: not an object");
    onlyKeys(value, ["version", "columns"], "config");
    if (value.version !== 1) throw new Error("config: unsupported version");
    if (!Array.isArray(value.columns)) throw new Error("config: columns must be an array");
    value.columns.forEach((col, i) => checkColumn(col, `column ${i}`));
    const columns = value.columns as Column[];
    if (new Set(columns.map((c) => c.id)).size !== columns.length) throw new Error("config: duplicate column id");
    if (!columns.some((c) => c.kind === "stage")) throw new Error("config: needs at least one Stage column");
    return { ok: true, config: value as unknown as Config };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// For an imported file or pasted text.
export function parseConfigJson(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  return parseConfig(value);
}
