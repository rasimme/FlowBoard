# Connection Routing Algorithm

Orthogonal routing for connections between sticky notes on the Idea Canvas.

## Constants

| Name | Value | Purpose |
|------|-------|---------|
| `MIN_ESCAPE` | 28px | Minimum clearance from card edge |
| `CORNER_RADIUS` | 12px | Bézier rounding at each bend |

## Core Rules

### Rule 1: Escape
Every dot has a **fixed escape stub** of `E = 28px` in its natural direction:
- **Right dot** → line goes right 28px before turning
- **Left dot** → line goes left 28px before turning
- **Bottom dot** → line goes down 28px before turning

This ensures lines never exit/enter directly at the card edge.

### Rule 2: Simplest Path
Between escape points, choose the path with **fewest bends**.

### Rule 3: No Reversals
A line must never go back the way it came. Specifically:
- No **direct** U-turns (right then immediately left on consecutive segments)
- Small entry stubs (28px) at the target dot are acceptable (inherent in the escape rule)

## Route Classification

The algorithm classifies connections by the relationship between source and target escape directions:

```
Source (horizontal)          Source (vertical)
┌──────────────────┐        ┌──────────────────┐
│  right → bottom  │ PERP   │  bottom → right  │ PERP
│  right → left    │ OPP    │  bottom → left   │ PERP
│  right → right   │ SAME   │  bottom → bottom │ SAME
│  left  → bottom  │ PERP   │                  │
│  left  → right   │ OPP    │                  │
│  left  → left    │ SAME   │                  │
└──────────────────┘        └──────────────────┘
```

### Perpendicular (L-Shape)
Source horizontal ↔ target vertical (or vice versa). **1 bend** optimal.

```
  Source (right)
  ──●━━━━━━━━━━━━━┓
                  ┃
                  ┃
                  ┃
                  ●── Target (bottom)
```

**Extension optimization**: When the L-corner's perpendicular segments both go
in the same direction (cross-axis check), the source escape extends to merge
with the L-corner → reduces from 3 bends to 1 bend.

**Cross-axis check**: Compare `sign(segment before corner)` with
`sign(segment after corner)` on the corner's perpendicular axis.
- Same sign → extension safe, 1-bend L
- Opposite sign → no extension, 3-bend L (escape + corner + entry)

**Direct reversal fallback**: If the L-segment after the corner would reverse
the escape direction AND there's no perpendicular segment separating them
(both escape points on same coordinate), use Z-shape instead.

### Parallel — Same Side (U-Shape)
Both dots on the same side (right→right, left→left). **4 bends**.

```
  Source (right)
  ──●━━━━━━━┓
            ┃
            ┃
  ──●━━━━━━━┛
  Target (right)
```

Midpoint placed **beyond both escapes** in the shared escape direction:
`mx = max(sx, ex) + E` for right-side connections.

### Parallel — Opposite Facing
Source and target face each other (right→left, left→right).

**Facing each other** (escapes point toward each other): **S-shape, 2 bends**.
Midpoint at `(sx + ex) / 2` — always between the two escape points.

```
  Source (right)         Target (left)
  ──●━━━━━┓          ┏━━━━━●──
          ┃          ┃
          ┗━━━━━━━━━━┛
```

**Facing away** (escapes point away from each other): **Z-shape, 4 bends**.
Midpoint at `(sy + ey) / 2` on the perpendicular axis.

```
            ┏━━━━━━━━━━━━━┓
            ┃             ┃
  ──●━━━━━━━┛             ┗━━━━━●──
  Source (right)          Target (left)
```

## Path Generation Pipeline

1. Compute escape points `(sx, sy)` and `(ex, ey)`
2. Classify connection (perpendicular / same-side / opposite)
3. Apply extension optimization (perpendicular only, with cross-axis check)
4. Generate waypoints: `[dot, escape, ...mid, escape, dot]`
5. Remove consecutive duplicate points
6. Render via `ptsToRoundedPath()` → SVG path with quadratic Bézier corners

## `ptsToRoundedPath(pts, r)`

Converts waypoints to an SVG path string with rounded corners:
- Each corner gets a quadratic Bézier curve (`Q` command)
- Corner radius is `min(r, segment1/2, segment2/2)` — adapts to short segments
- Consecutive duplicate points are filtered out

## File References

- **Implementation**: `dashboard/js/idea-canvas.js` → `routePath()`, `ptsToRoundedPath()`
- **Constants**: `MIN_ESCAPE = 28`, `CORNER_RADIUS = 12`
- **Rendering**: `renderConnections()` calls `routePath()` for each connection
- **Preview**: Drag handler calls `routePath()` for live preview during connection creation
