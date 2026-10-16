import { useEffect, useMemo, useRef, useState } from "react";
import { type Column, type Config, type Send, addColumn, deleteColumn, editColumn, enterAction, moveColumn } from "../shared/board-config";
import { type BridgeSession, type UiEntry, buildBoard, facets, findSnapshot, rowColumnSlots } from "../shared/board-model";
import { Board, type Editor, type HostMenu } from "./Board";
import { type Bridge, type BridgeContext, BridgeError } from "./bridge";
import { ColumnDialog } from "./ColumnDialog";
import { ConfigDialog } from "./ConfigDialog";

// The bridge has no change push, so the page polls.
const POLL_MS = 2_000;
// How long an edit shows before the snapshot must carry it back. An `action`
// reply only acknowledges delivery; the worker drops a config it rejects.
const CONFIRM_MS = 10_000;
// The worker ignores an invalid Stage write without a reply, so an unconfirmed
// move rolls back after this long. Matches core's action spinner timeout.
const MOVE_MS = 15_000;

interface Data {
  sessions: BridgeSession[];
  entries: UiEntry[];
  // Number of the poll that fetched this data.
  seq: number;
}

// A Stage write shown before the snapshot confirms it. `req` tells apart two
// writes of the same Session; `ackSeq` is the last poll started when the
// bridge acknowledged it, so only a later poll can confirm it. `enter` is the
// target Column's enter-action, fixed at drop time and run once confirmed.
interface Move {
  columnId: string;
  req: number;
  ackSeq?: number;
  enter?: EnterMethod;
}

type EnterMethod = NonNullable<ReturnType<typeof enterAction>>;
const SAVE_FAILED = "Couldn't save the Board.";
const ENTER_FAILED: Record<EnterMethod, string> = {
  "session.archive": "Couldn't archive the Session.",
  "session.trash": "Couldn't move the Session to the trash.",
};

