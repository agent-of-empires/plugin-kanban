import { readFile } from "node:fs/promises";
import { type Locator, type Page, devices, expect, test } from "@playwright/test";
import { DEFAULT_CONFIG, editColumn } from "../../src/shared/board-config";

const ORIGIN = "http://harness.test";
// The daemon's page policy (core src/server/api/plugins.rs `PLUGIN_PAGE_CSP`).
const PAGE_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const PLUGIN = "agent-of-empires.kanban";

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Session ${id}`,
  project_path: `/code/${id}`,
  tool: "claude",
  status: "Idle",
  archived: false,
  snoozed: false,
  trashed: false,
  workspace_repos: [],
  ...extra,
});

const theme = (bg: string, extra: Record<string, string> = {}) => ({
  appearance: "dark",
  cssVars: { "--color-surface-900": bg, "--color-text-primary": "rgb(240, 240, 240)", ...extra },
});

const fixtures = {
  context: { readOnly: false, cityhall: false, pluginId: PLUGIN, pageId: "board", bridgeVersion: 1 },
  theme: theme("rgb(1, 2, 3)", { "--color-favorite": "red" }),
  sessions: [
    session("waiting", { status: "Waiting" }),
    session("broken", { status: "Error" }),
    session("flagged"),
    session("fresh", { worktree: { branch: "feat/board", main_repo_path: "/code/aoe", managed_by_aoe: true } }),
    session("shipped", { status: "Stopped" }),
    session("archived", { archived: true }),
  ],
  entries: [
    { plugin_id: "gh", slot: "row-column", id: "pr", session_id: "flagged", payload: { text: "changes", tone: "danger", filter_values: ["ci:failing"] } },
    {
      plugin_id: "gh",
      slot: "filter-facet",
      id: "ci",
      payload: { label: "GitHub CI", column: "pr", options: [{ value: "ci:passing", label: "passing" }, { value: "ci:failing", label: "failing" }] },
    },
    { plugin_id: "gh", slot: "row-badge", id: "pr", session_id: "fresh", payload: { items: [{ text: "#42", tone: "success" }, { icon: "circle-x", tone: "danger", tooltip: "CI failing" }] } },
    { plugin_id: PLUGIN, slot: "page", id: "board", payload: { stages: { waiting: "needs-testing", shipped: "done" } } },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const isPage = path === "/dist/index.html";
    await route.fulfill({
      body: await readFile(path === "/" ? "tests/e2e/harness.html" : path.slice(1)),
      contentType: "text/html",
      headers: isPage ? { "content-security-policy": PAGE_CSP } : {},
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((f) => (window as unknown as { startPage: (f: unknown) => void }).startPage(f), fixtures);
});

const board = (page: Page) => page.frameLocator("#page");
const column = (page: Page, id: string) => board(page).getByTestId(`column-${id}`);

test("renders the default Board from bridge data", async ({ page }) => {
  await expect(board(page).locator("section h2")).toHaveText([
    /^Action needed/,
    /^Error/,
    /^In progress/,
    /^Needs testing/,
    /^Waiting for review/,
    /^Done/,
  ]);

  const action = column(page, "action-needed");
  await expect(action.locator("li")).toHaveCount(2);
  await expect(action.getByTestId("card-waiting").getByTestId("stage-chip")).toHaveText("Needs testing");
  await expect(action.getByTestId("card-flagged").getByTestId("stage-chip")).toHaveText("In progress");
  await expect(column(page, "error").getByTestId("card-broken")).toBeVisible();
  await expect(column(page, "done").getByTestId("card-shipped")).toBeVisible();

  const fresh = column(page, "in-progress").getByTestId("card-fresh");
  await expect(fresh).toContainText("Session fresh");
  await expect(fresh).toContainText("aoe · feat/board");
  await expect(fresh).toContainText("#42");
  // Plugin icons render as lucide icons, not their names.
  await expect(fresh.getByLabel("CI failing").locator("svg")).toHaveCount(1);
  await expect(fresh).not.toContainText("circle-x");
  await expect(board(page).getByTestId("card-flagged")).toContainText("changes");
  await expect(fresh.getByTestId("stage-chip")).toHaveCount(0);

  await expect(board(page).getByTestId("card-archived")).toHaveCount(0);
  await expect(board(page).getByRole("navigation", { name: "Columns" })).toBeHidden();
});

test("clicking a Card opens its Session through the bridge", async ({ page }) => {
  await board(page).getByTestId("card-broken").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["broken"]);
});

test("applies the theme the dashboard pushes, and replaces it on change", async ({ page }) => {
  const body = board(page).locator("body");
  const rootVar = (name: string) =>
    board(page)
      .locator("html")
      .evaluate((el, n) => el.style.getPropertyValue(n), name);

  await expect(body).toHaveCSS("background-color", "rgb(1, 2, 3)");
  expect(await rootVar("--color-favorite")).toBe("red");

  await page.evaluate((t) => (window as unknown as { pushTheme: (t: unknown) => void }).pushTheme(t), theme("rgb(9, 9, 9)"));
  await expect(body).toHaveCSS("background-color", "rgb(9, 9, 9)");
  expect(await rootVar("--color-favorite")).toBe("");
});

test("the search box hides non-matching Cards and counts matches per Column", async ({ page }) => {
  const counts = board(page).locator("section h2 .count");
  await expect(counts).toHaveText(["2", "1", "1", "0", "0", "1"]);

  await board(page).getByRole("searchbox", { name: "Search sessions" }).fill("FEAT/board");
  await expect(board(page).locator("li")).toHaveCount(1);
  await expect(column(page, "in-progress").getByTestId("card-fresh")).toBeVisible();
  await expect(counts).toHaveText(["0/2", "0/1", "1/1", "0/0", "0/0", "0/1"]);

  await board(page).getByRole("searchbox", { name: "Search sessions" }).fill("");
  await expect(board(page).locator("li")).toHaveCount(5);
  await expect(counts).toHaveText(["2", "1", "1", "0", "0", "1"]);
});

type Harness = {
  startPage: (f: unknown) => void;
  fixtures: () => typeof fixtures;
  publishStage: (sessionId: string, columnId: string) => void;
  pushSelection: (sessionId: string | null) => void;
  pickMenu: (picked: string | null) => void;
  menus: { id: string; x: number; y: number; items: { id: string; label: string }[] }[];
  opened: string[];
  actions: {
    method: string;
    params: {
      config: { columns: { id: string; title: string; kind: string; on_enter: string; send?: { label: string; message: string; stage?: string } }[] };
      sessionIds: string[];
    };
  }[];
};
// Runs fn in the harness window with a JSON argument; fn sees no closure.
const harness = <T, A = undefined>(page: Page, fn: (h: Harness, arg: A) => T, arg?: A): Promise<T> =>
  page.evaluate(`(${fn})(window, ${JSON.stringify(arg ?? null)})`);
const titles = (page: Page) => board(page).locator("section h2 .truncate");
const DEFAULT_TITLES = ["Action needed", "Error", "In progress", "Needs testing", "Waiting for review", "Done"];

// Drags with small mouse steps: the Board's pointer sensor waits for 5px.
async function dragHeader(page: Page, from: string, to: string) {
  const box = async (title: string) => (await board(page).getByRole("region", { name: title }).locator("h2").boundingBox())!;
  const [a, b] = [await box(from), await box(to)];
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 20, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

test("adds, renames, reorders and deletes Columns through config.set", async ({ page }) => {
  const b = board(page);
  await expect(titles(page)).toHaveText(DEFAULT_TITLES);

  await b.getByRole("button", { name: "+ Add column" }).click();
  const add = b.getByRole("dialog", { name: "Add column" });
  await expect(add).toContainText("the leftmost match holds the Card; drag Columns to change that order");
  await add.getByLabel("Name").fill("  Blocked  ");
  await add.getByLabel(/^Signal/).check();
  await add.getByRole("button", { name: "Save" }).click();
  await expect(titles(page)).toHaveText([...DEFAULT_TITLES, "Blocked"]);

  await b.getByRole("button", { name: "Edit column Blocked", exact: true }).click();
  const edit = b.getByRole("dialog", { name: "Edit column" });
  await expect(edit.getByLabel(/^Signal/)).toBeChecked();
  await expect(edit.getByLabel(/^Signal/)).toBeDisabled();
  await expect(edit.getByLabel(/^Stage/)).toBeDisabled();
  await edit.getByLabel("Name").fill("Blocked on me");
  await edit.getByLabel("Name").press("Enter");
  await expect(titles(page)).toHaveText([...DEFAULT_TITLES, "Blocked on me"]);

  // "shipped" has Stage done; with Done gone it falls to the leftmost Stage.
  await b.getByRole("button", { name: "Edit column Done", exact: true }).click();
  await b.getByRole("dialog", { name: "Edit column" }).getByRole("button", { name: "Delete" }).click();
  await expect(titles(page)).toHaveText([...DEFAULT_TITLES.slice(0, -1), "Blocked on me"]);
  await expect(column(page, "in-progress").getByTestId("card-shipped")).toBeVisible();

  // Last on purpose: dnd-kit swallows clicks for 50ms after a drop.
  await dragHeader(page, "Blocked on me", "Action needed");
  const after = ["Blocked on me", ...DEFAULT_TITLES.slice(0, -1)];
  await expect(titles(page)).toHaveText(after);

  // Edits render before the bridge delivers them.
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(4);
  const sent = await harness(page, (h) => h.actions);
  expect(sent.map((a) => a.method)).toEqual(["config.set", "config.set", "config.set", "config.set"]);
  const last = sent.at(-1)!.params.config.columns;
  expect(last.map((c) => c.title)).toEqual(after);
  expect(last[0]).toMatchObject({ kind: "signal", id: expect.stringMatching(/^col-/) });

  // Another device reads the same snapshot.
  await harness(page, (h) => h.startPage(h.fixtures()));
  await expect(titles(page)).toHaveText(after);
  await expect(b.getByRole("alert")).toHaveCount(0);
});

test("the Column dialog sets an enter-action on Stage columns only", async ({ page }) => {
  const b = board(page);
  const when = /^When a Card is dropped here/;
  await b.getByRole("button", { name: "Edit column Done", exact: true }).click();
  const edit = b.getByRole("dialog", { name: "Edit column" });
  await expect(edit.getByLabel(when)).toHaveValue("none");
  await edit.getByLabel(when).selectOption({ label: "Archive the Session" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(1);

  // A reload reads it back from the snapshot.
  await harness(page, (h) => h.startPage(h.fixtures()));
  await b.getByRole("button", { name: "Edit column Done", exact: true }).click();
  await expect(b.getByRole("dialog", { name: "Edit column" }).getByLabel(when)).toHaveValue("archive");
  await b.getByRole("dialog", { name: "Edit column" }).getByRole("button", { name: "Cancel" }).click();

  await b.getByRole("button", { name: "Edit column Error", exact: true }).click();
  await expect(b.getByRole("dialog", { name: "Edit column" }).getByLabel(when)).toHaveCount(0);
  await b.getByRole("dialog", { name: "Edit column" }).getByRole("button", { name: "Cancel" }).click();

  // A new Column picked as Stage, then switched to Signal, keeps none.
  await b.getByRole("button", { name: "+ Add column" }).click();
  const add = b.getByRole("dialog", { name: "Add column" });
  await add.getByLabel("Name").fill("Bin");
  await add.getByLabel(when).selectOption("trash");
  await add.getByLabel(/^Signal/).check();
  await add.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(2);
  const columns = await harness(page, (h) => h.actions.map((a) => a.params.config.columns));
  expect(columns[0].find((c) => c.id === "done")).toMatchObject({ on_enter: "archive" });
  expect(columns[1].at(-1)).toMatchObject({ title: "Bin", kind: "signal", on_enter: "none" });
});

test("the last Stage column cannot be deleted, and Cancel changes nothing", async ({ page }) => {
  const columns = [
    { id: "action-needed", title: "Action needed", kind: "signal", rules: [], on_enter: "none" },
    { id: "done", title: "Done", kind: "stage", rules: [], on_enter: "none" },
  ];
  const entries = [{ plugin_id: PLUGIN, slot: "page", id: "board", payload: { config: { version: 1, columns } } }];
  await harness(page, (h, e) => h.startPage({ ...h.fixtures(), entries: e }), entries);
  await expect(titles(page)).toHaveText(["Action needed", "Done"]);

  await board(page).getByRole("button", { name: "Edit column Done", exact: true }).click();
  const edit = board(page).getByRole("dialog", { name: "Edit column" });
  await expect(edit.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(edit).toContainText("The Board needs at least one Stage column.");
  await edit.getByLabel("Name").fill("Gone");
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeHidden();
  await expect(titles(page)).toHaveText(["Action needed", "Done"]);
  expect(await harness(page, (h) => h.actions)).toEqual([]);
});

test("a rejected save rolls the edit back and says so", async ({ page }) => {
  await harness(page, (h) => h.startPage({ ...h.fixtures(), rejectActions: true }));
  await board(page).getByRole("button", { name: "+ Add column" }).click();
  const add = board(page).getByRole("dialog", { name: "Add column" });
  await add.getByLabel("Name").fill("Lost");
  await add.getByRole("button", { name: "Save" }).click();
  await expect(board(page).getByRole("alert")).toHaveText("Couldn't save the Board.");
  await expect(titles(page)).toHaveText(DEFAULT_TITLES);
});

test("Export shows the current Board config as JSON", async ({ page }) => {
  await board(page).getByRole("button", { name: "Export" }).click();
  const dialog = board(page).getByRole("dialog", { name: "Export Board" });
  const json = dialog.getByLabel("Board JSON");
  await expect(json).toHaveJSProperty("readOnly", true);
  expect(JSON.parse(await json.inputValue())).toEqual(DEFAULT_CONFIG);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("Import validates, then replaces the Board through config.set", async ({ page }) => {
  const b = board(page);
  await b.getByRole("button", { name: "Import" }).click();
  const dialog = b.getByRole("dialog", { name: "Import Board" });
  const json = dialog.getByLabel("Board JSON");
  const replace = dialog.getByRole("button", { name: "Replace Board" });
  await expect(replace).toBeDisabled();

  await json.fill("{ nope");
  await expect(dialog.getByRole("alert")).toContainText("not valid JSON");
  await expect(replace).toBeDisabled();

  const stage = { id: "todo", title: "Todo", kind: "stage", rules: [], on_enter: "none" };
  await json.fill(JSON.stringify({ version: 1, columns: [{ ...stage, color: "red" }] }));
  await expect(dialog.getByRole("alert")).toHaveText('column 0: unknown key "color"');
  await expect(replace).toBeDisabled();

  // A file loads into the text box.
  const imported = { version: 1, columns: [stage, { ...stage, id: "later", title: "Later" }] };
  await dialog.getByLabel("Board file").setInputFiles({
    name: "board.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(dialog).toContainText("Replaces this Board's 6 Columns with these 2.");
  await replace.click();
  await expect(dialog).toHaveCount(0);
  await expect(titles(page)).toHaveText(["Todo", "Later"]);
  // Sessions whose Stage column is gone fall to the leftmost Stage column.
  await expect(column(page, "todo").getByTestId("card-shipped")).toBeVisible();
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(1);
  expect(await harness(page, (h) => h.actions[0])).toEqual({ method: "config.set", params: { config: imported } });
});

type Rules = unknown[][];
// Edits render before the bridge delivers them, so wait for the nth action.
async function sentRules(page: Page, n: number, id: string) {
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(n);
  const columns = await harness(page, (h) => h.actions.at(-1)!.params.config.columns);
  return (columns as unknown as { id: string; rules: Rules }[]).find((c) => c.id === id)!.rules;
}

test("editing a Signal column's Rules moves Cards and saves through config.set", async ({ page }) => {
  const b = board(page);
  await expect(column(page, "action-needed").getByTestId("card-waiting")).toBeVisible();

  // The default Rules show as ordinary, editable rows.
  await b.getByRole("button", { name: "Edit column Action needed", exact: true }).click();
  let edit = b.getByRole("dialog", { name: "Edit column" });
  const rules = edit.getByRole("group", { name: /^Rule / });
  await expect(rules).toHaveCount(6);
  const first = rules.first();
  await expect(first.getByLabel("Field")).toHaveValue("status");
  await expect(first.getByLabel("Operator")).toHaveValue("is");
  await expect(first.getByLabel("Value")).toHaveValue("Waiting");
  await expect(rules.nth(4).getByLabel("Plugin")).toHaveValue("*");
  await expect(rules.nth(4).getByLabel("Value")).toHaveValue("danger");

  // Removing a Rule's only condition removes the Rule.
  await first.getByRole("button", { name: "Remove condition" }).click();
  await expect(rules).toHaveCount(5);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(column(page, "needs-testing").getByTestId("card-waiting")).toBeVisible();
  expect(await sentRules(page, 1, "action-needed")).toHaveLength(5);

  // A new Rule on Error pulls in the Idle Card.
  await b.getByRole("button", { name: "Edit column Error", exact: true }).click();
  edit = b.getByRole("dialog", { name: "Edit column" });
  await edit.getByRole("button", { name: "+ Rule" }).click();
  const added = edit.getByRole("group", { name: "Rule 3" });
  await added.getByLabel("Value").fill("Idle");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(column(page, "error").getByTestId("card-fresh")).toBeVisible();
  expect((await sentRules(page, 2, "error")).at(-1)).toEqual([{ field: "status", op: "is", value: "Idle" }]);

  // Another device reads the same snapshot.
  await harness(page, (h) => h.startPage(h.fixtures()));
  await expect(column(page, "error").getByTestId("card-fresh")).toBeVisible();
  await expect(column(page, "needs-testing").getByTestId("card-waiting")).toBeVisible();
});

test("a plugin condition picks plugin and slot, and Save waits for a value", async ({ page }) => {
  const b = board(page);
  await b.getByRole("button", { name: "+ Add column" }).click();
  const add = b.getByRole("dialog", { name: "Add column" });
  await add.getByLabel("Name").fill("Stopped");
  await expect(add.getByRole("button", { name: "+ Rule" })).toHaveCount(0);
  await add.getByLabel(/^Signal/).check();
  await expect(add).toContainText("No Rules: this Column holds no Cards.");

  await add.getByRole("button", { name: "+ Rule" }).click();
  const rule = add.getByRole("group", { name: "Rule 1" });
  await rule.getByLabel("Value").fill("Stopped");
  await rule.getByRole("button", { name: "+ and" }).click();
  const second = rule.locator(".condition").nth(1);
  await second.getByLabel("Field").selectOption("text");
  await expect(second.getByLabel("Plugin")).toHaveValue("*");
  await expect(second.getByLabel("Value")).toHaveValue("");
  await expect(add.getByRole("button", { name: "Save" })).toBeDisabled();
  await second.getByLabel("Plugin").fill("gh");
  await second.getByLabel("Slot").fill("pr");
  await second.getByLabel("Operator").selectOption("is empty");
  await expect(second.getByLabel("Value")).toHaveCount(0);
  await add.getByRole("button", { name: "Save" }).click();

  // "shipped" is Stopped and has no gh/pr text.
  await expect(b.getByRole("region", { name: "Stopped" }).getByTestId("card-shipped")).toBeVisible();
  const id = await b.getByRole("region", { name: "Stopped" }).getAttribute("data-testid");
  expect(await sentRules(page, 1, id!.replace(/^column-/, ""))).toEqual([
    [
      { field: "status", op: "is", value: "Stopped" },
      { field: { plugin_id: "gh", slot_id: "pr", attr: "text" }, op: "is empty" },
    ],
  ]);
});

test("a facet condition offers the plugin's facets and their options", async ({ page }) => {
  const b = board(page);
  await b.getByRole("button", { name: "+ Add column" }).click();
  const add = b.getByRole("dialog", { name: "Add column" });
  await add.getByLabel("Name").fill("CI failing");
  await add.getByLabel(/^Signal/).check();
  await add.getByRole("button", { name: "+ Rule" }).click();
  const rule = add.getByRole("group", { name: "Rule 1" });
  await rule.getByLabel("Field").selectOption({ label: "GitHub CI" });
  await expect(rule.getByLabel("Plugin")).toHaveCount(0);
  await expect(rule.getByLabel("Value").locator("option")).toHaveText(["passing", "failing"]);
  await rule.getByLabel("Value").selectOption({ label: "failing" });
  await add.getByRole("button", { name: "Save" }).click();

  const id = await b.getByRole("region", { name: "CI failing" }).getAttribute("data-testid");
  expect(await sentRules(page, 1, id!.replace(/^column-/, ""))).toEqual([
    [{ field: { plugin_id: "gh", facet_id: "ci" }, op: "is", value: "ci:failing" }],
  ]);
});

for (const flag of ["readOnly", "cityhall"] as const) {
  test(`${flag} context hides Column editing`, async ({ page }) => {
    await harness(
      page,
      (h, key) => {
        const f = h.fixtures();
        h.startPage({ ...f, context: { ...f.context, [key]: true } });
      },
      flag,
    );
    await expect(titles(page)).toHaveText(DEFAULT_TITLES);
    await expect(board(page).getByRole("button", { name: "+ Add column" })).toHaveCount(0);
    await expect(board(page).getByRole("button", { name: "Import" })).toHaveCount(0);
    await expect(board(page).getByRole("button", { name: "Export" })).toBeVisible();
    await expect(board(page).getByRole("button", { name: /^Edit column/ })).toHaveCount(0);
    await expect(board(page).locator("h2[aria-roledescription]")).toHaveCount(0);
  });
}

test.describe("moving Cards", () => {
  // Wide enough for the whole default Board, so a drag never nears an edge and
  // autoscrolls the Board under the pointer.
  test.use({ viewport: { width: 1920, height: 1000 } });

  const actions = (page: Page) => harness(page, (h) => h.actions);
  const stageSet = (sessionId: string, columnId: string) => ({ method: "stage.set", params: { sessionId, columnId } });
  const restart = (
    page: Page,
    overrides: { rejectActions?: boolean; hostMenu?: boolean; context?: Record<string, boolean> },
  ) =>
    harness(page, (h, o) => h.startPage({ ...h.fixtures(), ...o, context: { ...h.fixtures().context, ...o!.context } }), overrides);

  // A real mouse drag: past the 5px activation distance, then onto the target.
  async function drag(page: Page, from: Locator, to: Locator) {
    const a = (await from.boundingBox())!;
    const b = (await to.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 5 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
  }

  test("dragging a Card onto a Stage column writes its Stage and moves it at once", async ({ page }) => {
    await drag(page, column(page, "in-progress").getByTestId("card-fresh"), column(page, "done"));

    await expect(column(page, "done").getByTestId("card-fresh")).toBeVisible();
    await expect.poll(() => actions(page)).toEqual([stageSet("fresh", "done")]);
    expect(await harness(page, (h) => h.opened)).toEqual([]);

    // Once the snapshot confirms the move, the snapshot alone places the Card:
    // a later change from elsewhere shows up.
    await harness(page, (h) => h.publishStage("fresh", "done"));
    await page.waitForTimeout(2_500);
    await harness(page, (h) => h.publishStage("fresh", "needs-testing"));
    await expect(column(page, "needs-testing").getByTestId("card-fresh")).toBeVisible();
  });

  test("dragging a Card out of a Signal column records its Stage but leaves it there", async ({ page }) => {
    const card = column(page, "action-needed").getByTestId("card-waiting");
    await drag(page, card, column(page, "done"));

    await expect(card.getByTestId("stage-chip")).toHaveText("Done");
    await expect(column(page, "done").getByTestId("card-waiting")).toHaveCount(0);
    await expect.poll(() => actions(page)).toEqual([stageSet("waiting", "done")]);
  });

  test("a Card dropped on a Signal column stays and writes nothing", async ({ page }) => {
    await drag(page, column(page, "in-progress").getByTestId("card-fresh"), column(page, "error"));
    await expect(column(page, "in-progress").getByTestId("card-fresh")).toBeVisible();
    expect(await actions(page)).toEqual([]);
  });

  test("Move to lists the Stage columns and writes the chosen one", async ({ page }) => {
    await column(page, "in-progress").getByTestId("card-fresh").getByRole("button", { name: "Session actions" }).click();

    const items = board(page).getByRole("menu").getByRole("menuitemradio");
    await expect(items).toHaveText(["In progress", "Needs testing", "Waiting for review", "Done"]);
    await expect(items.first()).toHaveAttribute("aria-checked", "true");
    await items.filter({ hasText: "Needs testing" }).click();

    await expect(board(page).getByRole("menu")).toHaveCount(0);
    await expect(column(page, "needs-testing").getByTestId("card-fresh")).toBeVisible();
    await expect.poll(() => actions(page)).toEqual([stageSet("fresh", "needs-testing")]);
  });

  test("right-clicking a Card opens Move to, and Escape closes it", async ({ page }) => {
    await board(page).getByTestId("card-broken").click({ button: "right" });
    await expect(board(page).getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(board(page).getByRole("menu")).toHaveCount(0);
  });

  test("a refused write puts the Card back and says so", async ({ page }) => {
    await restart(page, { rejectActions: true });
    await drag(page, column(page, "in-progress").getByTestId("card-fresh"), column(page, "done"));
    await expect(board(page).getByRole("alert")).toHaveText("Couldn't save the Board.");
    await expect(column(page, "in-progress").getByTestId("card-fresh")).toBeVisible();
    await expect(column(page, "done").getByTestId("card-fresh")).toHaveCount(0);
  });

  // Restarts with Done set to `on_enter`, plus fixture overrides.
  const enterBoard = (page: Page, on_enter: "archive" | "trash", overrides: Record<string, unknown> = {}) =>
    harness(
      page,
      (h, a) => {
        const f = h.fixtures();
        const entries = f.entries.map((e) => (e.slot === "page" ? { ...e, payload: { ...e.payload, config: a!.config } } : e));
        h.startPage({ ...f, ...a!.overrides, entries });
      },
      { config: editColumn(DEFAULT_CONFIG, "done", { title: "Done", on_enter }), overrides },
    );
  const moveTo = async (page: Page, id: string, title: string) => {
    await board(page).getByTestId(`card-${id}`).getByRole("button", { name: "Session actions" }).click();
    await board(page).getByRole("menu").getByRole("menuitemradio").filter({ hasText: title }).click();
  };

  test("dropping onto an archive Column writes the Stage, then archives once it lands", async ({ page }) => {
    await enterBoard(page, "archive");
    await drag(page, column(page, "in-progress").getByTestId("card-fresh"), column(page, "done"));
    await expect(column(page, "done").getByTestId("card-fresh")).toBeVisible();
    await expect.poll(() => actions(page)).toEqual([stageSet("fresh", "done")]);

    // Polls go by, but the Stage is not in the snapshot yet: no archive.
    await page.waitForTimeout(2_500);
    expect(await actions(page)).toEqual([stageSet("fresh", "done")]);

    await harness(page, (h) => h.publishStage("fresh", "done"));
    await expect
      .poll(() => actions(page))
      .toEqual([stageSet("fresh", "done"), { method: "session.archive", params: { id: "fresh" } }]);
    await expect(board(page).getByTestId("card-fresh")).toHaveCount(0);
    await expect(board(page).getByRole("dialog")).toHaveCount(0);
  });

  test("Move to a trash Column writes the Stage, then trashes", async ({ page }) => {
    await enterBoard(page, "trash");
    await moveTo(page, "fresh", "Done");
    await expect.poll(() => actions(page)).toEqual([stageSet("fresh", "done")]);
    await harness(page, (h) => h.publishStage("fresh", "done"));
    await expect
      .poll(() => actions(page))
      .toEqual([stageSet("fresh", "done"), { method: "session.trash", params: { id: "fresh" } }]);
    await expect(board(page).getByTestId("card-fresh")).toHaveCount(0);
  });

  test("a refused Stage write never archives", async ({ page }) => {
    await enterBoard(page, "archive", { rejectActions: true });
    await moveTo(page, "fresh", "Done");
    await expect(board(page).getByRole("alert")).toHaveText("Couldn't save the Board.");
    await page.waitForTimeout(2_500);
    expect(await actions(page)).toEqual([]);
    await expect(column(page, "in-progress").getByTestId("card-fresh")).toBeVisible();
  });

  test("a refused archive keeps the Stage, says so, and dropping again retries", async ({ page }) => {
    await enterBoard(page, "archive", { rejectEnter: true });
    await moveTo(page, "fresh", "Done");
    await harness(page, (h) => h.publishStage("fresh", "done"));
    await expect(board(page).getByRole("alert")).toHaveText("Couldn't archive the Session.");
    await expect(column(page, "done").getByTestId("card-fresh")).toBeVisible();

    await harness(page, (h) => Object.assign(h.fixtures(), { rejectEnter: false }));
    await moveTo(page, "fresh", "Done");
    await expect
      .poll(() => actions(page))
      .toEqual([stageSet("fresh", "done"), { method: "session.archive", params: { id: "fresh" } }]);
    await expect(board(page).getByTestId("card-fresh")).toHaveCount(0);
  });

  test("the dashboard's session menu keeps an archive Column's own entry to retry a refused archive", async ({ page }) => {
    await enterBoard(page, "archive", { rejectEnter: true, hostMenu: true });
    const menuItems = async () => {
      const before = await harness(page, (h) => h.menus.length);
      await board(page).getByTestId("card-fresh").click({ button: "right" });
      await expect.poll(() => harness(page, (h) => h.menus.length)).toBe(before + 1);
      return (await harness(page, (h) => h.menus.at(-1)!)).items.map((i: { id: string }) => i.id);
    };
    expect(await menuItems()).toContain("move:done");
    await harness(page, (h) => h.pickMenu("move:done"));
    await harness(page, (h) => h.publishStage("fresh", "done"));
    await expect(board(page).getByRole("alert")).toHaveText("Couldn't archive the Session.");

    await harness(page, (h) => Object.assign(h.fixtures(), { rejectEnter: false }));
    expect(await menuItems()).toContain("move:done");
    await harness(page, (h) => h.pickMenu("move:done"));
    await expect
      .poll(() => actions(page))
      .toEqual([stageSet("fresh", "done"), { method: "session.archive", params: { id: "fresh" } }]);
  });

  test("with the dashboard's session menu, a Card opens it with Move to items", async ({ page }) => {
    await restart(page, { hostMenu: true });
    const card = column(page, "in-progress").getByTestId("card-fresh");
    await card.click({ button: "right", position: { x: 20, y: 10 } });
    await expect.poll(() => harness(page, (h) => h.menus.length)).toBe(1);
    const [menu] = await harness(page, (h) => h.menus);
    // In the frame's own coordinates.
    const box = await card.evaluate((el) => el.getBoundingClientRect().toJSON());
    expect(menu.id).toBe("fresh");
    expect(menu.x).toBeCloseTo(box.x + 20, 0);
    expect(menu.y).toBeCloseTo(box.y + 10, 0);
    expect(menu.items).toEqual([
      { id: "move:needs-testing", label: "Move to Needs testing" },
      { id: "move:waiting-for-review", label: "Move to Waiting for review" },
      { id: "move:done", label: "Move to Done" },
    ]);
    // The Board's own menu stays closed.
    await expect(board(page).getByRole("menu")).toHaveCount(0);

    await harness(page, (h) => h.pickMenu("move:done"));
    await expect(column(page, "done").getByTestId("card-fresh")).toBeVisible();
    await expect.poll(() => actions(page)).toEqual([stageSet("fresh", "done")]);
  });

  test("the split view's Session is outlined", async ({ page }) => {
    await expect(board(page).getByTestId("card-fresh")).toBeVisible();
    await harness(page, (h) => h.pushSelection("fresh"));
    await expect(board(page).getByTestId("card-fresh")).toHaveAttribute("aria-current", "true");
    await expect(board(page).locator(".card.selected")).toHaveCount(1);
    await harness(page, (h) => h.pushSelection(null));
    await expect(board(page).locator(".card.selected")).toHaveCount(0);
  });

  for (const flag of ["readOnly", "cityhall"] as const) {
    test(`${flag} context: no drag and no Move to`, async ({ page }) => {
      await restart(page, { context: { [flag]: true } });
      const card = column(page, "in-progress").getByTestId("card-fresh");
      await expect(card).toBeVisible();
      await expect(card.getByRole("button", { name: "Session actions" })).toHaveCount(0);

      await card.click({ button: "right" });
      await expect(board(page).getByRole("menu")).toHaveCount(0);
      await drag(page, card, column(page, "done"));
      await expect(column(page, "in-progress").getByTestId("card-fresh")).toBeVisible();
      expect(await actions(page)).toEqual([]);
    });

    test(`${flag} context: the dashboard's session menu opens without Move to items`, async ({ page }) => {
      await restart(page, { hostMenu: true, context: { [flag]: true } });
      await column(page, "in-progress").getByTestId("card-fresh").getByRole("button", { name: "Session actions" }).click();
      await expect.poll(() => harness(page, (h) => h.menus)).toMatchObject([{ id: "fresh", items: [] }]);
    });
  }
});

