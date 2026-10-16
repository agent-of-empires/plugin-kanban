# Board

A kanban Board of your Sessions for the Agent of Empires web dashboard.

An [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)
plugin. It adds a **Board** page (the `page` UI slot) backed by a Node worker
that speaks JSON-RPC 2.0 over newline-delimited JSON on stdio.

## Requirements

Agent of Empires 1.20.0 or newer, and Node 22 or newer on the `PATH` of the AoE
daemon. The built worker and page are committed under `dist/`, so install runs
no build step and needs no `npm`.

## Install into Agent of Empires

```bash
# from a fresh clone (no node_modules/)
aoe plugin install ./plugin-kanban

# or the latest release from GitHub
aoe plugin install gh:agent-of-empires/plugin-kanban
```

`agent-of-empires.kanban` is a reserved namespace, so a GitHub install only
succeeds for a release that AoE pins in its featured index.

Install from a checkout without `node_modules/`: the installer rejects symlinks,
and `npm ci` creates them under `node_modules/.bin`.

## The Board

Every Session that is not Dismissed (archived, snoozed or trashed) is one
**Card** in exactly one **Column**. There are two kinds of Column:

- **Stage** columns record where a Session sits in your workflow. A Session's
  Stage is sticky: it stays until you move the Card.
- **Signal** columns pull a Card in while one of their **Rules** matches, and
  release it back to its Stage when none does.

Placement: Signal columns are checked left to right and the first one whose
Rules match wins; otherwise the Card sits in its Stage column. A Session with
no Stage, or one whose Stage column no longer exists, goes to the leftmost
Stage column. A Card held by a Signal column shows its Stage as a chip.

Within a Column, Cards follow the sidebar's attention order: urgent first,
then Waiting, Error (or a plugin column toned danger or warn), Idle, Running,
Stopped, then most recent activity.

The default Board:

| Column | Kind | Holds a Session when |
|---|---|---|
| Action needed | Signal | Status is Waiting, it is urgent, it has pending Approvals, or any plugin row column is toned danger or warn |
| Error | Signal | Status is Error, or its last error is set |
| In progress | Stage | |
| Needs testing | Stage | |
| Waiting for review | Stage | |
| Done | Stage | |

### Editing Columns

"Add column" at the end of the Board and the `⋯` on a Column header open the
Column dialog. A Column's kind is fixed once created. Drag a header to reorder
Columns; for Signal columns that order is their priority. Deleting a Stage
column sends its Cards to the leftmost Stage column, and the last Stage column
cannot be deleted. A Signal column with no Rules holds nothing.
Editing is hidden in read-only and CityHall mode.

### Rules

A Signal column's Rules are edited in its Column dialog, the shipped ones
included. A Rule is a list of conditions that must all hold; a Column matches
when any of its Rules does. There is no nesting.

A condition is a field, an operator and, for `is` and `is not`, a value:

- **Fields:** Status, Urgent, Unread, Pending approvals, Last error, and a
  plugin row column's tone or text, picked by plugin id and slot id, where
  `*` means any.
- **`is` / `is not`** compare the exact value, case included. `is not` needs
  the field to have a value, so a missing field matches neither.
- **`is set` / `is empty`** treat `0`, `false` and blank text as empty. So
  `urgent is false` and `urgent is empty` both hold when the urgent flag is
  false, and `pending approvals is set` means at least one.
- When several plugin row columns match one condition, `is` needs any of them
  to equal the value and `is not` needs none to.

Urgent, unread, last error and pending Approvals are not yet exposed to plugin
pages by the dashboard, so they read as missing for now; so is last activity,
which Card order uses.

The search box matches title, path, repo, branch and agent, like the sidebar
filter. Group names are not exposed to plugin pages yet, so they do not match.

### Moving Cards

To set a Session's Stage, drag its Card onto a Stage column (on touch, long
press first), or pick one under **Move to** from the Card's `⋯` button or
right-click menu. A Card dragged out of a Signal column records the new Stage
but stays until the Signal clears, showing the Stage as its chip. Read-only
and CityHall dashboards can't move Cards.

On a phone the Board shows one Column per screen: swipe sideways, or tap a dot
above the Board, to change Column. To drag a Card to another Column, long press
it and hold it at the screen edge until that Column scrolls in. **Move to** on
the `⋯` button is the easier way; long press does not open it on touch.

A Stage column can archive or trash what enters it ("When a Card is dropped
here" in the Column dialog). Moving a Card there records the Stage, then, once
the Board shows it written, archives or trashes the Session without asking, so
the Card leaves the Board; restore it from the dashboard. Only a move triggers
it: a restored Session sits in that Column untouched until moved again.
Dropping it on the same Column retries a failed archive or trash. Archive and
trash need a core release newer than 1.20.0; on 1.20.0 the Stage is recorded and
the Board reports that the archive or trash failed.

## Where data lives

The worker owns all Board state, so every device sees the same Board.

- **Stage** of each Session: that Session's plugin metadata, key `stage`
  (a Stage column id). It follows the Session and goes away with it.
- **Board config** (Columns, Rules, enter-actions): one JSON value in the
  plugin's storage, key `config`. Until you change the Board, nothing is stored
  and the default Board applies.
- **Snapshot**: the worker republishes `{stages, config}` as the Board page's
  UI state, which the page reads. It is a copy of the two above, capped at
  64 KiB; a change that would push it over is refused and logged.

## Develop

```bash
npm ci
npm run lint
npm run typecheck
npm run build      # writes dist/worker.js and dist/index.html
npm test           # Vitest, against the built worker
npm run test:e2e   # Playwright, against the built page
```

Releases are cut by CI; see [RELEASING.md](RELEASING.md).

`dist/` is committed and must match the source: run `npm run build` and commit
the result with your change. CI fails when they drift.

The worker must never write to stdout except JSON-RPC requests to the host; log
with `console.error`, which goes to the worker log file.

## Layout

- `aoe-plugin.toml`: plugin manifest
- `src/worker/`: worker, bundled by esbuild into `dist/worker.js`
- `src/page/`: React page, bundled by Vite into a single self-contained
  `dist/index.html`. `bridge.ts` holds the page to dashboard message format.
- `src/shared/`: Board config and the pure Board model (placement, Rules,
  ordering), shared by the worker and the page
- `tests/`: Vitest tests; `tests/e2e/` Playwright tests hosting the page in a
  sandboxed iframe as the dashboard does

## License

MIT
