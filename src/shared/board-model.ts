// Board model: places Sessions on the Board. Pure, so the page renders it and
// Vitest covers it; no Node or DOM imports.
import { type Column, type Condition, type Config, DEFAULT_CONFIG, type PluginField, parseConfig } from "./board-config";

// A row of the bridge's sessions.list. The optional fields are not sent by
// bridge v1 yet; absent means unset, so Rules on them do not match.
export interface BridgeSession {
  id: string;
  title: string;
  project_path: string;
  tool: string;
  status: string;
  archived: boolean;
  snoozed: boolean;
  trashed: boolean;
  workspace_repos?: { source_path: string; branch?: string | null }[];
  worktree?: { branch?: string | null; main_repo_path: string } | null;
  urgent?: boolean;
  unread?: boolean;
  last_error?: string | null;
  pending_approvals?: number;
  // ISO 8601.
  last_activity?: string;
  // Slash-separated sidebar Group path.
  group_path?: string;
}

// One entry of the bridge's plugins.uiState.
export interface UiEntry {
  plugin_id: string;
  slot: string;
  id: string;
  session_id?: string;
  payload: Record<string, unknown>;
}

export type Tone = "neutral" | "info" | "success" | "warn" | "danger";

export interface Badge {
  text?: string;
  icon?: string;
  tone: Tone;
  tooltip?: string;
}

export interface Card {
  session: BridgeSession;
  repo: string;
  branch?: string;
  badges: Badge[];
  // Id of the Session's resolved Stage column, wherever the Card sits.
  stageId: string;
  // Title of the Session's Stage, set when the Card sits in a Signal column.
  stageChip?: string;
}

export interface BoardColumn {
  column: Column;
  cards: Card[];
}

export interface FilteredColumn extends BoardColumn {
  // Card count before filtering.
  total: number;
}

export interface Snapshot {
  stages: Record<string, string>;
  config: Config;
}

export const TONES: readonly Tone[] = ["neutral", "info", "success", "warn", "danger"];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The worker's snapshot is the page slot's own global ui-state entry.
export function findSnapshot(entries: UiEntry[], pluginId: string, pageId: string): Snapshot {
  const payload = entries.find(
    (e) => e.plugin_id === pluginId && e.slot === "page" && e.id === pageId && !e.session_id,
  )?.payload;
  const parsed = parseConfig(payload?.config);
  const stages = isRecord(payload?.stages) ? payload.stages : {};
  return {
    config: parsed.ok ? parsed.config : DEFAULT_CONFIG,
    stages: Object.fromEntries(Object.entries(stages).filter(([, v]) => typeof v === "string" && v)) as Record<
      string,
      string
    >,
  };
}

// Dismissed matches core's Instance::is_dismissed.
const isDismissed = (s: BridgeSession) => s.archived || s.snoozed || s.trashed;

// 0 and false count as empty for "is set" and "is empty", so `pending_approvals
// is set` skips a zero count and `urgent is set` a false flag.
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === 0 || v === false;

const matches = (want: string, got: string) => want === "*" || want === got;

const rowColumns = (entries: UiEntry[], session: BridgeSession) =>
  entries.filter((e) => e.session_id === session.id && e.slot === "row-column");

// Slot ids of the row columns on screen, by plugin id: what a plugin
// condition can pick from.
export function rowColumnSlots(entries: UiEntry[]): Record<string, string[]> {
  const slots: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.slot !== "row-column") continue;
    const ids = (slots[e.plugin_id] ??= []);
    if (!ids.includes(e.id)) ids.push(e.id);
  }
  return slots;
}

function candidates(field: Condition["field"], session: BridgeSession, entries: UiEntry[]): unknown[] {
  if (typeof field === "string") return [session[field]];
  const f: PluginField = field;
  return rowColumns(entries, session)
    .filter((e) => matches(f.plugin_id, e.plugin_id) && matches(f.slot_id, e.id))
    .map((e) => e.payload[f.attr]);
}

// Several plugin entries can match one condition: "is" needs any of them to
// equal the value, "is not" needs a value and none equal to it. "is" and "is
// not" compare the real value, so `urgent is false` matches a false flag that
// "is empty" also matches.
function holds(c: Condition, session: BridgeSession, entries: UiEntry[]): boolean {
  const values = candidates(c.field, session, entries).filter((v) => v !== undefined && v !== null);
  const set = values.filter((v) => !isEmpty(v));
  switch (c.op) {
    case "is":
      return values.some((v) => v === c.value);
    case "is not":
      return values.length > 0 && values.every((v) => v !== c.value);
    case "is set":
      return set.length > 0;
    case "is empty":
      return set.length === 0;
  }
}

