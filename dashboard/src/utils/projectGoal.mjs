// T-382 — extract the project goal from PROJECT.md for the Project Goal widget.
//
// Pulls the body of the `## Ziel` / `## Goal` section (up to the next `## `
// heading or end of file); if there is no such section, falls back to the intro
// text before the first `## ` heading. Pure + unit-tested.
//
// NB: does NOT use `\Z` — JavaScript has no end-of-string `\Z` anchor and reads
// it as a literal "Z", which previously truncated goals at their first "Z"
// (e.g. depot's "Zentrale …" rendered empty → false "No PROJECT.md").

const STRIP = /[#>*_`[\]]/g;

export function extractGoal(md) {
  const text = String(md ?? '');
  if (!text.trim()) return '';

  let body;
  const head = text.match(/^##[ \t]+(?:Ziel|Goal)[ \t]*$/m);
  if (head) {
    const rest = text.slice(head.index + head[0].length);
    const nextIdx = rest.search(/^##[ \t]/m);
    body = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  } else {
    // intro: everything before the first `## ` heading, minus the `# Title` line
    body = text.split(/^##\s/m)[0].split('\n').slice(1).join(' ');
  }

  return body.replace(STRIP, '').trim().slice(0, 280);
}
