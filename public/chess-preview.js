'use strict';

/**
 * chess-preview.js — DOM-free chess position logic for the FEN preview.
 *
 * Kept separate from app.js so it can be unit-tested in Node (UMD-style
 * export below) and reused if the preview grows into a move player.
 *
 * Scope note: this is NOT a chess engine. It only needs to (a) read a FEN
 * placement and (b) apply already-validated UCI moves from the dataset, so
 * there is no legality checking.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChessPreview = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /** 'e4' -> { r: row 0..7 from rank 8, c: col 0..7 from file a }. */
  function sq(name) {
    return { c: name.charCodeAt(0) - 97, r: 8 - Number(name[1]) };
  }

  /**
   * Parse a FEN string.
   * @returns {{ board: string[][], activeColor: 'w'|'b' }}
   *   board[0] is rank 8; cells hold piece letters ('P', 'n', ...) or ''.
   */
  function parseFen(fen) {
    const [placement, activeColor] = fen.split(' ');
    const board = placement.split('/').map((rankStr) => {
      const rank = [];
      for (const ch of rankStr) {
        if (ch >= '1' && ch <= '8') {
          for (let i = 0; i < Number(ch); i++) rank.push('');
        } else {
          rank.push(ch);
        }
      }
      return rank;
    });
    return { board, activeColor: activeColor === 'b' ? 'b' : 'w' };
  }

  /**
   * Apply a UCI move (e.g. "f2g3", promotion "b7b8q") to a parsed board,
   * in place. Handles the three special cases UCI leaves implicit:
   * castling (rook hop), en passant (captured pawn removal), promotion.
   */
  function applyUciMove(board, uci) {
    const from = sq(uci.slice(0, 2));
    const to = sq(uci.slice(2, 4));
    const piece = board[from.r][from.c];
    if (!piece) return; // defensive: malformed move for this position

    const kind = piece.toLowerCase();

    // En passant: a pawn capturing onto an empty square.
    if (kind === 'p' && from.c !== to.c && board[to.r][to.c] === '') {
      board[from.r][to.c] = '';
    }

    // Castling: the king moves two files; move the rook as well.
    if (kind === 'k' && Math.abs(to.c - from.c) === 2) {
      const rookFrom = to.c > from.c ? 7 : 0;
      const rookTo = to.c > from.c ? to.c - 1 : to.c + 1;
      board[from.r][rookTo] = board[from.r][rookFrom];
      board[from.r][rookFrom] = '';
    }

    // Promotion: 5th char is the new piece; keep the mover's color (case).
    const promo = uci[4];
    board[to.r][to.c] = promo
      ? (piece === piece.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase())
      : piece;
    board[from.r][from.c] = '';
  }

  /**
   * Serialize a board array back to a FEN placement string (first FEN field
   * only) — the format chessboard.js accepts as a position.
   */
  function boardToFen(board) {
    return board.map((rank) => {
      let out = '';
      let empty = 0;
      for (const cell of rank) {
        if (cell === '') { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += cell;
      }
      if (empty) out += empty;
      return out;
    }).join('/');
  }

  return { parseFen, applyUciMove, boardToFen };
});
