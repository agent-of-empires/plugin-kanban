import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { icons } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Column } from "../shared/board-config";
import { type BoardColumn, type Card, type FilteredColumn, filterBoard } from "../shared/board-model";

// Absent in read-only and CityHall context, where the Board cannot change.
export interface Editor {
  onAdd: () => void;
  onEdit: (column: Column) => void;
  onMove: (id: string, to: number) => void;
  onStage: (sessionId: string, columnId: string) => void;
  // Sends the Column's one-click message to these Sessions.
  onSend: (column: Column, sessionIds: string[]) => void;
  onImport: () => void;
}

type OnMenu = (card: Card, x: number, y: number) => void;
// Opens the dashboard's session menu at frame coordinates.
export type HostMenu = OnMenu;

// The open "Move to" menu: its Card and viewport position.
interface Menu {
  card: Card;
  x: number;
  y: number;
}

// Card drags share the DndContext with Column reordering; the prefix keeps a
// Session id from colliding with a Column id.
const CARD = "card:";

// Spinner frames of the dashboard's StatusGlyph (web/src/components/StatusGlyph.tsx).
const RATTLES = {
  dots: { frames: [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"], interval: 220 },
  orbit: { frames: [..."⠃⠉⠘⠰⢠⣀⡄⠆"], interval: 400 },
  breathe: { frames: [..."⠀⠂⠌⡑⢕⢝⣫⣟⣿⣟⣫⢝⢕⡑⠌⠂⠀"], interval: 180 },
};
const STATUS_RATTLE: Record<string, keyof typeof RATTLES> = {
  Running: "dots",
  Waiting: "orbit",
  Starting: "breathe",
  Creating: "orbit",
};
const STATIC_GLYPH: Record<string, string> = { Idle: "⠒", Stopped: "⠒", Error: "✕", Deleting: "✕" };
// The dashboard colours these titles by status; the rest stay secondary.
const ACTIVE = ["Running", "Waiting", "Starting"];

// ponytail: frames follow the wall clock, not the Session's created_at, which
// the bridge does not send; Cards of one status spin in step.
function StatusGlyph({ status }: { status: string }) {
  const rattle = RATTLES[STATUS_RATTLE[status]];
  const frameNow = () => (rattle ? Math.floor(Date.now() / rattle.interval) % rattle.frames.length : 0);
  const [frame, setFrame] = useState(frameNow);
  useEffect(() => {
    if (!rattle) return;
    const id = setInterval(() => setFrame(frameNow()), rattle.interval);
    return () => clearInterval(id);
  }, [rattle]);
  return <>{rattle ? rattle.frames[frame] : (STATIC_GLYPH[status] ?? "⠤")}</>;
}

// Plugins name lucide icons in kebab case, as the dashboard renders them; an
// unknown name renders nothing.
function PluginIcon({ name }: { name: string }) {
  const Icon = icons[name.replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase()) as keyof typeof icons];
  return Icon ? <Icon size={12} aria-hidden /> : null;
}

function CardBody({ card }: { card: Card }) {
  const { session, badges, columns } = card;
  const status = session.status.toLowerCase();
  return (
    <>
      <span className="card-title">
        <span className={`glyph status-${status}`} title={session.status} aria-label={session.status}>
          <StatusGlyph status={session.status} />
        </span>
        {session.unread && <span className="unread-dot" title="Unread" aria-label="Unread" />}
        <span className={`truncate${ACTIVE.includes(session.status) ? ` status-${status}` : ""}`}>{session.title}</span>
      </span>
      <span className="card-meta truncate">
        {card.repo}
        {card.branch && <span className="branch"> · {card.branch}</span>}
      </span>
      {(badges.length > 0 || columns.length > 0) && (
        <span className="plugin-line">
          <span className="chips">
            {badges.map((b, i) => (
              <span key={i} className={`chip tone-${b.tone}`} title={b.tooltip} aria-label={b.text ? undefined : b.tooltip}>
                {b.icon && <PluginIcon name={b.icon} />}
                {b.text && <span className="truncate">{b.text}</span>}
              </span>
            ))}
          </span>
          {columns.map((c, i) => (
            <span key={i} className={`row-column truncate tone-${c.tone}`} title={c.tooltip ?? c.text}>
              {c.text}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function CardView({
  card,
  selected,
  draggable,
  onOpen,
  onMenu,
  send,
}: {
  card: Card;
  selected: boolean;
  draggable: boolean;
  onOpen: (id: string) => void;
  onMenu?: OnMenu;
  send?: { label: string; onClick: () => void };
}) {
  const { id } = card.session;
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: CARD + id,
    data: card,
    disabled: !draggable,
  });
  // Keyboard drag is for Columns: Enter on a Card opens it, Move to moves it.
  const pointer = Object.fromEntries(Object.entries(listeners ?? {}).filter(([name]) => name !== "onKeyDown"));
  return (
    <div
      ref={setNodeRef}
      className={`card${isDragging ? " dragging" : ""}${selected ? " selected" : ""}`}
      data-testid={`card-${id}`}
      aria-current={selected || undefined}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          // Android fires this on a long press, which starts a drag instead.
          if ("pointerType" in e.nativeEvent && e.nativeEvent.pointerType === "touch") return;
          onMenu(card, e.clientX, e.clientY);
        })
      }
    >
      <button type="button" className="card-open" {...attributes} {...pointer} onClick={() => onOpen(id)}>
        <CardBody card={card} />
      </button>
      {send && (
        <button type="button" className="card-send" onClick={send.onClick}>
          {send.label}
        </button>
      )}
      {onMenu && (
        <button
          type="button"
          className="card-menu"
          aria-label="Session actions"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(card, r.left, r.bottom);
          }}
        >
          ⋯
        </button>
      )}
    </div>
  );
}

function ColumnView({
  column,
  cards,
  total,
  searching,
  selected,
  onOpen,
  onMenu,
  editor,
}: FilteredColumn & {
  searching: boolean;
  selected: string | null;
  onOpen: (id: string) => void;
  onMenu?: OnMenu;
  editor?: Editor;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver, active } =
    useSortable({ id: column.id, disabled: !editor });
  // The header is the drag handle; spreading nothing keeps it inert when read-only.
  const handle = editor ? { ...attributes, ...listeners, "aria-roledescription": "draggable column" } : {};
  const cardOver = isOver && String(active?.id).startsWith(CARD);
  const { send } = column;
  const ids = cards.map((c) => c.session.id);
  const idsKey = ids.join();
  // Sends to many Sessions at once, so the first click asks and the second sends.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [idsKey]);
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`column${isDragging ? " dragging" : ""}${cardOver ? " over" : ""}`}
      aria-label={column.title}
      data-testid={`column-${column.id}`}
    >
      <header className="column-header">
        <h2 ref={setActivatorNodeRef} {...handle}>
          <span className="truncate">{column.title}</span> <span className="count">{searching ? `${cards.length}/${total}` : total}</span>
        </h2>
        {editor && send && cards.length > 0 && (
          <button
            type="button"
            className="column-send"
            onClick={() => {
              if (!confirming && cards.length > 1) return setConfirming(true);
              setConfirming(false);
              editor.onSend(column, ids);
            }}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? `Send to ${cards.length}?` : cards.length > 1 ? `${send.label} (all)` : send.label}
          </button>
        )}
        {editor && (
          <button
            type="button"
            className="icon"
            aria-label={`Edit column ${column.title}`}
            onClick={() => editor.onEdit(column)}
          >
            ⋯
          </button>
        )}
      </header>
      <ul>
        {cards.map((card) => (
          <li key={card.session.id}>
            <CardView
              card={card}
              selected={card.session.id === selected}
              draggable={!!editor}
              onOpen={onOpen}
              onMenu={onMenu}
              send={editor && send && { label: send.label, onClick: () => editor.onSend(column, [card.session.id]) }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// position: fixed escapes the Columns' scroll clipping, so no portal.
// ponytail: Tab moves between items, no arrow keys or focus return; add them
// if the menu grows past a short list of Stages.
function MoveMenu({
  menu,
  stages,
  onStage,
  onClose,
}: {
  menu: Menu;
  stages: Column[];
  onStage: Editor["onStage"];
  onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);

  // Keeps the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, innerWidth - width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, innerHeight - height - 4))}px`;
  }, [menu]);

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const outside = (e: Event) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    // Capture, since a Column's scroll does not bubble.
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [menu, onClose]);

  return (
    <ul ref={ref} className="menu" role="menu" aria-label="Move to" data-testid="move-menu">
      <li role="presentation" className="menu-title">
        Move to
      </li>
      {stages.map((s) => (
        <li key={s.id} role="none">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={s.id === menu.card.stageId}
            onClick={() => {
              onStage(menu.card.session.id, s.id);
              onClose();
            }}
          >
            {s.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Board({
  columns,
  selected,
  onOpen,
  onExport,
  editor,
  hostMenu,
}: {
  columns: BoardColumn[];
  selected: string | null;
  onOpen: (id: string) => void;
  onExport: () => void;
  editor?: Editor;
  // Absent on a dashboard without session.contextMenu, where the Board falls back to its own Move to menu.
  hostMenu?: HostMenu;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterBoard(columns, query), [columns, query]);
  const searching = query.trim() !== "";
  const stages = useMemo(() => columns.filter((b) => b.column.kind === "stage").map((b) => b.column), [columns]);
  // A short move before a mouse drag, so a click on a header or Card passes,
  // and a long press before a touch drag, so swipes scroll.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // A Card lands on the Stage column under the pointer, or nowhere; a Column
  // swaps with the nearest one.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) =>
      String(args.active.id).startsWith(CARD)
        ? pointerWithin({
            ...args,
            droppableContainers: args.droppableContainers.filter((c) => stages.some((s) => s.id === c.id)),
          })
        : closestCenter(args),
    [stages],
  );
  const [dragged, setDragged] = useState<Card | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMoveMenu = useCallback<OnMenu>((card, x, y) => setMenu({ card, x, y }), []);
  const openMenu = hostMenu ?? (editor && openMoveMenu);
  // On a phone one Column fills the Board; the indicator tracks which.
  const boardRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(0);
  const columnEls = () => [...boardRef.current!.querySelectorAll<HTMLElement>(".column")];
  const onScroll = () => {
    const el = boardRef.current!;
    const mid = el.scrollLeft + el.clientWidth / 2;
    const els = columnEls();
    const i = els.findIndex((c) => c.offsetLeft + c.offsetWidth >= mid);
    setVisible(i === -1 ? els.length - 1 : i);
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    if (String(active.id).startsWith(CARD)) setDragged(active.data.current as Card);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragged(null);
    if (!editor || !over) return;
    const id = String(active.id);
    if (id.startsWith(CARD)) editor.onStage(id.slice(CARD.length), String(over.id));
    else if (id !== over.id) editor.onMove(id, columns.findIndex((b) => b.column.id === over.id));
  };
  return (
    <>
      <header className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="spacer" />
        <button type="button" onClick={onExport}>
          Export
        </button>
        {editor && (
          <button type="button" onClick={editor.onImport}>
            Import
          </button>
        )}
      </header>
      <nav className="indicator" aria-label="Columns">
        {shown.map((b, i) => (
          <button
            key={b.column.id}
            type="button"
            aria-label={b.column.title}
            aria-current={i === Math.min(visible, shown.length - 1) || undefined}
            onClick={() => columnEls()[i].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" })}
          />
        ))}
      </nav>
      <main className="board" ref={boardRef} onScroll={onScroll}>
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragged(null)}
        >
          <SortableContext items={columns.map((b) => b.column.id)} strategy={horizontalListSortingStrategy}>
            {shown.map((b) => (
              <ColumnView
                key={b.column.id}
                {...b}
                searching={searching}
                selected={selected}
                onOpen={onOpen}
                onMenu={openMenu || undefined}
                editor={editor}
              />
            ))}
          </SortableContext>
          {/* Rendered outside the Columns, so their scrolling does not clip it. */}
          <DragOverlay dropAnimation={null}>
            {dragged && (
              <div className="card overlay">
                <span className="card-open">
                  <CardBody card={dragged} />
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {editor && (
          <button type="button" className="add-column" onClick={editor.onAdd}>
            + Add column
          </button>
        )}
      </main>
      {editor && menu && <MoveMenu menu={menu} stages={stages} onStage={editor.onStage} onClose={closeMenu} />}
    </>
  );
}
