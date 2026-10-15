import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

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
    { plugin_id: "gh", slot: "row-column", id: "pr", session_id: "flagged", payload: { text: "changes", tone: "danger" } },
    { plugin_id: "gh", slot: "row-badge", id: "pr", session_id: "fresh", payload: { text: "#42", tone: "success" } },
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
  await expect(action.getByRole("button")).toHaveCount(2);
  await expect(action.getByTestId("card-waiting").getByTestId("stage-chip")).toHaveText("Needs testing");
  await expect(action.getByTestId("card-flagged").getByTestId("stage-chip")).toHaveText("In progress");
  await expect(column(page, "error").getByTestId("card-broken")).toBeVisible();
  await expect(column(page, "done").getByTestId("card-shipped")).toBeVisible();

  const fresh = column(page, "in-progress").getByTestId("card-fresh");
  await expect(fresh).toContainText("Session fresh");
  await expect(fresh).toContainText("aoe · feat/board");
  await expect(fresh).toContainText("claude");
  await expect(fresh).toContainText("#42");
  await expect(fresh.getByTestId("stage-chip")).toHaveCount(0);

  await expect(board(page).getByTestId("card-archived")).toHaveCount(0);
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
  await expect(board(page).getByRole("button")).toHaveCount(1);
  await expect(column(page, "in-progress").getByTestId("card-fresh")).toBeVisible();
  await expect(counts).toHaveText(["0/2", "0/1", "1/1", "0/0", "0/0", "0/1"]);

  await board(page).getByRole("searchbox", { name: "Search sessions" }).fill("");
  await expect(board(page).getByRole("button")).toHaveCount(5);
  await expect(counts).toHaveText(["2", "1", "1", "0", "0", "1"]);
});
