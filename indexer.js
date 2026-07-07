'use strict';

/**
 * indexer.js — builds and loads a compact binary index over the puzzle CSV.
 *
 * The CSV (~1.1 GB, ~6M rows) is never held in memory. One streaming pass
 * extracts, per row:
 *   - byte offset of the row in the CSV  -> Uint32Array (4 B/row)
 *   - rating                             -> Uint16Array (2 B/row)
 *   - theme bitmask (96 bits, 73 themes) -> Uint32Array, 3 words/row (12 B/row)
 *
 * Total: ~18 B/row ≈ 110 MB for 6M rows. The index is persisted to disk
 * (puzzles.idx) and re-validated against the CSV's size/mtime, so only the
 * first-ever startup pays the build cost.
 */

const fs = require('fs');

const INDEX_VERSION = 1;
const MASK_WORDS = 3; // 3 x 32-bit words = 96 theme bits (73 needed)

// CSV columns, in file order. Used to turn a raw line into a named object.
const COLUMNS = [
  'puzzleId', 'fen', 'moves', 'rating', 'ratingDeviation',
  'popularity', 'nbPlays', 'themes', 'gameUrl', 'openingTags',
];

/* ------------------------------------------------------------------ */
/* Building                                                             */
/* ------------------------------------------------------------------ */

/**
 * Stream the CSV once and build the in-memory index.
 * @returns {Promise<object>} index data (see makeIndex)
 */
async function buildIndex(csvPath) {
  const stat = fs.statSync(csvPath);
  if (stat.size >= 2 ** 32) {
    throw new Error('CSV larger than 4 GB: Uint32 offsets would overflow.');
  }

  // Pre-size arrays from an average-row-size guess; grown 1.5x if exceeded.
  let capacity = Math.ceil(stat.size / 150);
  let offsets = new Uint32Array(capacity);
  let ratings = new Uint16Array(capacity);
  let masks = new Uint32Array(capacity * MASK_WORDS);

  const themeIds = new Map(); // theme name -> bit position
  const themeNames = [];
  const themeCounts = [];

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

  function processLine(line, byteOffset) {
    if (!headerSkipped) { headerSkipped = true; return; } // column header row
    if (line.length === 0) return;

    // The lichess puzzle CSV has no quoted fields, so a plain split is safe.
    const fields = line.split(',');
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
    if (count % 1_000_000 === 0) console.log(`  indexed ${count.toLocaleString()} rows...`);
  }

  // Stream in 1 MB chunks, splitting on '\n' while tracking byte offsets.
  const stream = fs.createReadStream(csvPath, { highWaterMark: 1 << 20 });
  let leftover = Buffer.alloc(0);
  let filePos = 0; // byte offset of the start of `buf` below

  for await (const chunk of stream) {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    let lineStart = 0;
    let nl;
    while ((nl = buf.indexOf(10, lineStart)) !== -1) {
      const end = nl > lineStart && buf[nl - 1] === 13 ? nl - 1 : nl; // strip \r
      processLine(buf.toString('utf8', lineStart, end), filePos + lineStart);
      lineStart = nl + 1;
    }
    leftover = buf.subarray(lineStart);
    filePos += lineStart;
  }
  if (leftover.length) processLine(leftover.toString('utf8'), filePos); // no trailing \n

  return makeIndex({
    version: INDEX_VERSION,
    rows: count,
    csvSize: stat.size,
    csvMtimeMs: stat.mtimeMs,
    ratingMin,
    ratingMax,
    themes: themeNames,
    themeCounts,
  }, offsets.subarray(0, count), ratings.subarray(0, count), masks.subarray(0, count * MASK_WORDS));
}

