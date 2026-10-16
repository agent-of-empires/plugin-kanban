import { expect, test } from "vitest";
import { type Column, type Condition, type Config, DEFAULT_CONFIG } from "../src/shared/board-config";
import { type BridgeSession, type UiEntry, buildBoard, facets, filterBoard, findSnapshot, rowColumnSlots } from "../src/shared/board-model";

const session = (id: string, extra: Partial<BridgeSession> = {}): BridgeSession => ({
  id,
  title: id,
  project_path: `/repos/${id}`,
  tool: "claude",
  status: "Idle",
  archived: false,
  snoozed: false,
  trashed: false,
  ...extra,
});

const rowColumn = (session_id: string, payload: Record<string, unknown>, plugin_id = "p", id = "c"): UiEntry => ({
  plugin_id,
  slot: "row-column",
  id,
  session_id,
  payload,
});

const board = (sessions: BridgeSession[], entries: UiEntry[] = [], stages: Record<string, string> = {}, config = DEFAULT_CONFIG) =>
  buildBoard(sessions, entries, { stages, config });

// Column id of each Card, by Session id.
const placement = (...args: Parameters<typeof board>) =>
  Object.fromEntries(board(...args).flatMap((b) => b.cards.map((c) => [c.session.id, b.column.id])));

const ids = (b: ReturnType<typeof board>, column: string) =>
  b.find((x) => x.column.id === column)!.cards.map((c) => c.session.id);

test("renders the default Columns in order", () => {
  expect(board([]).map((b) => b.column.title)).toEqual([
    "Action needed",
    "Error",
    "In progress",
    "Needs testing",
    "Waiting for review",
    "Done",
  ]);
});

test.each<[string, Partial<BridgeSession>, UiEntry[], string]>([
  ["status Waiting", { status: "Waiting" }, [], "action-needed"],
  ["urgent", { urgent: true }, [], "action-needed"],
  ["pending approvals", { pending_approvals: 2 }, [], "action-needed"],
  ["unread", { unread: true }, [], "action-needed"],
  ["plugin tone danger", {}, [rowColumn("s", { tone: "danger" })], "action-needed"],
  ["plugin tone warn", {}, [rowColumn("s", { tone: "warn" })], "action-needed"],
  ["status Error", { status: "Error" }, [], "error"],
  ["last error set", { last_error: "boom" }, [], "error"],
])("default Rule: %s", (_name, extra, entries, column) => {
  expect(placement([session("s", extra)], entries)).toEqual({ s: column });
});

test.each<[string, Partial<BridgeSession>, UiEntry[]]>([
  ["zero pending approvals", { pending_approvals: 0 }, []],
  ["urgent false", { urgent: false }, []],
  ["null last error", { last_error: null }, []],
  ["plugin tone success", {}, [rowColumn("s", { tone: "success" })]],
  ["danger tone on a row badge", {}, [{ ...rowColumn("s", { tone: "danger" }), slot: "row-badge" }]],
  ["danger tone on another Session", {}, [rowColumn("other", { tone: "danger" })]],
])("no Signal for %s", (_name, extra, entries) => {
  expect(placement([session("s", extra)], entries)).toEqual({ s: "in-progress" });
});

test("leftmost Signal column wins", () => {
  expect(placement([session("s", { status: "Error", urgent: true })])).toEqual({ s: "action-needed" });
  const [action, error, ...stages] = DEFAULT_CONFIG.columns;
  const swapped: Config = { version: 1, columns: [error, action, ...stages] };
  expect(placement([session("s", { status: "Error", urgent: true })], [], {}, swapped)).toEqual({ s: "error" });
});

test("a Signal beats the stored Stage, and the Card carries a stage chip", () => {
  const b = board([session("s", { status: "Waiting" })], [], { s: "needs-testing" });
  expect(b[0].cards[0]).toMatchObject({ stageId: "needs-testing", stageChip: "Needs testing" });
});

test("missing or unknown Stage resolves to the leftmost Stage column", () => {
  expect(placement([session("a"), session("b")], [], { b: "gone" })).toEqual({ a: "in-progress", b: "in-progress" });
  expect(board([session("a")]).flatMap((b) => b.cards)[0]).toMatchObject({ stageId: "in-progress", stageChip: undefined });
});

test("a Session sits in its stored Stage when no Signal matches", () => {
  expect(placement([session("s")], [], { s: "done" })).toEqual({ s: "done" });
});

