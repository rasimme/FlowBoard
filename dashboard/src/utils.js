/**
 * Format a project slug as a display name.
 * Uses displayName from project data if available, otherwise title-cases the slug.
 */
export function formatDisplayName(name, projects) {
  const proj = projects?.find(p => p.name === name);
  if (proj?.displayName) return proj.displayName;
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
