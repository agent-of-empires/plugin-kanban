# Board

A kanban Board of your Sessions for the Agent of Empires web dashboard.

An [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)
plugin. It adds a **Board** page (the `page` UI slot) backed by a Node worker
that speaks JSON-RPC 2.0 over newline-delimited JSON on stdio.

> **Status:** early. Columns are editable; moving Cards and editing Rules
> come later. The page slot needs core
> [agent-of-empires#4459](https://github.com/agent-of-empires/agent-of-empires/issues/4459)
> (`api_version` 16).

## Requirements

Node 22 or newer on the `PATH` of the AoE daemon. The built worker and page are
committed under `dist/`, so install runs no build step and needs no `npm`.

## Install into Agent of Empires

```bash
# from a fresh clone (no node_modules/)
aoe plugin install ./plugin-kanban

# or from GitHub once published
aoe plugin install gh:agent-of-empires/plugin-kanban
```

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
cannot be deleted. A new Signal column has no Rules yet, so it holds nothing.
Editing is hidden in read-only and CityHall mode.

A Rule is a list of conditions that must all hold; a Column matches when any
of its Rules does. Urgent, unread, last error, pending Approvals and last
activity are not yet exposed to plugin pages by the dashboard, so Rules on
them do not match for now.

The search box matches title, path, repo, branch and agent, like the sidebar
filter. Group names are not exposed to plugin pages yet, so they do not match.

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

Publishing the snapshot needs a core release where the `page` slot accepts UI state.

## Develop

```bash
npm ci
npm run lint
npm run typecheck
npm run build      # writes dist/worker.js and dist/index.html
npm test           # Vitest, against the built worker
npm run test:e2e   # Playwright, against the built page
```

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
