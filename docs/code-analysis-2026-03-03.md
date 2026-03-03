# FlowBoard Code Analysis Report

**Datum:** 2026-03-03
**Scope:** Gesamtes Repository, alle Source Files
**Branch:** `dev` (commit `a57fe89`)

## Zusammenfassung

FlowBoard ist eine gut strukturierte Vanilla-JS Single-Page-App mit Express-Backend. Das Projekt ist funktional solide, hat aber durch das organische Wachstum des Canvas-Features ein deutliches Größen-Ungleichgewicht entwickelt. Die wichtigsten Handlungsfelder sind: `idea-canvas.js` aufteilen (2832 Zeilen), duplizierte Funktionen entfernen, und fehlende Event-Listener-Cleanup beheben.

---

## 1. Architektur & Modulstruktur

### 1.1 Dateigrößen-Übersicht

| Datei | Zeilen | Bewertung |
|---|---:|---|
| `js/idea-canvas.js` | 2832 | **Kritisch — Monolith** |
| `server.js` | 1100 | Grenzwertig, aber akzeptabel |
| `styles/dashboard.css` | 970 | OK (separates canvas.css existiert) |
| `index.html` | 577 | Zu viel Glue-Code |
| `js/file-explorer.js` | 477 | Angemessen |
| `js/kanban.js` | 447 | Angemessen |
| `js/utils.js` | 131 | Gut, fokussiert |
| `styles/canvas.css` | 370 | Angemessen |

### 1.2 idea-canvas.js — Der Monolith (2832 Zeilen)

Dies ist das größte Problem im Codebase. Eine einzige Datei enthält:

- **Canvas State Management** (~50 Zeilen) — `canvasState`, `resetCanvasState`
- **Markdown Rendering** (~100 Zeilen) — `renderNoteMarkdown`, eigene MD-Subset-Implementierung
- **Note CRUD** (~200 Zeilen) — create, delete, edit, save, color, size
- **Canvas Event Handling** (~700 Zeilen) — mouse, touch, wheel, pinch-zoom, lasso, keyboard
- **Connection Routing** (~500 Zeilen) — `routePath`, `manhattanPath`, `ptsToRoundedPath`, `getBestSides`
- **Port Rendering & Stacking** (~250 Zeilen) — `computePortPositions`, `renderPorts`, `stackOffset`
- **Floating Toolbar** (~350 Zeilen) — toolbar, popovers, formatting commands
- **Sidebar** (~50 Zeilen) — open/close, textarea management
- **Promote Flow** (~100 Zeilen) — modal, API call
- **Copy/Paste/Duplicate** (~150 Zeilen)
- **SVG Connection Rendering** (~200 Zeilen) — `renderConnections`, delete overlay

**Empfehlung: 6-Modul-Split:**

```
js/canvas/
  state.js          — canvasState, resetCanvasState, loadCanvas
  notes.js          — CRUD, rendering, markdown, truncation
  connections.js    — routing, rendering, port stacking, save/delete
  events.js         — mouse, touch, wheel, keyboard handlers
  toolbar.js        — floating toolbar, formatting, popovers
  index.js          — renderIdeaCanvas, refreshCanvas (orchestrator)
```

### 1.3 server.js — Akzeptabel, aber verbesserbar (1100 Zeilen)

Die Datei ist logisch gegliedert (Auth → Middleware → Helpers → Routes), aber enthält:

- **Duplizierte Funktionen**: `trimSessionLog()` und `updateBootstrapMd()` existieren zweimal (Zeile 194-253 und Zeile 431-497) — identischer Code, Copy-Paste.
- **Duplizierte Route-Handler**: `GET /api/status` und `PUT /api/status` sind ebenfalls doppelt (Zeile 282-309 und Zeile 525-553).

**Empfehlung: Duplikate entfernen (sofort), danach optionaler Split:**

```
server/
  auth.js          — validateTelegramWebApp, middleware, JWT
  routes-tasks.js  — CRUD für Tasks
  routes-files.js  — File Explorer API
  routes-canvas.js — Canvas API
  helpers.js       — readTasksFile, writeTasksFile, nextId, etc.
  index.js         — Express setup, middleware, route mounting
```

