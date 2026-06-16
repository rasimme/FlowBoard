// Connection routing geometry — extracted 1:1 from js/canvas/connections.js
// and js/canvas/state.js (T-340-1). Function bodies are verbatim; the only
// change is decoupling from module state and the DOM: note dimensions and
// the canvas state arrive as parameters instead of element/getElementById
// lookups, so everything here is pure and unit-testable.

import { CORNER_RADIUS, PORT_SPACING, MIN_ESCAPE, COLOR_STROKE, SCALE_MIN, SCALE_MAX } from './canvasConstants.mjs';

/**
 * Convert an array of [x,y] waypoints into a rounded-corner SVG path.
 * Each interior corner gets a Q arc of radius r (clamped to half the shorter segment).
 */
export function ptsToRoundedPath(pts, r) {
  // Remove consecutive duplicates
  const p = pts.filter((pt, i) =>
    i === 0 || pt[0] !== pts[i-1][0] || pt[1] !== pts[i-1][1]
  );
  if (p.length < 2) return '';
  if (p.length === 2) return `M ${p[0][0]} ${p[0][1]} L ${p[1][0]} ${p[1][1]}`;

  let d = `M ${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i-1], [cx, cy] = p[i], [nx, ny] = p[i+1];
    const len1 = Math.hypot(cx - px, cy - py);
    const len2 = Math.hypot(nx - cx, ny - cy);
    const rc = Math.min(r, len1 / 2, len2 / 2);
    if (rc < 1) {
      d += ` L ${cx} ${cy}`;
    } else {
      const bx = cx - ((cx - px) / len1) * rc;
      const by = cy - ((cy - py) / len1) * rc;
      const ax = cx + ((nx - cx) / len2) * rc;
      const ay = cy + ((ny - cy) / len2) * rc;
      d += ` L ${bx} ${by} Q ${cx} ${cy} ${ax} ${ay}`;
    }
  }
  d += ` L ${p[p.length-1][0]} ${p[p.length-1][1]}`;
  return d;
}

/**
 * Route a connection with mandatory card-edge escapes on BOTH ends + proper rounding.
 * - Source exit: always escapes MIN_ESCAPE away from source card edge
 * - Target entry: always escapes MIN_ESCAPE away from target card edge
 * - Middle routing: perpendicular exits/entries (no U-turns)
 * - All corners rounded via ptsToRoundedPath
 */
export function routePath(x1, y1, x2, y2, fromSide, toSide = null, tgtHalfW = 0) {
  const E = MIN_ESCAPE;
  const r = CORNER_RADIUS;

  // ── Escape points: fixed E in dot's natural direction ──
  function esc(x, y, side) {
    if (side === 'right')  return [x + E, y];
    if (side === 'left')   return [x - E, y];
    if (side === 'bottom') return [x, y + E];
    return [x, y];
  }

  let [sx, sy] = esc(x1, y1, fromSide);
  const [ex, ey] = toSide ? esc(x2, y2, toSide) : [x2, y2];

  const srcHorz = (fromSide === 'right' || fromSide === 'left');
  const tgtHorz = !!toSide && (toSide === 'right' || toSide === 'left');
  const perpendicular = !!toSide && (srcHorz !== tgtHorz);

  // ── Route between escape points ──
  let mid;

  if (!toSide) {
    // Free drag: simple L
    mid = srcHorz ? [[sx, ey]] : [[ex, sy]];
  } else if (perpendicular) {
    // L-shape — but check if it would reverse the escape direction.
    // If so, use Z-shape (escape → perpendicular → approach target).
    // Direct reversal: the L-segment after corner goes opposite to escape,
    // AND there's no perpendicular segment separating them (corner axis = 0).
    // With a perpendicular segment between, it's a valid L-shape, not a reversal.
    const wouldReverse = srcHorz
      ? ((fromSide === 'right' && ex < sx) || (fromSide === 'left' && ex > sx)) && Math.abs(ey - sy) < 1
      : (fromSide === 'bottom' && ey < sy) && Math.abs(ex - sx) < 1;

    if (wouldReverse) {
      // Z-shape: go perpendicular first (midpoint between), then toward target
      if (srcHorz) {
        const my = (sy + ey) / 2;
        mid = [[sx, my], [ex, my]];
      } else {
        const mx = (sx + ex) / 2;
        mid = [[mx, sy], [mx, ey]];
      }
    } else {
      // L-shape: extend source escape to merge with L-corner when safe.
      // Cross-axis check: the segments on BOTH sides of the L-corner must
      // go in the same direction on the corner's perpendicular axis.
      // If they go opposite (e.g., left then right), extension would create
      // a visible reversal → keep fixed escape instead.
      if (srcHorz) {
        const crossOK = Math.sign(ey - sy) === Math.sign(y2 - ey) || ey === sy || ey === y2;
        if (crossOK) sx = (fromSide === 'right') ? Math.max(sx, ex) : Math.min(sx, ex);
      } else {
        const crossOK = Math.sign(ex - sx) === Math.sign(x2 - ex) || ex === sx || ex === x2;
        if (crossOK) sy = (fromSide === 'bottom') ? Math.max(sy, ey) : sy;
      }
      mid = srcHorz ? [[sx, ey]] : [[ex, sy]];
    }
  } else {
    // Parallel connections: two sub-cases
    const sameSide = fromSide === toSide; // right→right, left→left, bottom→bottom

    if (sameSide) {
      // Same-side: U-shape. Midpoint BEYOND both escapes in escape direction.
      if (srcHorz) {
        const mx = fromSide === 'right' ? Math.max(sx, ex) + E : Math.min(sx, ex) - E;
        mid = [[mx, sy], [mx, ey]];
      } else {
        const my = Math.max(sy, ey) + E;
        if (Math.abs(sx - ex) < 2 * r) {
          // Dots nearly overlap: C-shape to avoid invisible overlapping arms
          const armX = (sx >= ex) ? sx + E : ex + E;
          mid = [[armX, sy], [armX, ey]];
        } else {
          // Normal U-shape: go below both, connect horizontally
          mid = [[sx, my], [ex, my]];
        }
      }
    } else {
      // Opposite-facing (left→right, right→left): check if escapes face
      // each other (S-shape OK) or face away (need U-shape like same-side).
      // Facing each other: right-escape (sx) is LEFT of left-escape (ex) → sx < ex
      // Facing away: right-escape (sx) is RIGHT of left-escape (ex) → sx > ex
      if (srcHorz) {
        const facingEachOther = (fromSide === 'right' && sx < ex) ||
                                (fromSide === 'left'  && sx > ex);
        if (facingEachOther) {
          const escGap = Math.abs(sx - ex);
          if (Math.abs(sy - ey) < 1) {
            mid = [];
          } else {
            // S-shape: vertical line always centered between escapes.
            // When gap is narrow (< 2*r), skip both escape stubs and
            // route directly from source dot through midpoint to target dot.
            // This avoids micro-segments AND ensures no visual jump when
            // the gap crosses the threshold.
            const mx = (sx + ex) / 2;
            if (escGap < 4 * r) {
              const sPts = srcHorz
                ? [[x1, y1], [mx, sy], [mx, y2], [x2, y2]]
                : [[x1, y1], [sx, mx], [x2, mx], [x2, y2]];
              return ptsToRoundedPath(sPts, r);
            }
            mid = [[mx, sy], [mx, ey]];
          }
        } else {
          // Facing away: Z-shape (per connection-routing.md).
          // When vertical gap is too small, midpoint would collapse
          // onto the escapes → route above or below instead.
          const vertGap = Math.abs(sy - ey);
          const my = (vertGap < 2 * r)
            ? Math.min(sy, ey) - E
            : (sy + ey) / 2;
          mid = [[sx, my], [ex, my]];
        }
      } else {
        const facingEachOther = (fromSide === 'bottom' && sy < ey);
        if (facingEachOther) {
          const my = (sy + ey) / 2;
          mid = (Math.abs(sx - ex) < 1) ? [] : [[sx, my], [ex, my]];
        } else {
          if (srcHorz) {
            // left/right same-side: U goes in escape direction
            const mx = (fromSide === 'right') ? Math.max(sx, ex) + E : Math.min(sx, ex) - E;
            // When vertical gap too small, offset arms horizontally
            if (Math.abs(sy - ey) < 2 * r) {
              const cy = (sy + ey) / 2;
              const arm1 = cy - E, arm2 = cy + E;
              mid = [[mx, arm1], [mx, arm2]];
              // TODO: may need 4-point mid for full rectangle
            } else {
              mid = [[mx, sy], [mx, ey]];
            }
          } else {
            // bottom same-side: U goes below both escapes
            const my = Math.max(sy, ey) + E;
            // When horizontal gap too small, offset arms so U is visible
            if (Math.abs(sx - ex) < 2 * r) {
              const cx = (sx + ex) / 2;
              mid = [[cx - E, sy], [cx - E, my], [cx + E, my], [cx + E, ey]];
            } else {
              mid = [[sx, my], [ex, my]];
            }
          }
        }
      }
    }
  }

  let pts = [[x1, y1], [sx, sy], ...mid, [ex, ey], [x2, y2]];

  return ptsToRoundedPath(pts, r);
}

export function manhattanPath(x1, y1, x2, y2, oriA = 'horizontal', oriB = 'horizontal') {
  const r   = CORNER_RADIUS;
  const dx  = x2 - x1;
  const dy  = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const sx  = dx >= 0 ? 1 : -1;
  const sy  = dy >= 0 ? 1 : -1;

  // Degenerate: essentially straight
  if (adx < 2 || ady < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;

  // Same orientation: use midpoint routing
  if (oriA === oriB) {
    if (oriA === 'vertical') {
      // V→H→V: vertical out, horizontal across, vertical in
      const my = (y1 + y2) / 2;
      const rv = Math.max(0, Math.min(r, ady / 2 - 2));
      const rh = Math.max(0, Math.min(r, adx / 2 - 2));
      if (rv < 1 || rh < 1) {
        return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
      }
      return [
        `M ${x1} ${y1}`,
        `L ${x1} ${my - sy * rv}`,
        `Q ${x1} ${my} ${x1 + sx * rh} ${my}`,
        `L ${x2 - sx * rh} ${my}`,
        `Q ${x2} ${my} ${x2} ${my + sy * rv}`,
        `L ${x2} ${y2}`
      ].join(' ');
    }
    // H→V→H: horizontal out, vertical across, horizontal in
    const mx = (x1 + x2) / 2;
    const rh = Math.max(0, Math.min(r, adx / 2 - 2));
    const rv = Math.max(0, Math.min(r, ady / 2 - 2));
    if (rh < 1 || rv < 1) {
      return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
    }
    return [
      `M ${x1} ${y1}`,
      `L ${mx - sx * rh} ${y1}`,
      `Q ${mx} ${y1} ${mx} ${y1 + sy * rv}`,
      `L ${mx} ${y2 - sy * rv}`,
      `Q ${mx} ${y2} ${mx + sx * rh} ${y2}`,
      `L ${x2} ${y2}`
    ].join(' ');
  }

  // Mixed orientation: L-shape routing (one bend)
  if (oriA === 'horizontal' && oriB === 'vertical') {
    // H out → turn → V into target (bend at x2, y1)
    const rc = Math.max(0, Math.min(r, adx - 2, ady - 2));
    if (rc < 1) {
      return `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`;
    }
    return [
      `M ${x1} ${y1}`,
      `L ${x2 - sx * rc} ${y1}`,
      `Q ${x2} ${y1} ${x2} ${y1 + sy * rc}`,
      `L ${x2} ${y2}`
    ].join(' ');
  }

  // V out → turn → H into target (bend at x1, y2)
  const rc = Math.max(0, Math.min(r, adx - 2, ady - 2));
  if (rc < 1) {
    return `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`;
  }
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${y2 - sy * rc}`,
    `Q ${x1} ${y2} ${x1 + sx * rc} ${y2}`,
    `L ${x2} ${y2}`
  ].join(' ');
}

