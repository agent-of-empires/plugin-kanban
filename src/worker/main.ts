import { createInterface } from "node:readline";

// The host parses every stdout line as a JSON-RPC request, so diagnostics go to
// stderr, which the host writes to this worker's log file.
const log = (msg: string) => console.error(`[kanban] ${msg}`);

log(`worker started (plugin ${process.env.AOE_PLUGIN_ID ?? "unknown"})`);

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  try {
    const msg = JSON.parse(line) as { method?: unknown };
    log(`received ${typeof msg.method === "string" ? msg.method : "message without method"}`);
  } catch {
    log("ignored a line that is not JSON");
  }
});

// The host closes stdin to stop the worker.
lines.on("close", () => {
  log("stdin closed, exiting");
  process.exit(0);
});
