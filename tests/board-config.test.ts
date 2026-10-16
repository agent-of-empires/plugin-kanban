import { expect, test } from "vitest";
import {
  DEFAULT_CONFIG,
  addColumn,
  deleteColumn,
  editColumn,
  enterAction,
  moveColumn,
  newColumnId,
  parseConfig,
  parseConfigJson,
} from "../src/shared/board-config";

const withColumns = (columns: unknown[]) => ({ version: 1, columns });
const stage = { id: "s", title: "S", kind: "stage", rules: [], on_enter: "none" };

test("default config is valid", () => {
  expect(parseConfig(DEFAULT_CONFIG)).toEqual({ ok: true, config: DEFAULT_CONFIG });
});

test("accepts plugin fields and every op", () => {
  const rule = [
    { field: { plugin_id: "agent-of-empires.github", slot_id: "pr", attr: "text" }, op: "is not", value: "open" },
    { field: "unread", op: "is empty" },
    { field: "pending_approvals", op: "is", value: 2 },
    { field: { plugin_id: "agent-of-empires.github", facet_id: "github_ci" }, op: "is", value: "ci:failing" },
  ];
  const sig = { id: "x", title: "X", kind: "signal", rules: [rule], on_enter: "trash" };
  expect(parseConfig(withColumns([sig, stage])).ok).toBe(true);
});

test.each([
  ["not an object", null, "config: not an object"],
  ["wrong version", { version: 2, columns: [stage] }, "unsupported version"],
  ["unknown top-level key", { version: 1, columns: [stage], extra: 1 }, 'unknown key "extra"'],
  ["no Stage column", withColumns([]), "at least one Stage column"],
  ["duplicate ids", withColumns([stage, stage]), "duplicate column id"],
  ["empty id", withColumns([{ ...stage, id: "" }]), "id required"],
  ["bad kind", withColumns([{ ...stage, kind: "lane" }]), "kind must be"],
  ["bad on_enter", withColumns([{ ...stage, on_enter: "delete" }]), "on_enter must be"],
  ["rules on a Stage column", withColumns([{ ...stage, rules: [[{ field: "urgent", op: "is set" }]] }]), "take no rules"],
  ["empty rule", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[]] }]), "needs conditions"],
  ["unknown field", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: "cpu", op: "is set" }]] }]), "unknown field"],
  ["unknown op", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: "urgent", op: "~" }]] }]), "unknown op"],
  ["missing value", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: "status", op: "is" }]] }]), "needs value"],
  ["stray value", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: "status", op: "is set", value: "x" }]] }]), "takes no value"],
  ["facet without id", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: { plugin_id: "p", facet_id: "" }, op: "is set" }]] }]), "facet_id required"],
  ["facet with a slot", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: { plugin_id: "p", facet_id: "f", slot_id: "s" }, op: "is set" }]] }]), 'unknown key "slot_id"'],
  ["bad plugin attr", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: { plugin_id: "p", slot_id: "s", attr: "color" }, op: "is set" }]] }]), "attr must be"],
])("rejects %s", (_name, value, error) => {
  const result = parseConfig(value);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error).toContain(error);
});

const ids = (config: { columns: { id: string }[] }) => config.columns.map((c) => c.id);
const valid = (config: unknown) => expect(parseConfig(config)).toEqual({ ok: true, config });

test("edits on the default Board stay valid and keep the shipped Rules", () => {
  const renamed = editColumn(DEFAULT_CONFIG, "action-needed", { title: "Look at me", on_enter: "none" });
  valid(renamed);
  expect(renamed.columns[0]).toEqual({ ...DEFAULT_CONFIG.columns[0], title: "Look at me" });
  expect(renamed.columns.slice(1)).toEqual(DEFAULT_CONFIG.columns.slice(1));

  const moved = moveColumn(DEFAULT_CONFIG, "error", 0);
  valid(moved);
  expect(ids(moved).slice(0, 2)).toEqual(["error", "action-needed"]);
  expect(moved.columns[0]).toBe(DEFAULT_CONFIG.columns[1]);
  expect(moveColumn(DEFAULT_CONFIG, "nope", 0)).toBe(DEFAULT_CONFIG);

  const added = addColumn(DEFAULT_CONFIG, "Blocked", "signal");
  valid(added);
  expect(added.columns.at(-1)).toMatchObject({ title: "Blocked", kind: "signal", rules: [], on_enter: "none" });
  expect(ids(added).slice(0, -1)).toEqual(ids(DEFAULT_CONFIG));

  const deleted = deleteColumn(DEFAULT_CONFIG, "done");
  valid(deleted);
  expect(ids(deleted!)).toEqual(ids(DEFAULT_CONFIG).filter((id) => id !== "done"));
});

test("a rename keeps the Column's id and kind", () => {
  const renamed = editColumn(DEFAULT_CONFIG, "done", { title: "Shipped", on_enter: "none" }).columns.find((c) => c.title === "Shipped");
  expect(renamed).toMatchObject({ id: "done", kind: "stage" });
});