/**
 * Given two notes and their rendered dimensions, returns which sides of each
 * note face each other — used to route the connection.
 *
 * @param {object} noteA  note object {id, x, y, ...}
 * @param {object} noteB
 * @param {{w:number, h:number}} dimsA  rendered size of noteA
 * @param {{w:number, h:number}} dimsB
 * @returns {{ sideA: string, sideB: string }}  e.g. { sideA: 'right', sideB: 'left' }
 */
export function getBestSides(noteA, noteB, dimsA, dimsB) {
  const wA = dimsA.w,  hA = dimsA.h;
  const wB = dimsB.w,  hB = dimsB.h;
  const cax = noteA.x + wA / 2,  cay = noteA.y + hA / 2;
  const cbx = noteB.x + wB / 2,  cby = noteB.y + hB / 2;
  const dx = cbx - cax,  dy = cby - cay;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sideA: 'right',  sideB: 'left'  }
      : { sideA: 'left',   sideB: 'right' };
  }
  return dy >= 0
    ? { sideA: 'bottom', sideB: 'top'    }
    : { sideA: 'top',    sideB: 'bottom' };
}

// Stacking slots: center=0, then alternating +1,-1,+2,-2,...
// slot 0 → offset 0, slot 1 → +PORT_SPACING, slot 2 → -PORT_SPACING, etc.
export function stackOffset(slotIndex) {
  if (slotIndex === 0) return 0;
  const half = Math.ceil(slotIndex / 2);
  return (slotIndex % 2 === 1 ? 1 : -1) * half * PORT_SPACING;
}

