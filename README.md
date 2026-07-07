# Lichess Puzzle Browser

A lightweight local web app for browsing and filtering the Lichess puzzle
database (`lichess_db_puzzle.csv`, ~1.1 GB, ~6 million puzzles) without ever
loading the whole file into memory.

## Project structure

```
csv-reader/
├── lichess_db_puzzle.csv   # the dataset (gitignored — exceeds GitHub's 100 MB limit)
├── server.js               # dependency-free Node HTTP server + JSON API
├── indexer.js              # streaming index builder + binary cache + row reader
├── puzzles.idx             # generated binary index cache (~110 MB, gitignored)
├── .github/workflows/
│   └── deploy.yml          # deploys public/ to GitHub Pages on push to main
├── public/
│   ├── index.html          # markup: drop zone, filters, list, details, pagination
│   ├── style.css           # minimal styling, responsive at <900px
│   ├── app.js              # vanilla JS: state, data-source calls, rendering
│   ├── local-source.js     # in-browser CSV indexing + querying for dropped files
│   ├── chess-preview.js    # DOM-free FEN parsing + UCI move logic (Node-testable)
│   ├── board-preview.js    # board rendering via chessboard.js + PNG export
│   ├── vendor/             # chessboard.js 1.0.0, its CSS, jQuery 3.7.1 (offline)
│   └── img/chesspieces/    # wikipedia piece PNGs used by board + PNG export
└── README.md
```

## Running locally

Requires only Node.js (no `npm install` — zero dependencies).

```
node server.js
```

Then open http://localhost:8000 (set `PORT` to change the port).

The **first** start streams the CSV once to build the index (~30–60 s,
progress is logged). The index is cached to `puzzles.idx`, so every later
start loads in about a second. If the CSV changes (size/mtime), the index is
rebuilt automatically. Delete `puzzles.idx` to force a rebuild.

If `lichess_db_puzzle.csv` is not present, the server still starts and serves
the frontend; load data by dropping a CSV onto the page (below).

## Drag & drop a CSV (no backend needed)

Instead of placing the CSV next to `server.js`, you can **drop a puzzle CSV
anywhere onto the page** (or click *browse for a file* in the banner). The
file is then indexed **entirely in the browser** by `public/local-source.js`,
which ports the server-side technique to the File API:

- the File is streamed once to build the same ~18 B/row typed-array index
  (offsets + ratings + 96-bit theme bitmasks), with live progress;
- filters run as bitwise scans over those arrays, exactly like the server;
- full rows are fetched with positioned `File.slice()` reads — the CSV is
  never held in memory and **never uploaded anywhere**.

The CSV must have the standard Lichess puzzle columns
(`PuzzleId,FEN,Moves,Rating,…`). This mode is what makes the static
deployment below possible.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` publishes `public/` to GitHub Pages on every
push to `main`. One-time setup: in the repo, **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

GitHub Pages is static hosting — there is no Node server, and the dataset
cannot be committed anyway (GitHub rejects files over 100 MB; the CSV is
~1.1 GB and `puzzles.idx` ~110 MB, both gitignored). So on the deployed site
the app starts empty and the visitor drops their own copy of
`lichess_db_puzzle.csv` onto the page; everything runs client-side from
there.

## Why a backend is needed (for the classic mode)

The requirements prefer a no-backend solution, but at 1.1 GB / 6 M rows a
purely static approach fails on its own goals:

- A browser tab cannot hold the dataset (memory), and `file://` pages cannot
  `fetch()` local files at all — so *some* local server is required anyway.
- Filtering by rating/themes requires knowing which of the 6 M rows match.
  Statically, the client would have to download index data (~100 MB) to do
  that, violating the "fast page load, low memory" goals.

Given that a static server is unavoidable, a ~150-line dependency-free Node
server that also answers filter queries is the minimal-setup option: one
command, no packages, and the browser only ever receives 20 rows at a time.

The drag-and-drop mode sidesteps the `fetch()` limitation via the File API
(the user hands the browser the file explicitly), at two costs the server
mode doesn't have: every page load re-indexes the CSV (~30–60 s — there is
no `puzzles.idx` cache in the browser), and the ~110 MB index lives in the
tab's memory. Both modes coexist: the app uses the API when the server has
the dataset and falls back to drop mode otherwise.

