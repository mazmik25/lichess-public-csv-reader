'use strict';

/**
 * app.js — frontend for the puzzle browser.
 *
 * All heavy lifting (filtering, pagination) happens in the data source —
 * either the Node server's API or a dropped CSV indexed in-browser (see
 * local-source.js). This file only tracks UI state, queries the source,
 * and renders the current page of 20.
 *
 * To add a new filter later: add a control, include its value in
 * buildQuery(), and add the matching entry to FILTERS in server.js and
 * local-source.js.
 */

const PAGE_SIZE = 20;

/** Rating bands for the single-select rating filter (dataset spans 399-3347). */
const RATING_BANDS = [
  { label: 'Under 800', min: null, max: 799 },
  { label: '800 – 1199', min: 800, max: 1199 },
  { label: '1200 – 1599', min: 1200, max: 1599 },
  { label: '1600 – 1999', min: 1600, max: 1999 },
  { label: '2000 – 2399', min: 2000, max: 2399 },
  { label: '2400 and up', min: 2400, max: null },
];

/** UI state — the single source of truth for what page/filters are shown. */
const state = {
  page: 1,
  totalPages: 1,
  ratingBand: '',            // index into RATING_BANDS, or '' for all
  selectedThemes: new Set(), // theme names, combined with AND on the server
  rows: [],                  // rows currently displayed
  selectedPuzzleId: null,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Data sources                                                         */
/* ------------------------------------------------------------------ */
/*
 * The app can be fed two ways, behind one interface (getMeta/getPuzzles):
 *   - remoteSource: the Node server's JSON API (local `node server.js`)
 *   - LocalSource:  a CSV File dropped onto the page, indexed and queried
 *     entirely in the browser (the only option on static hosting, e.g.
 *     GitHub Pages, where there is no API)
 */

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const remoteSource = {
  getMeta: () => fetchJson('/api/meta'),
  getPuzzles: (params) => fetchJson(`/api/puzzles?${params}`),
};

let source = remoteSource;

function buildQuery() {
  const params = new URLSearchParams({ page: state.page, pageSize: PAGE_SIZE });
  if (state.ratingBand !== '') {
    const band = RATING_BANDS[state.ratingBand];
    if (band.min !== null) params.set('ratingMin', band.min);
    if (band.max !== null) params.set('ratingMax', band.max);
  }
  if (state.selectedThemes.size) {
    params.set('themes', [...state.selectedThemes].join(','));
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

async function loadPage() {
  const summary = $('result-summary');
  summary.textContent = 'Loading…';
  try {
    const data = await source.getPuzzles(buildQuery());
    state.rows = data.rows;
    state.totalPages = data.totalPages;
    // Server may clamp; keep the input honest.
    if (state.page > data.totalPages) state.page = data.totalPages;

    renderRows(data.rows);
    renderPagination();
    summary.textContent =
      `${data.total.toLocaleString()} puzzles match · query ${data.elapsedMs} ms`;
  } catch (err) {
    summary.textContent = `Error: ${err.message}`;
  }
}

function renderRows(rows) {
  const tbody = $('puzzle-rows');
  tbody.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 3;
    td.textContent = 'No puzzles match the current filters.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.puzzleId = row.puzzleId;
    if (row.puzzleId === state.selectedPuzzleId) tr.classList.add('selected');

    const idCell = document.createElement('td');
    idCell.className = 'puzzle-id';
    idCell.textContent = row.puzzleId;

    const ratingCell = document.createElement('td');
    ratingCell.textContent = row.rating;

    const themesCell = document.createElement('td');
    for (const theme of row.themes.split(' ').filter(Boolean)) {
      const tag = document.createElement('span');
      tag.className = 'theme-tag';
      tag.textContent = theme;
      themesCell.appendChild(tag);
    }

    tr.append(idCell, ratingCell, themesCell);
    tr.addEventListener('click', () => selectPuzzle(row));
    tbody.appendChild(tr);
  }
}

function renderPagination() {
  $('page-input').value = state.page;
  $('page-total').textContent = state.totalPages.toLocaleString();
  $('page-input').max = state.totalPages;
  $('page-first').disabled = $('page-prev').disabled = state.page <= 1;
  $('page-next').disabled = $('page-last').disabled = state.page >= state.totalPages;
}

/** Show every CSV field of the clicked puzzle in the details panel. */
function selectPuzzle(row) {
  state.selectedPuzzleId = row.puzzleId;
  document.querySelectorAll('#puzzle-rows tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.puzzleId === row.puzzleId));

  $('details-placeholder').hidden = true;
  const box = $('details-content');
  box.hidden = false;
  box.replaceChildren();

  const title = document.createElement('h2');
  title.textContent = `Puzzle ${row.puzzleId}`;
  box.appendChild(title);

  // Board preview + PNG export (chessboard.js rendering; see board-preview.js)
  BoardPreview.render(box, row);

  const dl = document.createElement('dl');
  dl.className = 'details-grid';
  const fields = [
    ['Rating', row.rating],
    ['Rating deviation', row.ratingDeviation],
    ['Popularity', row.popularity],
    ['Times played', Number(row.nbPlays).toLocaleString()],
    ['FEN', row.fen, 'mono'],
    ['Solution moves', row.moves, 'mono'],
    ['Opening', row.openingTags ? row.openingTags.replaceAll('_', ' ') : '—'],
  ];
  for (const [label, value, cls] of fields) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (cls) dd.className = cls;
    dd.textContent = value;
    dl.append(dt, dd);
  }
  // Themes as tags
  const dt = document.createElement('dt');
  dt.textContent = 'Themes';
  const dd = document.createElement('dd');
  for (const theme of row.themes.split(' ').filter(Boolean)) {
    const tag = document.createElement('span');
    tag.className = 'theme-tag';
    tag.textContent = theme;
    dd.appendChild(tag);
  }
  dl.append(dt, dd);
  box.appendChild(dl);

  const links = document.createElement('div');
  links.className = 'details-links';
  const trainLink = document.createElement('a');
  trainLink.href = `https://lichess.org/training/${row.puzzleId}`;
  trainLink.target = '_blank';
  trainLink.rel = 'noopener';
  trainLink.textContent = 'Solve on Lichess ↗';
  links.appendChild(trainLink);
  if (row.gameUrl) {
    const gameLink = document.createElement('a');
    gameLink.href = row.gameUrl;
    gameLink.target = '_blank';
    gameLink.rel = 'noopener';
    gameLink.textContent = 'Source game ↗';
    links.appendChild(gameLink);
  }
  box.appendChild(links);
}

/* ------------------------------------------------------------------ */
/* Filter controls                                                      */
/* ------------------------------------------------------------------ */

function initRatingFilter() {
  const select = $('rating-select');
  RATING_BANDS.forEach((band, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = band.label;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    state.ratingBand = select.value;
    applyFilters();
  });
}

/** (Re)fill the theme dropdown — called at startup and per dropped CSV. */
function populateThemeList(themes) {
  const list = $('theme-list');
  list.replaceChildren();
  for (const { name, count } of themes) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.addEventListener('change', () => {
      cb.checked ? state.selectedThemes.add(name) : state.selectedThemes.delete(name);
      updateThemeSummary();
      applyFilters();
    });
    const text = document.createElement('span');
    text.textContent = name;
    const countEl = document.createElement('span');
    countEl.className = 'theme-count';
    countEl.textContent = count.toLocaleString();
    label.append(cb, text, countEl);
    li.appendChild(label);
    list.appendChild(li);
  }
}

function initThemeControls() {
  const list = $('theme-list');

  // Narrow the checkbox list as the user types (client-side, 73 items).
  $('theme-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of list.children) {
      li.hidden = q !== '' && !li.textContent.toLowerCase().includes(q);
    }
  });

  $('theme-clear').addEventListener('click', () => {
    state.selectedThemes.clear();
    list.querySelectorAll('input:checked').forEach((cb) => { cb.checked = false; });
    updateThemeSummary();
    applyFilters();
  });

  // Close the dropdown when clicking outside it.
  document.addEventListener('click', (e) => {
    const dropdown = $('theme-dropdown');
    if (dropdown.open && !dropdown.contains(e.target)) dropdown.open = false;
  });
}