test.describe("phone", () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices["Pixel 7"];
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

  const dots = (page: Page) => board(page).getByRole("navigation", { name: "Columns" }).getByRole("button");
  const current = (page: Page) => board(page).getByRole("navigation", { name: "Columns" }).locator("[aria-current=true]");
  const scrollTo = (page: Page, id: string) =>
    board(page)
      .locator("main")
      .evaluate((el, id) => (el.scrollLeft = el.querySelector<HTMLElement>(`[data-testid=column-${id}]`)!.offsetLeft), id);

  test("shows one Column per screen, with an indicator that follows and jumps", async ({ page }) => {
    await expect(dots(page)).toHaveCount(6);
    await expect(current(page)).toHaveAccessibleName("Action needed");
    await expect(column(page, "action-needed")).toBeInViewport({ ratio: 0.95 });
    await expect(column(page, "error")).not.toBeInViewport();

    await dots(page).and(board(page).getByLabel("Done", { exact: true })).tap();
    await expect(column(page, "done")).toBeInViewport({ ratio: 0.95 });
    await expect(current(page)).toHaveAccessibleName("Done");

    await scrollTo(page, "error");
    await expect(current(page)).toHaveAccessibleName("Error");
    await expect(column(page, "error")).toBeInViewport({ ratio: 0.95 });
  });

  test("Move to sets a Stage", async ({ page }) => {
    await dots(page).nth(2).tap();
    await column(page, "in-progress").getByTestId("card-fresh").getByRole("button", { name: "Session actions" }).tap();
    await board(page).getByRole("menu").getByRole("menuitemradio", { name: "Needs testing" }).tap();
    await expect(column(page, "needs-testing").getByTestId("card-fresh")).toBeAttached();
    await expect.poll(() => harness(page, (h) => h.actions)).toEqual([
      { method: "stage.set", params: { sessionId: "fresh", columnId: "needs-testing" } },
    ]);
  });

  test("a long press drags a Card to another Column", async ({ page }) => {
    await dots(page).nth(2).tap();
    await expect(column(page, "in-progress")).toBeInViewport({ ratio: 0.95 });
    const a = (await column(page, "in-progress").getByTestId("card-fresh").boundingBox())!;
    const [x, y] = [a.x + a.width / 2, a.y + a.height / 2];

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    await touch("touchStart", [{ x, y }]);
    await page.waitForTimeout(400);
    await touch("touchMove", [{ x: x + 10, y }]);
    // Stands in for the edge autoscroll that brings the next Column under the finger.
    await scrollTo(page, "needs-testing");
    await touch("touchMove", [{ x: x + 12, y: y + 2 }]);
    await touch("touchEnd", []);

    await expect(column(page, "needs-testing").getByTestId("card-fresh")).toBeAttached();
    await expect.poll(() => harness(page, (h) => h.actions)).toEqual([
      { method: "stage.set", params: { sessionId: "fresh", columnId: "needs-testing" } },
    ]);
    expect(await harness(page, (h) => h.opened)).toEqual([]);
  });
});

