'use strict';

/**
 * board-preview.js — renders the puzzle position in the details panel.
 *
 * Display uses chessboard.js (vendored in vendor/, MIT, chessboardjs.com);
 * position math (FEN parse + setup-move application) stays in
 * chess-preview.js because chessboard.js is render-only. PNG export draws
 * the position onto a <canvas> with the same piece images — no
 * DOM-screenshot library needed, and the output is crisp at any size.
 *
 * Globals expected on the page (see index.html script order):
 *   jQuery ($), Chessboard, ChessPreview.
 */
(function (root) {

  // Same square colors chessboard.js's stylesheet uses, for the PNG export.
  const SQUARE_LIGHT = '#f0d9b5';
  const SQUARE_DARK = '#b58863';
  const PIECE_THEME = 'img/chesspieces/wikipedia/{piece}.png';
  const EXPORT_SQUARE_PX = 64; // exported PNG is 8 * 64 = 512px

  const pieceImageCache = new Map(); // 'wK' -> Promise<HTMLImageElement>
  let activeBoard = null; // the single live chessboard.js instance

  // chessboard.js sizes itself from its container; follow window resizes.
  root.addEventListener('resize', () => { if (activeBoard) activeBoard.resize(); });

  /**
   * Compute the position the solver actually faces: the CSV's FEN is the
   * position BEFORE the opponent's setup move (moves[0], auto-played on
   * lichess), so apply it and flip the side to move.
   */
  function computePosition(row) {
    const { parseFen, applyUciMove, boardToFen } = root.ChessPreview;
    const { board, activeColor } = parseFen(row.fen);
    const setupMove = row.moves.split(' ')[0] || '';
    let toMove = activeColor;
    if (setupMove) {
      applyUciMove(board, setupMove);
      toMove = activeColor === 'w' ? 'b' : 'w';
    }
    return { board, fen: boardToFen(board), toMove, setupMove };
  }

  /** Render board + caption + "save PNG" button into `container`. */
  function render(container, row) {
    const pos = computePosition(row);
    const orientation = pos.toMove === 'b' ? 'black' : 'white'; // solver at bottom

    const wrap = document.createElement('div');
    wrap.className = 'board-preview';
    const boardEl = document.createElement('div');
    wrap.appendChild(boardEl);

    const caption = document.createElement('p');
    caption.className = 'board-caption';
    caption.textContent = `${pos.toMove === 'w' ? 'White' : 'Black'} to move`
      + (pos.setupMove ? ` (after ${pos.setupMove})` : '');
    wrap.appendChild(caption);

    const actions = document.createElement('div');
    actions.className = 'board-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'save-png-btn';
    saveBtn.textContent = 'Save Diagram';
    saveBtn.addEventListener('click', () => downloadPng(pos.board, orientation, row.puzzleId, saveBtn));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'save-png-btn';
    copyBtn.textContent = 'Copy Diagram';
    copyBtn.addEventListener('click', () => copyPng(pos.board, orientation, copyBtn));

    actions.append(saveBtn, copyBtn);
    wrap.appendChild(actions);

    // chessboard.js needs the container attached (for width) before init.
    container.appendChild(wrap);
    if (activeBoard) activeBoard.destroy(); // previous panel's instance
    activeBoard = root.Chessboard(boardEl, {
      position: pos.fen,
      orientation,
      draggable: false,
      showNotation: true,
      pieceTheme: PIECE_THEME,
    });
  }

  /* ---------------- PNG export ---------------- */

  function loadPieceImage(code) {
    if (!pieceImageCache.has(code)) {
      pieceImageCache.set(code, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load piece image ${code}`));
        img.src = PIECE_THEME.replace('{piece}', code);
      }));
    }
    return pieceImageCache.get(code);
  }

  /** Draw the position to a canvas (used for export; also testable). */
  async function buildBoardCanvas(board, orientation, squareSize = EXPORT_SQUARE_PX) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = squareSize * 8;
    const ctx = canvas.getContext('2d');
    const flipped = orientation === 'black';
    const pieceDraws = [];

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const x = (flipped ? 7 - c : c) * squareSize;
        const y = (flipped ? 7 - r : r) * squareSize;
        ctx.fillStyle = (r + c) % 2 === 0 ? SQUARE_LIGHT : SQUARE_DARK;
        ctx.fillRect(x, y, squareSize, squareSize);
        const piece = board[r][c];
        if (piece) {
          const code = (piece === piece.toUpperCase() ? 'w' : 'b') + piece.toUpperCase();
          pieceDraws.push(loadPieceImage(code)
            .then((img) => ctx.drawImage(img, x, y, squareSize, squareSize)));
        }
      }
    }
    await Promise.all(pieceDraws);
    return canvas;
  }

  /** Render the position and encode it as a PNG blob (shared by save/copy). */
  async function buildPngBlob(board, orientation) {
    const canvas = await buildBoardCanvas(board, orientation);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
      'image/png',
    ));
  }

  async function downloadPng(board, orientation, puzzleId, btn) {
    btn.disabled = true;
    try {
      const blob = await buildPngBlob(board, orientation);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `puzzle-${puzzleId}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(`Could not export PNG: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  async function copyPng(board, orientation, btn) {
    const originalLabel = btn.textContent;
    btn.disabled = true;
    try {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('this browser does not support copying images');
      }
      // Pass the blob as a Promise: keeps the user-gesture window open while
      // the canvas renders (required by Safari, harmless elsewhere).
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': buildPngBlob(board, orientation) }),
      ]);
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = originalLabel; }, 1500);
    } catch (err) {
      alert(`Could not copy diagram: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  root.BoardPreview = { render, buildBoardCanvas, buildPngBlob, computePosition };
})(window);