function updateThemeSummary() {
  const n = state.selectedThemes.size;
  $('theme-summary').textContent = n === 0 ? 'Any theme' : [...state.selectedThemes].join(', ');
  const badge = $('theme-count-badge');
  badge.hidden = n === 0;
  badge.textContent = n;
}

/** Filter changes always restart from page 1 (debounced for rapid clicking). */
let applyTimer;
function applyFilters() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    state.page = 1;
    loadPage();
  }, 250);
}

/* ------------------------------------------------------------------ */
/* Pagination controls                                                  */
/* ------------------------------------------------------------------ */

function goToPage(page) {
  const target = Math.min(Math.max(1, page), state.totalPages);
  if (target === state.page) return;
  state.page = target;
  loadPage();
}

function initPagination() {
  $('page-first').addEventListener('click', () => goToPage(1));
  $('page-prev').addEventListener('click', () => goToPage(state.page - 1));
  $('page-next').addEventListener('click', () => goToPage(state.page + 1));
  $('page-last').addEventListener('click', () => goToPage(state.totalPages));
  $('page-input').addEventListener('change', (e) => goToPage(Number(e.target.value) || 1));
}

/* ------------------------------------------------------------------ */
/* Dropped CSV handling                                                 */
/* ------------------------------------------------------------------ */

