// canvas/connections.js — Connection routing, SVG rendering, ports, drag, save/delete

import { api, toast } from '../utils.js?v=4';
import {
  canvasState, getNoteDotPosition, COLOR_STROKE,
  CORNER_RADIUS, PORT_SPACING, MIN_ESCAPE, MAX_PORTS_PER_SIDE
} from './state.js?v=1';
import { renderPromoteButton, updateToolbar } from './toolbar.js?v=9';
import { renderClusterFrames } from './clusters.js?v=1';

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

  // ── Perpendicular optimization: extend escape toward L-corner ──
  // Only extend when the L-corner horizontal/vertical segment would be
  // long enough (> E) to avoid creating a reversal at the target entry.
  if (perpendicular && srcHorz) {
    // L-corner at (sx, ey). After corner, horizontal goes sx→ex.
    // Only extend if target is far enough in escape direction.
  }
  if (perpendicular && !srcHorz) {
    // L-corner at (ex, sy). After corner, vertical goes sy→ey.
  }

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
 * Given two notes (with their DOM element dimensions), returns which sides
 * of each note face each other — used to route the connection.
 *
 * @param {object} noteA  note object {id, x, y, color, ...}
 * @param {object} noteB
 * @param {HTMLElement} elA  DOM element for noteA
 * @param {HTMLElement} elB  DOM element for noteB
 * @returns {{ sideA: string, sideB: string }}  e.g. { sideA: 'right', sideB: 'left' }
 */
