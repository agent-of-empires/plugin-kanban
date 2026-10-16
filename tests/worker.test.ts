import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { type Config, DEFAULT_CONFIG } from "../src/shared/board-config";

interface Request {
  jsonrpc: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface HostState {
  sessions: string[];
  meta?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  // Return "silent" to never reply, or a reply body to send instead.
  intercept?: (req: Request) => "silent" | { error: { code: number; message: string } } | { result: unknown } | undefined;
  env?: Record<string, string>;
}

const procs: ChildProcess[] = [];
afterEach(() => procs.splice(0).forEach((p) => p.kill()));

// Runs the built worker against an in-memory host that answers its JSON-RPC
// requests the way the AoE host does.
function startWorker(host: HostState) {
  const meta = { ...host.meta };
  const storage = { ...host.storage };
  const proc = spawn("node", ["dist/worker.js"], {
    env: { ...process.env, AOE_PLUGIN_ID: "agent-of-empires.kanban", ...host.env },
  });
  const requests: Request[] = [];
  const stdoutLines: string[] = [];
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", resolve));

  const reply = (id: number, body: object) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  createInterface({ input: proc.stdout }).on("line", (line) => {
    stdoutLines.push(line);
    const req = JSON.parse(line) as Request;
    requests.push(req);
    const intercepted = host.intercept?.(req);
    if (intercepted === "silent") return;
    if (intercepted) return reply(req.id, intercepted);
    const p = req.params;
    const sid = p.session_id as string;
    switch (req.method) {
      case "sessions.list":
        return reply(req.id, { result: { sessions: host.sessions.map((id) => ({ id, status: "Idle" })) } });
      case "session.meta.get":
        return reply(req.id, { result: { value: meta[sid] ?? null } });
      case "session.meta.set":
        if (!host.sessions.includes(sid)) return reply(req.id, { error: { code: -32602, message: `unknown session "${sid}"` } });
        meta[sid] = p.value;
        return reply(req.id, { result: { ok: true } });
      case "plugin.storage.get":
        return reply(req.id, { result: { value: storage[p.key as string] ?? null } });
      case "plugin.storage.set":
        storage[p.key as string] = p.value;
        return reply(req.id, { result: {} });
      case "sessions.message.send":
        return reply(req.id, { result: { disposition: "sent", revived: false } });
      case "ui.state.set":
        return reply(req.id, { result: { ok: true } });
    }
  });

  const worker = {
    proc,
    requests,
    stdoutLines,
    meta,
    storage,
    exited,
    stderr: () => stderr,
    calls: (method: string) => requests.filter((r) => r.method === method).map((r) => r.params),
    snapshots: () =>
      worker.calls("ui.state.set").map((p) => {
        expect(p).toMatchObject({ slot: "page", id: "board" });
        return p.payload as { stages: Record<string, string>; config: Config };
      }),
    notify: (method: string, params?: unknown) =>
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    raw: (line: string) => proc.stdin.write(`${line}\n`),
  };
  procs.push(proc);
  return worker;
}

const lastSnapshot = (w: ReturnType<typeof startWorker>) => w.snapshots().at(-1);

test("publishes the default config with no stages when storage is empty", async () => {
  const w = startWorker({ sessions: ["a1"] });
  await vi.waitFor(() => expect(w.snapshots()).toEqual([{ stages: {}, config: DEFAULT_CONFIG }]));
  expect(w.calls("plugin.storage.get")).toEqual([{ key: "config" }]);
  expect(w.calls("session.meta.get")).toEqual([{ session_id: "a1", key: "stage" }]);
  expect(w.calls("plugin.storage.set")).toEqual([]);
});

test("start loads stored config and each Session's stage", async () => {
  const config: Config = {
    version: 1,
    columns: [{ id: "todo", title: "Todo", kind: "stage", rules: [], on_enter: "none" }],
  };
  const w = startWorker({ sessions: ["a1", "b2"], meta: { a1: "todo" }, storage: { config } });
  await vi.waitFor(() => expect(lastSnapshot(w)).toEqual({ stages: { a1: "todo" }, config }));
});

test("an invalid stored config falls back to the default without overwriting it", async () => {
  const w = startWorker({ sessions: [], storage: { config: { version: 9 } } });
  await vi.waitFor(() => expect(lastSnapshot(w)?.config).toEqual(DEFAULT_CONFIG));
  expect(w.stderr()).toContain("stored config is invalid");
  expect(w.calls("plugin.storage.set")).toEqual([]);
});

test("stage.set persists to session.meta and republishes", async () => {
  const w = startWorker({ sessions: ["a1"] });
  // Sent before the start scan finishes: the queue runs it afterwards.
  w.notify("stage.set", { sessionId: "a1", columnId: "done" });
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" }));
  expect(w.calls("session.meta.set")).toEqual([{ session_id: "a1", key: "stage", value: "done" }]);

  w.notify("stage.set", { sessionId: "a1", columnId: null });
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({}));
  expect(w.meta.a1).toBeNull();
  // Start, then one publish per write.
  expect(w.snapshots()).toHaveLength(3);
});

