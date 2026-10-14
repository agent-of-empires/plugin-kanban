import { createInterface } from "node:readline";

// JSON-RPC 2.0 over newline-delimited JSON on stdio. The host only sends
// notifications; the worker sends requests and the host replies by id. The host
// parses every stdout line as a request, so nothing else may go there.

// Overridable so tests can exercise a host that never replies.
const TIMEOUT_MS = Number(process.env.KANBAN_RPC_TIMEOUT_MS) || 10_000;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type Call = (method: string, params: unknown) => Promise<unknown>;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function connect(
  log: (msg: string) => void,
  onNotification: (method: string, params: unknown) => void,
  onClose: () => void,
): Call {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log("ignored a line that is not JSON");
      return;
    }
    if (!isRecord(msg)) {
      log("ignored a message that is not an object");
      return;
    }
    if (typeof msg.method === "string") {
      onNotification(msg.method, msg.params);
      return;
    }
    // A reply. Replies run outside the caller's task queue, or a task awaiting
    // its own request would never see the answer.
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) {
      log("ignored a reply to no pending request");
      return;
    }
    pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (isRecord(msg.error)) p.reject(new Error(String(msg.error.message ?? "host error")));
    else p.resolve(msg.result);
  });
  lines.on("close", onClose);

  return (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}
