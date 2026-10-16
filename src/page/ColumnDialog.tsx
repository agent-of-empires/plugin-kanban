import { useEffect, useRef, useState } from "react";
import { type Column, type Condition, SEND_MESSAGE_MAX, type Send } from "../shared/board-config";
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
  // Stage columns, offered as the move after a message.
  stages: Column[];
  onSave: (title: string, kind: Column["kind"], onEnter: Column["on_enter"], rules: Condition[][], send?: Send) => void;
  onDelete: () => void;
  onClose: () => void;
}

// No <form>: the page's sandbox has no allow-forms, so a form never submits.
export function ColumnDialog({ column, canDelete, slots, facets, stages, onSave, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(column?.title ?? "");
  const [kind, setKind] = useState<Column["kind"]>(column?.kind ?? "stage");
  // Hidden on Signal columns, which take no drops; a stored value is kept.
  const [onEnter, setOnEnter] = useState<Column["on_enter"]>(column?.on_enter ?? "none");
  const [rules, setRules] = useState(column?.rules ?? []);
  const [sendLabel, setSendLabel] = useState(column?.send?.label ?? "");
  const [sendMessage, setSendMessage] = useState(column?.send?.message ?? "");
  const [sendStage, setSendStage] = useState(column?.send?.stage ?? "");
  // Guarded because StrictMode runs effects twice.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const name = title.trim();
  const signal = kind === "signal";
  const label = sendLabel.trim();
  const message = sendMessage.trim();
  // Both or neither: a label without a message has nothing to send.
  const sendValid = !label === !message && message.length <= SEND_MESSAGE_MAX;
  const valid = name && sendValid && (!signal || rulesValid(rules));
  const send = label ? { label, message, ...(sendStage && { stage: sendStage }) } : undefined;
  // A new Column switched to Signal drops any pick made while it was a Stage.
  const save = () => valid && onSave(name, kind, column || !signal ? onEnter : "none", signal ? rules : [], send);
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
      <fieldset>
        <legend>One-click message</legend>
        <p className="hint">Adds a button to each Card and to the Column that sends this message to the Session. Leave empty for none.</p>
        <label>
          Button label
          <input value={sendLabel} onChange={(e) => setSendLabel(e.target.value)} />
        </label>
        <label>
          Message
          <textarea rows={3} maxLength={SEND_MESSAGE_MAX} value={sendMessage} onChange={(e) => setSendMessage(e.target.value)} />
        </label>
        <label>
          Then move the Card to
          <select value={sendStage} onChange={(e) => setSendStage(e.target.value)}>
            <option value="">Stay put</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
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
        <button type="button" className="primary" disabled={!valid} onClick={save}>
          Save
        </button>
      </div>
    </dialog>
  );
}
