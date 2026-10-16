import { type Condition, OPS, type Op } from "../shared/board-config";
import { STATUS_RANK, TONES } from "../shared/board-model";

// A Condition's field as one select value; tone and text are plugin fields.
type FieldKey = "status" | "urgent" | "unread" | "pending_approvals" | "last_error" | "tone" | "text";

const FIELDS: [FieldKey, string][] = [
  ["status", "Status"],
  ["urgent", "Urgent"],
  ["unread", "Unread"],
  ["pending_approvals", "Pending approvals"],
  ["last_error", "Last error"],
  ["tone", "Plugin tone"],
  ["text", "Plugin text"],
];

const keyOf = (c: Condition): FieldKey => (typeof c.field === "string" ? c.field : c.field.attr);

const DEFAULT_VALUE: Record<FieldKey, string | number | boolean> = {
  status: "Waiting",
  urgent: true,
  unread: true,
  pending_approvals: 1,
  last_error: "",
  tone: "danger",
  text: "",
};

const hasValue = (op: Op) => op === "is" || op === "is not";

// A field change starts the condition over, keeping the plugin and slot.
function withField(c: Condition, key: FieldKey): Condition {
  const plugin = typeof c.field === "string" ? { plugin_id: "*", slot_id: "*" } : c.field;
  const field = key === "tone" || key === "text" ? { plugin_id: plugin.plugin_id, slot_id: plugin.slot_id, attr: key } : key;
  return { field, op: "is", value: DEFAULT_VALUE[key] };
}

function withOp(c: Condition, op: Op): Condition {
  if (!hasValue(op)) return { field: c.field, op };
  return { ...c, op, value: c.value ?? DEFAULT_VALUE[keyOf(c)] };
}

const NEW_CONDITION = withField({ field: "status", op: "is" }, "status");

// Blank text, a non-number count and a blank plugin or slot can't be saved.
export const rulesValid = (rules: Condition[][]) =>
  rules.every((rule) =>
    rule.every(
      (c) =>
        (typeof c.field === "string" || (c.field.plugin_id.trim() && c.field.slot_id.trim())) &&
        (typeof c.value === "string" ? c.value.trim() : typeof c.value !== "number" || Number.isFinite(c.value)),
    ),
  );

interface Props {
  rules: Condition[][];
  // Row-column slot ids by plugin id, suggested for plugin conditions.
  slots: Record<string, string[]>;
  onChange: (rules: Condition[][]) => void;
}

export function RuleBuilder({ rules, slots, onChange }: Props) {
  const setCondition = (r: number, i: number, c: Condition) =>
    onChange(rules.map((rule, ri) => (ri === r ? rule.map((x, ci) => (ci === i ? c : x)) : rule)));
  // A Rule can't be empty, so removing its last condition removes the Rule.
  const removeCondition = (r: number, i: number) =>
    onChange(rules.map((rule, ri) => (ri === r ? rule.filter((_, ci) => ci !== i) : rule)).filter((rule) => rule.length));
  const addCondition = (r: number) => onChange(rules.map((rule, ri) => (ri === r ? [...rule, NEW_CONDITION] : rule)));

  return (
    <div className="rules">
      <datalist id="rule-statuses">
        {Object.keys(STATUS_RANK).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id="rule-plugins">
        <option value="*">any plugin</option>
        {Object.keys(slots).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {rules.length === 0 && <p className="hint">No Rules: this Column holds no Cards.</p>}
      {rules.map((rule, r) => (
        <div key={r} className="rule" role="group" aria-label={`Rule ${r + 1}`}>
          {r > 0 && <span className="joiner">or</span>}
          {rule.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              first={i === 0}
              slots={slots}
              listId={`rule-slots-${r}-${i}`}
              onChange={(next) => setCondition(r, i, next)}
              onRemove={() => removeCondition(r, i)}
            />
          ))}
          <button type="button" className="icon" onClick={() => addCondition(r)}>
            + and
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rules, [NEW_CONDITION]])}>
        + Rule
      </button>
    </div>
  );
}

interface RowProps {
  condition: Condition;
  first: boolean;
  slots: Record<string, string[]>;
  listId: string;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}

function ConditionRow({ condition: c, first, slots, listId, onChange, onRemove }: RowProps) {
  const key = keyOf(c);
  const plugin = typeof c.field === "string" ? null : c.field;
  const slotIds = plugin && (plugin.plugin_id === "*" ? [...new Set(Object.values(slots).flat())] : slots[plugin.plugin_id]);
  const setValue = (value: string | number | boolean) => onChange({ ...c, value });

  let value = null;
  if (hasValue(c.op)) {
    const text = (list?: string) => (
      <input aria-label="Value" list={list} value={String(c.value ?? "")} onChange={(e) => setValue(e.target.value)} />
    );
    if (key === "urgent" || key === "unread") {
      value = (
        <select aria-label="Value" value={String(c.value)} onChange={(e) => setValue(e.target.value === "true")}>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      );
    } else if (key === "pending_approvals") {
      value = (
        <input
          aria-label="Value"
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(c.value) ? String(c.value) : ""}
          onChange={(e) => setValue(e.target.valueAsNumber)}
        />
      );
    } else if (key === "tone") {
      value = (
        <select aria-label="Value" value={String(c.value)} onChange={(e) => setValue(e.target.value)}>
          {TONES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      );
    } else value = text(key === "status" ? "rule-statuses" : undefined);
  }

  return (
    <div className="condition">
      <span className="joiner">{first ? "when" : "and"}</span>
      <select aria-label="Field" value={key} onChange={(e) => onChange(withField(c, e.target.value as FieldKey))}>
        {FIELDS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      {plugin && (
        <>
          <input
            aria-label="Plugin"
            placeholder="plugin"
            list="rule-plugins"
            value={plugin.plugin_id}
            onChange={(e) => onChange({ ...c, field: { ...plugin, plugin_id: e.target.value } })}
          />
          <input
            aria-label="Slot"
            placeholder="slot"
            list={listId}
            value={plugin.slot_id}
            onChange={(e) => onChange({ ...c, field: { ...plugin, slot_id: e.target.value } })}
          />
          <datalist id={listId}>
            <option value="*">any slot</option>
            {slotIds?.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
      <select aria-label="Operator" value={c.op} onChange={(e) => onChange(withOp(c, e.target.value as Op))}>
        {OPS.map((op) => (
          <option key={op}>{op}</option>
        ))}
      </select>
      {value}
      <button type="button" className="icon" aria-label="Remove condition" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}
