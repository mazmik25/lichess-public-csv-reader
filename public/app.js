'use strict';

/**
 * app.js — frontend for the puzzle browser.
 *
 * All heavy lifting (filtering, pagination) happens server-side; this file
 * only tracks UI state, calls the API, and renders the current page of 20.
 *
 * To add a new filter later: add a control, include its value in
 * buildQuery(), and add the matching entry to FILTERS in server.js.
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
/* API                                                                  */
/* ------------------------------------------------------------------ */

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

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
    const data = await fetchJson(`/api/puzzles?${buildQuery()}`);
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

function initThemeFilter(themes) {
  const list = $('theme-list');
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
/* Init                                                                 */
/* ------------------------------------------------------------------ */

async function init() {
  initRatingFilter();
  initPagination();
  try {
    const meta = await fetchJson('/api/meta');
    $('dataset-info').textContent =
      `${meta.totalPuzzles.toLocaleString()} puzzles · ratings ${meta.ratingMin}–${meta.ratingMax} · ${meta.themes.length} themes`;
    initThemeFilter(meta.themes);
  } catch (err) {
    $('result-summary').textContent = `Failed to load dataset info: ${err.message}`;
  }
  loadPage();
}

init();
