import { useEffect, useRef, useState } from "react";
import type { Column, Condition } from "../shared/board-config";
import type { Facet } from "../shared/board-model";
import { RuleBuilder, rulesValid } from "./RuleBuilder";

interface Props {
  // null adds a new Column.
  column: Column | null;
  // False on the last Stage column.
  canDelete: boolean;
  // Row-column slot ids by plugin id, for the Rule builder.
  slots: Record<string, string[]>;
  // Plugin filter facets, offered as Rule fields.
  facets: Facet[];
  onSave: (title: string, kind: Column["kind"], onEnter: Column["on_enter"], rules: Condition[][]) => void;
  onDelete: () => void;
  onClose: () => void;
}

// No <form>: the page's sandbox has no allow-forms, so a form never submits.
export function ColumnDialog({ column, canDelete, slots, facets, onSave, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(column?.title ?? "");
  const [kind, setKind] = useState<Column["kind"]>(column?.kind ?? "stage");
  // Hidden on Signal columns, which take no drops; a stored value is kept.
  const [onEnter, setOnEnter] = useState<Column["on_enter"]>(column?.on_enter ?? "none");
  const [rules, setRules] = useState(column?.rules ?? []);
  // Guarded because StrictMode runs effects twice.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const name = title.trim();
  const signal = kind === "signal";
  const valid = name && (!signal || rulesValid(rules));
  // A new Column switched to Signal drops any pick made while it was a Stage.
  const save = () => valid && onSave(name, kind, column || !signal ? onEnter : "none", signal ? rules : []);
  return (
    <dialog ref={ref} className={`column-dialog${signal ? " wide" : ""}`} aria-label={column ? "Edit column" : "Add column"} onClose={onClose}>
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
      {kind === "stage" && (
        <label>
          When a Card is dropped here
          <select value={onEnter} onChange={(e) => setOnEnter(e.target.value as Column["on_enter"])}>
            <option value="none">Nothing</option>
            <option value="archive">Archive the Session</option>
            <option value="trash">Move the Session to the trash</option>
          </select>
        </label>
      )}
      {signal && (
        <fieldset>
          <legend>Rules</legend>
          <p className="hint">A Rule matches when all its conditions hold; the Column holds a Card while any Rule matches.</p>
          <RuleBuilder rules={rules} slots={slots} facets={facets} onChange={setRules} />
        </fieldset>
      )}
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
        <button type="button" className="primary" disabled={!valid} onClick={save}>
          Save
        </button>
      </div>
    </dialog>
  );
}
