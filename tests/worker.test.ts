import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";

test("built worker stays up, logs to stderr only, and exits on stdin EOF", async () => {
  const worker = spawn("node", ["dist/worker.js"], {
    env: { ...process.env, AOE_PLUGIN_ID: "agent-of-empires.kanban" },
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.on("data", (chunk) => (stdout += chunk));
  worker.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => worker.on("exit", resolve));

  worker.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session.status.changed", params: {} })}\n`);
  worker.stdin.write("null\n");
  worker.stdin.write("not json\n");
  await sleep(300);
  expect(worker.exitCode).toBeNull();

  worker.stdin.end();
  expect(await exited).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("worker started (plugin agent-of-empires.kanban)");
  expect(stderr).toContain("received session.status.changed");
  expect(stderr).toContain("received message without method");
  expect(stderr.match(/ignored a line that is not JSON/g)).toHaveLength(1);
});