test("Dismissed Sessions are excluded", () => {
  const sessions = [
    session("a", { archived: true }),
    session("s", { snoozed: true, status: "Waiting" }),
    session("t", { trashed: true }),
    session("live"),
  ];
  expect(placement(sessions)).toEqual({ live: "in-progress" });
});

const signalColumn = (rules: Column["rules"]): Config => ({
  version: 1,
  columns: [
    { id: "sig", title: "Sig", kind: "signal", rules, on_enter: "none" },
    { id: "stage", title: "Stage", kind: "stage", rules: [], on_enter: "none" },
  ],
});
const inSignal = (rules: Column["rules"], s: BridgeSession, entries: UiEntry[] = []) =>
  placement([s], entries, {}, signalColumn(rules)).s === "sig";

test("absent fields never match is, is not or is set, and match is empty", () => {
  const s = session("s");
  expect(inSignal([[{ field: "urgent", op: "is", value: true }]], s)).toBe(false);
  expect(inSignal([[{ field: "urgent", op: "is not", value: true }]], s)).toBe(false);
  expect(inSignal([[{ field: "unread", op: "is set" }]], s)).toBe(false);
  expect(inSignal([[{ field: "unread", op: "is empty" }]], s)).toBe(true);
});

const gh = (attr: "tone" | "text") => ({ plugin_id: "gh", slot_id: "pr", attr });
const pr = (payload: Record<string, unknown>) => [rowColumn("s", payload, "gh", "pr")];

test.each<[string, Condition, Partial<BridgeSession>, UiEntry[], boolean]>([
  ["status is", { field: "status", op: "is", value: "Running" }, { status: "Running" }, [], true],
  ["status is, other", { field: "status", op: "is", value: "Running" }, {}, [], false],
  ["status is not", { field: "status", op: "is not", value: "Running" }, {}, [], true],
  ["status is not, same", { field: "status", op: "is not", value: "Idle" }, {}, [], false],
  ["status is set", { field: "status", op: "is set" }, {}, [], true],
  ["status is empty", { field: "status", op: "is empty" }, {}, [], false],
  ["urgent is true", { field: "urgent", op: "is", value: true }, { urgent: true }, [], true],
  ["urgent is false, false", { field: "urgent", op: "is", value: false }, { urgent: false }, [], true],
  ["urgent is false, true", { field: "urgent", op: "is", value: false }, { urgent: true }, [], false],
  ["urgent is not true, false", { field: "urgent", op: "is not", value: true }, { urgent: false }, [], true],
  ["urgent is set, false", { field: "urgent", op: "is set" }, { urgent: false }, [], false],
  ["urgent is empty, false", { field: "urgent", op: "is empty" }, { urgent: false }, [], true],
  ["unread is true", { field: "unread", op: "is", value: true }, { unread: true }, [], true],
  ["unread is not true", { field: "unread", op: "is not", value: true }, { unread: true }, [], false],
  ["unread is set", { field: "unread", op: "is set" }, { unread: true }, [], true],
  ["unread is empty", { field: "unread", op: "is empty" }, { unread: true }, [], false],
  ["approvals is 2", { field: "pending_approvals", op: "is", value: 2 }, { pending_approvals: 2 }, [], true],
  ["approvals is 0, zero", { field: "pending_approvals", op: "is", value: 0 }, { pending_approvals: 0 }, [], true],
  ["approvals is not 0, two", { field: "pending_approvals", op: "is not", value: 0 }, { pending_approvals: 2 }, [], true],
  ["approvals is not 0, zero", { field: "pending_approvals", op: "is not", value: 0 }, { pending_approvals: 0 }, [], false],
  ["approvals is set, zero", { field: "pending_approvals", op: "is set" }, { pending_approvals: 0 }, [], false],
  ["approvals is empty, zero", { field: "pending_approvals", op: "is empty" }, { pending_approvals: 0 }, [], true],
  ["last error is", { field: "last_error", op: "is", value: "boom" }, { last_error: "boom" }, [], true],
  ["last error is not", { field: "last_error", op: "is not", value: "boom" }, { last_error: "bang" }, [], true],
  ["last error is set, blank", { field: "last_error", op: "is set" }, { last_error: "" }, [], false],
  ["last error is empty, null", { field: "last_error", op: "is empty" }, { last_error: null }, [], true],
  ["plugin tone is", { field: gh("tone"), op: "is", value: "danger" }, {}, pr({ tone: "danger" }), true],
  ["plugin tone is, other", { field: gh("tone"), op: "is", value: "danger" }, {}, pr({ tone: "info" }), false],
  ["plugin tone is not", { field: gh("tone"), op: "is not", value: "danger" }, {}, pr({ tone: "info" }), true],
  ["plugin tone is not, absent", { field: gh("tone"), op: "is not", value: "danger" }, {}, [], false],
  ["plugin tone is set", { field: gh("tone"), op: "is set" }, {}, pr({ tone: "info" }), true],
  ["plugin tone is empty", { field: gh("tone"), op: "is empty" }, {}, pr({ text: "x" }), true],
  ["plugin text is", { field: gh("text"), op: "is", value: "open" }, {}, pr({ text: "open" }), true],
  ["plugin text is, case", { field: gh("text"), op: "is", value: "open" }, {}, pr({ text: "Open" }), false],
  ["plugin text is not", { field: gh("text"), op: "is not", value: "open" }, {}, pr({ text: "merged" }), true],
  ["plugin text is set", { field: gh("text"), op: "is set" }, {}, pr({ text: "open" }), true],
  ["plugin text is empty", { field: gh("text"), op: "is empty" }, {}, pr({ text: "open" }), false],
])("%s", (_name, condition, extra, entries, want) => {
  expect(inSignal([[condition]], session("s", extra), entries)).toBe(want);
});

