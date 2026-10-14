import { expect, test, vi } from "vitest";
import { BRIDGE_VERSION, connectBridge } from "../src/page/bridge";

function fakeWindows() {
  let listener: ((event: MessageEvent) => void) | null = null;
  const host = { postMessage: vi.fn() };
  const self = {
    addEventListener: (_: "message", fn: (event: MessageEvent) => void) => (listener = fn),
    removeEventListener: () => (listener = null),
  };
  const deliver = (source: unknown, data: unknown) => listener?.({ source, data } as MessageEvent);
  return { host, self, deliver, listening: () => listener !== null };
}

const context = { readOnly: true, cityhall: false, pluginId: "agent-of-empires.kanban", pageId: "board", bridgeVersion: 1 };

test("signals ready and forwards context and theme pushes from the host", () => {
  const { host, self, deliver } = fakeWindows();
  const onContext = vi.fn();
  const onTheme = vi.fn();
  connectBridge(host, self, { onContext, onTheme });

  expect(host.postMessage).toHaveBeenCalledWith({ bridge: BRIDGE_VERSION, type: "ready" }, "*");

  deliver(host, { bridge: BRIDGE_VERSION, type: "context", payload: context });
  const theme = { appearance: "dark", cssVars: { "--bg": "#000" } };
  deliver(host, { bridge: BRIDGE_VERSION, type: "theme", payload: theme });
  expect(onContext).toHaveBeenCalledWith(context);
  expect(onTheme).toHaveBeenCalledWith(theme);
});

test("ignores messages from other sources or bridge versions", () => {
  const { host, self, deliver } = fakeWindows();
  const onContext = vi.fn();
  connectBridge(host, self, { onContext, onTheme: vi.fn() });

  deliver({}, { bridge: BRIDGE_VERSION, type: "context", payload: context });
  deliver(host, { bridge: BRIDGE_VERSION + 1, type: "context", payload: context });
  deliver(host, null);
  expect(onContext).not.toHaveBeenCalled();
});

test("ignores pushes with a malformed payload", () => {
  const { host, self, deliver } = fakeWindows();
  const onContext = vi.fn();
  const onTheme = vi.fn();
  connectBridge(host, self, { onContext, onTheme });

  deliver(host, { bridge: BRIDGE_VERSION, type: "context" });
  deliver(host, { bridge: BRIDGE_VERSION, type: "theme", payload: null });
  deliver(host, { bridge: BRIDGE_VERSION, type: "theme", payload: { appearance: "dark" } });
  expect(onContext).not.toHaveBeenCalled();
  expect(onTheme).not.toHaveBeenCalled();
});

test("disconnect removes the listener", () => {
  const { host, self, listening } = fakeWindows();
  const disconnect = connectBridge(host, self, { onContext: vi.fn(), onTheme: vi.fn() });
  disconnect();
  expect(listening()).toBe(false);
});