### 1.4 index.html — Zu viel orchestrierender Code (577 Zeilen)

Der `<script type="module">` Block (Zeile 69-575) enthält ~500 Zeilen Glue-Code:
- State-Initialisierung
- 30+ `window.*` Bindings für inline onclick-Handler
- Polling/Refresh-Logik
- Tab-System mit Scroll-Restoration
- Telegram-Integration

**Empfehlung:** `js/app.js` extrahieren — index.html sollte nur HTML + `<script src>` enthalten.

### 1.5 Was gut funktioniert

- **Module Pattern**: `kanban.js`, `file-explorer.js`, `utils.js` sind saubere ES-Module mit klarer Export-API
- **State-Trennung**: Jedes Modul hat seinen eigenen State-Export (`kanbanState`, `fileState`, `canvasState`)
- **Server-Architektur**: Express 5, saubere Middleware-Pipeline, klare Route-Organisation (bis auf die Duplikate)

---

## 2. Code-Qualität & Patterns

### 2.1 Duplizierter Code

**Kritisch — server.js: Identische Funktionen doppelt definiert**

`trimSessionLog()` existiert bei Zeile 194-221 und identisch nochmals bei Zeile 438-465.
`updateBootstrapMd()` existiert bei Zeile 223-253 und identisch nochmals bei Zeile 467-497.
`sendWakeEvent()` existiert bei Zeile 255-277 und identisch nochmals bei Zeile 499-521.
`GET /api/status` und `PUT /api/status` existieren bei Zeile 282-309 und identisch nochmals bei Zeile 525-553.

Das deutet auf einen Merge/Paste-Fehler hin. Node.js verwendet die letzte Definition, aber der tote Code ist verwirrend und fehleranfällig.

**Mittel — Doppelte Markdown-Renderer**

- `file-explorer.js:295` hat `renderMarkdown()` — full-featured (headings, tables, code blocks, images)
- `idea-canvas.js:51` hat `renderNoteMarkdown()` — Subset (bold, italic, lists, links)

Die Subset-Version ist bewusst reduziert, aber teilt Logik (escHtml → inline markdown → links). Ein gemeinsamer Kern in `utils.js` könnte Konsistenz sicherstellen.

**Mittel — Slug-Generierung**

Identische Slug-Logik existiert in `server.js:889-894` (createSpec) und `server.js:1068-1070` (promote). Sollte eine `slugify()`-Hilfsfunktion sein.

### 2.2 DOM-Manipulation vs. JS-State

**Grundsätzlich gut gelöst:** State lebt in JS-Objekten (`state.tasks`, `canvasState.notes`), DOM wird aus State gerendert. Aber es gibt Inkonsistenzen:

- **kanban.js**: Sauberes diff-basiertes Update — existierende Cards werden nur aktualisiert, nicht neu erstellt. Vorbildlich.
- **idea-canvas.js**: Mischt DOM-State-Abfragen mit JS-State. Z.B. `el.offsetWidth` wird bei jedem `renderConnections()`-Aufruf abgefragt statt gecacht. Bei vielen Notes könnte das zu Layout-Thrashing führen.
- **file-explorer.js**: `renderFileTree()` macht `container.innerHTML = html` bei jedem Update — kompletter DOM-Rebuild. Für die typische Dateigröße (< 50 Dateien) OK, aber nicht skalierbar.

### 2.3 Event Handling & Memory Leaks

**Problematisch: idea-canvas.js Event Listeners ohne Cleanup**

`bindCanvasEvents()` (Zeile 1267-1346) bindet 10+ Event-Listener, darunter kritisch:
- `document.addEventListener('keydown', ...)` bei Zeile 1302 — wird bei jedem Tab-Wechsel zu Ideas **neu** gebunden, ohne den vorherigen zu entfernen.
- `window.addEventListener('mousemove', ...)` und `window.addEventListener('mouseup', ...)` innerhalb von `_bindScroll()` (file-explorer.js:383-392) — werden nie entfernt.