test("Rules OR on a Column", () => {
  const rules: Column["rules"] = [[{ field: "status", op: "is", value: "Error" }], [{ field: "urgent", op: "is set" }]];
  expect(inSignal(rules, session("s"))).toBe(false);
  expect(inSignal(rules, session("s", { status: "Error" }))).toBe(true);
  expect(inSignal(rules, session("s", { urgent: true }))).toBe(true);
  expect(inSignal([], session("s", { status: "Error" }))).toBe(false);
});

test("rowColumnSlots lists each plugin's row-column slots once", () => {
  const entries = [
    rowColumn("a", {}, "gh", "pr"),
    rowColumn("b", {}, "gh", "pr"),
    rowColumn("a", {}, "gh", "checks"),
    rowColumn("a", {}, "ci", "build"),
    { ...rowColumn("a", {}, "gh", "badge"), slot: "row-badge" },
  ];
  expect(rowColumnSlots(entries)).toEqual({ gh: ["pr", "checks"], ci: ["build"] });
});

test("conditions AND inside a Rule", () => {
  const rule = [[{ field: "status", op: "is", value: "Idle" } as const, { field: "urgent", op: "is", value: true } as const]];
  expect(inSignal(rule, session("s"))).toBe(false);
  expect(inSignal(rule, session("s", { urgent: true }))).toBe(true);
});

test("plugin fields match by plugin and slot id, with * wildcards", () => {
  const entries = [rowColumn("s", { text: "open", tone: "info" }, "gh", "pr")];
  const rule = (plugin_id: string, slot_id: string) => [
    [{ field: { plugin_id, slot_id, attr: "text" as const }, op: "is" as const, value: "open" }],
  ];
  expect(inSignal(rule("gh", "pr"), session("s"), entries)).toBe(true);
  expect(inSignal(rule("*", "pr"), session("s"), entries)).toBe(true);
  expect(inSignal(rule("gh", "*"), session("s"), entries)).toBe(true);
  expect(inSignal(rule("other", "*"), session("s"), entries)).toBe(false);
  expect(inSignal(rule("gh", "checks"), session("s"), entries)).toBe(false);
});

test("is not across several plugin entries needs none to equal the value", () => {
  const rule = [[{ field: { plugin_id: "*", slot_id: "*", attr: "tone" as const }, op: "is not" as const, value: "danger" }]];
  expect(inSignal(rule, session("s"), [rowColumn("s", { tone: "info" })])).toBe(true);
  expect(inSignal(rule, session("s"), [rowColumn("s", { tone: "info" }), rowColumn("s", { tone: "danger" }, "q")])).toBe(
    false,
  );
});

