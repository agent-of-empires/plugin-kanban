import { useEffect, useMemo, useState } from "react";
import { type BridgeSession, type UiEntry, buildBoard, findSnapshot } from "../shared/board-model";
import { Board } from "./Board";
import type { Bridge, BridgeContext } from "./bridge";

// The bridge has no change push, so the page polls.
const POLL_MS = 2_000;

interface Data {
  sessions: BridgeSession[];
  entries: UiEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Keeps rows with the fields the Board relies on; a malformed answer throws so
// the last good data stays on screen.
function readData(sessions: unknown, uiState: unknown): Data {
  const entries = isRecord(uiState) ? uiState.entries : undefined;
  if (!Array.isArray(sessions) || !Array.isArray(entries)) throw new Error("malformed bridge reply");
  return {
    sessions: sessions.filter(
      (s): s is BridgeSession =>
        isRecord(s) && typeof s.id === "string" && typeof s.title === "string" && typeof s.status === "string",
    ),
    entries: entries.filter(
      (e): e is UiEntry =>
        isRecord(e) && typeof e.plugin_id === "string" && typeof e.slot === "string" && isRecord(e.payload),
    ),
  };
}

export function App({ bridge, context }: { bridge: Bridge; context: BridgeContext | null }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!context) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // Waits for each poll before scheduling the next, so polls never overlap.
    const poll = async () => {
      try {
        const [sessions, uiState] = await Promise.all([bridge.request("sessions.list"), bridge.request("plugins.uiState")]);
        if (live) setData(readData(sessions, uiState));
      } catch (e) {
        console.error(`[kanban] refresh failed: ${(e as Error).message}`);
        if (live) setFailed(true);
      }
      if (live) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bridge, context]);

  const columns = useMemo(
    () => data && context && buildBoard(data.sessions, data.entries, findSnapshot(data.entries, context.pluginId, context.pageId)),
    [data, context],
  );

  if (!columns) {
    return (
      <p className="notice" data-testid="board-status">
        {failed ? "Couldn't load sessions from the dashboard." : "Loading the Board..."}
      </p>
    );
  }
  const openSession = (id: string) =>
    bridge.request("openSession", { id }).catch((e: Error) => console.error(`[kanban] openSession failed: ${e.message}`));
  return <Board columns={columns} onOpen={openSession} />;
}
