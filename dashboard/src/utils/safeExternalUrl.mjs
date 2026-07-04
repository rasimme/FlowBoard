export function safeExternalHttpUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    return scheme === 'http' || scheme === 'https' ? trimmed : '';
  }

  return `https://${trimmed}`;
}