const columnMatches = (col: Column, session: BridgeSession, entries: UiEntry[]) =>
  col.rules.some((rule) => rule.every((c) => holds(c, session, entries)));

// Mirrors the dashboard sidebar's attention order (web/src/lib/sidebarSort.ts).
export const STATUS_RANK: Record<string, number> = {
  Waiting: 0,
  Error: 1,
  Idle: 2,
  Unknown: 3,
  Running: 4,
  Stopped: 5,
  Starting: 6,
  Creating: 6,
  Deleting: 6,
};

function attentionRank(session: BridgeSession, entries: UiEntry[]): number {
  const rank = STATUS_RANK[session.status] ?? 3;
  const flagged = rowColumns(entries, session).some((e) => e.payload.tone === "danger" || e.payload.tone === "warn");
  return flagged ? Math.min(rank, 1) : rank;
}

const activityMs = (s: BridgeSession) => {
  const ms = s.last_activity ? Date.parse(s.last_activity) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
};

function compareCards(a: Card, b: Card, entries: UiEntry[]): number {
  const [sa, sb] = [a.session, b.session];
  if (!!sa.urgent !== !!sb.urgent) return sa.urgent ? -1 : 1;
  const rank = attentionRank(sa, entries) - attentionRank(sb, entries);
  if (rank !== 0) return rank;
  const activity = activityMs(sb) - activityMs(sa);
  if (activity !== 0 && !Number.isNaN(activity)) return activity;
  return sa.id.localeCompare(sb.id);
}

function badges(session: BridgeSession, entries: UiEntry[]): Badge[] {
  return entries
    .filter((e) => e.session_id === session.id && e.slot === "row-badge")
    .flatMap((e) => (Array.isArray(e.payload.items) ? e.payload.items : [e.payload]))
    .filter(isRecord)
    .map((b) => ({
      text: typeof b.text === "string" ? b.text : undefined,
      icon: typeof b.icon === "string" ? b.icon : undefined,
      tooltip: typeof b.tooltip === "string" ? b.tooltip : undefined,
      tone: ((TONES as readonly unknown[]).includes(b.tone) ? b.tone : "neutral") as Tone,
    }))
    .filter((b) => b.text || b.icon);
}

const basename = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function buildBoard(sessions: BridgeSession[], entries: UiEntry[], snapshot: Snapshot): BoardColumn[] {
  const { columns } = snapshot.config;
  const board = columns.map((column) => ({ column, cards: [] as Card[] }));
  const stageCols = columns.filter((c) => c.kind === "stage");
  const signalCols = columns.filter((c) => c.kind === "signal");

  for (const session of sessions) {
    if (isDismissed(session)) continue;
    // An unknown or missing Stage resolves to the leftmost Stage column.
    const stage = stageCols.find((c) => c.id === snapshot.stages[session.id]) ?? stageCols[0];
    // Signal columns left to right, first match wins.
    const signal = signalCols.find((c) => columnMatches(c, session, entries));
    const home = signal ?? stage;
    const repo = session.worktree?.main_repo_path ?? session.workspace_repos?.[0]?.source_path ?? session.project_path;
    board
      .find((b) => b.column === home)!
      .cards.push({
        session,
        repo: basename(repo),
        branch: session.worktree?.branch ?? session.workspace_repos?.[0]?.branch ?? undefined,
        badges: badges(session, entries),
        stageId: stage.id,
        stageChip: signal ? stage.title : undefined,
      });
  }
  for (const b of board) b.cards.sort((x, y) => compareCards(x, y, entries));
  return board;
}

// Mirrors the dashboard sidebar matcher (web/src/components/sidebar/filterGroups.ts):
// a case-insensitive substring of any listed field.
function cardMatches({ session, repo, branch }: Card, q: string): boolean {
  return [session.title, session.project_path, repo, branch, session.tool, session.group_path].some((f) =>
    typeof f === "string" && f.toLowerCase().includes(q),
  );
}

// Columns stay when no Card matches, so their `total` still shows.
export function filterBoard(board: BoardColumn[], query: string): FilteredColumn[] {
  const q = query.trim().toLowerCase();
  return board.map(({ column, cards }) => ({
    column,
    cards: q ? cards.filter((c) => cardMatches(c, q)) : cards,
    total: cards.length,
  }));
}
