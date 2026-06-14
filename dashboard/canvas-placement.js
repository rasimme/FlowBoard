'use strict';

// Canvas auto-placement (T-352) — pure, no IO. Picks a collision-free slot for
// a new note when the caller did not supply x/y (agent/API convenience: just
// POST {text} and the note lands sensibly instead of stacking at (0,0)).
//
// Strategy (confirmed with the user): a Chebyshev-ring ("spiral") scan over a
// grid of (note box + gutter) cells, anchored at the existing note cluster
// (centroid) — or at a specific note via `near` — falling back to a fixed
// origin on an empty canvas. The first cell whose AABB (expanded by a margin)
// overlaps no existing note wins. Deterministic: same inputs → same slot.
//
// The server has no rendered DOM, so note boxes are approximated with the same
// fallback dimensions the React geometry uses (notesBounds: 160×120).

const NOTE_W = 160;
const NOTE_H = 120;
const GUTTER = 32;   // spacing between grid cells
const MARGIN = 16;   // extra breathing room enforced around the new note
const ORIGIN = { x: 60, y: 60 }; // empty-canvas fallback (matches initial pan)
const MAX_RING = 120; // safety cap on the outward scan

const stepX = NOTE_W + GUTTER;
const stepY = NOTE_H + GUTTER;

/** AABB overlap test between two boxes {x,y,w,h}. Touching edges do not overlap. */
function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Box for an existing note (top-left x/y + approximated dimensions). */
function noteBox(n) {
  return { x: Number(n.x) || 0, y: Number(n.y) || 0, w: NOTE_W, h: NOTE_H };
}

/**
 * Compute a collision-free top-left {x,y} for a new note.
 *
 * @param {Array<{id?:string,x:number,y:number}>} existingNotes
 * @param {{ near?: string }} [opts]  near: anchor beside this note id if present
 * @returns {{x:number, y:number}}  rounded integer coordinates
 */
function autoPlaceNote(existingNotes, opts = {}) {
  const notes = Array.isArray(existingNotes) ? existingNotes : [];
  const boxes = notes.map(noteBox);

  // --- Anchor selection -----------------------------------------------------
  let anchor;
  const near = opts.near
    ? notes.find(n => n && n.id === opts.near)
    : null;
  if (near) {
    anchor = { x: Number(near.x) || 0, y: Number(near.y) || 0 };
  } else if (boxes.length > 0) {
    // Centroid of existing note centers, expressed as a top-left anchor so the
    // new note's box is roughly centered on the cluster's middle.
    let cx = 0, cy = 0;
    for (const b of boxes) { cx += b.x + b.w / 2; cy += b.y + b.h / 2; }
    cx /= boxes.length; cy /= boxes.length;
    anchor = { x: cx - NOTE_W / 2, y: cy - NOTE_H / 2 };
  } else {
    return { x: ORIGIN.x, y: ORIGIN.y };
  }

  // --- Chebyshev-ring scan from the anchor ---------------------------------
  const fits = (x, y) => {
    const candidate = { x: x - MARGIN, y: y - MARGIN, w: NOTE_W + 2 * MARGIN, h: NOTE_H + 2 * MARGIN };
    return !boxes.some(b => overlaps(candidate, b));
  };

  for (let r = 0; r <= MAX_RING; r++) {
    // Walk the ring at Chebyshev distance r (max(|dx|,|dy|) === r) in a stable
    // order. r === 0 is just the anchor cell.
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = anchor.x + dx * stepX;
        const y = anchor.y + dy * stepY;
        if (fits(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
    }
  }

  // Unreachable in practice (space grows quadratically); degrade gracefully.
  return { x: Math.round(anchor.x + (MAX_RING + 1) * stepX), y: Math.round(anchor.y) };
}

module.exports = { autoPlaceNote, NOTE_W, NOTE_H, GUTTER, MARGIN, ORIGIN };
