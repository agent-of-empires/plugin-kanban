import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { useMemo, useState } from "react";
import type { Column } from "../shared/board-config";
import { type BoardColumn, type Card, type FilteredColumn, filterBoard } from "../shared/board-model";

// Absent in read-only and CityHall context, where the Board cannot change.
export interface Editor {
  onAdd: () => void;
  onEdit: (column: Column) => void;
  onMove: (id: string, to: number) => void;
}

function CardView({ card, onOpen }: { card: Card; onOpen: (id: string) => void }) {
  const { session, stageChip, badges } = card;
  return (
    <button type="button" className="card" data-testid={`card-${session.id}`} onClick={() => onOpen(session.id)}>
      <span className="card-title">
        <span className={`dot status-${session.status.toLowerCase()}`} title={session.status} aria-label={session.status} />
        <span className="truncate">{session.title}</span>
      </span>
      <span className="card-meta truncate">
        {card.repo}
        {card.branch && <span className="branch"> · {card.branch}</span>}
      </span>
      <span className="card-meta">
        {session.tool}
        {session.last_activity && <> · {new Date(session.last_activity).toLocaleString()}</>}
      </span>
      {(stageChip || badges.length > 0) && (
        <span className="chips">
          {stageChip && (
            <span className="chip stage" data-testid="stage-chip">
              {stageChip}
            </span>
          )}
          {badges.map((b, i) => (
            <span key={i} className={`chip tone-${b.tone}`} title={b.tooltip}>
              {[b.icon, b.text].filter(Boolean).join(" ")}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function ColumnView({
  column,
  cards,
  total,
  searching,
  onOpen,
  editor,
}: FilteredColumn & { searching: boolean; onOpen: (id: string) => void; editor?: Editor }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !editor,
  });
  // The header is the drag handle; spreading nothing keeps it inert when read-only.
  const handle = editor ? { ...attributes, ...listeners, "aria-roledescription": "draggable column" } : {};
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "column dragging" : "column"}
      aria-label={column.title}
      data-testid={`column-${column.id}`}
    >
      <header className="column-header">
        <h2 ref={setActivatorNodeRef} {...handle}>
          <span className="truncate">{column.title}</span> <span className="count">{searching ? `${cards.length}/${total}` : total}</span>
        </h2>
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
            <CardView card={card} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Board({ columns, onOpen, editor }: { columns: BoardColumn[]; onOpen: (id: string) => void; editor?: Editor }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterBoard(columns, query), [columns, query]);
  const searching = query.trim() !== "";
  // The distance lets a click on the header pass without starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!editor || !over || active.id === over.id) return;
    editor.onMove(String(active.id), columns.findIndex((b) => b.column.id === over.id));
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
      </header>
      <main className="board">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={columns.map((b) => b.column.id)} strategy={horizontalListSortingStrategy}>
            {shown.map((b) => (
              <ColumnView key={b.column.id} {...b} searching={searching} onOpen={onOpen} editor={editor} />
            ))}
          </SortableContext>
        </DndContext>
        {editor && (
          <button type="button" className="add-column" onClick={editor.onAdd}>
            + Add column
          </button>
        )}
      </main>
    </>
  );
}