Jeder Wechsel zu Ideas → zurück → zu Ideas → zurück akkumuliert keydown-Handler auf `document`. Bei 10 Tab-Wechseln gibt es 10 identische keydown-Handler.

**Empfehlung:** AbortController oder explizites Cleanup beim Tab-Wechsel:
```js
let _canvasAbort = null;
function bindCanvasEvents() {
  _canvasAbort?.abort();
  _canvasAbort = new AbortController();
  const { signal } = _canvasAbort;
  document.addEventListener('keydown', handler, { signal });
  // ...
}
```

**Akzeptabel:** Popover-Close-Handler (kanban.js:325, idea-canvas.js:812-820) verwenden Event-Listener mit manueller Cleanup — korrekt implementiert.

### 2.4 Naming-Konsistenz

**Funktionen:** Generell konsistent (`camelCase`), aber einige Abkürzungen:
- `_h()` und `_hn()` in kanban.js — zu kryptisch. Besser: `hapticLight()`, `hapticSuccess()`.
- `escHtml()` — akzeptabel als bekanntes Pattern.
- `_addNoteCounter`, `_pinchDist`, `_longPressTimer` — Underscore-Prefix für private Variablen ist konsistent.

**CSS-Klassen:** BEM-artig ohne striktes BEM. Konsistent: `.note-body`, `.note-header`, `.canvas-toolbar`, `.file-preview-header`. Einzige Ausnahme: `.cscroll-wrap` / `.cscroll-inner` — Abkürzung statt `custom-scroll`.

**IDs:** Mix aus camelCase (`canvasWrap`) und kebab-case (`file-tree-footer`). Sollte vereinheitlicht werden.

### 2.5 Error Handling

**Server-seitig gut:**
- Alle Routen haben try/catch mit 500-Response
- Input-Validierung vorhanden (title required, path traversal checks)
- Fehlende Projekte geben 404 zurück

**Client-seitig inkonsistent:**
- `api()` in utils.js handelt 403 korrekt (Re-Auth)
- Aber: Nicht-403-Fehler werden nie behandelt — `api()` gibt `res.json()` zurück, auch bei 404 oder 500. Der Aufrufer bekommt dann ein Objekt mit `{ error: "..." }`, prüft aber oft nur `res.ok`.
- `loadCanvas()` (idea-canvas.js:152-161) hat try/catch — gut.
- `refresh()` (index.html:396-491) hat äußeres try/catch — gut.
- Aber viele Canvas-API-Calls haben `catch { /* silent */ }` — zu aggressiv stilles Schlucken.

**Empfehlung:** `api()` sollte bei Nicht-OK-Responses einen Error werfen oder ein Result-Objekt zurückgeben, das `.ok` enthält.

---

## 3. Vanilla JS Bewertung

### 3.1 Ist Vanilla JS noch tragfähig?

**Ja, grundsätzlich.** Der aktuelle Scope (3 Tabs, keine komplexen Formulare, kein verschachteltes Routing) ist mit Vanilla JS gut bedienbar. Die ~6500 Zeilen Gesamt-JS sind handhabbar.

**Aber:** Das Canvas-Feature hat die Grenze erreicht, an der fehlende Abstraktionen spürbar werden:
- Kein zentraler Event-Bus → Events werden über `window.*` Bindings und inline onclick geleitet
- Kein Lifecycle-Management → Event-Listener-Leaks (s.o.)
- Kein reaktives Rendering → manuelle `renderAll()`-Aufrufe an >30 Stellen

### 3.2 Wo ein EventBus helfen würde

Aktuell: `canvasState._state` speichert eine Referenz auf den globalen State, damit Canvas-Funktionen auf `viewedProject` zugreifen können. Das ist fragil.

Ein minimaler EventBus (50 Zeilen) würde entkoppeln:
```
app.emit('project:changed', name) → canvas.onProjectChanged()
app.emit('task:created', task)    → kanban.addCard(task)
canvas.emit('note:promoted', task) → app.state.tasks.push(task)
```

