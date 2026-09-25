/**
 * In-column reordering as `order` ranks (T-499).
 *
 * The board sorts a column by `order` ascending, unranked cards last, ties by
 * a natural id compare (board.js `compareTasks`). Moving a card up, down or to
 * the top is therefore a question of which `order` values to write, and the
 * answer should touch as few tasks as possible — every write is a request, a
 * `tasks-changed` event, and a chance to collide with an agent's own write.
 *
 *  1. **Midpoint first.** When both neighbours at the new position are ranked
 *     and there is room between them, only the moved card is written, at the
 *     midpoint. At the top or bottom edge it goes one STEP beyond the ranked
 *     neighbour.
 *  2. **Sparse re-rank otherwise.** When a neighbour is unranked, or repeated
 *     midpoints have used up the gap, the column is re-ranked at STEP spacing
 *     from the top down to the moved card (or to the last ranked card, if that
 *     is further down). An unranked tail stays unranked: it already sorts
 *     last and by id, so writing it would change nothing on screen.
 *  3. **Only changed values are sent.** A card that already carries the rank
 *     it would be given is left alone.
 *
 * The result is a list of `{ id, order }`; the page turns each into one
 * `task.update { project, id, order }` and sends them one after another.
 * The column comes in board order (board.js `columnOf`).
 */

export const ORDER_STEP = 1000;
/** Below this gap a midpoint is no longer trustworthy in a double; re-rank. */
export const MIN_ORDER_GAP = 1e-6;

export const ORDER_MOVES = ['top', 'up', 'down'];

function rankOf(task) {
  return Number.isFinite(task?.order) ? task.order : null;
}

/** Which of top/up/down make sense for this position; empty when alone. */
export function orderMoves(column, id) {
  const index = Array.isArray(column) ? column.findIndex((row) => row.id === id) : -1;
  if (index < 0 || column.length < 2) return [];
  const moves = [];
  if (index > 0) moves.push('top', 'up');
  if (index < column.length - 1) moves.push('down');
  // "Top" from second place is just "up"; offering both is noise.
  return index === 1 ? moves.filter((move) => move !== 'top') : moves;
}

/**
 * The updates that move `id` in `column` (already in board order). Returns
 * `[]` when the move is impossible or changes nothing.
 */
export function orderUpdates(column, id, move) {
  if (!Array.isArray(column) || !ORDER_MOVES.includes(move)) return [];
  const index = column.findIndex((row) => row?.id === id);
  if (index < 0) return [];
  const moving = column[index];
  const rest = column.filter((_, at) => at !== index);
  let position;
  if (move === 'top') position = 0;
  else if (move === 'up') position = index - 1;
  else position = index + 1;
  if (position < 0 || position > rest.length || position === index) return [];

  const before = position > 0 ? rest[position - 1] : null;
  const after = position < rest.length ? rest[position] : null;
  const low = before ? rankOf(before) : null;
  const high = after ? rankOf(after) : null;

  // Rule 1: a single write.
  if (before && after && low !== null && high !== null && high - low > MIN_ORDER_GAP) {
    return [{ id: moving.id, order: low + (high - low) / 2 }];
  }
  if (!before && after && high !== null) return [{ id: moving.id, order: high - ORDER_STEP }];
  if (before && !after && low !== null) return [{ id: moving.id, order: low + ORDER_STEP }];

  // Rule 2: re-rank the head of the final arrangement.
  const arranged = [...rest.slice(0, position), moving, ...rest.slice(position)];
  let last = position;
  arranged.forEach((row, at) => {
    if (row !== moving && rankOf(row) !== null) last = Math.max(last, at);
  });
  const updates = [];
  for (let at = 0; at <= last; at += 1) {
    const order = (at + 1) * ORDER_STEP;
    if (rankOf(arranged[at]) !== order) updates.push({ id: arranged[at].id, order });
  }
  return updates;
}
