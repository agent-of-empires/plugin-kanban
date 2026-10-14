import { expect, test } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/shared/board-config";

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
  ["bad plugin attr", withColumns([stage, { ...stage, id: "g", kind: "signal", rules: [[{ field: { plugin_id: "p", slot_id: "s", attr: "color" }, op: "is set" }]] }]), "attr must be"],
])("rejects %s", (_name, value, error) => {
  const result = parseConfig(value);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error).toContain(error);
});