Statt: `canvasState._state.tasks.push(res.task)` (idea-canvas.js:2824) — direkte Mutation von fremdem State.

### 3.3 Ungenutzte Browser-APIs

| API | Könnte helfen bei |
|---|---|
| `AbortController` | Event-Listener-Cleanup bei Tab-Wechsel |
| `structuredClone()` | Immutable State-Snapshots für Diff-Detection (statt JSON.stringify) |
| `Intersection Observer` | Lazy-Rendering von Notes außerhalb des sichtbaren Canvas-Bereichs |
| `requestIdleCallback` | Debounced Position-Saves könnten idle-time nutzen |
| `CSS Container Queries` | Responsive Note-Sizing statt JS-basierter Size-Klassen |
| `Popover API` | Native Popovers statt custom Popover-Management |

### 3.4 Was NICHT geändert werden sollte

- **Kein Framework einführen.** Der Aufwand eines Rewrites übersteigt den Nutzen massiv.
- **Custom Elements** wären overkill — die Note-Rendering-Logik ist komplex, aber DOM-Template-basiert statt Component-basiert.
- **Kein Build-Step einführen** — das No-Build-Setup ist eine bewusste Designentscheidung und funktioniert gut.

---

## 4. CSS Analyse

### 4.1 Stärken

- **CSS Custom Properties:** Umfangreiches, konsistentes Theme-System mit 30+ Variablen
- **Dark Theme:** Durchgängig — kein einziger Hardcoded-Light-Color-Wert (korrekt für Telegram Mini App)
- **Responsive Design:** 3 Breakpoints (default, 900px, 600px) mit sinnvollen Anpassungen
- **Animationen:** Konsistent über CSS-Variablen (`--duration-normal`, `--ease-out`)

### 4.2 Duplikation & Inkonsistenzen

**Hardcoded Background-Color in canvas.css:**
`#12141a` erscheint 8x in `canvas.css` (Zeile 21, 25, 30, 35, 40, 45, 229) statt `var(--bg)`. Das bricht, wenn das Theme jemals geändert wird.

**Radius-Variablen:** `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius`, `--radius-full` — fünf Variablen für vier semantische Stufen. `--radius` (8px) ist identisch mit `--radius-md` (8px). Nur eine behalten.

**`!important`-Overload in canvas.css:**
15x `!important` in 370 Zeilen. Die meisten sind nötig, weil `canvas.css` `dashboard.css` überschreibt. Bessere Lösung: Spezifischere Selektoren oder `:where()` in `dashboard.css` für niedrigere Spezifität.

**Inkonsistente Spacing:**
- Header-Padding: `12px 14px` (Zeile 98)
- Content-Padding: `12px 18px 16px 22px` (Zeile 217)
- Tab-Bar-Padding: `12px 22px 0` (Zeile 419)
- File-Tree-Padding: `12px 0` (Zeile 459)

Die horizontalen Werte variieren zwischen 14px, 18px, 22px, 24px. Ein `--spacing-page` Variable (z.B. 18px) würde Konsistenz schaffen.

### 4.3 Responsive Design

**Gut:** Mobile Kanban als horizontaler Scroll mit Snap funktioniert. Sidebar als Overlay auf Mobile. File-Explorer Toggle zwischen Tree und Preview.

**Verbesserungspotenzial:**
- `grid-column: 1 / -1` wird 3x auf Mobile wiederholt (Zeile 702, 703, 735, 736) — identische Declarations in zwei Media Queries.
- Canvas hat keine spezifische Tablet-Optimierung — auf 900px-1200px-Screens wird der Toolbar eventuell von Notes verdeckt.

### 4.4 Zwei-CSS-Dateien-Architektur

`dashboard.css` definiert Basis-Styles für Canvas-Elemente (`.note`, `.conn-dot`, etc.), die dann von `canvas.css` per `!important` überschrieben werden. Das ist die Ursache für die `!important`-Inflation.

**Empfehlung:** Canvas-Styles komplett nach `canvas.css` verlagern und aus `dashboard.css` entfernen. Dann sind keine `!important` mehr nötig.