test("Cards follow the sidebar attention order", () => {
  const sessions = [
    session("running", { status: "Running" }),
    session("stopped", { status: "Stopped" }),
    session("idle-old", { last_activity: "2026-01-01T00:00:00Z" }),
    session("idle-new", { last_activity: "2026-02-01T00:00:00Z" }),
    session("idle-none"),
    session("flagged", { status: "Running" }),
  ];
  // flagged's warn tone caps its rank at Error's, above Idle. The config has
  // no Signal columns, so every Card stays in In progress.
  const entries = [rowColumn("flagged", { tone: "warn" })];
  const config: Config = { version: 1, columns: [DEFAULT_CONFIG.columns[2]] };
  expect(ids(board(sessions, entries, {}, config), "in-progress")).toEqual([
    "flagged",
    "idle-new",
    "idle-old",
    "idle-none",
    "running",
    "stopped",
  ]);
  const urgent = [session("waiting", { status: "Waiting" }), session("urgent", { status: "Stopped", urgent: true })];
  expect(ids(board(urgent, [], {}, config), "in-progress")).toEqual(["urgent", "waiting"]);
});

test("Cards carry repo, branch and plugin row badges", () => {
  const entries: UiEntry[] = [
    { plugin_id: "gh", slot: "row-badge", id: "pr", session_id: "s", payload: { text: "#12", tone: "success" } },
    {
      plugin_id: "ci",
      slot: "row-badge",
      id: "checks",
      session_id: "s",
      payload: { items: [{ text: "lint", tone: "bogus" }, { icon: "x" }, "junk", {}] },
    },
  ];
  const s = session("s", { worktree: { branch: "feat/x", main_repo_path: "/code/aoe/" } });
  const card = board([s], entries).flatMap((b) => b.cards)[0];
  expect(card).toMatchObject({ repo: "aoe", branch: "feat/x" });
  expect(card.badges).toEqual([
    { text: "#12", tone: "success", icon: undefined, tooltip: undefined },
    { text: "lint", tone: "neutral", icon: undefined, tooltip: undefined },
    { text: undefined, tone: "neutral", icon: "x", tooltip: undefined },
  ]);
  const multi = session("m", { workspace_repos: [{ source_path: "/code/one", branch: "main" }] });
  expect(board([multi]).flatMap((b) => b.cards)[0]).toMatchObject({ repo: "one", branch: "main" });
  expect(board([session("p")]).flatMap((b) => b.cards)[0]).toMatchObject({ repo: "p", branch: undefined });
});

test("findSnapshot reads the page entry and falls back to the default config", () => {
  const custom: Config = { version: 1, columns: [DEFAULT_CONFIG.columns[5]] };
  const entry = (payload: Record<string, unknown>, extra: Partial<UiEntry> = {}): UiEntry => ({
    plugin_id: "k",
    slot: "page",
    id: "board",
    payload,
    ...extra,
  });
  expect(findSnapshot([entry({ stages: { a: "done", b: 3, c: "" }, config: custom })], "k", "board")).toEqual({
    stages: { a: "done" },
    config: custom,
  });
  expect(findSnapshot([entry({ config: { version: 9 } })], "k", "board")).toEqual({ stages: {}, config: DEFAULT_CONFIG });
  expect(findSnapshot([entry({ stages: { a: "done" } })], "k", "board")).toEqual({
    stages: { a: "done" },
    config: DEFAULT_CONFIG,
  });
  expect(findSnapshot([entry({ config: custom }, { plugin_id: "other" })], "k", "board").config).toBe(DEFAULT_CONFIG);
  expect(findSnapshot([], "k", "board")).toEqual({ stages: {}, config: DEFAULT_CONFIG });
});

const searchSessions = [
  session("a", { title: "Fix Login", status: "Waiting" }),
  session("b", { tool: "codex", worktree: { branch: "feat/board", main_repo_path: "/repos/aoe" } }),
  session("c", { project_path: "/work/kanban", group_path: "clients/acme" }),
];
const search = (query: string) => filterBoard(board(searchSessions), query);
const matched = (query: string) => search(query).flatMap((b) => b.cards.map((c) => c.session.id));

test.each([
  ["title", "LOGIN", ["a"]],
  ["project path", "/work/", ["c"]],
  ["repo", "Aoe", ["b"]],
  ["branch", "feat/board", ["b"]],
  ["agent", "Codex", ["b"]],
  ["Group path", "acme", ["c"]],
  ["no field", "nothing", []],
])("search matches %s, case-insensitive", (_name, query, ids) => {
  expect(matched(query)).toEqual(ids);
});

test("a blank query keeps every Card", () => {
  expect(matched("  ").sort()).toEqual(["a", "b", "c"]);
});