function applyMeta(meta, originLabel) {
  $('dataset-info').textContent =
    `${originLabel ? originLabel + ' · ' : ''}${meta.totalPuzzles.toLocaleString()} puzzles · ratings ${meta.ratingMin}–${meta.ratingMax} · ${meta.themes.length} themes`;
  populateThemeList(meta.themes);
  updateThemeSummary();
}

/** Index a dropped/browsed CSV in the browser and switch the app to it. */
async function loadLocalFile(file) {
  const summary = $('result-summary');
  if (!/\.csv$/i.test(file.name)) {
    summary.textContent = `"${file.name}" is not a .csv file.`;
    return;
  }
  try {
    const local = await LocalSource.open(file, (read, total, rows) => {
      summary.textContent =
        `Indexing ${file.name}… ${Math.round((read / total) * 100)}% (${rows.toLocaleString()} rows)`;
    });
    source = local;
    state.page = 1;
    state.selectedThemes.clear();
    state.selectedPuzzleId = null;
    applyMeta(await source.getMeta(), file.name);
    loadPage();
  } catch (err) {
    summary.textContent = `Could not load ${file.name}: ${err.message}`;
  }
}

function initDropZone() {
  const zone = $('drop-zone');
  const input = $('csv-file-input');

  $('csv-browse').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) loadLocalFile(input.files[0]);
    input.value = ''; // allow re-selecting the same file
  });

  // Accept drops anywhere on the page, highlighting the banner while dragging.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-active');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) zone.classList.remove('drag-active');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-active');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadLocalFile(file);
  });
}

/* ------------------------------------------------------------------ */
/* Init                                                                 */
/* ------------------------------------------------------------------ */

async function init() {
  initRatingFilter();
  initThemeControls();
  initPagination();
  initDropZone();
  try {
    const meta = await remoteSource.getMeta();
    applyMeta(meta, 'Server dataset');
    loadPage();
  } catch {
    // No API (static hosting, e.g. GitHub Pages) — wait for a dropped CSV.
    $('dataset-info').textContent = 'No dataset loaded';
    $('result-summary').textContent =
      'Drop a Lichess puzzle CSV anywhere on this page to start.';
  }
}

init();