---

## 5. Security & Best Practices

### 5.1 API Security — Gut

- **Path Traversal Protection:** Alle File-Endpunkte prüfen mit `path.resolve()` + `startsWith()`. Korrekt implementiert.
- **Rate Limiting:** 60 req/min auf `/api/`, localhost ausgenommen. Sinnvoll.
- **Auth:** Telegram WebApp-Validation + JWT Sessions. HMAC-Verification korrekt.
- **CORS:** Konfigurierbar, mit Credential-Support.
- **Security Headers:** CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy — alles vorhanden.
- **Input Validation:** Task-Title required, specFile-Path-Traversal-Check, Content-Size-Limits auf File-Upload.

### 5.2 Potenzielle Issues

**Synchrone File-I/O auf dem Server:**
Alle `fs.readFileSync` / `fs.writeFileSync` Aufrufe blockieren den Event-Loop. Für ein Single-User-Dashboard akzeptabel, aber bei gleichzeitigen Requests (Polling + User-Action) könnte es zu kurzen Blockaden kommen.

**XSS-Risiken in Markdown-Rendering (Client):**

`renderMarkdown()` in file-explorer.js konvertiert Markdown zu HTML via Regex. Die Funktion ruft `escHtml()` zuerst auf (gut), aber das Ergebnis wird dann als `innerHTML` gesetzt. Die Link-Regex (`\[([^\]]+)\]\(([^)]+)\)`) erzeugt `<a href="$2">` — wobei `$2` bereits HTML-escaped ist. Das ist korrekt, aber fragil: Jede Änderung an der Reihenfolge könnte XSS einführen.

`renderNoteMarkdown()` in idea-canvas.js hat dasselbe Pattern, aber zusätzlich einen Auto-Link-Matcher, der URLs außerhalb von HTML-Tags zu Links konvertiert. Die Regex ist komplex aber korrekt.

**Kein CSRF-Schutz:**
Die API nutzt Cookie-basierte Auth (`flowboard_session`), aber hat keinen CSRF-Token. `SameSite: 'none'` erlaubt Cross-Site-Requests. In der Praxis ist das Risiko gering (Telegram WebApp Context), aber formal ein Issue.

**`Object.assign(task, updates)` ohne Whitelist:**
In `PUT /api/projects/:name/tasks/:id` (Zeile 628) werden alle Request-Body-Properties direkt auf das Task-Objekt kopiert. Ein Client könnte beliebige Properties setzen (z.B. `id`, `created`). Besser: Explizite Whitelist wie bei Canvas-Notes (Zeile 955-957).

### 5.3 Fehlende Tooling

- **Kein Linter (ESLint):** Keine `.eslintrc` im Projekt. Inkonsistente Semicolons (Server: ja, Client: ja — immerhin konsistent).
- **Kein Formatter (Prettier):** Einrückung ist konsistent (2 Spaces), aber durch manuelles Einhalten.
- **Keine Tests:** Weder Server-Tests noch Client-Tests. `package.json` hat nur `echo "Error: no test specified"`.
- **package.json Name:** `"name": "canvas"` — sollte `"flowboard-dashboard"` sein.

### 5.4 Dependency Management

Nur 5 Dependencies — minimal und bewusst:
- `express@5.2.1` — aktuell
- `jsonwebtoken@9.0.3` — aktuell
- `cookie-parser@1.4.7` — aktuell
- `cors@2.8.6` — aktuell
- `express-rate-limit@8.2.1` — aktuell

Keine Dev-Dependencies. Keine bekannten Vulnerabilities bei diesen Versionen (Stand März 2026).

---

## 6. Konkrete Empfehlungen — TOP 5

### Priorität 1: Duplizierte Funktionen in server.js entfernen

**Was:** Die zweiten Kopien von `trimSessionLog()`, `updateBootstrapMd()`, `sendWakeEvent()`, sowie die duplizierten `GET/PUT /api/status` Routen entfernen (ca. 130 Zeilen toter Code).

