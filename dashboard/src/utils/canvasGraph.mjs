// Cluster derivation — extracted 1:1 from js/canvas/connections.js (T-340-1).
// Clusters are never stored; they are connected components of the
// connection graph (ADR-0014). Module state replaced by parameters.

/** BFS over the undirected connection graph starting at startId. */
export function getConnectedComponent(connections, startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const conn of connections) {
      if (conn.from === id && !visited.has(conn.to))   queue.push(conn.to);
      if (conn.to   === id && !visited.has(conn.from)) queue.push(conn.from);
    }
  }
  return visited;
}

/** Returns array of Sets, one per connected component with ≥2 notes. */
export function getAllClusters(notes, connections) {
  const seen = new Set();
  const clusters = [];
  for (const note of notes) {
    if (seen.has(note.id)) continue;
    const component = getConnectedComponent(connections, note.id);
    for (const id of component) seen.add(id);
    if (component.size >= 2) clusters.push(component);
  }
  return clusters;
}
