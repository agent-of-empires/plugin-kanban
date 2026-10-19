// Client for the dashboard's plugin page bridge v1 (core docs/plugin-api.md,
// "Page bridge"). The page posts `ready` to its parent with one end of a
// MessageChannel; every later request, reply and push travels over that port.

export const BRIDGE_VERSION = 1;
// Bridge calls are local, so a reply this late means the dashboard is gone.
const TIMEOUT_MS = 5_000;

export interface BridgeContext {
  readOnly: boolean;
  cityhall: boolean;
  pluginId: string;
  pageId: string;
  bridgeVersion: number;
}

export interface BridgeTheme {
  appearance: "dark" | "light";
  cssVars: Record<string, string>;
}

export interface BridgeHandlers {
  onContext: (context: BridgeContext) => void;
  onTheme: (theme: BridgeTheme) => void;
  // The Session the dashboard's split view shows below the page, or null.
  onSelection: (sessionId: string | null) => void;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Bridge {
  // `wait` drops the timeout, for a call that waits on the user, like session.contextMenu.
  request(method: string, params?: Record<string, unknown>, opts?: { wait?: boolean }): Promise<unknown>;
  // Closes the port and rejects every pending request.
  close(): void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isContext = (d: unknown): d is BridgeContext =>
  isRecord(d) &&
  typeof d.readOnly === "boolean" &&
  typeof d.cityhall === "boolean" &&
  typeof d.pluginId === "string" &&
  typeof d.pageId === "string";

const isTheme = (d: unknown): d is BridgeTheme =>
  isRecord(d) && (d.appearance === "dark" || d.appearance === "light") && isRecord(d.cssVars);

// The dashboard accepts one `ready` per frame, so call this once per document.
export function connectBridge(host: Pick<Window, "postMessage">, nonce: string, handlers: BridgeHandlers): Bridge {
  const { port1: port, port2 } = new MessageChannel();
  const pending = new Map<number, Pending>();
  let nextId = 1;

  port.onmessage = ({ data: msg }: MessageEvent) => {
    if (!isRecord(msg) || msg.aoeBridge !== BRIDGE_VERSION) return;
    if (msg.event === "context" && isContext(msg.data)) return handlers.onContext(msg.data);
    if (msg.event === "theme" && isTheme(msg.data)) return handlers.onTheme(msg.data);
    if (msg.event === "selection" && isRecord(msg.data)) {
      const { sessionId } = msg.data;
      return handlers.onSelection(typeof sessionId === "string" ? sessionId : null);
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (isRecord(msg.error)) p.reject(new BridgeError(String(msg.error.code), String(msg.error.message)));
    else p.resolve(msg.result);
  };

  const send = (method: string, params: Record<string, unknown> | undefined, post: (msg: object) => void, wait = false) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = wait
        ? undefined
        : setTimeout(() => {
            pending.delete(id);
            reject(new BridgeError("timeout", `${method} timed out`));
          }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      post({ aoeBridge: BRIDGE_VERSION, id, method, ...(params && { params }) });
    });

  send("ready", { nonce }, (msg) => host.postMessage(msg, "*", [port2])).catch((e: Error) =>
    console.error(`[kanban] bridge: ${e.message}`),
  );

  return {
    request: (method, params, opts) => send(method, params, (msg) => port.postMessage(msg), opts?.wait),
    close() {
      port.close();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new BridgeError("closed", "bridge closed"));
      }
      pending.clear();
    },
  };
}