test("config.set persists to plugin.storage and republishes", async () => {
  const w = startWorker({ sessions: [] });
  const config: Config = { ...DEFAULT_CONFIG, columns: DEFAULT_CONFIG.columns.slice(0, 3) };
  w.notify("config.set", { config });
  await vi.waitFor(() => expect(lastSnapshot(w)?.config).toEqual(config));
  expect(w.calls("plugin.storage.set")).toEqual([{ key: "config", value: config }]);
});

test("invalid payloads are logged and ignored, and the worker keeps serving", async () => {
  const w = startWorker({ sessions: ["a1"] });
  w.raw("not json");
  w.raw("null");
  w.notify("board.explode", {});
  w.notify("stage.set");
  w.notify("stage.set", { sessionId: 7, columnId: "done" });
  w.notify("stage.set", { sessionId: "a1", columnId: "nope" });
  w.notify("stage.set", { sessionId: "a1", columnId: "error" });
  w.notify("config.set", { config: { version: 1, columns: [] } });
  w.notify("config.set", "garbage");
  const huge = { ...DEFAULT_CONFIG.columns[2], title: "x".repeat(70_000) };
  w.notify("config.set", { config: { version: 1, columns: [huge] } });
  w.notify("stage.set", { sessionId: "a1", columnId: "done" });

  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" }));
  expect(w.calls("session.meta.set")).toHaveLength(1);
  expect(w.calls("plugin.storage.set")).toEqual([]);
  const log = w.stderr();
  for (const line of [
    "ignored a line that is not JSON",
    "ignored a message that is not an object",
    "ignored unknown method board.explode",
    "ignored stage.set: expected {sessionId, columnId|null}",
    'ignored stage.set: "nope" is not a Stage column',
    'ignored stage.set: "error" is not a Stage column',
    "ignored config.set: config: needs at least one Stage column",
    "ignored config.set: config: not an object",
    "ignored config.set: the snapshot would exceed its size cap",
  ]) {
    expect(log).toContain(line);
  }
  expect(w.proc.exitCode).toBeNull();
});

test("a host error leaves state unchanged", async () => {
  const w = startWorker({ sessions: ["a1"] });
  w.notify("stage.set", { sessionId: "gone", columnId: "done" });
  w.notify("stage.set", { sessionId: "a1", columnId: "done" });
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" }));
  expect(w.stderr()).toContain('stage.set failed: unknown session "gone"');
});

test("a host that never replies times out without wedging the queue", async () => {
  let dropped = false;
  const w = startWorker({
    sessions: ["a1"],
    env: { KANBAN_RPC_TIMEOUT_MS: "200" },
    intercept: (req) => {
      if (req.method !== "session.meta.set" || dropped) return undefined;
      dropped = true;
      return "silent";
    },
  });
  w.notify("stage.set", { sessionId: "a1", columnId: "needs-testing" });
  w.notify("stage.set", { sessionId: "a1", columnId: "done" });
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" }));
  expect(w.stderr()).toContain("stage.set failed: session.meta.set timed out");
  expect(w.snapshots().some((s) => s.stages.a1 === "needs-testing")).toBe(false);
});

test("a write that times out but lands on the host is reloaded on the next status change", async () => {
  const config: Config = { ...DEFAULT_CONFIG, columns: DEFAULT_CONFIG.columns.slice(0, 3) };
  const w = startWorker({
    sessions: ["a1"],
    env: { KANBAN_RPC_TIMEOUT_MS: "200" },
    // Apply both writes, then never reply.
    intercept: (req) => {
      if (req.method === "session.meta.set") w.meta.a1 = req.params.value;
      else if (req.method === "plugin.storage.set") w.storage.config = req.params.value;
      else return undefined;
      return "silent";
    },
  });
  w.notify("stage.set", { sessionId: "a1", columnId: "in-progress" });
  w.notify("config.set", { config });
  await vi.waitFor(() => expect(w.stderr()).toContain("config.set failed: plugin.storage.set timed out"));
  expect(lastSnapshot(w)).toEqual({ stages: {}, config: DEFAULT_CONFIG });

  w.notify("session.status.changed", {});
  await vi.waitFor(() => expect(lastSnapshot(w)).toEqual({ stages: { a1: "in-progress" }, config }));
});

