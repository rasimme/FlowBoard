# Spec: Minimal-Trigger Architektur (Lazy Loading)

## Zielbild

AGENTS.md enthält nur einen **Minimal-Trigger** (ca. 20 Zeilen). Der Agent prüft selbst, ob ein Projekt aktiv ist — **ohne zu fragen**. Wenn aktiv → lazy loading von Kontext + Rules. Wenn nicht aktiv → nichts tun.

**Warum:** Weniger Kontext-Noise, keine unnötigen FlowBoard-Regeln wenn kein Projekt aktiv.

## Soll-Flow

1. Agent startet (Session-Start).
2. AGENTS.md sagt: `GET /api/status?agentId=<id>`
3. Wenn `activeProject === null`: nichts weiter tun.
4. Wenn `activeProject !== null`:
   - `GET /api/projects/<activeProject>/bootstrap` (Kontext)
   - `GET /api/projects/<activeProject>/rules/<section>` (Rules lazy)
5. Kein FlowBoard-Content in BOOT/BOOTSTRAP.md.

## Ist-Analyse (was aktuell falsch ist)

### AGENTS-trigger.md (72 Zeilen)
- Zu lang, enthält komplettes API-Workflow-Regelwerk
- Sagt "BOOTSTRAP.md wird injiziert" → stimmt nicht für alle Fälle
- Nicht klar: Agent soll **selbst prüfen**

### BOOT-extension.md (12 Zeilen)
- Sagt "use live-injected BOOTSTRAP.md"
- Genau das wollen wir abschaffen
- Muss entfernt werden

### snippets-doctor.js
- Hat BOOT.md als Target → muss entfernt werden
- LEGACY_MARKERS nur für `echo "$OPENCLAW_AGENT_ID"` → muss erweitert werden
- `extractInsertBody` hat Spezialfall für BOOT.md → muss vereinfacht werden

### server.js Wake-Event
- Sagt "Kontext laden: GET /api/projects/.../bootstrap"
- Sollte sagen: "Prüfe /api/status, dann lade /bootstrap + /rules lazy"

### external-trigger.md (96 Zeilen)
- Zu lang, viel Redundanz
- Sollte gleicher Minimal-Trigger + API-First-Workflow sein

## Änderungsplan

### Phase 1: Spec + Planung (T-188)
- [x] Task anlegen
- [ ] Spec schreiben (diese Datei)
- [ ] Review + Go

### Phase 2: Snippets (T-189, T-191, T-193)
- [ ] AGENTS-trigger.md auf Minimal-Trigger umbauen
- [ ] BOOT-extension.md + Legacy löschen
- [ ] external-trigger.md anpassen

### Phase 3: Doctor + Wake-Event (T-192, T-194)
- [ ] snippets-doctor.js: BOOT-Target entfernen
- [ ] server.js: Wake-Event präzisieren

### Phase 4: Tests + Migration (T-195)
- [ ] snippets-doctor Tests anpassen
- [ ] Bestehende Workspaces migrieren (snippets-doctor --apply)
- [ ] 109 Tests grün

## Dateien

| Datei | Änderung | Task |
|---|---|---|
| `snippets/AGENTS-trigger.md` | Rewrite → Minimal-Trigger | T-189 |
| `snippets/BOOT-extension.md` | Löschen | T-191 |
| `snippets/legacy/BOOT-extension.v1.md` | Löschen | T-191 |
| `snippets/legacy/BOOT-extension.v2.md` | Löschen | T-191 |
| `snippets/external-trigger.md` | Rewrite → Minimal-Trigger | T-193 |
| `dashboard/snippets-doctor.js` | BOOT-Target entfernen | T-192 |
| `dashboard/server.js` | Wake-Event präzisieren | T-194 |
| `dashboard/test-snippets-doctor.js` | Tests anpassen | T-195 |

## Minimal-Trigger (Ziel-Format)

```markdown
## FlowBoard (API-First)

Project coordination via FlowBoard dashboard at `http://127.0.0.1:18790`.

### On every session start (or before any project-related work)

1. **Check your status:**
   `GET /api/status?agentId=<your-agentId-from-BOOTSTRAP>`

2. **If `activeProject === null`:** no project active. Work normally, do not ask.

3. **If `activeProject !== null`:**
   - Fetch context: `GET /api/projects/<activeProject>/bootstrap`
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`

### Project commands (execute immediately, do not ask)

- Activate: `PUT /api/status` → `{ project, agentId }`
- Deactivate: `PUT /api/status` → `{ project: null, agentId }`
- List: `GET /api/projects`
- Create: `POST /api/projects` → `{ name }`

### Task workflow (API-first)

Claim before work, update while working, complete when done.
Endpoints: `GET /api/projects/<project>/rules/api-access` for full schema.
```

## Risiken

- **Main-Agent** hat andere AGENTS.md → muss separat migriert werden
- **Bestehende Workspaces** haben alte Snippets → `snippets-doctor --apply`
- **Tests** könnten rot werden → müssen angepasst werden

## Abhängigkeiten

- Keine externen Abhängigkeiten
- Alles innerhalb FlowBoard-Repo
