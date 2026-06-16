import { getAllClusters } from '../../utils/canvasGraph.mjs';
import {
  routePath, stackOffset, stackedDotCanvas, computePortPositions, buildConnectedPorts,
} from '../../utils/canvasGeometry.mjs';
import { COLOR_STROKE } from '../../utils/canvasConstants.mjs';

const FRAME_PAD = 20;

/**
 * ConnectionLayer (T-340-4) — the underlay SVG: dot grid, cluster frames and
 * connection paths. Declarative port of the vanilla renderConnections /
 * renderClusterFrames; all geometry comes from the pure canvasGeometry
 * modules, positions/dims arrive via positionOf/getDims so drag previews
 * (live positions) render without committing state.
 */
export default function ConnectionLayer({
  notes, connections, positionOf, getDims, onSelectConnection, onSelectCluster,
}) {
  // Notes with live (drag) positions applied — geometry runs on these.
  const liveNotes = notes.map(n => {
    const pos = positionOf(n.id);
    return pos ? { ...n, x: pos.x, y: pos.y } : n;
  });
  const byId = new Map(liveNotes.map(n => [n.id, n]));

  const connectedPorts = buildConnectedPorts(liveNotes, connections, getDims);
  const portMap = computePortPositions(liveNotes, connections, getDims);

  // --- Cluster frames (vanilla renderClusterFrames) ---
  const frames = [];
  for (const cluster of getAllClusters(liveNotes, connections)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const colorCounts = {};
    for (const id of cluster) {
      const note = byId.get(id);
      const dims = note ? getDims(id) : null;
      if (!note || !dims) continue;
      minX = Math.min(minX, note.x);
      minY = Math.min(minY, note.y);
      maxX = Math.max(maxX, note.x + dims.w);
      maxY = Math.max(maxY, note.y + dims.h);
      const c = note.color || 'grey';
      colorCounts[c] = (colorCounts[c] || 0) + 1;
    }
    if (!isFinite(minX)) continue;
    const dominant = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0][0];
    const stroke = COLOR_STROKE[dominant] || 'var(--border-strong)';
    const ids = [...cluster];
    frames.push(
      <rect
        key={`frame-${ids.join('-')}`}
        x={minX - FRAME_PAD}
        y={minY - FRAME_PAD}
        width={maxX - minX + FRAME_PAD * 2}
        height={maxY - minY + FRAME_PAD * 2}
        rx="12"
        className="cluster-frame"
        style={{ stroke, fill: stroke, pointerEvents: 'all' }}
        onMouseDown={(e) => { e.stopPropagation(); onSelectCluster(ids); }}
        onTouchStart={(e) => { e.stopPropagation(); e.preventDefault(); onSelectCluster(ids); }}
      />
    );
  }

  // --- Connection paths (vanilla renderConnections step 2) ---
  const stackedDot = (noteId, side, connId) => {
    const note = byId.get(noteId);
    const dims = note ? getDims(noteId) : null;
    if (!note || !dims) return null;
    const conns = connectedPorts.get(noteId + ':' + side) || [];
    const idx = conns.findIndex(c => c.connId === connId);
    const offset = idx === -1 ? 0 : stackOffset(idx);
    return stackedDotCanvas(note, dims, side, offset);
  };

  const paths = [];
  for (const conn of connections) {
    let ax, ay, bx, by, sideA, sideB;
    const connKey = conn.from + ':' + conn.to;

    if (conn.fromPort && conn.toPort) {
      sideA = conn.fromPort; sideB = conn.toPort;
      const ptA = stackedDot(conn.from, sideA, connKey);
      const ptB = stackedDot(conn.to, sideB, connKey);
      if (!ptA || !ptB) continue;
      ax = ptA.x; ay = ptA.y; bx = ptB.x; by = ptB.y;
    } else {
      const ports = portMap.get(connKey);
      if (!ports || ports.ax == null || ports.bx == null) continue;
      ax = ports.ax; ay = ports.ay; sideA = ports.sideA;
      bx = ports.bx; by = ports.by; sideB = ports.sideB;
    }

    const fromNote = byId.get(conn.from);
    const strokeCol = COLOR_STROKE[fromNote?.color] || 'var(--border-strong)';
    let tgtHW = 0;
    if (sideB === 'bottom') {
      const tDims = getDims(conn.to);
      if (tDims) tgtHW = tDims.w / 2;
    }
    const d = routePath(ax, ay, bx, by, sideA, sideB, tgtHW);

    const select = (e) => {
      e.stopPropagation();
      onSelectConnection(conn.from, conn.to, e.currentTarget.previousSibling);
    };
    paths.push(
      <g key={connKey} className="conn-line-group">
        <path d={d} className="conn-path" style={{ stroke: strokeCol }} data-from={conn.from} data-to={conn.to} />
        <path
          d={d}
          className="conn-path-hit"
          onClick={select}
          onTouchEnd={(e) => { e.preventDefault(); select(e); }}
        />
      </g>
    );
  }

  return (
    <svg className="canvas-svg canvas-svg-underlay" style={{ pointerEvents: 'none' }}>
      <defs>
        <pattern id="cvDotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="12" cy="12" r="1" fill="#3a3a45" />
        </pattern>
      </defs>
      <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#cvDotPattern)" />
      {frames}
      {paths}
    </svg>
  );
}
