/**
 * Order context/ files for the Context Index widget (T-392): pinned files first,
 * then most-recently-edited (modifiedMs desc), then name ascending. Recency
 * surfaces "what changed lately" the way ChatGPT/Claude project folders show
 * recently used files; pins still take precedence.
 *
 * @param {Array<{name:string, modifiedMs?:number}>} files
 * @param {string[]} pins  pinned file names
 */
export function sortContextFiles(files, pins = []) {
  const pinned = new Set(pins);
  return [...(files || [])].sort((a, b) => {
    const ap = pinned.has(a.name) ? 0 : 1;
    const bp = pinned.has(b.name) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const am = Number.isFinite(a.modifiedMs) ? a.modifiedMs : 0;
    const bm = Number.isFinite(b.modifiedMs) ? b.modifiedMs : 0;
    if (am !== bm) return bm - am; // most recent first
    return a.name.localeCompare(b.name);
  });
}
