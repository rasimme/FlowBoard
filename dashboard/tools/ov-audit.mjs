// T-325 — responsiveness audit: render every widget type at a given size,
// measure overflow (content escaping the card or its scroll areas), and
// emit a findings table. Usage: node tools/ov-audit.mjs <w> <h> [label]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const W = Number(process.argv[2] || 4);
const H = Number(process.argv[3] || 2);
const LABEL = process.argv[4] || `${W}x${H}`;
const API = 'http://localhost:18790/api';

const manifest = await fetch(`${API}/overview/widgets`).then(r => r.json());
const types = manifest.widgets.map(w => w.type);

// build a stacked layout: every type at the requested size (clamped to its
// minSize), three per row where they fit
const widgets = [];
let x = 0, y = 0, rowH = 0;
for (const t of types) {
  const def = manifest.widgets.find(m => m.type === t);
  const w = Math.max(W, def.minSize?.w || 1);
  const h = Math.max(H, def.minSize?.h || 1);
  if (x + w > 12) { x = 0; y += rowH; rowH = 0; }
  widgets.push({
    id: `w-${t}`, type: t,
    props: {
      ...(t.startsWith('gh-') || t === 'repo-status' ? { repo: 'rasimme/FlowBoard' } : {}),
      ...(t === 'gh-ci' ? { branch: 'dev' } : {}),
      ...(t === 'file-viewer' ? { path: 'PROJECT.md' } : {}),
      ...(t === 'links' ? { links: [{ label: 'Repo', url: 'https://github.com/example/repo' }, { label: 'Docs', url: 'https://example.com/docs' }] } : {}),
    },
    grid: { x, y, w, h },
  });
  x += w; rowH = Math.max(rowH, h);
}
const res = await fetch(`${API}/projects/flowboard/overview`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: 1, layout: 'grid', widgets }),
});
if (!res.ok) { console.error('PUT failed', await res.text()); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  headless: 'new', args: ['--no-first-run', '--window-size=1600,1100'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100 });
await page.goto('http://localhost:18790', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 4500));

const findings = await page.evaluate(() => {
  const out = [];
  for (const cell of document.querySelectorAll('.ov-cell, .react-grid-item')) {
    const widget = cell.querySelector('.ov-widget');
    if (!widget) continue;
    const title = widget.querySelector('.ov-wtitle')?.textContent?.trim() || '?';
    const issues = [];
    // content escaping the card despite overflow:hidden
    if (widget.scrollWidth > widget.clientWidth + 3) issues.push(`hOverflow +${widget.scrollWidth - widget.clientWidth}px`);
    if (widget.scrollHeight > widget.clientHeight + 3) issues.push(`vOverflow +${widget.scrollHeight - widget.clientHeight}px`);
    // text clipped mid-line: any element whose own box is cut by the body
    const body = widget.querySelector('.ov-wbody');
    if (body) {
      const br = body.getBoundingClientRect();
      let clipped = 0;
      for (const el of body.querySelectorAll('button, .gh-row, .ms-check-row, .lk-row, .ci-row, .ov-link')) {
        const r = el.getBoundingClientRect();
        if (r.height > 6 && r.top < br.bottom && r.bottom > br.bottom + 6) {
          // cut elements are fine inside a scrollable ancestor
          let p = el.parentElement, scrollable = false;
          while (p && p !== body.parentElement) {
            const st = getComputedStyle(p);
            if (/(auto|scroll)/.test(st.overflowY)) { scrollable = true; break; }
            p = p.parentElement;
          }
          if (!scrollable) clipped++;
        }
      }
      if (clipped) issues.push(`${clipped} hard-clipped row(s)`);
    }
    // dead space: body more than 55% empty (only at generous sizes)
    if (body) {
      const br = body.getBoundingClientRect();
      let maxBottom = br.top;
      for (const el of body.children) maxBottom = Math.max(maxBottom, el.getBoundingClientRect().bottom);
      const used = (maxBottom - br.top) / Math.max(br.height, 1);
      if (br.height > 220 && used < 0.45) issues.push(`only ${Math.round(used * 100)}% of height used`);
    }
    if (issues.length) out.push({ title, issues });
  }
  return out;
});
console.log(`# Audit ${LABEL}`);
if (findings.length === 0) console.log('  alle Widgets sauber');
for (const f of findings) console.log(`  ${f.title}: ${f.issues.join(' · ')}`);
fs.appendFileSync('/tmp/ov-audit-findings.txt', `\n# ${LABEL}\n` + findings.map(f => `${f.title}: ${f.issues.join(' · ')}`).join('\n') + '\n');
await page.screenshot({ path: `/tmp/ov-audit-${LABEL}.png`, fullPage: false });
await browser.close();
