'use strict';

/**
 * server.js — minimal, dependency-free HTTP server for the puzzle browser.
 *
 * Why a backend at all: the CSV is 1.1 GB / 6M rows. A browser cannot hold it,
 * and static hosting would force the client to download index data to filter.
 * This server keeps only a ~110 MB index in RAM (see indexer.js) and reads
 * just the requested 20 rows from the CSV per request.
 *
 * Endpoints:
 *   GET /api/meta                       -> dataset stats + theme list
 *   GET /api/puzzles?page&pageSize
 *        &ratingMin&ratingMax&themes    -> one filtered page of rows
 *   GET /*                              -> static files from ./public
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadOrBuild, readRows, MASK_WORDS } = require('./indexer');

const PORT = Number(process.env.PORT) || 8000;
const CSV_PATH = path.join(__dirname, 'lichess_db_puzzle.csv');
const IDX_PATH = path.join(__dirname, 'puzzles.idx');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/* ------------------------------------------------------------------ */
/* Filters                                                              */
/* ------------------------------------------------------------------ */
/*
 * Each filter is { parse(params, index) -> state | null }, where the state
 * carries a `key` (for result-count caching) and a `test(rowIdx) -> bool`.
 * To add a new filter (e.g. popularity, opening), append an entry here and
 * expose a control in the UI — nothing else changes.
 */
const FILTERS = [
  // Rating range (the UI presents this as a single-select band dropdown).
  {
    parse(params, index) {
      const min = params.get('ratingMin');
      const max = params.get('ratingMax');
      if (min === null && max === null) return null;
      const lo = min !== null ? Number(min) : -Infinity;
      const hi = max !== null ? Number(max) : Infinity;
      if (Number.isNaN(lo) || Number.isNaN(hi)) throw badRequest('Invalid rating bounds.');
      const { ratings } = index;
      return {
        key: `rating:${lo}-${hi}`,
        test: (i) => ratings[i] >= lo && ratings[i] <= hi,
      };
    },
  },
  // Themes, comma-separated; a puzzle must have ALL selected themes (AND).
  {
    parse(params, index) {
      const raw = params.get('themes');
      if (!raw) return null;
      const names = raw.split(',').filter(Boolean);
      if (names.length === 0) return null;
      const want = new Uint32Array(MASK_WORDS);
      for (const name of names) {
        const id = index.themes.indexOf(name);
        if (id === -1) throw badRequest(`Unknown theme: ${name}`);
        want[id >> 5] |= 1 << (id & 31);
      }
      const { masks } = index;
      const [w0, w1, w2] = want;
      return {
        key: `themes:${[...names].sort().join(',')}`,
        test: (i) => {
          const b = i * MASK_WORDS;
          return (masks[b] & w0) === w0
            && (masks[b + 1] & w1) === w1
            && (masks[b + 2] & w2) === w2;
        },
      };
    },
  },
];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Scan the index for rows matching all filters, collecting the requested
 * page window. When the total for this filter combination is already cached,
 * the scan stops as soon as the page is full (fast for early pages).
 */
function queryPuzzles(index, tests, page, pageSize, cachedTotal) {
  const first = (page - 1) * pageSize;
  const hits = [];
  let matched = 0;
  for (let i = 0; i < index.count; i++) {
    let ok = true;
    for (const t of tests) if (!t(i)) { ok = false; break; }
    if (!ok) continue;
    if (matched >= first && hits.length < pageSize) hits.push(i);
    matched++;
    if (cachedTotal !== undefined && hits.length === pageSize) {
      return { total: cachedTotal, rowIndices: hits };
    }
  }
  return { total: matched, rowIndices: hits };
}

/* ------------------------------------------------------------------ */
/* HTTP handlers                                                        */
/* ------------------------------------------------------------------ */

// filter-key -> total matches. Avoids rescanning to count on page changes.
const totalCache = new Map();
const TOTAL_CACHE_MAX = 200;

function handleMeta(index, res) {
  const themes = index.themes
    .map((name, id) => ({ name, count: index.themeCounts[id] }))
    .sort((a, b) => b.count - a.count);
  sendJson(res, 200, {
    totalPuzzles: index.count,
    ratingMin: index.ratingMin,
    ratingMax: index.ratingMax,
    themes,
  });
}

async function handlePuzzles(index, csvFd, url, res) {
  const params = url.searchParams;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.get('pageSize')) || DEFAULT_PAGE_SIZE));

  const active = [];
  for (const filter of FILTERS) {
    const state = filter.parse(params, index);
    if (state) active.push(state);
  }
  const cacheKey = active.map((f) => f.key).join('|');
  const tests = active.map((f) => f.test);

  const started = process.hrtime.bigint();
  const { total, rowIndices } = queryPuzzles(index, tests, page, pageSize, totalCache.get(cacheKey));
  if (!totalCache.has(cacheKey)) {
    if (totalCache.size >= TOTAL_CACHE_MAX) totalCache.delete(totalCache.keys().next().value);
    totalCache.set(cacheKey, total);
  }
  const rows = await readRows(csvFd, index, rowIndices);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  sendJson(res, 200, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Static files                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  // Refuse anything that escapes ./public (e.g. ../../secret).
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ */
/* Startup                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  // Without the CSV the server still serves the frontend; the browser then
  // asks for a dropped CSV and does all indexing/filtering itself.
  let index = null;
  let csvFd = null;
  if (fs.existsSync(CSV_PATH)) {
    index = await loadOrBuild(CSV_PATH, IDX_PATH);
    totalCache.set('', index.count); // unfiltered total is known up front
    csvFd = fs.openSync(CSV_PATH, 'r');
  } else {
    console.warn(`CSV not found at ${CSV_PATH} — static mode; drop a CSV onto the page to load data.`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/') && !index) {
        return sendJson(res, 503, { error: 'No dataset on the server; drop a CSV onto the page instead.' });
      }
      if (url.pathname === '/api/meta') return handleMeta(index, res);
      if (url.pathname === '/api/puzzles') return await handlePuzzles(index, csvFd, url, res);
      return serveStatic(url, res);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: err.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`Puzzle browser running at http://localhost:${PORT}`);
  });
}

main();