// Prefixes a Stage column id in the dashboard menu's page items.
const MOVE = "move:";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Keeps rows with the fields the Board relies on; a malformed answer throws so
// the last good data stays on screen.
function readData(sessions: unknown, uiState: unknown): Omit<Data, "seq"> {
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

export function App({
  bridge,
  context,
  selected,
}: {
  bridge: Bridge;
  context: BridgeContext | null;
  selected: string | null;
}) {
  const [data, setData] = useState<Data | null>(null);
  // Whether the dashboard can open its own session menu. A probe with no params
  // answers invalid_params where it can and unknown_method where it is older.
  const [hostMenuOk, setHostMenuOk] = useState(false);
  useEffect(() => {
    if (!context) return;
    bridge.request("session.contextMenu").catch((e: Error) => setHostMenuOk(e instanceof BridgeError && e.code === "invalid_params"));
  }, [bridge, context]);
  const [failed, setFailed] = useState(false);
  const pollSeq = useRef(0);

  useEffect(() => {
    if (!context) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // Waits for each poll before scheduling the next, so polls never overlap.
    const poll = async () => {
      const seq = ++pollSeq.current;
      try {
        const [sessions, uiState] = await Promise.all([bridge.request("sessions.list"), bridge.request("plugins.uiState")]);
        if (live) setData({ ...readData(sessions, uiState), seq });
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
  const [toast, setToast] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Column | "new" | null>(null);
  const [configDialog, setConfigDialog] = useState<"export" | "import" | null>(null);
  const [moves, setMoves] = useState<Record<string, Move>>({});
  const nextReq = useRef(0);
  // The req of each Session's unsettled move, read by its timer and rejection.
  const liveReq = useRef<Record<string, number>>({});

  // Runs only after the snapshot shows the Stage written, since an `action`
  // reply only acknowledges delivery. Reversible, so it asks nothing.
  const runEnter = (sessionId: string, method: EnterMethod) =>
    bridge.request(method, { id: sessionId }).catch((e: Error) => {
      console.error(`[kanban] ${method} failed: ${e.message}`);
      setToast(ENTER_FAILED[method]);
    });

  const snapshot = useMemo(() => data && context && findSnapshot(data.entries, context.pluginId, context.pageId), [data, context]);
  useEffect(() => {
    if (pending && snapshot && JSON.stringify(snapshot.config) === JSON.stringify(pending)) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [snapshot, pending]);
  // Drops the Stage writes this snapshot confirms and runs their enter-actions.
  useEffect(() => {
    if (!data || !snapshot) return;
    const confirmed = Object.entries(moves).filter(
      ([id, m]) => m.ackSeq !== undefined && data.seq > m.ackSeq && snapshot.stages[id] === m.columnId,
    );
    if (!confirmed.length) return;
    // Clearing liveReq first makes a rerun of this effect skip the move.
    for (const [id, m] of confirmed) {
      if (liveReq.current[id] !== m.req) continue;
      delete liveReq.current[id];
      if (m.enter) runEnter(id, m.enter);
    }
    setMoves((prev) => Object.fromEntries(Object.entries(prev).filter(([id, m]) => liveReq.current[id] === m.req)));
  }, [data, snapshot, moves]);
  const config = pending ?? snapshot?.config;
  const columns = useMemo(() => {
    if (!data || !snapshot || !config) return null;
    const stages = { ...snapshot.stages };
    for (const [id, m] of Object.entries(moves)) stages[id] = m.columnId;
    return buildBoard(data.sessions, data.entries, { config, stages });
  }, [data, snapshot, config, moves]);

  if (!columns || !config || !snapshot || !data) {
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
    setToast(null);
    // Only the latest edit may roll back, so an older timer never undoes a newer one.
    const fail = () => {
      if (pendingRef.current !== next) return;
      pendingRef.current = null;
      setPending(null);
      setToast(SAVE_FAILED);
    };
    bridge.request("action", { method: "config.set", params: { config: next } }).then(
      () => setTimeout(fail, CONFIRM_MS),
      (e: Error) => {
        console.error(`[kanban] config.set failed: ${e.message}`);
        fail();
      },
    );
  };
  const setStage = (sessionId: string, columnId: string) => {
    const enter = enterAction(config.columns.find((c) => c.id === columnId));
    // A Stage that is only the leftmost fallback is still written, to record it.
    if ((moves[sessionId]?.columnId ?? snapshot.stages[sessionId]) === columnId) {
      // Dropping again onto a written archive or trash Column retries its action.
      if (enter && !moves[sessionId]) runEnter(sessionId, enter);
      return;
    }
    const req = ++nextReq.current;
    liveReq.current[sessionId] = req;
    setMoves((prev) => ({ ...prev, [sessionId]: { columnId, req, enter } }));
    setToast(null);
    // Only the Session's latest move may roll back, so an older one never
    // undoes a newer one.
    const fail = () => {
      if (liveReq.current[sessionId] !== req) return;
      delete liveReq.current[sessionId];
      setMoves((prev) => without(prev, [sessionId]));
      setToast(SAVE_FAILED);
    };
    setTimeout(fail, MOVE_MS);
    bridge.request("action", { method: "stage.set", params: { sessionId, columnId } }).then(
      () => {
        const ackSeq = pollSeq.current;
        setMoves((prev) => (prev[sessionId]?.req === req ? { ...prev, [sessionId]: { ...prev[sessionId], ackSeq } } : prev));
      },
      (e: Error) => {
        console.error(`[kanban] stage.set failed: ${e.message}`);
        fail();
      },
    );
  };
  const sendMessage = (column: Column, sessionIds: string[]) => {
    setToast(null);
    // The reply only acknowledges delivery to the worker, which logs a failed send.
    bridge.request("action", { method: "message.send", params: { columnId: column.id, sessionIds } }).then(
      () => setToast(`Sending "${column.send?.label}" to ${sessionIds.length} Session${sessionIds.length === 1 ? "" : "s"}.`),
      (e: Error) => {
        console.error(`[kanban] message.send failed: ${e.message}`);
        setToast("Couldn't send the message.");
      },
    );
  };
  const editor: Editor | undefined =
    context && !context.readOnly && !context.cityhall
      ? {
          onAdd: () => setDialog("new"),
          onEdit: setDialog,
          onMove: (id, to) => save(moveColumn(config, id, to)),
          onStage: setStage,
          onSend: sendMessage,
          onImport: () => setConfigDialog("import"),
        }
      : undefined;
  const editing = dialog === "new" ? null : dialog;
  // The dashboard's session menu, with this Board's Stages appended as Move to items.
  const hostMenu: HostMenu | undefined = hostMenuOk
    ? (card, x, y) => {
        const items = editor
          ? config.columns
              // The Card's own archive or trash Stage stays, to retry a refused action.
              .filter((c) => c.kind === "stage" && (c.id !== card.stageId || enterAction(c)))
              .map((c) => ({ id: MOVE + c.id, label: `Move to ${c.title}` }))
          : [];
        bridge.request("session.contextMenu", { id: card.session.id, x, y, items }, { wait: true }).then(
          (picked) => {
            if (editor && typeof picked === "string" && picked.startsWith(MOVE)) setStage(card.session.id, picked.slice(MOVE.length));
          },
          (e: Error) => console.error(`[kanban] session.contextMenu failed: ${e.message}`),
        );
      }
    : undefined;

  return (
    <>
      <Board
        columns={columns}
        selected={selected}
        onOpen={openSession}
        onExport={() => setConfigDialog("export")}
        editor={editor}
        hostMenu={hostMenu}
      />
      {editor && dialog && (
        <ColumnDialog
          column={editing}
          canDelete={!!editing && !!deleteColumn(config, editing.id)}
          slots={rowColumnSlots(data.entries)}
          facets={facets(data.entries)}
          stages={config.columns.filter((c) => c.kind === "stage")}
          onClose={() => setDialog(null)}
          onSave={(title, kind, onEnter, rules, send?: Send) => {
            if (!editing) save(addColumn(config, title, kind, onEnter, rules, send));
            else if (
              title !== editing.title ||
              onEnter !== editing.on_enter ||
              JSON.stringify(rules) !== JSON.stringify(editing.rules) ||
              JSON.stringify(send) !== JSON.stringify(editing.send)
            )
              save(editColumn(config, editing.id, { title, on_enter: onEnter, rules, send }));
            setDialog(null);
          }}
          onDelete={() => {
            const next = editing && deleteColumn(config, editing.id);
            if (next) save(next);
            setDialog(null);
          }}
        />
      )}
      {configDialog && (
        <ConfigDialog
          config={config}
          onImport={
            editor && configDialog === "import"
              ? (next) => {
                  save(next);
                  setConfigDialog(null);
                }
              : undefined
          }
          onClose={() => setConfigDialog(null)}
        />
      )}
      {toast && (
        <p className="toast" role="alert">
          {toast}
        </p>
      )}
    </>
  );
}

const without = <T,>(map: Record<string, T>, ids: string[]) =>
  Object.fromEntries(Object.entries(map).filter(([id]) => !ids.includes(id)));