test("the last Stage column cannot be deleted", () => {
  const one = { version: 1 as const, columns: [DEFAULT_CONFIG.columns[0], DEFAULT_CONFIG.columns[5]] };
  expect(deleteColumn(one, "done")).toBeUndefined();
  expect(deleteColumn(one, "action-needed")).toEqual({ version: 1, columns: [DEFAULT_CONFIG.columns[5]] });
});

test("new Column ids are opaque, so a re-added Column never inherits old Stages", () => {
  const first = addColumn(DEFAULT_CONFIG, "Done", "stage").columns.at(-1)!.id;
  const second = addColumn(DEFAULT_CONFIG, "Done", "stage").columns.at(-1)!.id;
  expect(first).not.toBe("done");
  expect(first).not.toBe(second);
  expect(newColumnId(["col-x"])).toMatch(/^col-[0-9a-z]+$/);
});

test("an enter-action is set on add and on edit, and survives parsing", () => {
  const added = addColumn(DEFAULT_CONFIG, "Archive", "stage", "archive");
  valid(added);
  expect(added.columns.at(-1)).toMatchObject({ kind: "stage", on_enter: "archive" });

  const edited = editColumn(DEFAULT_CONFIG, "done", { title: "Done", on_enter: "trash" });
  valid(edited);
  expect(edited.columns.find((c) => c.id === "done")).toEqual({ ...DEFAULT_CONFIG.columns[5], on_enter: "trash" });
});

test.each([
  ["stage", "none", undefined],
  ["stage", "archive", "session.archive"],
  ["stage", "trash", "session.trash"],
  ["signal", "archive", undefined],
  ["signal", "trash", undefined],
] as const)("a %s column with on_enter %s triggers %s", (kind, on_enter, method) => {
  expect(enterAction({ id: "c", title: "C", kind, rules: [], on_enter })).toBe(method);
});

test("a missing column triggers nothing", () => {
  expect(enterAction(undefined)).toBeUndefined();
});

test("editColumn replaces one Column's Rules and keeps the rest", () => {
  const rules = [[{ field: "unread" as const, op: "is set" as const }]];
  const edited = editColumn(DEFAULT_CONFIG, "error", { rules });
  valid(edited);
  expect(edited.columns[1]).toEqual({ ...DEFAULT_CONFIG.columns[1], rules });
  expect(edited.columns.filter((c) => c.id !== "error")).toEqual(DEFAULT_CONFIG.columns.filter((c) => c.id !== "error"));
  valid(editColumn(DEFAULT_CONFIG, "action-needed", { rules: [] }));
});

test("a new Signal column can start with Rules", () => {
  const rules = [[{ field: "status" as const, op: "is" as const, value: "Idle" }]];
  const added = addColumn(DEFAULT_CONFIG, "Idle", "signal", "none", rules);
  valid(added);
  expect(added.columns.at(-1)).toMatchObject({ kind: "signal", rules });
});

test("an exported config imports back unchanged", () => {
  const config = addColumn(DEFAULT_CONFIG, "Archive", "stage", "archive");
  expect(parseConfigJson(JSON.stringify(config, null, 2))).toEqual({ ok: true, config });
});

test.each([
  ["invalid JSON", "{ version: 1", "not valid JSON"],
  ["an empty file", "", "not valid JSON"],
  ["a nested unknown key", JSON.stringify(withColumns([{ ...stage, color: "red" }])), 'column 0: unknown key "color"'],
  ["a JSON array", "[]", "config: not an object"],
  [
    "a number too big to store",
    JSON.stringify(withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: "pending_approvals", op: "is", value: 1 }]] }])).replace(
      '"value":1',
      '"value":1e400',
    ),
    "rule 0 condition 0: value must be a finite number",
  ],
])("import rejects %s", (_name, text, error) => {
  const result = parseConfigJson(text);
  expect(result.ok ? "" : result.error).toContain(error);
});

const withSend = (send: unknown) => ({
  version: 1,
  columns: [{ id: "s", title: "S", kind: "stage", rules: [], on_enter: "none", send }],
});

test("a Column send takes a label and message with an optional stage", () => {
  expect(parseConfig(withSend({ label: "Fix", message: "do it" })).ok).toBe(true);
  expect(parseConfig(withSend({ label: "Fix", message: "do it", stage: "s" })).ok).toBe(true);
});

test("a Column send rejects an empty message, an unknown key and an over-long message", () => {
  expect(parseConfig(withSend({ label: "Fix", message: "" })).ok).toBe(false);
  expect(parseConfig(withSend({ label: "Fix", message: "x", extra: 1 })).ok).toBe(false);
  expect(parseConfig(withSend({ label: "Fix", message: "x".repeat(4_001) })).ok).toBe(false);
});