## Optimization techniques

1. **One-pass streaming index build.** The CSV is read once as a stream
   (1 MB chunks); it is never fully in memory. Per row only three things are
   kept: the row's byte offset in the CSV (`Uint32`), its rating (`Uint16`),
   and a 96-bit theme bitmask (3×`Uint32` — the dataset has 73 themes).
   That is ~18 bytes/row ≈ **110 MB of RAM instead of 1.1 GB**.

2. **Binary index cache.** The typed arrays are dumped to `puzzles.idx` and
   revalidated against the CSV's size + mtime, so the build cost is paid once.

3. **Bitmask theme filtering.** A multi-theme (AND) filter is three bitwise
   `AND`s per row over contiguous typed arrays — a full 6 M-row scan takes
   tens of milliseconds (the query time is shown in the UI).

4. **Early-exit scans with a total-count cache.** The first query for a
   filter combination scans fully to get the match count (needed for "page X
   of Y"); the count is cached, so subsequent page navigations stop scanning
   as soon as the 20 requested rows are found.

5. **Positioned reads for row data.** Full puzzle rows are fetched by
   `fs.read` directly at the stored byte offsets — ~20 reads of ~200 bytes
   per page request, regardless of dataset size.

6. **Tiny responses.** The API returns exactly one page (20 rows, a few KB
   of JSON). The details panel reuses the row data already on the page — no
   extra request on click.

## Board preview & PNG export

The details panel renders the puzzle position with
[chessboard.js](https://chessboardjs.com) (v1.0.0). It and its dependencies
(jQuery, piece images) are **vendored under `public/vendor/` and
`public/img/`** so the app keeps working fully offline — no CDN.

chessboard.js is render-only, so the position math lives in
`chess-preview.js`: in the Lichess format the CSV's FEN is the position
*before* the opponent's setup move (`Moves[0]`, auto-played on lichess.org).
`chess-preview.js` applies that move (including castling, en passant, and
promotion) and serializes the result back to a FEN placement for
chessboard.js. The board is oriented with the solver's side at the bottom,
matching what lichess presents. The module has no DOM dependencies and is
unit-tested in Node.

**Save / Copy diagram**: both buttons under the board share one export path —
the position is redrawn onto a `<canvas>` (512×512) using the same piece
images and square colors, then encoded as a PNG. *Save Diagram* downloads it
as `puzzle-<id>.png`; *Copy Diagram* places it on the clipboard via the async
Clipboard API (`ClipboardItem`), ready to paste into chats, docs, or image
editors. Drawing from the position data rather than screenshotting the DOM
keeps the export crisp and dependency-free. Clipboard image copy needs a
Chromium-based browser or Firefox 127+; the button reports if unsupported.

## Extending with new filters

Filters are pluggable on the server: each entry in `FILTERS` (`server.js`)
parses its own query parameters and returns a per-row `test(i)` predicate
plus a cache `key`. To add e.g. a popularity filter:

1. Add popularity to the index arrays in `indexer.js` (one more typed array,
   bump `INDEX_VERSION` so caches rebuild).
2. Append a `FILTERS` entry reading `?popularityMin=`.
3. Add a control in `index.html` and include its value in `buildQuery()`
   (`public/app.js`).

## Future improvements

- **Text search** on PuzzleId / opening tags (needs a small trigram or prefix
  index; the pluggable-filter shape already accommodates it).
- **Sorting** by rating/popularity: keep permutation arrays (sorted row-index
  orders) built once at startup, then scan in that order.
- **Bookmarks**: persist puzzle IDs to `localStorage`, plus a "bookmarked
  only" filter.
- **Virtual scrolling** instead of pagination — the API already supports
  arbitrary `page`/`pageSize`, so an infinite list is a frontend-only change.
- **Shareable URLs**: mirror filter state into the query string so a
  filtered view can be bookmarked/reloaded.
- **OR mode for themes**: the bitmask test trivially supports "any of"
  (`(mask & want) !== 0`) behind a toggle.
