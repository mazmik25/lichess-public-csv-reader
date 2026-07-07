'use strict';

/**
 * local-source.js — client-side data source for a dropped puzzle CSV.
 *
 * Browser port of the index build in indexer.js plus the query side of
 * server.js, so the app can run without any backend (e.g. on GitHub Pages):
 * the dropped File is streamed once to build the same compact typed-array
 * index (~18 B/row), filters scan those arrays, and full rows are fetched
 * with positioned File.slice() reads — the browser never holds the CSV.
 *
 * Usage: const source = await LocalSource.open(file, onProgress);
 * The returned object mirrors the HTTP API: getMeta() and getPuzzles(params)
 * resolve with the same JSON shapes as /api/meta and /api/puzzles.
 *
 * No DOM dependencies — testable in Node with buffer.File.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LocalSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MASK_WORDS = 3; // 3 x 32-bit words = 96 theme bits (73 needed)
  const DEFAULT_PAGE_SIZE = 20;
  const MAX_PAGE_SIZE = 100;

  // CSV columns, in file order (same dataset format as indexer.js).
  const COLUMNS = [
    'puzzleId', 'fen', 'moves', 'rating', 'ratingDeviation',
    'popularity', 'nbPlays', 'themes', 'gameUrl', 'openingTags',
  ];

  /* ---------------------------------------------------------------- */
  /* Index build (streaming, one pass over the File)                    */
  /* ---------------------------------------------------------------- */

  async function buildIndex(file, onProgress) {
    if (file.size >= 2 ** 32) {
      throw new Error('CSV larger than 4 GB: Uint32 offsets would overflow.');
    }

    // Pre-size arrays from an average-row-size guess; grown 1.5x if exceeded.
    let capacity = Math.max(16, Math.ceil(file.size / 150));
    let offsets = new Uint32Array(capacity);
    let ratings = new Uint16Array(capacity);
    let masks = new Uint32Array(capacity * MASK_WORDS);

    const themeIds = new Map(); // theme name -> bit position
    const themeNames = [];
    const themeCounts = [];
    const decoder = new TextDecoder();

    let count = 0;
    let ratingMin = Infinity;
    let ratingMax = -Infinity;
    let headerSkipped = false;

    function grow() {
      capacity = Math.ceil(capacity * 1.5);
      const o = new Uint32Array(capacity); o.set(offsets); offsets = o;
      const r = new Uint16Array(capacity); r.set(ratings); ratings = r;
      const m = new Uint32Array(capacity * MASK_WORDS); m.set(masks); masks = m;
    }

    function processLine(bytes, start, end, byteOffset) {
      if (!headerSkipped) { headerSkipped = true; return; } // column header row
      if (end > start && bytes[end - 1] === 13) end--; // strip \r
      if (end === start) return;

      // The lichess puzzle CSV has no quoted fields, so a plain split is safe.
      const fields = decoder.decode(bytes.subarray(start, end)).split(',');
      const rating = +fields[3];
      if (count === capacity) grow();

      offsets[count] = byteOffset;
      ratings[count] = rating;
      if (rating < ratingMin) ratingMin = rating;
      if (rating > ratingMax) ratingMax = rating;

      const themesField = fields[7];
      if (themesField) {
        const base = count * MASK_WORDS;
        for (const name of themesField.split(' ')) {
          if (!name) continue;
          let id = themeIds.get(name);
          if (id === undefined) {
            id = themeNames.length;
            if (id >= MASK_WORDS * 32) throw new Error('Too many themes for bitmask.');
            themeIds.set(name, id);
            themeNames.push(name);
            themeCounts.push(0);
          }
          themeCounts[id]++;
          masks[base + (id >> 5)] |= 1 << (id & 31);
        }
      }
      count++;
    }

    // Stream the File, splitting on '\n' while tracking byte offsets.
    const reader = file.stream().getReader();
    let leftover = new Uint8Array(0);
    let filePos = 0;      // byte offset of the start of `buf` below
    let bytesRead = 0;
    let lastReport = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;

      let buf = value;
      if (leftover.length) {
        buf = new Uint8Array(leftover.length + value.length);
        buf.set(leftover);
        buf.set(value, leftover.length);
      }
      let lineStart = 0;
      let nl;
      while ((nl = buf.indexOf(10, lineStart)) !== -1) {
        processLine(buf, lineStart, nl, filePos + lineStart);
        lineStart = nl + 1;
      }
      leftover = buf.subarray(lineStart);
      filePos += lineStart;

      // Report progress and yield so the UI can repaint (~every 16 MB).
      if (onProgress && bytesRead - lastReport >= (1 << 24)) {
        lastReport = bytesRead;
        onProgress(bytesRead, file.size, count);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (leftover.length) processLine(leftover, 0, leftover.length, filePos); // no trailing \n
    if (onProgress) onProgress(file.size, file.size, count);

    if (count === 0) throw new Error('No data rows found — is this a puzzle CSV?');

    return {
      count,
      csvSize: file.size,
      ratingMin,
      ratingMax,
      themes: themeNames,
      themeCounts,
      offsets: offsets.subarray(0, count),
      ratings: ratings.subarray(0, count),
      masks: masks.subarray(0, count * MASK_WORDS),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Query engine (mirrors FILTERS + queryPuzzles in server.js)         */
  /* ---------------------------------------------------------------- */

  function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
  }

  const FILTERS = [
    // Rating range.
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

  /** Positioned reads: only the ~200 bytes of each requested row leave the File. */
  function readRows(file, index, rowIndices) {
    return Promise.all(rowIndices.map(async (i) => {
      const start = index.offsets[i];
      const end = i + 1 < index.count ? index.offsets[i + 1] : index.csvSize;
      const line = (await file.slice(start, end).text()).replace(/\r?\n$/, '');
      const fields = line.split(',');
      const row = {};
      COLUMNS.forEach((col, c) => { row[col] = fields[c] ?? ''; });
      return row;
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                          */
  /* ---------------------------------------------------------------- */

  async function open(file, onProgress) {
    const index = await buildIndex(file, onProgress);
    // filter-key -> total matches, so page changes can stop scanning early.
    const totalCache = new Map([['', index.count]]);
    const TOTAL_CACHE_MAX = 200;
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

    return {
      async getMeta() {
        const themes = index.themes
          .map((name, id) => ({ name, count: index.themeCounts[id] }))
          .sort((a, b) => b.count - a.count);
        return {
          totalPuzzles: index.count,
          ratingMin: index.ratingMin,
          ratingMax: index.ratingMax,
          themes,
        };
      },

      async getPuzzles(params) {
        const page = Math.max(1, Number(params.get('page')) || 1);
        const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.get('pageSize')) || DEFAULT_PAGE_SIZE));

        const active = [];
        for (const filter of FILTERS) {
          const state = filter.parse(params, index);
          if (state) active.push(state);
        }
        const cacheKey = active.map((f) => f.key).join('|');
        const tests = active.map((f) => f.test);

        const started = now();
        const { total, rowIndices } = queryPuzzles(index, tests, page, pageSize, totalCache.get(cacheKey));
        if (!totalCache.has(cacheKey)) {
          if (totalCache.size >= TOTAL_CACHE_MAX) totalCache.delete(totalCache.keys().next().value);
          totalCache.set(cacheKey, total);
        }
        const rows = await readRows(file, index, rowIndices);
        const elapsedMs = now() - started;

        return {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          elapsedMs: Math.round(elapsedMs * 10) / 10,
          rows,
        };
      },
    };
  }

  return { open };
});
