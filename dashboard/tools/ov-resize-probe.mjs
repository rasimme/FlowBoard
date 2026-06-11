import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  headless: 'new',
  args: ['--no-first-run', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', m => { if (m.text().includes('[ov-resize]')) logs.push(m.text()); });

await page.goto('http://localhost:18790', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 2500));

// Edit-Modus öffnen
const editBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('Edit layout')));
if (!(await editBtn.evaluate(el => Boolean(el)))) { console.log('FAIL: kein Edit-Button'); process.exit(1); }
await editBtn.click();
await new Promise(r => setTimeout(r, 1200));

// Struktur-Snapshot vor dem Drag
const before = await page.evaluate(() => {
  const item = document.querySelector('.ov-rgl .react-grid-item');
  const handle = document.querySelector('.ov-rgl .react-resizable-handle-e');
  return {
    items: document.querySelectorAll('.ov-rgl .react-grid-item').length,
    handles: [...document.querySelectorAll('.ov-rgl .react-resizable-handle')].map(h => h.className).slice(0, 6),
    itemCls: item?.className,
    itemStyle: item ? item.getAttribute('style')?.slice(0, 140) : null,
    cellInItem: Boolean(item?.querySelector(':scope > .ov-cell')),
    handleParentCls: handle?.parentElement?.className?.toString?.().slice(0, 80),
  };
});
console.log('BEFORE:', JSON.stringify(before, null, 1));

// East-Handle eines Widgets greifen und ziehen
const h = await page.$('.ov-rgl .react-resizable-handle-e');
if (!h) { console.log('FAIL: kein e-Handle'); await browser.close(); process.exit(1); }
const box = await h.boundingBox();
const startX = box.x + box.width / 2, startY = box.y + box.height / 2;
await page.mouse.move(startX, startY);
await page.mouse.down();

const frames = [];
for (let dx = 20; dx <= 260; dx += 40) {
  await page.mouse.move(startX + dx, startY, { steps: 4 });
  await new Promise(r => setTimeout(r, 120));
  const f = await page.evaluate(() => {
    // das Item, das gerade interagiert wird: suche eins mit will-change/ resizing-artigem Zustand
    const items = [...document.querySelectorAll('.ov-rgl .react-grid-item')];
    const probed = items.map(it => ({
      cls: it.className.replace('react-grid-item', '').trim().slice(0, 60),
      w: it.style.width, h: it.style.height,
      cellW: it.querySelector(':scope > .ov-cell')?.style.width || '',
      cardW: Math.round(it.querySelector('.ov-widget')?.getBoundingClientRect().width || 0),
    }));
    return probed.filter(p => p.cls.length > 0 || p.cellW)
      .concat([probed[3] || probed[0]]).slice(0, 3);
  });
  frames.push({ dx, f });
}
await page.mouse.up();
await new Promise(r => setTimeout(r, 300));

console.log('FRAMES:');
for (const fr of frames) console.log(JSON.stringify(fr));
console.log('CONSOLE-LOGS (' + logs.length + '):');
logs.slice(0, 6).forEach(l => console.log(' ', l.slice(0, 220)));
await browser.close();