test("a Column's one-click message sends from a Card and, after a confirm, from the Column", async ({ page }) => {
  const b = board(page);
  await b.getByRole("button", { name: "Edit column Action needed", exact: true }).click();
  const edit = b.getByRole("dialog", { name: "Edit column" });
  // A label without a message has nothing to send.
  await edit.getByLabel("Button label").fill("Fix");
  await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
  await edit.getByLabel("Message").fill("resolve the comments");
  await edit.getByLabel("Then move the Card to").selectOption({ label: "Done" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(1);
  const saved = await harness(page, (h) => h.actions[0].params.config.columns.find((c) => c.id === "action-needed"));
  expect(saved?.send).toEqual({ label: "Fix", message: "resolve the comments", stage: "done" });

  const action = column(page, "action-needed");
  await action.getByTestId("card-waiting").getByRole("button", { name: "Fix" }).click();
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(2);
  expect(await harness(page, (h) => h.actions[1])).toEqual({
    method: "message.send",
    params: { columnId: "action-needed", sessionIds: ["waiting"] },
  });

  // Many Sessions: the first click asks, the second sends.
  await action.getByRole("button", { name: "Fix (all)" }).click();
  expect(await harness(page, (h) => h.actions.length)).toBe(2);
  await action.getByRole("button", { name: "Send to 2?" }).click();
  await expect.poll(() => harness(page, (h) => h.actions.length)).toBe(3);
  const sent = await harness(page, (h) => h.actions[2].params.sessionIds);
  expect([...sent].sort()).toEqual(["flagged", "waiting"]);

  // Columns without a message show no button.
  await expect(column(page, "error").getByRole("button", { name: /Fix/ })).toHaveCount(0);
});
