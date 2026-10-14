import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const ORIGIN = "http://harness.test";

test.beforeEach(async ({ page }) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = path === "/" ? "tests/e2e/harness.html" : path.slice(1);
    await route.fulfill({ body: await readFile(file), contentType: "text/html" });
  });
  await page.goto(`${ORIGIN}/`);
});

test("built page signals ready and renders the context the host pushes", async ({ page }) => {
  const board = page.frameLocator("#page");
  await expect(board.getByTestId("bridge-status")).toHaveText("Waiting for the dashboard...");

  await expect.poll(() => page.evaluate(() => (window as { received?: unknown[] }).received)).toEqual([
    { bridge: 1, type: "ready" },
  ]);

  await page.evaluate(() =>
    (window as unknown as { pushToPage: (msg: unknown) => void }).pushToPage({
      bridge: 1,
      type: "context",
      payload: { readOnly: true, cityhall: false, pluginId: "agent-of-empires.kanban", pageId: "board", bridgeVersion: 1 },
    }),
  );
  await expect(board.getByTestId("bridge-status")).toHaveText(
    "Connected to agent-of-empires.kanban/board (bridge v1, read-only)",
  );
});