test("session.status.changed drops purged Sessions and skips unchanged snapshots", async () => {
  const host: HostState = { sessions: ["a1", "b2"], meta: { a1: "done", b2: "in-progress" } };
  const w = startWorker(host);
  await vi.waitFor(() => expect(w.snapshots()).toHaveLength(1));

  w.notify("session.status.changed", { session_id: "a1", from: "running", to: "idle" });
  await vi.waitFor(() => expect(w.calls("sessions.list")).toHaveLength(2));
  await sleep(100);
  expect(w.snapshots()).toHaveLength(1);

  host.sessions = ["a1"];
  w.notify("session.status.changed", { session_id: "b2", from: "idle", to: "idle" });
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" }));
});

test("a failed start scan is retried on the next status change, a malformed list prunes nothing", async () => {
  let listCalls = 0;
  const host: HostState = {
    sessions: ["a1"],
    meta: { a1: "done" },
    intercept: (req) => {
      if (req.method !== "sessions.list") return undefined;
      listCalls += 1;
      return listCalls === 1 ? { error: { code: -32603, message: "boom" } } : undefined;
    },
  };
  const w = startWorker(host);
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({}));
  w.notify("session.status.changed", {});
  await vi.waitFor(() => expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" }));

  host.sessions = [];
  host.intercept = (req) => (req.method === "sessions.list" ? { result: { sessions: [{ title: "no id" }] } } : undefined);
  w.notify("session.status.changed", {});
  await vi.waitFor(() => expect(w.stderr()).toContain("sessions.list returned a malformed list"));
  await sleep(100);
  expect(lastSnapshot(w)?.stages).toEqual({ a1: "done" });
});

test("snapshot for 500 Sessions stays under the 64 KiB ui-state cap", async () => {
  const sessions = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(16, "0"));
  const meta = Object.fromEntries(sessions.map((id) => [id, "waiting-for-review"]));
  const w = startWorker({ sessions, meta });
  await vi.waitFor(() => expect(Object.keys(lastSnapshot(w)?.stages ?? {})).toHaveLength(500), { timeout: 5000 });
  expect(Buffer.byteLength(JSON.stringify(lastSnapshot(w)))).toBeLessThan(64 * 1024);
});

test("stdout carries only JSON-RPC requests, and stdin EOF exits cleanly", async () => {
  const w = startWorker({ sessions: [] });
  await vi.waitFor(() => expect(w.snapshots()).toHaveLength(1));
  w.proc.stdin.end();
  expect(await w.exited).toBe(0);
  for (const line of w.stdoutLines) {
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0", id: expect.any(Number), method: expect.any(String) });
  }
  expect(w.stderr()).toContain("worker started (plugin agent-of-empires.kanban)");
});

const sendConfig: Config = {
  version: 1,
  columns: [
    { id: "gh", title: "Comments", kind: "signal", rules: [], on_enter: "none", send: { label: "Fix", message: "resolve the comments", stage: "wip" } },
    { id: "wip", title: "WIP", kind: "stage", rules: [], on_enter: "none" },
    { id: "plain", title: "Plain", kind: "stage", rules: [], on_enter: "none" },
  ],
};

test("message.send sends the Column's stored message and moves each Session", async () => {
  const w = startWorker({ sessions: ["a1", "b2"], storage: { config: sendConfig } });
  await vi.waitFor(() => expect(lastSnapshot(w)).toBeDefined());
  w.notify("message.send", { columnId: "gh", sessionIds: ["a1", "b2"], message: "page text is ignored" });
  await vi.waitFor(() => expect(w.meta).toEqual({ a1: "wip", b2: "wip" }));
  expect(w.calls("sessions.message.send")).toEqual([
    { session_id: "a1", message: "resolve the comments" },
    { session_id: "b2", message: "resolve the comments" },
  ]);
});

test("message.send skips the move for a Session that failed and carries on", async () => {
  const w = startWorker({
    sessions: ["a1", "b2"],
    storage: { config: sendConfig },
    intercept: (req) =>
      req.method === "sessions.message.send" && req.params.session_id === "a1"
        ? { error: { code: -32000, message: "session_archived" } }
        : undefined,
  });
  await vi.waitFor(() => expect(lastSnapshot(w)).toBeDefined());
  w.notify("message.send", { columnId: "gh", sessionIds: ["a1", "b2"] });
  await vi.waitFor(() => expect(w.meta).toEqual({ b2: "wip" }));
  expect(w.stderr()).toContain("messaging a1 failed");
});

test("message.send ignores a Column without a message", async () => {
  const w = startWorker({ sessions: ["a1"], storage: { config: sendConfig } });
  await vi.waitFor(() => expect(lastSnapshot(w)).toBeDefined());
  w.notify("message.send", { columnId: "plain", sessionIds: ["a1"] });
  await vi.waitFor(() => expect(w.stderr()).toContain("ignored message.send"));
  expect(w.calls("sessions.message.send")).toEqual([]);
});
