// src/worker/main.ts
import { createInterface } from "node:readline";
var log = (msg) => console.error(`[kanban] ${msg}`);
log(`worker started (plugin ${process.env.AOE_PLUGIN_ID ?? "unknown"})`);
var lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    log(`received ${typeof msg?.method === "string" ? msg.method : "message without method"}`);
  } catch {
    log("ignored a line that is not JSON");
  }
});
lines.on("close", () => {
  log("stdin closed, exiting");
  process.exit(0);
});