test("search skips non-string fields a malformed bridge row carries", () => {
  const odd = session("x", { tool: 42 as unknown as string, group_path: {} as unknown as string });
  expect(filterBoard(board([odd]), "42").flatMap((b) => b.cards)).toEqual([]);
});

test("search trims the query", () => {
  expect(matched("  codex ")).toEqual(["b"]);
});

test("search keeps every Column and counts matched over total", () => {
  expect(search("codex").map((b) => [b.column.id, b.cards.length, b.total])).toEqual([
    ["action-needed", 0, 1],
    ["error", 0, 0],
    ["in-progress", 1, 2],
    ["needs-testing", 0, 0],
    ["waiting-for-review", 0, 0],
    ["done", 0, 0],
  ]);
});

// GitHub's shape: one row column backs several facets through filter_values.
const ciFacet: UiEntry = {
  plugin_id: "gh",
  slot: "filter-facet",
  id: "ci",
  payload: {
    label: "GitHub CI",
    column: "pr",
    options: [{ value: "ci:passing", label: "passing" }, { value: "ci:failing", label: "failing" }],
  },
};
const ci = { plugin_id: "gh", facet_id: "ci" };
const withValues = (filter_values: string[]) => [ciFacet, rowColumn("s", { text: "x", filter_values }, "gh", "pr")];

test.each<[string, Condition, UiEntry[], boolean]>([
  ["is, listed", { field: ci, op: "is", value: "ci:failing" }, withValues(["ci:failing", "review:approved"]), true],
  ["is, other value", { field: ci, op: "is", value: "ci:failing" }, withValues(["ci:passing"]), false],
  ["is not, other value", { field: ci, op: "is not", value: "ci:failing" }, withValues(["ci:passing"]), true],
  ["is not, listed", { field: ci, op: "is not", value: "ci:failing" }, withValues(["ci:failing"]), false],
  // Another facet's value on the same column is not this facet's.
  ["is not, only another facet", { field: ci, op: "is not", value: "ci:failing" }, withValues(["review:approved"]), false],
  ["is set", { field: ci, op: "is set" }, withValues(["review:approved", "ci:passing"]), true],
  ["is set, only another facet", { field: ci, op: "is set" }, withValues(["review:approved"]), false],
  ["is empty, no column", { field: ci, op: "is empty" }, [ciFacet], true],
  ["is, facet not published", { field: ci, op: "is", value: "ci:failing" }, withValues(["ci:failing"]).slice(1), false],
  ["is, other plugin's column", { field: ci, op: "is", value: "ci:failing" }, [ciFacet, rowColumn("s", { text: "x", filter_values: ["ci:failing"] }, "other", "pr")], false],
])("facet condition: %s", (_name, condition, entries, expected) => {
  expect(inSignal([[condition]], session("s"), entries)).toBe(expected);
});

test("facets skips entries without a label or column, and options without a value", () => {
  const facet = (id: string, payload: Record<string, unknown>, session_id?: string): UiEntry => ({
    plugin_id: "gh",
    slot: "filter-facet",
    id,
    session_id,
    payload,
  });
  expect(
    facets([
      facet("ok", { label: "CI", column: "pr", options: [{ value: "ci:failing" }, { label: "no value" }] }),
      facet("unlabelled", { column: "pr" }),
      facet("no-column", { label: "X" }),
      facet("per-session", { label: "X", column: "pr" }, "s"),
      rowColumn("s", { label: "X", column: "pr" }),
    ]),
  ).toEqual([{ plugin_id: "gh", id: "ok", label: "CI", column: "pr", options: [{ value: "ci:failing", label: "ci:failing" }] }]);
});

test("Cards carry row-column text with its tone, and skip blank text", () => {
  const entries = [
    rowColumn("s", { text: "CI failing", tone: "danger", tooltip: "PR #1 (CI failing)" }, "gh", "pr"),
    rowColumn("s", { text: "", tone: "warn" }, "gh", "hidden"),
    rowColumn("s", { text: "odd", tone: "loud" }, "x", "y"),
  ];
  const card = board([session("s")], entries).flatMap((b) => b.cards)[0];
  expect(card.columns).toEqual([
    { text: "CI failing", tone: "danger", tooltip: "PR #1 (CI failing)" },
    { text: "odd", tone: "neutral", tooltip: undefined },
  ]);
});