export function getBestSides(noteA, noteB, elA, elB) {
  const wA = elA.offsetWidth,  hA = elA.offsetHeight;
  const wB = elB.offsetWidth,  hB = elB.offsetHeight;
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

/**
 * Computes stacked port positions for every connection in canvasState.connections.
 *
 * Algorithm:
 *   1. For each connection, call getBestSides() to decide (sideA, sideB).
 *   2. Group connections by (noteId, side) to know how many share each side.
 *   3. For each group, assign index i and offset around the side center:
 *        offset = (i - (n-1)/2) * PORT_SPACING
 *   4. Return a Map keyed by "fromId:toId" → { ax, ay, bx, by }.
 *
 * @returns {Map<string, {ax:number, ay:number, bx:number, by:number}>}
 */
export function computePortPositions() {
  // Step 1: assign sides to every connection
  const assignments = [];
  for (const conn of canvasState.connections) {
    const noteA = canvasState.notes.find(n => n.id === conn.from);
    const noteB = canvasState.notes.find(n => n.id === conn.to);
    const elA   = document.getElementById('note-' + conn.from);
    const elB   = document.getElementById('note-' + conn.to);
    if (!noteA || !noteB || !elA || !elB) continue;
    const { sideA, sideB } = getBestSides(noteA, noteB, elA, elB);
    assignments.push({ conn, noteA, noteB, elA, elB, sideA, sideB });
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
    const note     = canvasState.notes.find(n => n.id === noteId);
    const noteEl   = document.getElementById('note-' + noteId);
    if (!note || !noteEl) continue;

    const w = noteEl.offsetWidth;
    const h = noteEl.offsetHeight;
    const n = group.length;

    const bl = noteEl.clientLeft || 1;
    const bt = noteEl.clientTop || 1;
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

// --- Render connections (underlay SVG) ---
export function renderConnections() {
  const svg = document.getElementById('canvasSvg');
  if (!svg) return;

  // Remove all existing connection groups
  svg.querySelectorAll('.conn-line-group').forEach(g => g.remove());

  // Render cluster frames (before connection lines so frames are behind)
  renderClusterFrames();

  // Clear old connected-port markers
  document.querySelectorAll('.conn-dot-connected').forEach(d => d.classList.remove('conn-dot-connected'));

  const portMap = computePortPositions();

  // --- Step 1: Build connectedPorts map with stacking indices ---
  // Map: "noteId:side" → [{color, connId}]
  // Order matters: index in array = stacking slot index used by renderPorts
  const connectedPorts = new Map();
  for (const conn of canvasState.connections) {
    const fromNote = canvasState.notes.find(n => n.id === conn.from);
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

  // Helper: compute stacked dot position for a specific connection on a note/side
  // Uses same stackOffset formula as renderPorts so lines land exactly on dots
  function getStackedDotPos(noteId, side, connId) {
    const el = document.getElementById('note-' + noteId);
    const note = canvasState.notes.find(n => n.id === noteId);
    if (!el || !note) return null;
    const w = el.offsetWidth, h = el.offsetHeight;
    const key = noteId + ':' + side;
    const conns = connectedPorts.get(key) || [];
    const idx = conns.findIndex(c => c.connId === connId);
    if (idx === -1) return getNoteDotPosition(noteId, side);
    const offset = stackOffset(idx);
    const bl = el.clientLeft || 1;
    const bt = el.clientTop || 1;
    // Canvas coords: X = note.x + clientLeft + CSS_left, Y = note.y + clientTop + CSS_top
    let x = note.x, y = note.y;
    if (side === 'bottom') { x += bl + Math.max(8, Math.min(w - 8, w / 2 + offset)); y += bt + h - bl * 1.5; }
    else if (side === 'left')  { x += bl / 2; y += bt + Math.max(8, Math.min(h - 8, h / 2 + offset)); }
    else if (side === 'right') { x += w - bl / 2; y += bt + Math.max(8, Math.min(h - 8, h / 2 + offset)); }
    else { x += bl + w / 2; } // top fallback (legacy)
    return { x: Math.round(x), y: Math.round(y) };
  }

  // --- Step 2: Draw SVG lines using stacking-aware positions ---
  for (const conn of canvasState.connections) {
    let ax, ay, bx, by, sideA, sideB;

    if (conn.fromPort && conn.toPort) {
      sideA = conn.fromPort; sideB = conn.toPort;
      const connKey = conn.from + ':' + conn.to;
      const ptA = getStackedDotPos(conn.from, sideA, connKey);
      const ptB = getStackedDotPos(conn.to,   sideB, connKey);
      if (!ptA || !ptB) continue;
      ax = ptA.x; ay = ptA.y;
      bx = ptB.x; by = ptB.y;
    } else {
      // Legacy connections without stored ports — fallback to dynamic routing
      const ports = portMap.get(conn.from + ':' + conn.to);
      if (!ports || ports.ax == null || ports.bx == null) continue;
      ax = ports.ax; ay = ports.ay; sideA = ports.sideA;
      bx = ports.bx; by = ports.by; sideB = ports.sideB;
    }

    const fromNote  = canvasState.notes.find(n => n.id === conn.from);
    const strokeCol = COLOR_STROKE[fromNote?.color] || 'var(--border-strong)';
    // For bottom-dot targets, pass target card half-width so routing clears the card
    let tgtHW = 0;
    if (sideB === 'bottom') {
      const tNoteEl = document.getElementById('note-' + conn.to);
      if (tNoteEl) tgtHW = tNoteEl.offsetWidth / 2;
    }
    const pathD = routePath(ax, ay, bx, by, sideA, sideB, tgtHW);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'conn-line-group');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('class', 'conn-path');
    path.style.stroke = strokeCol;
    path.setAttribute('data-from', conn.from);
    path.setAttribute('data-to',   conn.to);

    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.setAttribute('d', pathD);
    hitPath.setAttribute('class', 'conn-path-hit');
    hitPath.addEventListener('click', e => {
      e.stopPropagation();
      showConnectionDeleteBtn(conn.from, conn.to, path);
    });
    hitPath.addEventListener('touchend', e => {
      e.stopPropagation();
      e.preventDefault();
      showConnectionDeleteBtn(conn.from, conn.to, path);
    });

    g.appendChild(path);
    g.appendChild(hitPath);
    svg.appendChild(g);
  }

  renderPorts(connectedPorts);
}

// --- Dynamic port rendering ---
// Stacking slots: center=0, then alternating +1,-1,+2,-2,...
// slot 0 → offset 0, slot 1 → +PORT_SPACING, slot 2 → -PORT_SPACING, etc.
export function stackOffset(slotIndex) {
  if (slotIndex === 0) return 0;
  const half = Math.ceil(slotIndex / 2);
  return (slotIndex % 2 === 1 ? 1 : -1) * half * PORT_SPACING;
}

export function renderPorts(connectedPorts) {
  document.querySelectorAll('.conn-dot[data-dynamic]').forEach(d => d.remove());

  // Only 3 sides — top removed (header area, easy to accidentally drag from)
  const sides = ['right', 'bottom', 'left'];

  for (const note of canvasState.notes) {
    const el = document.getElementById('note-' + note.id);
    if (!el) continue;
    const w = el.offsetWidth, h = el.offsetHeight;
    const noteColor = note.color || 'grey';
    const cardStroke = COLOR_STROKE[noteColor] || 'var(--border-strong)';

    for (const side of sides) {
      const key = note.id + ':' + side;
      const conns = connectedPorts.get(key) || [];
      const connCount = conns.length;
      // Render connected dots + 1 free dot (up to MAX_PORTS_PER_SIDE)
      const total = connCount < MAX_PORTS_PER_SIDE ? connCount + 1 : connCount;

      for (let i = 0; i < total; i++) {
        const offset = stackOffset(i);

        // Compute position centered on card BORDER LINE (not outer edge)
        // el.clientLeft = borderWidth (typically 1px); border center = offsetWidth - 1.5
        const bl = el.clientLeft || 1;
        let left, top;
        if (side === 'bottom') {
          left = Math.round(Math.max(8, Math.min(w - 8, w / 2 + offset)));
          top  = Math.round(h - bl * 1.5);
        } else if (side === 'left') {
          left = Math.round(-bl / 2);
          top  = Math.round(Math.max(8, Math.min(h - 8, h / 2 + offset)));
        } else { // right
          left = Math.round(w - bl * 1.5);
          top  = Math.round(Math.max(8, Math.min(h - 8, h / 2 + offset)));
        }

        const dot = document.createElement('div');
        dot.dataset.dynamic = '1';
        // Store note-relative coords for accurate connection preview
        dot.dataset.dotLeft = String(left);
        dot.dataset.dotTop  = String(top);

        if (i < connCount) {
          // Connected dot: filled, always visible, line color
          dot.className = `conn-dot conn-dot-connected conn-dot-${side}`;
          dot.style.cssText = `left:${left}px;top:${top}px;background:${conns[i].color};`;
        } else {
          // Free dot: ring style (visible on hover), draggable
          dot.className = `conn-dot conn-dot-free conn-dot-${side}`;
          dot.style.cssText = `left:${left}px;top:${top}px;`;
          dot.addEventListener('mousedown', e => startConnectionDrag(e, note.id, side));
          dot.addEventListener('touchstart', e => startConnectionDragTouch(e, note.id, side), { passive: false });
        }

        el.appendChild(dot);
      }
    }
  }
}

// --- Connection drag ---
export function startConnectionDragTouch(e, noteId, port) {
  e.stopPropagation();
  e.preventDefault();
  // Synthesize a mouse-like event for the shared drag logic
  // Include target so startConnectionDrag can read dot data attributes
  const touch = e.touches[0];
  const synth = { clientX: touch.clientX, clientY: touch.clientY,
                  target: e.target,
                  stopPropagation: () => {}, preventDefault: () => {} };
  startConnectionDrag(synth, noteId, port);
}

export function startConnectionDrag(e, noteId, port) {
  e.stopPropagation();
  e.preventDefault();
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  // Use actual rendered dot position if available (data-dot-left/top),
  // otherwise fall back to center of side
  let pt;
  const dotEl = e.target?.closest?.('.conn-dot') || e.target;
  if (dotEl?.dataset?.dotLeft !== undefined) {
    const _nEl = document.getElementById('note-' + noteId);
    const bl = _nEl?.clientLeft || 1;
    const bt = _nEl?.clientTop || 1;
    const dLeft = parseFloat(dotEl.dataset.dotLeft);
    const dTop  = parseFloat(dotEl.dataset.dotTop);
    pt = { x: note.x + bl + dLeft, y: note.y + bt + dTop };
    dotEl.classList.add('conn-dot-active');
  } else {
    pt = getNoteDotPosition(noteId, port);
  }
  if (!pt) return;
  // Lift source note above overlay SVG (z:2) so dots stay visible during drag
  const _srcNoteEl = document.getElementById('note-' + noteId);
  if (_srcNoteEl) _srcNoteEl.style.zIndex = '3';

  // Hide promote buttons during connection drag
  document.querySelectorAll('.canvas-promote-btn, .cluster-promote-btn').forEach(b => b.style.display = 'none');

  canvasState.connecting = { fromId: noteId, fromPort: port, fromPt: { x: pt.x, y: pt.y }, _noteEl: _srcNoteEl };
  // Store active dot ref after object creation
  const _dotEl = (e.target?.closest?.('.conn-dot') || e.target);
  if (_dotEl?.classList?.contains('conn-dot-active')) {
    canvasState.connecting._activeDotEl = _dotEl;
  }
  updateToolbar(); // hide toolbar during connection drag

  // Draw preview path in overlay SVG (above cards)
  const overlay = document.getElementById('canvasSvgOverlay');
  if (overlay) {
    const prev = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    prev.id = 'conn-preview';
    prev.setAttribute('class', 'conn-preview-path');
    prev.setAttribute('d', `M ${pt.x} ${pt.y}`);
    // Color preview line to match source card
    prev.style.stroke = COLOR_STROKE[note?.color] || 'var(--muted)';
    overlay.appendChild(prev);
  }

  // Show all target ports at normal size (no green highlight)
  document.querySelectorAll('.note').forEach(el => {
    if (el.id === 'note-' + noteId) return;
    el.querySelectorAll('.conn-dot').forEach(d => {
      d.classList.add('conn-dot-target-active');
    });
  });
}

export function removeTempConnectionLine() {
  const line = document.getElementById('conn-temp');
  if (line) line.remove();
  const prev = document.getElementById('conn-preview');
  if (prev) prev.remove();
  // Remove target port markers
  document.querySelectorAll('.conn-dot-target-active')
    .forEach(d => d.classList.remove('conn-dot-target-active'));
  document.querySelectorAll('.conn-dot-snap')
    .forEach(d => d.classList.remove('conn-dot-snap'));
}

export async function saveConnection(fromId, toId, fromPort, toPort) {
  if (!window.appState?.viewedProject) return;
  try {
    const res = await api(`/projects/${window.appState.viewedProject}/canvas/connections`, {
      method: 'POST', body: { from: fromId, to: toId, fromPort: fromPort || null, toPort: toPort || null }
    });
    if (res.ok && res.updated) {
      // Existing connection was updated with new ports
      const existing = canvasState.connections.find(
        c => (c.from === fromId && c.to === toId) || (c.from === toId && c.to === fromId)
      );
      if (existing) {
        if (existing.from === fromId) {
          existing.fromPort = fromPort || null;
          existing.toPort = toPort || null;
        } else {
          existing.fromPort = toPort || null;
          existing.toPort = fromPort || null;
        }
      }
      renderConnections();
    } else if (res.ok && !res.duplicate) {
      canvasState.connections.push({ from: fromId, to: toId, fromPort: fromPort || null, toPort: toPort || null });

      renderConnections();
      renderPromoteButton();
    }
  } catch {
    toast('Failed to save connection', 'error');
  }
}

// --- Delete connection ---
export function showConnectionDeleteBtn(from, to, svgPath) {
  document.querySelectorAll('.conn-delete-overlay').forEach(el => el.remove());

  // Find the actual SVG path element to get the true visual midpoint
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;

  // Use SVG path midpoint for accurate button placement
  let midX, midY;
  if (svgPath && svgPath.getTotalLength) {
    const mid = svgPath.getPointAtLength(svgPath.getTotalLength() / 2);
    midX = mid.x; midY = mid.y;
  } else {
    // Fallback: find path by from/to attributes
    const pathEl = vp.querySelector(`[data-from="${from}"][data-to="${to}"]`);
    if (pathEl && pathEl.getTotalLength) {
      const mid = pathEl.getPointAtLength(pathEl.getTotalLength() / 2);
      midX = mid.x; midY = mid.y;
    } else return;
  }

  // Track selected connection for keyboard delete
  canvasState.selectedConn = { from, to };

  // Place button inside canvasViewport — it inherits the pan/zoom transform automatically.
  // Counteract scale so the button stays the same visual size.
  const btn = document.createElement('button');
  btn.className = 'btn btn-danger btn-sm conn-delete-overlay';
  btn.title = 'Delete connection';
  btn.style.cssText = `position:absolute;left:${midX}px;top:${midY}px;transform:translate(-50%,-50%);z-index:40;padding:5px 7px;line-height:0;`;
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>';
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: false });
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    btn.remove();
    canvasState.selectedConn = null;
    await deleteConnection(from, to);
  });
  vp.appendChild(btn);

  setTimeout(() => {
    const close = ev => {
      if (!btn.contains(ev.target)) {
        btn.remove();
        canvasState.selectedConn = null;
        document.removeEventListener('click', close);
        document.removeEventListener('touchstart', close);
      }
    };
    document.addEventListener('click', close);
    document.addEventListener('touchstart', close);
  }, 0);
}

export async function deleteConnection(from, to) {
  if (!window.appState?.viewedProject) return;
  try {
    await api(`/projects/${window.appState.viewedProject}/canvas/connections`, {
      method: 'DELETE', body: { from, to }
    });
    canvasState.connections = canvasState.connections.filter(
      c => !((c.from === from && c.to === to) || (c.from === to && c.to === from))
    );
    renderConnections();
    renderPromoteButton();
  } catch { toast('Failed to delete connection', 'error'); }
}

// --- Cluster detection ---
export function getConnectedComponent(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const conn of canvasState.connections) {
      if (conn.from === id && !visited.has(conn.to))   queue.push(conn.to);
      if (conn.to   === id && !visited.has(conn.from)) queue.push(conn.from);
    }
  }
  return visited;
}

export function getAllClusters() {
  // Returns array of Sets, one per connected component with ≥2 notes
  const seen = new Set();
  const clusters = [];
  for (const note of canvasState.notes) {
    if (seen.has(note.id)) continue;
    const component = getConnectedComponent(note.id);
    for (const id of component) seen.add(id);
    if (component.size >= 2) clusters.push(component);
  }
  return clusters;
}
