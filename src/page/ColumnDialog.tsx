import { useEffect, useRef, useState } from "react";
import type { Column } from "../shared/board-config";

interface Props {
  // null adds a new Column.
  column: Column | null;
  // False on the last Stage column.
  canDelete: boolean;
  onSave: (title: string, kind: Column["kind"]) => void;
  onDelete: () => void;
  onClose: () => void;
}

// No <form>: the page's sandbox has no allow-forms, so a form never submits.
export function ColumnDialog({ column, canDelete, onSave, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(column?.title ?? "");
  const [kind, setKind] = useState<Column["kind"]>(column?.kind ?? "stage");
  // Guarded because StrictMode runs effects twice.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const name = title.trim();
  const save = () => name && onSave(name, kind);
  return (
    <dialog ref={ref} className="column-dialog" aria-label={column ? "Edit column" : "Add column"} onClose={onClose}>
      <h3>{column ? "Edit column" : "Add column"}</h3>
      <label>
        Name
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </label>
      <fieldset disabled={!!column}>
        <legend>Kind{column && ", fixed once created"}</legend>
        <label>
          <input type="radio" name="kind" checked={kind === "stage"} onChange={() => setKind("stage")} />
          Stage: holds Cards you move into it
        </label>
        <label>
          <input type="radio" name="kind" checked={kind === "signal"} onChange={() => setKind("signal")} />
          Signal: pulls Cards in while its Rules match
        </label>
      </fieldset>
      <p className="hint">
        Signal columns are checked left to right and the leftmost match holds the Card; drag Columns to change that
        order.
      </p>
      <div className="actions">
        {column && (
          <button type="button" className="danger" disabled={!canDelete} onClick={onDelete}>
            Delete
          </button>
        )}
        {column && !canDelete && <span className="hint">The Board needs at least one Stage column.</span>}
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!name} onClick={save}>
          Save
        </button>
      </div>
    </dialog>
  );
}