/** Bundle header + arrays into the index object used by the server. */
function makeIndex(header, offsets, ratings, masks) {
  return { ...header, count: header.rows, offsets, ratings, masks };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */
/*
 * puzzles.idx layout:
 *   [4 B uint32 LE] header JSON byte length
 *   [header JSON]
 *   [offsets bytes][ratings bytes][masks bytes]
 */

function saveIndex(index, idxPath) {
  const header = {
    version: index.version, rows: index.rows,
    csvSize: index.csvSize, csvMtimeMs: index.csvMtimeMs,
    ratingMin: index.ratingMin, ratingMax: index.ratingMax,
    themes: index.themes, themeCounts: index.themeCounts,
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);

  const fd = fs.openSync(idxPath, 'w');
  try {
    fs.writeSync(fd, lenBuf);
    fs.writeSync(fd, headerBuf);
    fs.writeSync(fd, Buffer.from(index.offsets.buffer, index.offsets.byteOffset, index.offsets.byteLength));
    fs.writeSync(fd, Buffer.from(index.ratings.buffer, index.ratings.byteOffset, index.ratings.byteLength));
    fs.writeSync(fd, Buffer.from(index.masks.buffer, index.masks.byteOffset, index.masks.byteLength));
  } finally {
    fs.closeSync(fd);
  }
}

/** Load the cached index if it exists and still matches the CSV; else null. */
function loadIndex(idxPath, csvPath) {
  if (!fs.existsSync(idxPath)) return null;
  const csvStat = fs.statSync(csvPath);
  const fd = fs.openSync(idxPath, 'r');
  try {
    const lenBuf = Buffer.alloc(4);
    fs.readSync(fd, lenBuf, 0, 4, 0);
    const headerLen = lenBuf.readUInt32LE(0);
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, 4);
    const header = JSON.parse(headerBuf.toString('utf8'));

    if (header.version !== INDEX_VERSION) return null;
    if (header.csvSize !== csvStat.size || header.csvMtimeMs !== csvStat.mtimeMs) {
      console.log('CSV changed since index was built; rebuilding.');
      return null;
    }

    const n = header.rows;
    const offsets = new Uint32Array(n);
    const ratings = new Uint16Array(n);
    const masks = new Uint32Array(n * MASK_WORDS);
    let pos = 4 + headerLen;
    for (const arr of [offsets, ratings, masks]) {
      const bytes = Buffer.from(arr.buffer);
      let read = 0;
      while (read < bytes.length) {
        const got = fs.readSync(fd, bytes, read, bytes.length - read, pos + read);
        if (got <= 0) throw new Error('Unexpected end of index file.');
        read += got;
      }
      pos += bytes.length;
    }
    return makeIndex(header, offsets, ratings, masks);
  } catch (err) {
    console.warn(`Failed to load index (${err.message}); rebuilding.`);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Load the cached index or build + persist a fresh one. */
async function loadOrBuild(csvPath, idxPath) {
  const cached = loadIndex(idxPath, csvPath);
  if (cached) {
    console.log(`Loaded cached index: ${cached.count.toLocaleString()} puzzles.`);
    return cached;
  }
  console.log('Building index (first run only, ~30-60s)...');
  const started = Date.now();
  const index = await buildIndex(csvPath);
  console.log(`Indexed ${index.count.toLocaleString()} puzzles in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  saveIndex(index, idxPath);
  console.log(`Index cached to ${idxPath}.`);
  return index;
}

/* ------------------------------------------------------------------ */
/* Row retrieval                                                        */
/* ------------------------------------------------------------------ */

/**
 * Read full rows for the given row indices straight from the CSV via
 * positioned reads — only ~200 bytes per row are ever read from disk.
 */
function readRows(csvFd, index, rowIndices) {
  return Promise.all(rowIndices.map((i) => new Promise((resolve, reject) => {
    const start = index.offsets[i];
    const end = i + 1 < index.count ? index.offsets[i + 1] : index.csvSize;
    const buf = Buffer.alloc(end - start);
    fs.read(csvFd, buf, 0, buf.length, start, (err, bytesRead) => {
      if (err) return reject(err);
      const line = buf.toString('utf8', 0, bytesRead).replace(/\r?\n$/, '');
      const fields = line.split(',');
      const row = {};
      COLUMNS.forEach((col, c) => { row[col] = fields[c] ?? ''; });
      resolve(row);
    });
  })));
}

module.exports = { loadOrBuild, readRows, MASK_WORDS, COLUMNS };