/**
 * Computes stacked port positions for every connection.
 *
 * Algorithm (verbatim from the vanilla canvas):
 *   1. For each connection, call getBestSides() to decide (sideA, sideB).
 *   2. Group connections by (noteId, side) to know how many share each side.
 *   3. For each group, assign index i and offset around the side center via stackOffset.
 *   4. Return a Map keyed by "fromId:toId" → { ax, ay, sideA, bx, by, sideB }.
 *
 * @param {Array<object>} notes
 * @param {Array<{from:string, to:string}>} connections
 * @param {(noteId:string) => ({w:number, h:number, bl:number, bt:number}|null)} getDims
 *   rendered size + border widths (clientLeft/clientTop, vanilla defaults: 1)
 * @returns {Map<string, {ax:number, ay:number, sideA:string, bx:number, by:number, sideB:string}>}
 */
export function computePortPositions(notes, connections, getDims) {
  // Step 1: assign sides to every connection
  const assignments = [];
  for (const conn of connections) {
    const noteA = notes.find(n => n.id === conn.from);
    const noteB = notes.find(n => n.id === conn.to);
    const dimsA = noteA ? getDims(conn.from) : null;
    const dimsB = noteB ? getDims(conn.to) : null;
    if (!noteA || !noteB || !dimsA || !dimsB) continue;
    const { sideA, sideB } = getBestSides(noteA, noteB, dimsA, dimsB);
    assignments.push({ conn, sideA, sideB });
  }

  // Step 2: group by "noteId:side"
  const sideGroups = new Map(); // "noteId:side" → [assignment, ...]
  for (const a of assignments) {
    const kA = a.conn.from + ':' + a.sideA;
    const kB = a.conn.to   + ':' + a.sideB;
    if (!sideGroups.has(kA)) sideGroups.set(kA, []);
    if (!sideGroups.has(kB)) sideGroups.set(kB, []);
    sideGroups.get(kA).push(a);
    sideGroups.get(kB).push(a);
  }

  // Step 3: compute stacked positions per group
  const portMap = new Map(); // "fromId:toId" → { ax, ay, bx, by }
  for (const [sideKey, group] of sideGroups) {
    const colonIdx = sideKey.indexOf(':');
    const noteId   = sideKey.slice(0, colonIdx);
    const side     = sideKey.slice(colonIdx + 1);
    const note     = notes.find(n => n.id === noteId);
    const dims     = note ? getDims(noteId) : null;
    if (!note || !dims) continue;

    const w = dims.w;
    const h = dims.h;

    const bl = dims.bl || 1;
    const bt = dims.bt || 1;
    group.forEach((a, i) => {
      const offset = stackOffset(i);
      let px, py;
      // bl/bt = border widths (left may differ from top due to accent border)
      // dot CSS coords are relative to PADDING edge: X uses +bl, Y uses +bt
      if (side === 'top')    { px = Math.round(note.x + bl + w / 2 + offset); py = Math.round(note.y + bt / 2); }
      if (side === 'bottom') { px = Math.round(note.x + bl + w / 2 + offset); py = Math.round(note.y + bt + h - bl * 1.5); }
      if (side === 'left')   { px = Math.round(note.x + bl / 2);              py = Math.round(note.y + bt + h / 2 + offset); }
      if (side === 'right')  { px = Math.round(note.x + w - bl / 2);          py = Math.round(note.y + bt + h / 2 + offset); }

      const connKey = a.conn.from + ':' + a.conn.to;
      if (!portMap.has(connKey)) portMap.set(connKey, {});
      const entry = portMap.get(connKey);

      // isFrom: is this noteId the FROM end of the connection?
      if (a.conn.from === noteId) {
        entry.ax = px;
        entry.ay = py;
        entry.sideA = side;
      } else {
        entry.bx = px;
        entry.by = py;
        entry.sideB = side;
      }
    });
  }

  return portMap;
}

