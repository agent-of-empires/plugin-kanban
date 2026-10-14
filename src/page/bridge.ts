// Provisional client for the plugin page bridge. Core has not fixed the wire
// format yet (agent-of-empires/agent-of-empires#4461); every message name and
// shape lives in this file so adopting the real one is a one-file change.

export const BRIDGE_VERSION = 1;

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
}

type HostMessage =
  | { bridge: typeof BRIDGE_VERSION; type: "context"; payload: BridgeContext }
  | { bridge: typeof BRIDGE_VERSION; type: "theme"; payload: BridgeTheme };

interface MessageSource {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

// Listens for host pushes, then signals ready. The page runs in an opaque-origin
// sandbox, so messages are matched on their source window, not their origin.
export function connectBridge(
  host: Pick<Window, "postMessage">,
  self: MessageSource,
  handlers: BridgeHandlers,
): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== host) return;
    const msg = event.data as HostMessage;
    if (msg?.bridge !== BRIDGE_VERSION) return;
    if (msg.type === "context") handlers.onContext(msg.payload);
    else if (msg.type === "theme") handlers.onTheme(msg.payload);
  };
  self.addEventListener("message", listener);
  host.postMessage({ bridge: BRIDGE_VERSION, type: "ready" }, "*");
  return () => self.removeEventListener("message", listener);
}
