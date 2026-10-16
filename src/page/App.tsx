import { useEffect, useMemo, useRef, useState } from "react";
import { type Column, type Config, addColumn, deleteColumn, moveColumn, renameColumn } from "../shared/board-config";
import { type BridgeSession, type UiEntry, buildBoard, findSnapshot } from "../shared/board-model";
import { Board, type Editor } from "./Board";
import type { Bridge, BridgeContext } from "./bridge";
import { ColumnDialog } from "./ColumnDialog";

// The bridge has no change push, so the page polls.
const POLL_MS = 2_000;
// How long an edit shows before the snapshot must carry it back. An `action`
// reply only acknowledges delivery; the worker drops a config it rejects.
const CONFIRM_MS = 10_000;

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

  // An edit renders at once and holds until the snapshot carries the same config.
  const [pending, setPending] = useState<Config | null>(null);
  const pendingRef = useRef<Config | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [dialog, setDialog] = useState<Column | "new" | null>(null);

  const snapshot = useMemo(() => data && context && findSnapshot(data.entries, context.pluginId, context.pageId), [data, context]);
  useEffect(() => {
    if (pending && snapshot && JSON.stringify(snapshot.config) === JSON.stringify(pending)) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [snapshot, pending]);
  const config = pending ?? snapshot?.config;
  const columns = useMemo(
    () => data && snapshot && config && buildBoard(data.sessions, data.entries, { ...snapshot, config }),
    [data, snapshot, config],
  );

  if (!columns || !config) {
    return (
      <p className="notice" data-testid="board-status">
        {failed ? "Couldn't load sessions from the dashboard." : "Loading the Board..."}
      </p>
    );
  }
  const openSession = (id: string) =>
    bridge.request("openSession", { id }).catch((e: Error) => console.error(`[kanban] openSession failed: ${e.message}`));

  const save = (next: Config) => {
    pendingRef.current = next;
    setPending(next);
    setSaveFailed(false);
    // Only the latest edit may roll back, so an older timer never undoes a newer one.
    const fail = () => {
      if (pendingRef.current !== next) return;
      pendingRef.current = null;
      setPending(null);
      setSaveFailed(true);
    };
    bridge.request("action", { method: "config.set", params: { config: next } }).then(
      () => setTimeout(fail, CONFIRM_MS),
      (e: Error) => {
        console.error(`[kanban] config.set failed: ${e.message}`);
        fail();
      },
    );
  };
  const editor: Editor | undefined =
    context && !context.readOnly && !context.cityhall
      ? {
          onAdd: () => setDialog("new"),
          onEdit: setDialog,
          onMove: (id, to) => save(moveColumn(config, id, to)),
        }
      : undefined;
  const editing = dialog === "new" ? null : dialog;

  return (
    <>
      <Board columns={columns} onOpen={openSession} editor={editor} />
      {editor && dialog && (
        <ColumnDialog
          column={editing}
          canDelete={!!editing && !!deleteColumn(config, editing.id)}
          onClose={() => setDialog(null)}
          onSave={(title, kind) => {
            if (!editing) save(addColumn(config, title, kind));
            else if (title !== editing.title) save(renameColumn(config, editing.id, title));
            setDialog(null);
          }}
          onDelete={() => {
            const next = editing && deleteColumn(config, editing.id);
            if (next) save(next);
            setDialog(null);
          }}
        />
      )}
      {saveFailed && (
        <p className="toast" role="alert">
          Couldn't save the Board.
        </p>
      )}
    </>
  );
}