/**
 * Per-side dot occupancy: Map "noteId:side" → [{color, connId}], ordered —
 * the array index is the stacking slot (verbatim from the vanilla
 * renderConnections step 1). Stored ports win; legacy connections derive
 * their sides from geometry (computePortPositions/getBestSides).
 */
export function buildConnectedPorts(notes, connections, getDims) {
  const portMap = computePortPositions(notes, connections, getDims);
  const connectedPorts = new Map();
  for (const conn of connections) {
    const fromNote = notes.find(n => n.id === conn.from);
    const strokeCol = COLOR_STROKE[fromNote?.color] || 'var(--border-strong)';
    let sideA, sideB;
    if (conn.fromPort && conn.toPort) {
      sideA = conn.fromPort;
      sideB = conn.toPort;
    } else {
      const ports = portMap.get(conn.from + ':' + conn.to);
      if (ports) { sideA = ports.sideA; sideB = ports.sideB; }
    }
    if (sideA) {
      const kA = conn.from + ':' + sideA;
      if (!connectedPorts.has(kA)) connectedPorts.set(kA, []);
      connectedPorts.get(kA).push({ color: strokeCol, connId: conn.from + ':' + conn.to });
    }
    if (sideB) {
      const kB = conn.to + ':' + sideB;
      if (!connectedPorts.has(kB)) connectedPorts.set(kB, []);
      connectedPorts.get(kB).push({ color: strokeCol, connId: conn.from + ':' + conn.to });
    }
  }
  return connectedPorts;
}