**Aufwand:** 15 Minuten. Rein subtraktiv.

**Benefit:** Eliminiert die Hauptquelle für künftige Bugs (eine Kopie wird gefixt, die andere nicht). Reduziert server.js auf ~970 Zeilen.

### Priorität 2: Event-Listener-Cleanup in idea-canvas.js

**Was:** `AbortController` einführen für alle `document/window`-Level Event-Listener in `bindCanvasEvents()` und `_bindScroll()`. Controller wird bei jedem `renderIdeaCanvas()`-Aufruf aborted und neu erstellt.

**Aufwand:** 1-2 Stunden.

**Benefit:** Verhindert Memory Leaks und doppelte Handler-Ausführung. Kritisch für die Stabilität bei langem Gebrauch (Telegram Mini Apps werden oft nicht geschlossen).

### Priorität 3: idea-canvas.js aufteilen

**Was:** Die 2832-Zeilen-Datei in 5-6 fokussierte Module splitten (siehe 1.2).

**Aufwand:** 4-6 Stunden. Rein strukturell, keine Funktionsänderung.

**Benefit:** Jedes Modul wird verständlich und wartbar. Connection-Routing (500 Zeilen) und Event-Handling (700 Zeilen) sind eigenständige Concerns die unabhängig debugged werden können.

### Priorität 4: Inline-Script aus index.html extrahieren

**Was:** Den 500-Zeilen `<script type="module">` Block in `js/app.js` auslagern.

**Aufwand:** 1-2 Stunden.

**Benefit:** `index.html` wird auf 70 Zeilen reines HTML reduziert. Glue-Code wird testbar und lintbar.

### Priorität 5: Task-Update Whitelist auf dem Server

**Was:** In `PUT /api/projects/:name/tasks/:id` statt `Object.assign(task, updates)` eine explizite Whitelist verwenden:
```js
const allowed = ['title', 'status', 'priority', 'specFile', 'completed'];
for (const k of allowed) {
  if (Object.prototype.hasOwnProperty.call(updates, k)) task[k] = updates[k];
}
```

**Aufwand:** 10 Minuten.

**Benefit:** Verhindert, dass Clients Task-IDs, created-Timestamps oder beliebige Properties überschreiben.

---

## 7. Was NICHT anfassen

- **Vanilla JS Architektur:** Funktioniert für den Scope. Ein Framework-Rewrite wäre Overengineering.
- **No-Build-Setup:** Die `?v=N` Cache-Busting Strategie ist primitiv aber effektiv. Kein Bundler nötig.
- **Synchrones File-I/O (Server):** Für Single-User ausreichend. Async würde Komplexität ohne Nutzen hinzufügen.
- **Custom Scrollbar Implementation (file-explorer.js):** Komplex aber funktional. Nicht anfassen solange es funktioniert.
- **Connection Routing Algorithmus:** 500 Zeilen Geometrie, gut dokumentiert, funktioniert. Nur extrahieren, nicht refactoren.
- **Polling-basiertes Refresh:** 5-Sekunden-Intervall mit JSON-Diff ist einfach und robust. WebSockets wären overkill.

---

## 8. Metriken-Zusammenfassung

| Metrik | Wert | Bewertung |
|---|---|---|
| Gesamt JS (Client) | ~4487 Zeilen | Angemessen |
| Gesamt JS (Server) | ~1100 Zeilen | OK (nach Deduplizierung ~970) |
| Gesamt CSS | ~1340 Zeilen | Angemessen |
| Größte Datei | idea-canvas.js: 2832 | Zu groß |
| Dependencies | 5 | Minimal, gut |
| Security Headers | 5/5 | Vollständig |
| Path Traversal Protection | Alle Endpunkte | Vollständig |
| Test Coverage | 0% | Fehlend |
| Linting/Formatting | Nicht konfiguriert | Fehlend |
| Duplizierter Code (Server) | ~130 Zeilen | Sofort beheben |
| Event-Listener-Leaks | 2 Stellen | Mittelfristig beheben |

---

*Report generiert durch Code-Review am 2026-03-03.*
