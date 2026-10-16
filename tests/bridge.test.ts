import { afterEach, expect, test, vi } from "vitest";
import { BRIDGE_VERSION, BridgeError, connectBridge } from "../src/page/bridge";

const context = { readOnly: true, cityhall: false, pluginId: "agent-of-empires.kanban", pageId: "board", bridgeVersion: 1 };

type Msg = { aoeBridge: number; id: number; method: string; params?: Record<string, unknown> };

const open: MessagePort[] = [];
afterEach(() => {
  open.splice(0).forEach((p) => p.close());
  vi.useRealTimers();
});

// Plays the dashboard: captures the ready message and the transferred port,
// then answers requests on that port with `answer`.
function fakeHost(answer: (msg: Msg) => object | undefined = () => undefined) {
  let resolveReady: (v: { msg: Msg; port: MessagePort }) => void = () => {};
  const ready = new Promise<{ msg: Msg; port: MessagePort }>((resolve) => (resolveReady = resolve));
  const requests: Msg[] = [];
  const host = {
    postMessage: (msg: Msg, _origin: string, transfer: MessagePort[]) => {
      const port = transfer[0];
      open.push(port);
      port.onmessage = ({ data }) => {
        requests.push(data);
        const reply = answer(data);
        if (reply) port.postMessage({ aoeBridge: BRIDGE_VERSION, id: data.id, ...reply });
      };
      resolveReady({ msg, port });
    },
  } as unknown as Window;
  return { host, ready, requests };
}

const handlers = () => ({ onContext: vi.fn(), onTheme: vi.fn(), onSelection: vi.fn() });

test("sends ready with the nonce and a port, then forwards context and theme pushes", async () => {
  const { host, ready } = fakeHost();
  const h = handlers();
  const bridge = connectBridge(host, "n0nce", h);
  const { msg, port } = await ready;
  expect(msg).toEqual({ aoeBridge: BRIDGE_VERSION, id: 1, method: "ready", params: { nonce: "n0nce" } });

  const theme = { appearance: "dark", cssVars: { "--color-surface-900": "#000" } };
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "context", data: context });
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "theme", data: theme });
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "selection", data: { sessionId: "s" } });
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "selection", data: { sessionId: null } });
  await vi.waitFor(() => expect(h.onSelection).toHaveBeenCalledTimes(2));
  expect(h.onTheme).toHaveBeenCalledWith(theme);
  expect(h.onContext).toHaveBeenCalledWith(context);
  expect(h.onSelection.mock.calls).toEqual([["s"], [null]]);
  bridge.close();
});

test("ignores malformed pushes and other bridge versions", async () => {
  const { host, ready } = fakeHost();
  const h = handlers();
  const bridge = connectBridge(host, "", h);
  const { port } = await ready;
  port.postMessage({ aoeBridge: BRIDGE_VERSION + 1, event: "context", data: context });
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "context", data: { ...context, pluginId: 1 } });
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "theme", data: { appearance: "dark" } });
  port.postMessage(null);
  port.postMessage({ aoeBridge: BRIDGE_VERSION, event: "context", data: context });
  await vi.waitFor(() => expect(h.onContext).toHaveBeenCalledTimes(1));
  expect(h.onTheme).not.toHaveBeenCalled();
  bridge.close();
});

test("requests resolve with the result and reject with the bridge error", async () => {
  const { host, requests } = fakeHost((msg) =>
    msg.method === "sessions.list"
      ? { result: [{ id: "s" }] }
      : msg.method === "openSession"
        ? { error: { code: "invalid_params", message: "bad id" } }
        : undefined,
  );
  const bridge = connectBridge(host, "", handlers());
  await expect(bridge.request("sessions.list")).resolves.toEqual([{ id: "s" }]);
  const err = await bridge.request("openSession", { id: 7 }).catch((e) => e);
  expect(err).toBeInstanceOf(BridgeError);
  expect(err).toMatchObject({ code: "invalid_params", message: "bad id" });
  expect(requests).toEqual([
    { aoeBridge: BRIDGE_VERSION, id: 2, method: "sessions.list" },
    { aoeBridge: BRIDGE_VERSION, id: 3, method: "openSession", params: { id: 7 } },
  ]);
  bridge.close();
});

test("an unanswered request times out", async () => {
  vi.useFakeTimers();
  const { host } = fakeHost();
  const bridge = connectBridge(host, "", handlers());
  const pending = bridge.request("plugins.uiState");
  vi.advanceTimersByTime(5_000);
  await expect(pending).rejects.toMatchObject({ code: "timeout" });
  bridge.close();
});

test("a waiting request outlives the timeout", async () => {
  vi.useFakeTimers();
  const { host, ready } = fakeHost();
  const bridge = connectBridge(host, "", handlers());
  const { port } = await ready;
  const pending = bridge.request("session.contextMenu", { id: "s", x: 0, y: 0 }, { wait: true });
  vi.advanceTimersByTime(60_000);
  port.postMessage({ aoeBridge: BRIDGE_VERSION, id: 2, result: "pick" });
  vi.useRealTimers();
  await expect(pending).resolves.toBe("pick");
  bridge.close();
});

test("close rejects pending requests", async () => {
  const { host } = fakeHost();
  const bridge = connectBridge(host, "", handlers());
  const pending = bridge.request("sessions.list");
  bridge.close();
  await expect(pending).rejects.toMatchObject({ code: "closed" });
});
