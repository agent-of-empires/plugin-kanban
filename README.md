# Board

A kanban Board of your Sessions for the Agent of Empires web dashboard.

An [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)
plugin. It adds a **Board** page (the `page` UI slot) backed by a Node worker
that speaks JSON-RPC 2.0 over newline-delimited JSON on stdio.

> **Status:** scaffold. The page slot needs core
> [agent-of-empires#4459](https://github.com/agent-of-empires/agent-of-empires/issues/4459)
> (`api_version` 16); current releases refuse this manifest.

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
- `tests/`: Vitest tests; `tests/e2e/` Playwright tests hosting the page in a
  sandboxed iframe as the dashboard does

## License

MIT
