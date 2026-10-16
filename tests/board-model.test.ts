import { expect, test } from "vitest";
import { type Column, type Config, DEFAULT_CONFIG } from "../src/shared/board-config";
import { type BridgeSession, type UiEntry, buildBoard, filterBoard, findSnapshot } from "../src/shared/board-model";

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