/**
 * Note-relative CSS position of a port dot (verbatim formulas from the
 * vanilla renderPorts): dots sit centered on the card border line, offset
 * along the side and clamped 8px inside the card.
 */
export function portDotCss(side, dims, offset) {
  const { w, h } = dims;
  const bl = dims.bl || 1;
  if (side === 'bottom') {
    return {
      left: Math.round(Math.max(8, Math.min(w - 8, w / 2 + offset))),
      top: Math.round(h - bl * 1.5),
    };
  }
  if (side === 'left') {
    return {
      left: Math.round(-bl / 2),
      top: Math.round(Math.max(8, Math.min(h - 8, h / 2 + offset))),
    };
  }
  // right
  return {
    left: Math.round(w - bl * 1.5),
    top: Math.round(Math.max(8, Math.min(h - 8, h / 2 + offset))),
  };
}

/**
 * Canvas-space position of a stacked port dot (verbatim formulas from the
 * vanilla getStackedDotPos). Used to anchor connection paths on the dots.
 */
export function stackedDotCanvas(note, dims, side, offset) {
  const { w, h } = dims;
  const bl = dims.bl || 1;
  const bt = dims.bt || 1;
  let x = note.x, y = note.y;
  if (side === 'bottom') { x += bl + Math.max(8, Math.min(w - 8, w / 2 + offset)); y += bt + h - bl * 1.5; }
  else if (side === 'left')  { x += bl / 2; y += bt + Math.max(8, Math.min(h - 8, h / 2 + offset)); }
  else if (side === 'right') { x += w - bl / 2; y += bt + Math.max(8, Math.min(h - 8, h / 2 + offset)); }
  else { x += bl + w / 2; } // top fallback (legacy)
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Screen → canvas coordinate transform (verbatim math from js/canvas/state.js,
 * with the wrap rect, pan and scale passed in instead of read from the DOM).
 */
export function screenToCanvas(screenX, screenY, wrapRect, pan, scale) {
  return {
    x: (screenX - wrapRect.left - pan.x) / scale,
    y: (screenY - wrapRect.top  - pan.y) / scale
  };
}

// --- Minimap geometry (T-345-3) -------------------------------------------
// Pure, DOM-less helpers for the canvas minimap. The minimap shows the world
// bounding box of all notes (plus the current viewport rectangle) scaled to
// fit a small panel. The same bounding-box convention as fitToNotes is used
// (each note falls back to 160x120 when its rendered size is unknown), so the
// minimap and fit-to-view agree on "the world".

/**
 * World bounding box of the notes, padded like fitToNotes (pad px on every
 * side). getDims(noteId) may return null — falls back to 160x120. Returns
 * null when there are no notes.
 *
 * @returns {{minX:number, minY:number, maxX:number, maxY:number,
 *            width:number, height:number} | null}
 */
export function notesBounds(notes, getDims, pad = 40) {
  if (!notes || notes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const note of notes) {
    const d = getDims ? getDims(note.id) : null;
    const w = d?.w || 160;
    const h = d?.h || 120;
    minX = Math.min(minX, note.x);
    minY = Math.min(minY, note.y);
    maxX = Math.max(maxX, note.x + w);
    maxY = Math.max(maxY, note.y + h);
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * Uniform world→minimap mapping that fits `bounds` into a mapW×mapH panel,
 * centering the (letterboxed) content. Returns the scale factor plus the
 * centering offsets, and a `project(wx, wy)` closure that maps a world point
 * into minimap-panel pixels.
 *
 * @param {{minX,minY,maxX,maxY,width,height}} bounds  from notesBounds()
 * @returns {{ scale:number, offsetX:number, offsetY:number,
 *             project:(wx:number, wy:number)=>{x:number,y:number} }}
 */
export function minimapTransform(bounds, mapW, mapH) {
  const scale = Math.min(mapW / bounds.width, mapH / bounds.height);
  // Center the scaled world within the panel (letterbox the spare axis).
  const offsetX = (mapW - bounds.width * scale) / 2;
  const offsetY = (mapH - bounds.height * scale) / 2;
  const project = (wx, wy) => ({
    x: offsetX + (wx - bounds.minX) * scale,
    y: offsetY + (wy - bounds.minY) * scale,
  });
  return { scale, offsetX, offsetY, project };
}

/**
 * Rectangle (in minimap-panel pixels) for a single note: its world position
 * and size projected through `mm` (a minimapTransform result). getDims may
 * return null → 160x120 fallback (matches notesBounds).
 *
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function noteMiniRect(note, getDims, mm) {
  const d = getDims ? getDims(note.id) : null;
  const w = d?.w || 160;
  const h = d?.h || 120;
  const tl = mm.project(note.x, note.y);
  return { x: tl.x, y: tl.y, w: Math.max(1, w * mm.scale), h: Math.max(1, h * mm.scale) };
}

/**
 * Viewport frame rectangle (in minimap-panel pixels): the slice of the world
 * currently visible in the canvas wrap, given the committed {pan, scale} and
 * the wrap pixel size. The world-visible region is the inverse transform of
 * the wrap's top-left and bottom-right corners; that region is projected
 * through `mm`. Edges are clamped into the panel so the frame stays visible
 * even when the viewport extends past the note bounds.
 *
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function viewportFrameRect(pan, scale, wrapW, wrapH, mm, mapW, mapH, inset = 0) {
  const wx1 = (0 - pan.x) / scale;
  const wy1 = (0 - pan.y) / scale;
  const wx2 = (wrapW - pan.x) / scale;
  const wy2 = (wrapH - pan.y) / scale;
  const a = mm.project(wx1, wy1);
  const b = mm.project(wx2, wy2);
  // Clamp to the panel minus `inset` on every side so the (square) frame
  // never reaches the panel's rounded corners — otherwise the corner-radius
  // clips the frame's corners away (T-345-3 follow-up). With inset >= the
  // corner radius the frame floats fully inside, all four corners visible.
  const left = Math.max(inset, Math.min(a.x, b.x));
  const top = Math.max(inset, Math.min(a.y, b.y));
  const right = Math.min(mapW - inset, Math.max(a.x, b.x));
  const bottom = Math.min(mapH - inset, Math.max(a.y, b.y));
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/**
 * Inverse of minimapTransform: given a click/drag point in minimap-panel
 * pixels, return the world coordinate it corresponds to. Used to recenter the
 * canvas viewport on the clicked world point.
 *
 * @returns {{x:number, y:number}}
 */
export function minimapToWorld(mx, my, bounds, mm) {
  return {
    x: bounds.minX + (mx - mm.offsetX) / mm.scale,
    y: bounds.minY + (my - mm.offsetY) / mm.scale,
  };
}

/**
 * Pan that centers the canvas viewport (wrap pixel size wrapW×wrapH at the
 * given scale) on a world point — the navigation primitive behind a minimap
 * click/drag. Pure; the caller writes the result into viewRef + applyTransform.
 *
 * @returns {{x:number, y:number}}  new pan
 */
export function panToCenterWorld(worldX, worldY, scale, wrapW, wrapH) {
  return {
    x: wrapW / 2 - worldX * scale,
    y: wrapH / 2 - worldY * scale,
  };
}

/**
 * Viewport that centers a single note in the wrap (T-351, search-navigation).
 * Keeps the current zoom but raises it to a readable floor (minScale) when the
 * canvas is zoomed far out, so a jumped-to note is never a tiny speck; never
 * exceeds SCALE_MAX. dims may be null (falls back to the standard 160×120 box).
 * Pure; the caller writes { pan, scale } into viewRef + applyTransform.
 *
 * @returns {{ pan:{x:number,y:number}, scale:number }}
 */
export function centerViewOnNote(note, dims, wrapW, wrapH, currentScale, opts = {}) {
  const minScale = opts.minScale ?? 0.8;
  const w = dims?.w || 160;
  const h = dims?.h || 120;
  const base = Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1;
  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.max(base, minScale)));
  const pan = panToCenterWorld(note.x + w / 2, note.y + h / 2, scale, wrapW, wrapH);
  return { pan, scale };
}
