import { type Condition, type FacetField, OPS, type Op } from "../shared/board-config";
import { type Facet, STATUS_RANK, TONES } from "../shared/board-model";

// A Condition's field as one select value; tone and text are plugin fields.
type BaseKey = "status" | "urgent" | "unread" | "pending_approvals" | "last_error" | "tone" | "text";
// A facet's key, "facet:" then its plugin and facet ids as JSON.
type FieldKey = BaseKey | `facet:${string}`;

const FIELDS: [BaseKey, string][] = [
  ["status", "Status"],
  ["urgent", "Urgent"],
  ["unread", "Unread"],
  ["pending_approvals", "Pending approvals"],
  ["last_error", "Last error"],
  ["tone", "Plugin tone"],
  ["text", "Plugin text"],
];

const facetKey = (f: FacetField): FieldKey => `facet:${JSON.stringify([f.plugin_id, f.facet_id])}`;
const keyOf = (c: Condition): FieldKey =>
  typeof c.field === "string" ? c.field : "facet_id" in c.field ? facetKey(c.field) : c.field.attr;
const findFacet = (facets: Facet[], f: FacetField) => facets.find((x) => x.plugin_id === f.plugin_id && x.id === f.facet_id);

const DEFAULT_VALUE: Record<BaseKey, string | number | boolean> = {
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
function withField(c: Condition, key: FieldKey, facets: Facet[]): Condition {
  if (key.startsWith("facet:")) {
    const [plugin_id, facet_id] = JSON.parse(key.slice("facet:".length)) as [string, string];
    const field = { plugin_id, facet_id };
    return { field, op: "is", value: findFacet(facets, field)?.options[0]?.value ?? "" };
  }
  const base = key as BaseKey;
  const plugin = typeof c.field !== "string" && "slot_id" in c.field ? c.field : { plugin_id: "*", slot_id: "*" };
  const field = base === "tone" || base === "text" ? { plugin_id: plugin.plugin_id, slot_id: plugin.slot_id, attr: base } : base;
  return { field, op: "is", value: DEFAULT_VALUE[base] };
}

function withOp(c: Condition, op: Op, facets: Facet[]): Condition {
  if (!hasValue(op)) return { field: c.field, op };
  return { ...c, op, value: c.value ?? withField(c, keyOf(c), facets).value };
}

const NEW_CONDITION = withField({ field: "status", op: "is" }, "status", []);

// Blank text, a non-number count and a blank plugin or slot can't be saved.
export const rulesValid = (rules: Condition[][]) =>
  rules.every((rule) =>
    rule.every(
      (c) =>
        (typeof c.field === "string" || "facet_id" in c.field || (c.field.plugin_id.trim() && c.field.slot_id.trim())) &&
        (typeof c.value === "string" ? c.value.trim() : typeof c.value !== "number" || Number.isFinite(c.value)),
    ),
  );

interface Props {
  rules: Condition[][];
  // Row-column slot ids by plugin id, suggested for plugin conditions.
  slots: Record<string, string[]>;
  facets: Facet[];
  onChange: (rules: Condition[][]) => void;
}

export function RuleBuilder({ rules, slots, facets, onChange }: Props) {
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
              facets={facets}
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
  facets: Facet[];
  listId: string;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}

function ConditionRow({ condition: c, first, slots, facets, listId, onChange, onRemove }: RowProps) {
  const key = keyOf(c);
  const plugin = typeof c.field !== "string" && "slot_id" in c.field ? c.field : null;
  const facetField = typeof c.field !== "string" && "facet_id" in c.field ? c.field : null;
  const facet = facetField && findFacet(facets, facetField);
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
    } else if (facetField) {
      // A stored value the facet no longer offers stays selectable.
      const options = facet?.options ?? [];
      const known = options.some((o) => o.value === c.value);
      value = (
        <select aria-label="Value" value={String(c.value)} onChange={(e) => setValue(e.target.value)}>
          {!known && <option value={String(c.value)}>{String(c.value)}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
      <select aria-label="Field" value={key} onChange={(e) => onChange(withField(c, e.target.value as FieldKey, facets))}>
        {FIELDS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
        {facets.map((f) => (
          <option key={facetKey({ plugin_id: f.plugin_id, facet_id: f.id })} value={facetKey({ plugin_id: f.plugin_id, facet_id: f.id })}>
            {f.label}
          </option>
        ))}
        {/* A facet whose plugin is not publishing it right now. */}
        {facetField && !facet && (
          <option value={key}>
            {facetField.plugin_id} {facetField.facet_id}
          </option>
        )}
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
      <select aria-label="Operator" value={c.op} onChange={(e) => onChange(withOp(c, e.target.value as Op, facets))}>
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
