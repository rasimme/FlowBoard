const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = parseInt(process.env.FLOWBOARD_PORT, 10) || 18790;
// S-17: Default to localhost — Cloudflare Tunnel connects via 127.0.0.1 anyway
const HOST = process.env.FLOWBOARD_HOST || '127.0.0.1';

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(__dirname, '..');
const OPENCLAW_HOME = path.resolve(WORKSPACE, '..');
const SHARED_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || path.join(OPENCLAW_HOME, 'projects');
const PROJECTS_DIR = fs.existsSync(SHARED_PROJECTS_DIR) ? SHARED_PROJECTS_DIR : path.join(WORKSPACE, 'projects');
// LEGACY (T-161): file read by m003-active-project-to-db migration only;
// flowboard_agents table is now the source of truth. No code writes this.
const ACTIVE_PROJECT_FILE = path.join(WORKSPACE, 'ACTIVE-PROJECT.md');
const DASHBOARD_DATA_FILE = path.join(process.env.HOME, '.flowboard', 'dashboard-data.json');
const INDEX_FILE = path.join(PROJECTS_DIR, '_index.md');

const HZL_ENABLED = process.env.HZL_ENABLED === 'true';
const HZL_DB_PATH = process.env.HZL_DB_PATH || path.join(WORKSPACE, '.hzl', 'flowboard.db');
const hzlService = HZL_ENABLED ? require('./hzl-service.js') : null;
const fbMeta = HZL_ENABLED ? require('./flowboard-metadata.js') : null;
// AGENT_ID was a service-default-identity that defaulted to OPENCLAW_AGENT_ID
// or "main". It silently routed agent-less callers into a foreign agent's row
// (T-177 trace 2026-04-29). Removed in favour of explicit agentId on every
// per-agent call (T-177-2) and routing-by-action-context for outbound paths
// (T-177-3 Option C). The dashboard service has no own identity.
const specifySession = require('./specify-sessions');
const rulesApi = require('./rules-api.js');
const snippetsDoctor = require('./snippets-doctor.js');

// Gateway webhook config (for project-switch wake events)
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || 18789;
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '';
if (!HOOKS_TOKEN) {
  console.warn('⚠️  OPENCLAW_HOOKS_TOKEN not set — /api/hooks/task-complete endpoint will reject all calls');
}

// Auth config (from env vars — never hardcoded)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_TOKENS = [
  BOT_TOKEN,
  ...(process.env.TELEGRAM_BOT_TOKENS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
].filter(Boolean);
const JWT_SECRET = process.env.JWT_SECRET || '';
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const AUTH_ALWAYS = process.env.AUTH_ALWAYS === 'true';
const AUTH_ENABLED = !!(TELEGRAM_BOT_TOKENS.length && JWT_SECRET && ALLOWED_USER_IDS.length);

// S-03: Reject weak JWT secrets when auth is active
if (AUTH_ENABLED && JWT_SECRET.trim().length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters when auth is enabled.');
  process.exit(1);
}

// Fail-closed: refuse to start in production without auth
if (!AUTH_ENABLED && process.env.NODE_ENV === 'production') {
  console.error('FATAL: Auth not configured in production. Set TELEGRAM_BOT_TOKEN, JWT_SECRET, and ALLOWED_USER_IDS.');
  process.exit(1);
}
if (!AUTH_ENABLED) {
  console.warn('⚠️  AUTH DISABLED — only localhost access permitted');
}

// --- Auth helpers ---

function validateTelegramWebApp(initData) {
  if (!initData || !TELEGRAM_BOT_TOKENS.length) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const authDate = parseInt(params.get('auth_date'), 10);
  if (!authDate || Date.now() / 1000 - authDate > 300) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');

  // S-01: Timing-safe HMAC comparison to prevent timing side-channel attacks
  const isValid = TELEGRAM_BOT_TOKENS.some((token) => {
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const checkBuf = Buffer.from(checkHash, 'utf8');
    const hashBuf = Buffer.from(hash, 'utf8');
    if (checkBuf.length !== hashBuf.length) return false;
    return crypto.timingSafeEqual(checkBuf, hashBuf);
  });

  if (!isValid) return null;
  const user = JSON.parse(params.get('user') || 'null');
  if (!user || !ALLOWED_USER_IDS.includes(user.id)) return null;
  return user;
}

function telegramAuthMiddleware(req, res, next) {
  // Cloudflare Tunnel bypass: cloudflared connects from 127.0.0.1 so IP check can't distinguish
  // local vs external. cf-ray is ONLY set by Cloudflare edge — if present, request is external.
  if (req.headers['cf-ray']) {
    if (!AUTH_ENABLED) {
      // Auth not configured but request is external via tunnel — block it
      console.warn(`[auth] Blocked tunnel request — auth not configured. cf-connecting-ip=${req.headers['cf-connecting-ip']} ${new Date().toISOString()}`);
      return res.status(403).json({ error: 'Auth not configured — tunnel access denied' });
    }
    // External request via Cloudflare — must authenticate
    const token = req.cookies?.flowboard_session;
    if (token) {
      try {
        req.user = jwt.verify(token, JWT_SECRET);
        return next();
      } catch { /* abgelaufen */ }
    }
    const initData = req.headers['x-telegram-init-data'];
    const user = validateTelegramWebApp(initData);
    if (!user) {
      console.warn(`[auth] Failed attempt from ${req.headers['cf-connecting-ip'] || req.ip} — ${new Date().toISOString()}`);
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const sessionToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('flowboard_session', sessionToken, {
      httpOnly: true, secure: true, sameSite: 'none', maxAge: 8 * 60 * 60 * 1000
    });
    req.user = user;
    return next();
  }
  if (!AUTH_ENABLED) {
    // Fail-closed: only allow localhost when auth is not configured (direct local access only)
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
    return res.status(403).json({ error: 'Auth not configured — only localhost access permitted' });
  }
  // Requests via Cloudflare Tunnel always require auth (cf-ray header is set by CF edge)
  // Cloudflared connects locally so req.ip is always 127.0.0.1 — IP cannot distinguish local vs tunnel
  if (req.headers['cf-ray']) {
    // External request via Cloudflare — must authenticate
    const token = req.cookies?.flowboard_session;
    if (token) {
      try {
        req.user = jwt.verify(token, JWT_SECRET);
        return next();
      } catch { /* abgelaufen */ }
    }
    const initData = req.headers['x-telegram-init-data'];
    const user = validateTelegramWebApp(initData);
    if (!user) {
      console.warn(`[auth] Failed attempt from ${req.headers['cf-connecting-ip'] || req.ip} — ${new Date().toISOString()}`);
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const sessionToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('flowboard_session', sessionToken, {
      httpOnly: true, secure: true, sameSite: 'none', maxAge: 8 * 60 * 60 * 1000
    });
    req.user = user;
    return next();
  }
  // Direct local requests (no cf-ray) — allow for dev/ops access
  if (!AUTH_ALWAYS) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
  }
  // SECURITY WARNING (S-13): LOCAL_HOSTNAME bypass allows unauthenticated LAN access.
  // This ONLY works when the server listens on 0.0.0.0 (not the default 127.0.0.1).
  // When FLOWBOARD_HOST=127.0.0.1 (default after S-17), LAN clients cannot reach this
  // server directly, making this bypass unreachable. If you explicitly bind to 0.0.0.0,
  // be aware that LOCAL_HOSTNAME enables clear-text unauthenticated access from LAN IPs.
  const cfHost = (req.headers['host'] || '').split(':')[0];
  const localHostname = process.env.LOCAL_HOSTNAME || '';
  if (localHostname && cfHost === localHostname) {
    const srcIp = req.ip || req.connection?.remoteAddress || '';
    if (srcIp === '127.0.0.1' || srcIp === '::1' || srcIp.startsWith('192.168.') || srcIp.startsWith('10.') || srcIp.startsWith('::ffff:192.168.') || srcIp.startsWith('::ffff:10.')) {
      return next();
    }
  }
  const token = req.cookies?.flowboard_session;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch { /* abgelaufen */ }
  }
  const initData = req.headers['x-telegram-init-data'];
  const user = validateTelegramWebApp(initData);
  if (!user) {
    console.warn(`[auth] Failed attempt from ${req.headers['cf-connecting-ip'] || req.ip} — ${new Date().toISOString()}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const sessionToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('flowboard_session', sessionToken, {
    httpOnly: true, secure: true, sameSite: 'none', maxAge: 8 * 60 * 60 * 1000
  });
  req.user = user;
  next();
}

// --- Middleware stack ---

app.use(cookieParser());
app.use(express.json());

// S-15: Request logger — only in development or when explicitly enabled
if (process.env.LOG_REQUESTS === 'true' || process.env.DEBUG || process.env.NODE_ENV !== 'production') {
  app.use('/api/', (req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.originalUrl} ip=${req.ip} cf-ray=${req.headers['cf-ray'] || 'none'}`);
    next();
  });
}

// Global auth on all /api/ routes (except /health, /info and CORS preflight)
app.use('/api/', (req, res, next) => {
  if (req.path === '/health') return next();
  // /api/info is a public discovery endpoint (T-179): external agents must
  // be able to learn the API surface and the trigger snippet before they
  // know about identity / auth.
  if (req.path === '/info') return next();
  // CORS preflight (OPTIONS) must pass without auth — browser sends no credentials on preflight
  if (req.method === 'OPTIONS') return next();
  return telegramAuthMiddleware(req, res, next);
});

// S-06: CSRF mitigation — verify Origin header on mutating requests
// Browsers send Origin on cross-origin requests; HTML forms cannot set Content-Type: application/json
app.use('/api/', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers['origin'];
    if (origin) {
      const localHostname = process.env.LOCAL_HOSTNAME || '';
      const isLocalOrigin = origin.startsWith('http://localhost:')
        || origin.startsWith('http://127.0.0.1:')
        || (localHostname && origin.includes(localHostname));
      const allowedOrigins = DASHBOARD_ORIGIN
        ? [DASHBOARD_ORIGIN, 'https://web.telegram.org']
        : ['https://web.telegram.org'];
      if (!isLocalOrigin && !allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
    }
  }
  next();
});

// S-23: CORS — restrict origins when auth is active, no wildcard fallback
if (DASHBOARD_ORIGIN) {
  app.use(cors({
    origin: DASHBOARD_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'X-Requested-With']
  }));
} else if (AUTH_ENABLED) {
  console.warn('⚠️  DASHBOARD_ORIGIN not set with AUTH_ENABLED — restricting CORS to Telegram origins');
  app.use(cors({
    origin: ['https://web.telegram.org'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'X-Requested-With']
  }));
} else {
  // No auth, local-only — permissive CORS for development
  app.use(cors());
}

// Rate Limiting — max 60 Requests/Minute pro IP auf API-Routen
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1', // localhost immer erlauben
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip || 'unknown',
  message: { error: 'Too many requests, please slow down.' }
}));

// Security + Cache Headers
// S-25: Nonce-based CSP replaces unsafe-inline for script-src
app.use((req, res, next) => {
  // No-cache für JS/HTML
  if (req.path.endsWith('.js') || req.path.endsWith('.html') || req.path.endsWith('.css') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  // Generate per-request nonce for inline scripts
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  // Security Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://telegram.org`,
    "connect-src 'self'",
    "img-src 'self' data: https://t.me",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-ancestors 'self' https://web.telegram.org"
  ].join('; '));
  next();
});

// Serve index.html with injected config (from dist/ — never serve raw source)
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8');
  const localHostname = process.env.LOCAL_HOSTNAME || '';
  const nonce = res.locals.cspNonce;
  // Inject nonce into existing inline scripts and add config script
  html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
  html = html.replace('</head>', `<script nonce="${nonce}">window.__LOCAL_HOSTNAME__ = ${JSON.stringify(localHostname)};window.__AUTH_ENABLED__ = ${JSON.stringify(AUTH_ENABLED)};</script></head>`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// S-09: Serve static files ONLY from dist/ — never expose server source, configs, or data files
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// SPA Fallback: serve dist/index.html for all routes that aren't API or static files
app.get('/*path', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  // Check if it's a real file in dist/ (express.static above will have served it already,
  // but this guard handles race conditions with next())
  const filePath = path.join(__dirname, 'dist', req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return next();
  }

  // Fallback to dist/index.html with injected config + CSP nonce
  let html = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf8');
  const localHostname = process.env.LOCAL_HOSTNAME || '';
  const nonce = res.locals.cspNonce;
  html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
  html = html.replace('</head>', `<script nonce="${nonce}">window.__LOCAL_HOSTNAME__ = ${JSON.stringify(localHostname)};window.__AUTH_ENABLED__ = ${JSON.stringify(AUTH_ENABLED)};</script></head>`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// S-08/S-22: Central project name validation — prevents path traversal via :name param
function sanitizeProjectName(name) {
  if (name == null) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.includes('..')) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false;
  return true;
}

// All routes with :name are /api/projects/:name/* — validate once here
app.param('name', (req, res, next, name) => {
  if (!sanitizeProjectName(name)) {
    return res.status(400).json({ error: 'Invalid project name' });
  }
  next();
});

// Health-Endpoint (kein Auth)
// --- Canvas Helpers ---

function readCanvasFile(projectName) {
  const file = path.join(PROJECTS_DIR, projectName, 'canvas.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Garbage-collect orphaned connections on every load
    const noteIds = new Set((data.notes || []).map(n => n.id));
    data.connections = (data.connections || []).filter(
      c => noteIds.has(c.from) && noteIds.has(c.to)
    );
    return data;
  } catch {
    return { notes: [], connections: [] };
  }
}

function writeCanvasFile(projectName, data) {
  const file = path.join(PROJECTS_DIR, projectName, 'canvas.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function nextNoteId(notes) {
  let max = 0;
  for (const n of notes) {
    const m = n.id.match(/N-(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `N-${String(max + 1).padStart(3, '0')}`;
}

// --- Project Context Helpers ---

// NOTE: trimSessionLog removed by T-131-4/m005 — session logs now live in SESSIONS.md

async function sendWakeEvent(text) {
  if (!HOOKS_TOKEN) {
    console.log('[wake] No OPENCLAW_HOOKS_TOKEN set, skipping wake event');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/hooks/wake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HOOKS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, mode: 'now' })
    });
    if (res.ok) {
      console.log(`[wake] Sent wake event: ${text.slice(0, 80)}...`);
    } else {
      console.error(`[wake] Failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[wake] Error:`, err.message);
  }
}

// --- Routes ---

// GET /api/status
//
// Requires an explicit agentId — either as ?agentId=<id> query parameter or
// as `x-openclaw-agent-id` header (consistent with /api/projects/:name/rules
// telemetry). No silent fallback to a service-default agent (which routes
// the caller's status request into a foreign agent's state — see T-177
// trace from 2026-04-29).
app.get('/api/status', (req, res) => {
  const agentId = req.query.agentId || req.headers['x-openclaw-agent-id'];
  if (!agentId) {
    return res.status(400).json({
      error: 'agentId is required (?agentId=<id> query parameter or x-openclaw-agent-id header)',
    });
  }
  let activeProject;
  if (HZL_ENABLED) {
    // T-131-3: DB is canonical. Unknown agents → null, no file fallback.
    // (The pre-backfill `agentId === AGENT_ID` branch is removed in T-177-3 —
    // there is no service-default agent anymore. The m003 migration handles
    // file→DB backfill for the legacy ACTIVE-PROJECT.md case.)
    const row = fbMeta.getAgentRow(agentId);
    activeProject = row?.active_project || null;
  } else {
    activeProject = readActiveProject(); // LEGACY: non-HZL fallback.
  }
  res.json({ activeProject, agentId });
});

// PUT /api/status
//
// Requires an explicit agentId in the request body. No silent fallback to a
// service-default agent — that would route the activation into the wrong
// flowboard_agents row (see T-177 trace from 2026-04-29).
app.put('/api/status', async (req, res) => {
  const { project, agentId } = req.body;
  if (!agentId) {
    return res.status(400).json({ error: 'agentId is required in request body' });
  }
  let effectiveProject = (project && project !== 'none') ? project : null;

  // Resolve to canonical project name. Clients sometimes send displayName
  // ("FlowBoard") instead of the canonical name ("flowboard"); accept both,
  // but always store the canonical name so downstream lookups by p.name work.
  if (effectiveProject && HZL_ENABLED) {
    const canonical = fbMeta.resolveProjectName(effectiveProject, hzlService.listHzlProjects());
    if (!canonical) {
      return res.status(400).json({ error: `Unknown project: ${project}` });
    }
    effectiveProject = canonical;
  }

  // Read previous state from canonical source
  let previousProject;
  if (HZL_ENABLED) {
    previousProject = getCanonicalActiveProject(agentId);
  } else {
    previousProject = readActiveProject(); // LEGACY: non-HZL fallback.
  }

  try {
    // T-131-3: write DB state (canonical). The dashboard no longer writes
    // ACTIVE-PROJECT.md or any other agent-workspace file — flowboard_agents
    // is the source of truth, and agents fetch state via /api/agents and
    // /api/projects/:name/bootstrap.
    if (HZL_ENABLED) {
      fbMeta.setAgentActiveProject(agentId, effectiveProject);
    }

    // Send wake event to notify agent of project switch
    if (effectiveProject) {
      const apiHints =
        `Kontext laden: GET /api/projects/${effectiveProject}/bootstrap. ` +
        `Tasks führst du über die API: ` +
        `POST /api/projects/${effectiveProject}/tasks zum Anlegen, ` +
        `POST /api/projects/${effectiveProject}/tasks/{id}/claim mit {"agent":"${agentId}"} bevor du an einem Task arbeitest, ` +
        `PUT /api/projects/${effectiveProject}/tasks/{id} für Status/Progress, ` +
        `POST /api/projects/${effectiveProject}/tasks/{id}/complete bei Fertigstellung. ` +
        `Endpoint-Schema: GET /api/projects/${effectiveProject}/rules/api-access.`;
      const wakeText = previousProject && previousProject !== effectiveProject
        ? `Projekt gewechselt von ${previousProject} auf ${effectiveProject}. ${apiHints}`
        : `Projekt ${effectiveProject} aktiviert. ${apiHints}`;
      sendWakeEvent(wakeText);
    } else if (previousProject) {
      sendWakeEvent(`Projekt ${previousProject} deaktiviert. Kein aktives Projekt mehr.`);
    }

    const body = { ok: true, activeProject: effectiveProject, agentId };
    res.json(body);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});


// GET /api/agents — list all known agents and their active project (T-131-3)
app.get('/api/agents', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    res.json({ ok: true, agents: fbMeta.listAgents() });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/agents/:id — remove an agent row from flowboard_agents.
//
// Conflict-checked against active task claims by default; pass ?force=true
// to release any active claims (status of the tasks is preserved, only the
// lease/claim is dropped) and then delete the row. Historical attribution
// on tasks/comments/checkpoints (`agent="<id>"` fields) is unaffected:
// agentId is a string, not a foreign key. T-180.
app.delete('/api/agents/:id', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  const agentId = req.params.id;
  const force = req.query.force === 'true';
  try {
    const row = fbMeta.getAgentRow(agentId);
    if (!row) return res.status(404).json({ error: 'Agent not found' });

    const activeClaims = hzlService.listTasksClaimedBy(agentId);
    if (activeClaims.length > 0 && !force) {
      return res.status(409).json({
        error: `Agent has ${activeClaims.length} active claim(s)`,
        claimCount: activeClaims.length,
        claims: activeClaims.map(t => ({ project: t.project, id: t.id, title: t.title })),
        hint: 'Pass ?force=true to release claims and delete, or release them manually first',
      });
    }

    let releasedCount = 0;
    if (force && activeClaims.length > 0) {
      for (const t of activeClaims) {
        try {
          hzlService.releaseTask(t.project, t.id, { agent: agentId, force: true });
          releasedCount++;
        } catch (e) {
          console.warn(`[delete-agent] force-release failed for ${t.project}/${t.id}:`, e.message);
        }
      }
    }

    const removed = fbMeta.deleteAgentRow(agentId);
    res.json({
      ok: true,
      agent_id: agentId,
      deleted: removed > 0,
      releasedClaims: releasedCount,
    });
  } catch (err) {
    console.error('[api delete-agent]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// S-07: Health endpoint — minimal response, no version/uptime/auth info leak
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// GET /api/info — public discovery endpoint for external agents (T-179).
// Returns service metadata + the bundled external-trigger snippet so an
// agent in a project repo can self-onboard with a single curl. No auth
// (matches /api/health pattern); no agentId required.
const EXTERNAL_TRIGGER_PATH = path.resolve(__dirname, '..', 'snippets', 'external-trigger.md');
let _externalTriggerSnippet = '';
try {
  _externalTriggerSnippet = fs.readFileSync(EXTERNAL_TRIGGER_PATH, 'utf8');
} catch (e) {
  console.warn(`[api/info] Could not load ${EXTERNAL_TRIGGER_PATH}: ${e.message}`);
}
let _packageVersion = 'unknown';
try {
  _packageVersion = require('./package.json').version;
} catch { /* version stays 'unknown' */ }

app.get('/api/info', (req, res) => {
  res.json({
    service: 'FlowBoard',
    version: _packageVersion,
    api_base: `http://localhost:${PORT}`,
    endpoints: {
      health:    '/api/health',
      info:      '/api/info',
      agents:    '/api/agents',
      status:    '/api/status',
      projects:  '/api/projects',
      bootstrap: '/api/projects/:name/bootstrap',
      rules:     '/api/projects/:name/rules/:section',
      tasks:     '/api/projects/:name/tasks',
    },
    agent_id_convention:
      "Pick a stable agent-id like 'codex', 'cursor', 'claude-code'. " +
      'Auto-registered in flowboard_agents on first PUT /api/status.',
    anti_trust_rule:
      'Always pass agentId on per-agent calls (?agentId= or x-openclaw-agent-id header for GET, body for POST/PUT). ' +
      "Distrust responses where response.agentId differs from yours.",
    trigger_snippet: _externalTriggerSnippet,
  });
});

// Auth-Endpoint (vor dem generellen API-Auth)
app.post('/api/auth', (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Auth auf alle API-Routes wird jetzt global oben angewendet (nach Debug-Logger)

// --- Helpers ---

// LEGACY (T-161): retained for non-HZL deployments and as a one-shot bootstrap
// fallback in getCanonicalActiveProject() before the m003 migration backfills
// the agent row. Under HZL with a populated flowboard_agents table this never
// fires. Remove once non-HZL deployments are gone.
function readActiveProject() {
  try {
    const text = fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8');
    const match = text.match(/^project:\s*(.+)$/m);
    const name = match ? match[1].trim() : 'none';
    return name === 'none' ? null : name;
  } catch { return null; }
}

// T-177-3: agentId is required; no default. Pass the explicit caller agent.
// For per-project queries that don't have an agent context (e.g. legacy
// dashboard-data sync), pass null and accept that "active project" is
// undefined in that context.
function getCanonicalActiveProject(agentId) {
  if (!agentId) return null;
  if (HZL_ENABLED) {
    const row = fbMeta.getAgentRow(agentId);
    if (row) return row.active_project || null;
  }
  return readActiveProject(); // LEGACY: see readActiveProject() comment.
}

function readTasksFile(projectName) {
  const file = path.join(PROJECTS_DIR, projectName, 'tasks.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function taskWithSpecStatus(projectName, task) {
  const specFile = task?.specFile;
  const hasSpec = Boolean(specFile);
  const specExists = hasSpec && fs.existsSync(path.join(PROJECTS_DIR, projectName, specFile));
  // Ensure blocked field is always present in API response
  return { ...task, specExists, blocked: task?.blocked === true };
}

function enrichTasks(projectName, tasks = []) {
  return tasks.map(task => {
    const enriched = taskWithSpecStatus(projectName, task);
    if (task.subtaskIds && task.subtaskIds.length > 0) {
      enriched.progress = getSubtaskProgress(tasks, task.id);
    }
    return enriched;
  });
}

function writeTasksFile(projectName, data) {
  const file = path.join(PROJECTS_DIR, projectName, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Legacy file-write for the pre-React vanilla dashboard. Today's React UI
// reads from the API directly; the file is gitignored and unused by code
// in this repo. Kept for now so old debugging scripts still work; the
// `active` flag was multi-agent-meaningless and is removed (T-177-3).
function syncDashboardData(projectName) {
  let tasks;
  if (HZL_ENABLED) {
    tasks = hzlService.listTasks(projectName);
  } else {
    const data = readTasksFile(projectName);
    tasks = data ? data.tasks : [];
  }
  const out = { project: projectName, tasks };
  fs.writeFileSync(DASHBOARD_DATA_FILE, JSON.stringify(out, null, 2));
}

/** Promisified execFile for CLI bridge calls. */
function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); }
      else resolve(stdout);
    });
  });
}

function getDisplayName(projectName) {
  try {
    const mdPath = path.join(PROJECTS_DIR, projectName, 'PROJECT.md');
    const firstLine = fs.readFileSync(mdPath, 'utf8').split('\n')[0];
    let title = firstLine.replace(/^#\s*/, '').trim();
    // Strip subtitle after em-dash or en-dash
    title = title.split(/\s*[—–]\s*/)[0].trim();
    return title || projectName;
  } catch { return projectName; }
}

function parseIndexMd() {
  try {
    const text = fs.readFileSync(INDEX_FILE, 'utf8');
    const lines = text.split('\n');
    const projects = [];
    for (const line of lines) {
      const match = line.match(/^\|\s*(\w[\w-]*)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|$/);
      if (match && match[1] !== 'Project') {
        projects.push({
          name: match[1],
          displayName: getDisplayName(match[1]),
          status: match[2],
          description: match[3]
        });
      }
    }
    return projects;
  } catch { return []; }
}

function getTaskCounts(projectName) {
  if (HZL_ENABLED) return hzlService.getTaskCounts(projectName);
  const data = readTasksFile(projectName);
  const counts = { open: 0, 'in-progress': 0, review: 0, done: 0 };
  if (data && data.tasks) {
    for (const t of data.tasks) {
      if (counts[t.status] !== undefined) counts[t.status]++;
    }
  }
  return counts;
}

function nextTaskId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = t.id.match(/T-(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

function nextSubtaskId(parentId, existingSubtaskIds) {
  const nums = existingSubtaskIds.map(id => {
    const parts = id.split('-');
    return parseInt(parts[parts.length - 1], 10);
  }).filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${parentId}-${next}`;
}

function recalcParentStatus(tasks, parentId) {
  const parent = tasks.find(t => t.id === parentId);
  if (!parent || parent.status === 'done') return null;

  const subtasks = tasks.filter(t => t.parentId === parentId);
  if (subtasks.length === 0) return null;

  const allDone = subtasks.every(t => t.status === 'done');
  const anyStarted = subtasks.some(t => t.status !== 'open');

  let newStatus = parent.status;
  if (allDone) {
    newStatus = 'review';
  } else if (anyStarted && parent.status === 'open') {
    newStatus = 'in-progress';
  } else if (!allDone && parent.status === 'review') {
    newStatus = 'in-progress';
  }

  if (newStatus !== parent.status) {
    parent.status = newStatus;
    return { id: parent.id, status: newStatus };
  }
  return null;
}

function getSubtaskProgress(tasks, parentId) {
  const subtasks = tasks.filter(t => t.parentId === parentId);
  return {
    done: subtasks.filter(t => t.status === 'done').length,
    inProgress: subtasks.filter(t => t.status === 'in-progress' || t.status === 'review').length,
    total: subtasks.length
  };
}

function projectExists(projectName) {
  if (HZL_ENABLED) {
    try {
      // Ensure project is loaded into HZL before checking
      hzlService.ensureProject(projectName);
      return hzlService.listHzlProjects().some(p => p.name === projectName);
    } catch {
      return false;
    }
  }
  return !!readTasksFile(projectName);
}

/**
 * Return a contextual reminder string for task lifecycle events.
 * @param {object} task - The task object (after any mutations)
 * @param {'create'|'status-change'} action - What triggered the call
 * @param {string|undefined} newStatus - The new status (only for status-change)
 * @param {string|undefined} prevStatus - The previous status (only for status-change)
 * @returns {string|null}
 */
function getTaskReminder(task, action, newStatus, prevStatus) {
  if (action === 'create') {
    return '\u{1F4A1} Evaluate: does this task need a spec? Consider: multiple files affected, new UI pattern, unclear scope, or complex logic \u2192 create a spec. Simple fix or config change \u2192 title is enough.';
  }
  if (action === 'status-change' && newStatus && newStatus !== prevStatus) {
    if (newStatus === 'in-progress') {
      return task.specFile
        ? `\u{1F4CB} This task has a spec \u2014 read it before starting: ${task.specFile}`
        : '\u{1F4A1} No spec for this task. If it\'s complex (multiple files, new patterns), consider creating one first.';
    }
    if (newStatus === 'done') {
      return task.specFile
        ? `\u26A0\uFE0F Before confirming done: read the spec (${task.specFile}), verify all Done-When criteria are met, and update checkboxes.`
        : '\u2705 No spec to verify. Confirm the task title accurately describes what was delivered.';
    }
  }
  return null;
}

// POST /api/projects — T-131-6: canonical project creation
app.post('/api/projects', (req, res) => {
  if (!HZL_ENABLED) return res.status(501).json({ error: 'Project creation requires HZL_ENABLED=true' });
  const lifecycle = require('./project-lifecycle.js');
  try {
    const result = lifecycle.createProject(req.body, {
      hzlService,
      fbMeta,
      projectsDir: PROJECTS_DIR,
    });
    const response = { project: result.project };
    if (result.warnings.length > 0) response.warnings = result.warnings;
    return res.status(201).json(response);
  } catch (e) {
    if (e.code === 'VALIDATION_ERROR') return res.status(400).json({ error: e.message });
    if (e.code === 'DUPLICATE') return res.status(409).json({ error: e.message });
    console.error('[projects] createProject failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name — T-136: update metadata (displayName, archived, group, order)
app.put('/api/projects/:name', (req, res) => {
  if (!HZL_ENABLED) return res.status(501).json({ error: 'Project updates require HZL_ENABLED=true' });
  const lifecycle = require('./project-lifecycle.js');
  try {
    const project = lifecycle.updateProject(req.params.name, req.body || {}, { hzlService, fbMeta });
    return res.json({ project });
  } catch (e) {
    if (e.code === 'VALIDATION_ERROR') return res.status(400).json({ error: e.message });
    if (e.code === 'NOT_FOUND')        return res.status(404).json({ error: e.message });
    if (e.code === 'METADATA_ERROR')   return res.status(500).json({ error: e.message });
    console.error('[projects] updateProject failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name?confirm=<name> — T-136: hard-delete (tombstone + .trash/)
app.delete('/api/projects/:name', (req, res) => {
  if (!HZL_ENABLED) return res.status(501).json({ error: 'Project delete requires HZL_ENABLED=true' });
  if (req.query.confirm !== req.params.name) {
    return res.status(400).json({ error: 'Missing or mismatched ?confirm=<projectName>' });
  }
  const lifecycle = require('./project-lifecycle.js');
  try {
    const result = lifecycle.deleteProject(req.params.name, {
      hzlService,
      fbMeta,
      projectsDir: PROJECTS_DIR,
    });
    // Clear agent active-project rows pointing at the deleted project so no
    // agent stays "activated" on a tombstoned name.
    try {
      for (const row of fbMeta.listAgents()) {
        if (row.active_project === req.params.name) {
          fbMeta.setAgentActiveProject(row.agent_id, null);
        }
      }
    } catch (e) { console.warn('[projects] clear-agent-refs:', e.message); }
    const response = { ok: true, archivedTaskCount: result.archivedTaskCount };
    if (result.warnings && result.warnings.length > 0) response.warnings = result.warnings;
    return res.json(response);
  } catch (e) {
    if (e.code === 'NOT_FOUND')      return res.status(404).json({ error: e.message });
    if (e.code === 'METADATA_ERROR') return res.status(500).json({ error: e.message });
    console.error('[projects] deleteProject failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects
//
// T-177-3: the legacy `activeProject` field (single-agent semantics) is
// removed from the response. Multi-agent active-project state lives on
// per-agent rows — read /api/agents (list with active_project per agent)
// or /api/status?agentId=<id> for one. Frontend already uses /api/agents
// (Sidebar.jsx:215-228) as the source of truth.
app.get('/api/projects', (req, res) => {
  if (HZL_ENABLED) {
    try {
      const hzlProjects = hzlService.listHzlProjects();
      const projects = fbMeta.listProjects(hzlProjects).map(p => ({
        ...p,
        taskCounts: getTaskCounts(p.name),
      }));
      return res.json({ projects });
    } catch (e) {
      console.error('[projects] Failed to list DB-backed projects:', e.message);
      return res.status(500).json({ error: 'Failed to load projects from HZL/FlowBoard metadata' });
    }
  }
  const projects = parseIndexMd().map(p => ({ ...p, taskCounts: getTaskCounts(p.name) }));
  res.json({ projects });
});

// GET /api/snippets/status — per-workspace snippet state
// Returns { ok, counts, chip, files: [...] }.
//   counts — { identical, drifted, missing, current, ignored, total }
//   chip   — { text, variant } | null (null = hidden, setup complete)
//   files  — entries needing UI attention (identical / drifted / missing);
//            files in state `current` are excluded from this list.
app.get('/api/snippets/status', (req, res) => {
  try {
    const status = snippetsDoctor.collectStatus(OPENCLAW_HOME);
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error('[snippets/status]', err);
    res.status(500).json({ error: 'Failed to collect snippet status', detail: err.message });
  }
});

// POST /api/snippets/apply — unified apply endpoint for snippet actions.
// Body: { actions: [{ id, action }] } where action ∈ {upgrade, migrate, add}
//   upgrade — byte-identical legacy → current (state: identical)
//   migrate — drifted legacy → current (state: drifted, force-replace)
//   add     — insert current snippet at end of file (state: missing)
// Every action writes a .bak-<ts> backup first. State-mismatched actions and
// unknown IDs are reported in `skipped`, never silently applied.
//
// Back-compat: if body carries { ids: [...] } instead of { actions: [...] },
// treat each id as { action: 'upgrade' } — matches the older client contract.
app.post('/api/snippets/apply', (req, res) => {
  const body = req.body || {};
  let actions = null;
  if (Array.isArray(body.actions) && body.actions.length > 0) {
    actions = body.actions;
  } else if (Array.isArray(body.ids) && body.ids.length > 0) {
    actions = body.ids.map(id => ({ id, action: 'upgrade' }));
  }
  if (!actions) {
    return res.status(400).json({ error: 'Body must include actions[] (or legacy ids[])' });
  }
  try {
    const result = snippetsDoctor.applyActions(OPENCLAW_HOME, actions);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[snippets/apply]', err);
    res.status(500).json({ error: 'Failed to apply snippet actions', detail: err.message });
  }
});

// --- Rules-endpoint telemetry (diagnostic, env-gated) ---------------------
// Off by default. Enable via `FLOWBOARD_RULES_TELEMETRY=1` in the service env
// to log every /rules/* hit to stdout (picked up by systemd -> /tmp/dashboard.log).
// Format is grep/awk-friendly. Purpose: answer "do agents actually use the
// lazy-load?"; remove the three log lines below once the question is settled.
const RULES_TELEMETRY = process.env.FLOWBOARD_RULES_TELEMETRY === '1';
function logRuleHit(req, section) {
  if (!RULES_TELEMETRY) return;
  const agent = req.query.agentId || req.headers['x-openclaw-agent-id'] || 'unknown';
  const project = req.params.name || 'unknown';
  console.log(`[rules-telemetry] section=${section} agent=${agent} project=${project} ts=${new Date().toISOString()}`);
}

// GET /api/projects/:name/rules — list available rule sections
app.get('/api/projects/:name/rules', (req, res) => {
  logRuleHit(req, '_manifest');
  res.json({
    project: req.params.name,
    sections: rulesApi.listRuleSections(),
    manifest: rulesApi.buildRulesManifest(),
  });
});

// GET /api/projects/:name/rules/:section — fetch one rule section as markdown
app.get('/api/projects/:name/rules/:section', (req, res) => {
  const content = rulesApi.readRuleSection(req.params.section);
  if (content === null) {
    logRuleHit(req, `${req.params.section}[404]`);
    return res.status(404).json({ error: 'Rule section not found', section: req.params.section });
  }
  logRuleHit(req, req.params.section);
  res.type('text/markdown; charset=utf-8').send(content);
});

// GET /api/projects/:name/bootstrap — fetch full bootstrap document for a project
app.get('/api/projects/:name/bootstrap', (req, res) => {
  const content = rulesApi.buildBootstrapDocument(req.params.name);
  res.type('text/markdown; charset=utf-8').send(content);
});

// GET /api/projects/:name/tasks
app.get('/api/projects/:name/tasks', (req, res) => {
  let tasks, responseBase;
  if (HZL_ENABLED) {
    if (!projectExists(req.params.name)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const includeArchived = req.query.includeArchived === 'true';
    tasks = hzlService.listTasks(req.params.name, { includeArchived });
    responseBase = {};
  } else {
    const data = readTasksFile(req.params.name);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    tasks = data.tasks;
    responseBase = data;
  }
  const result = enrichTasks(req.params.name, tasks);
  const response = { ...responseBase, tasks: result };

  // Task status nudge
  try {
    const topLevel = result.filter(t => !t.parentId);
    const inProgress = topLevel.filter(t => t.status === 'in-progress');
    const review = topLevel.filter(t => t.status === 'review');
    const open = topLevel.filter(t => t.status === 'open');

    if (inProgress.length > 0) {
      const t = inProgress[0];
      const subInfo = t.progress ? ` (${t.progress.done}/${t.progress.total} subtasks done)` : '';
      response.taskContext = `\u26A1 Currently in-progress: ${t.id}${subInfo} \u2014 ${t.title}. Remember to set to review when done.`;
    } else if (review.length > 0) {
      const titles = review.map(t => `${t.id}`).join(', ');
      response.taskContext = `\uD83D\uDD0D ${review.length} task(s) in review (${titles}). Confirm done or continue working. ${open.length} open task(s) available.`;
    } else if (open.length > 0) {
      response.taskContext = `\uD83D\uDCA1 No task in-progress. ${open.length} open task(s) available \u2014 set one to in-progress before starting work.`;
    }
  } catch (e) { console.warn('[taskContext]', e); }

  res.json(response);
});

// POST /api/projects/:name/tasks
app.post('/api/projects/:name/tasks', (req, res) => {
  if (HZL_ENABLED) {
    if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
    const { title, priority, parentId } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    if (parentId) {
      const parent = hzlService.getTask(req.params.name, parentId);
      if (!parent) return res.status(400).json({ error: 'Parent task not found' });
      if (parent.parentId) return res.status(400).json({ error: 'Cannot nest subtasks (max 1 level)' });
    }

    let effectivePriority = priority || 'medium';
    if (parentId) {
      const parent = hzlService.getTask(req.params.name, parentId);
      if (parent) effectivePriority = parent.priority;
    }

    try {
      const task = hzlService.createTask(req.params.name, {
        title,
        priority: effectivePriority,
        parentId: parentId || null,
        status: req.body.status || 'backlog',
      });
      syncDashboardData(req.params.name);
      const response = { ok: true, task: taskWithSpecStatus(req.params.name, task) };
      try {
        const r = getTaskReminder(task, 'create');
        if (r) response.reminder = r;
      } catch (e) { console.warn('[reminder]', e); }
      return res.json(response);
    } catch (err) {
      console.error('[api]', err); return res.status(500).json({ error: 'Internal server error' });
    }
  }

  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  const { title, priority, parentId } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  let taskId;
  if (parentId) {
    const parent = data.tasks.find(t => t.id === parentId);
    if (!parent) return res.status(400).json({ error: 'Parent task not found' });
    if (parent.parentId) return res.status(400).json({ error: 'Cannot nest subtasks (max 1 level)' });
    const existingSubtaskIds = parent.subtaskIds || [];
    taskId = nextSubtaskId(parentId, existingSubtaskIds);
    if (!parent.subtaskIds) parent.subtaskIds = [];
    parent.subtaskIds.push(taskId);
  } else {
    taskId = nextTaskId(data.tasks);
  }

  // Subtasks inherit parent priority; top-level tasks use provided or default 'medium'
  let effectivePriority = priority || 'medium';
  if (parentId) {
    const parent = data.tasks.find(t => t.id === parentId);
    if (parent) effectivePriority = parent.priority;
  }

  const task = {
    id: taskId,
    title,
    status: 'open',
    priority: effectivePriority,
    parentId: parentId || null,
    specFile: null,
    created: new Date().toISOString().slice(0, 10),
    completed: null
  };
  data.tasks.push(task);
  try {
    writeTasksFile(req.params.name, data);
    syncDashboardData(req.params.name);
    const response = { ok: true, task: taskWithSpecStatus(req.params.name, task) };
    try {
      const r = getTaskReminder(task, 'create');
      if (r) response.reminder = r;
    } catch (e) { console.warn('[reminder]', e); }
    res.json(response);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name/tasks/:id
app.put('/api/projects/:name/tasks/:id', (req, res) => {
  if (HZL_ENABLED) {
    const task = hzlService.getTask(req.params.name, req.params.id, { includeArchived: true });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const updates = req.body;

    if (Object.prototype.hasOwnProperty.call(updates, 'specFile')) {
      const nextSpec = updates.specFile;
      if (nextSpec !== null) {
        if (typeof nextSpec !== 'string' || !nextSpec.trim()) {
          return res.status(400).json({ error: 'specFile must be a non-empty string or null' });
        }
        const resolvedSpec = path.resolve(PROJECTS_DIR, req.params.name, nextSpec);
        const projectRoot = path.resolve(PROJECTS_DIR, req.params.name) + path.sep;
        if (!resolvedSpec.startsWith(projectRoot)) {
          return res.status(400).json({ error: 'specFile path traversal not allowed' });
        }
        if (!fs.existsSync(resolvedSpec) || fs.statSync(resolvedSpec).isDirectory()) {
          return res.status(400).json({ error: `specFile target not found: ${nextSpec}` });
        }
      }
      hzlService.setSpecLink(req.params.name, req.params.id, nextSpec);
    }

    const prevStatus = task.status;

    if (updates.status === 'done' && task.status !== 'done') {
      updates.completed = new Date().toISOString().slice(0, 10);
    }
    if (updates.status && updates.status !== 'done' && task.status === 'done') {
      updates.completed = null;
    }

    const ALLOWED = ['title', 'status', 'priority', 'completed', 'agent'];
    const hzlUpdates = {};
    for (const key of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        hzlUpdates[key] = updates[key];
      }
    }
    // blocked + trashedAt are handled separately below (not in ALLOWED to keep whitelist clean)

    // agent can only be cleared, not set to a value
    if (Object.prototype.hasOwnProperty.call(updates, 'agent') && updates.agent !== null) {
      return res.status(400).json({ error: 'agent can only be cleared (set to null), not set to a value' });
    }

    if (hzlUpdates.status !== undefined) {
      const VALID = new Set(['open', 'in-progress', 'review', 'done', 'backlog', 'archived']);
      if (!VALID.has(hzlUpdates.status)) {
        return res.status(400).json({ error: `Invalid status: "${hzlUpdates.status}"` });
      }
    }

    // Pass blocked flag through
    if (Object.prototype.hasOwnProperty.call(updates, 'blocked')) {
      hzlUpdates.blocked = updates.blocked === true;
    }

    // T-161-4: pass trashedAt through (ISO string to send to Trash, null to restore).
    // Minimal validation: must be null or a parseable date string.
    if (Object.prototype.hasOwnProperty.call(updates, 'trashedAt')) {
      const raw = updates.trashedAt;
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== 'string' || Number.isNaN(new Date(raw).getTime())) {
          return res.status(400).json({ error: 'trashedAt must be null or an ISO date string' });
        }
      }
      hzlUpdates.trashedAt = raw || null;
    }

    try {
      const updatedTask = hzlService.updateTask(req.params.name, req.params.id, hzlUpdates);

      if (updates.priority && updatedTask.subtaskIds && updatedTask.subtaskIds.length > 0) {
        for (const subId of updatedTask.subtaskIds) {
          try { hzlService.updateTask(req.params.name, subId, { priority: updates.priority }); } catch (e) { console.warn('[priority-cascade]', e); }
        }
      }

      let parentUpdated = null;
      if (updatedTask.parentId && updates.status && updates.status !== prevStatus) {
        try {
          parentUpdated = hzlService.recalcParentStatus(req.params.name, updatedTask.parentId);
          if (parentUpdated) {
            const allTasks = hzlService.listTasks(req.params.name);
            parentUpdated.progress = getSubtaskProgress(allTasks, updatedTask.parentId);
          }
        } catch (e) { console.warn('[recalcParent]', e); }
      }

      syncDashboardData(req.params.name);
      const response = { ok: true, task: taskWithSpecStatus(req.params.name, updatedTask) };
      if (parentUpdated) response.parentUpdated = parentUpdated;
      try {
        const r = getTaskReminder(updatedTask, 'status-change', updates.status, prevStatus);
        if (r) response.reminder = r;
      } catch (e) { console.warn('[reminder]', e); }
      return res.json(response);
    } catch (err) {
      console.error('[api]', err); return res.status(500).json({ error: 'Internal server error' });
    }
  }

  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updates = req.body;

  if (Object.prototype.hasOwnProperty.call(updates, 'specFile')) {
    const nextSpec = updates.specFile;
    if (nextSpec !== null) {
      if (typeof nextSpec !== 'string' || !nextSpec.trim()) {
        return res.status(400).json({ error: 'specFile must be a non-empty string or null' });
      }
      const resolvedSpec = path.resolve(PROJECTS_DIR, req.params.name, nextSpec);
      const projectRoot = path.resolve(PROJECTS_DIR, req.params.name) + path.sep;
      if (!resolvedSpec.startsWith(projectRoot)) {
        return res.status(400).json({ error: 'specFile path traversal not allowed' });
      }
      if (!fs.existsSync(resolvedSpec) || fs.statSync(resolvedSpec).isDirectory()) {
        return res.status(400).json({ error: `specFile target not found: ${nextSpec}` });
      }
    }
  }

  const prevStatus = task.status;
  if (updates.status === 'done' && task.status !== 'done') {
    updates.completed = new Date().toISOString().slice(0, 10);
  }
  if (updates.status && updates.status !== 'done' && task.status === 'done') {
    updates.completed = null;
  }
  const ALLOWED = ['title', 'status', 'priority', 'specFile', 'completed', 'agent'];
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      task[key] = updates[key];
    }
  }

  // Cascade priority change to subtasks
  if (updates.priority && task.subtaskIds && task.subtaskIds.length > 0) {
    for (const subId of task.subtaskIds) {
      const sub = data.tasks.find(t => t.id === subId);
      if (sub) sub.priority = updates.priority;
    }
  }

  // Recalculate parent status if this is a subtask and status changed
  let parentUpdated = null;
  if (task.parentId && updates.status && updates.status !== prevStatus) {
    try {
      parentUpdated = recalcParentStatus(data.tasks, task.parentId);
      if (parentUpdated) {
        parentUpdated.progress = getSubtaskProgress(data.tasks, task.parentId);
      }
    } catch (e) { console.warn('[recalcParent]', e); }
  }

  try {
    writeTasksFile(req.params.name, data);
    syncDashboardData(req.params.name);
    const response = { ok: true, task: taskWithSpecStatus(req.params.name, task) };
    if (parentUpdated) response.parentUpdated = parentUpdated;
    try {
      const r = getTaskReminder(task, 'status-change', updates.status, prevStatus);
      if (r) response.reminder = r;
    } catch (e) { console.warn('[reminder]', e); }
    res.json(response);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// T-161-4: DELETE /api/projects/:name/tasks/trash — Empty Trash.
// Hard-deletes every task in the project whose metadata.flowboard.trashedAt
// is set. Confirmation happens in the UI (dialog before the call); the
// server trusts the caller. Must be registered before the :id variant so
// Express does not match the literal "trash" as a task id.
app.delete('/api/projects/:name/tasks/trash', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const result = hzlService.emptyTrash(req.params.name);
    syncDashboardData(req.params.name);
    return res.json({ ok: true, removed: result.removed, failed: result.failed });
  } catch (err) {
    console.error('[api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/tasks/:id
app.delete('/api/projects/:name/tasks/:id', (req, res) => {
  if (HZL_ENABLED) {
    const task = hzlService.getTask(req.params.name, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (task.subtaskIds && task.subtaskIds.length > 0 && !req.query.mode) {
      return res.status(400).json({
        error: 'Task has subtasks',
        subtaskCount: task.subtaskIds.length
      });
    }

    // Collect spec info before deletion (task will disappear from cache after delete)
    const idsToDeleteSpecs = task.subtaskIds && req.query.mode === 'all'
      ? [task.id, ...task.subtaskIds]
      : [task.id];
    const specsToClean = [];
    for (const id of idsToDeleteSpecs) {
      const t = hzlService.getTask(req.params.name, id);
      if (t && t.specFile) specsToClean.push({ id, specFile: t.specFile });
      else specsToClean.push({ id, specFile: null });
    }

    try {
      hzlService.deleteTask(req.params.name, req.params.id, req.query.mode);
    } catch (err) {
      if (err.subtaskCount) return res.status(400).json({ error: err.message, subtaskCount: err.subtaskCount });
      console.error('[api]', err); return res.status(500).json({ error: 'Internal server error' });
    }

    // Delete spec files/links only after successful task deletion
    for (const { id, specFile } of specsToClean) {
      if (specFile) {
        try {
          const specPath = path.join(PROJECTS_DIR, req.params.name, specFile);
          if (fs.existsSync(specPath)) fs.unlinkSync(specPath);
        } catch (e) { console.warn('[delete-spec]', e); }
      }
      hzlService.setSpecLink(req.params.name, id, null);
    }

    syncDashboardData(req.params.name);
    return res.json({ ok: true });
  }

  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.subtaskIds && task.subtaskIds.length > 0) {
    // Parent with subtasks — require mode
    const mode = req.query.mode;
    if (!mode) {
      return res.status(400).json({
        error: 'Task has subtasks',
        subtaskCount: task.subtaskIds.length
      });
    }

    if (mode === 'all') {
      const idsToDelete = new Set([task.id, ...task.subtaskIds]);
      for (const t of data.tasks) {
        if (idsToDelete.has(t.id) && t.specFile) {
          try {
            const specPath = path.join(PROJECTS_DIR, req.params.name, t.specFile);
            if (fs.existsSync(specPath)) fs.unlinkSync(specPath);
          } catch (e) { console.warn('[delete-spec]', e); }
        }
      }
      data.tasks = data.tasks.filter(t => !idsToDelete.has(t.id));
    } else if (mode === 'keep-children') {
      for (const t of data.tasks) {
        if (t.parentId === task.id) {
          t.parentId = null;
        }
      }
      data.tasks = data.tasks.filter(t => t.id !== task.id);
    } else {
      return res.status(400).json({ error: 'Invalid mode. Use "all" or "keep-children"' });
    }
  } else if (task.parentId) {
    // Subtask — remove from parent's subtaskIds, recalc parent
    const parent = data.tasks.find(t => t.id === task.parentId);
    if (parent && parent.subtaskIds) {
      parent.subtaskIds = parent.subtaskIds.filter(id => id !== task.id);
      // Auto-demote: if no subtasks left, parent becomes a normal task
      if (parent.subtaskIds.length === 0) {
        parent.subtaskIds = undefined;
      }
    }
    data.tasks = data.tasks.filter(t => t.id !== task.id);
    if (parent && parent.subtaskIds) {
      try { recalcParentStatus(data.tasks, parent.id); } catch (e) { console.warn('[recalcParent]', e); }
    }
  } else {
    // Simple task — no subtasks, no parent
    data.tasks = data.tasks.filter(t => t.id !== task.id);
  }

  try {
    writeTasksFile(req.params.name, data);
    syncDashboardData(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// --- File Explorer API ---

// File loading categories
const ALWAYS_LOADED = new Set(['PROJECT.md']);
const MANDATORY_LAZY = new Set(['DECISIONS.md', 'tasks.json']);

function getFileCategory(relPath) {
  const basename = path.basename(relPath);
  if (ALWAYS_LOADED.has(basename) && !relPath.includes('/')) return 'always';
  if (MANDATORY_LAZY.has(basename) && !relPath.includes('/')) return 'lazy';
  return 'optional';
}

function buildFileTree(projectName) {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) return null;

  const entries = [];

  function walk(dir, relBase) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const relPath = relBase ? `${relBase}/${item.name}` : item.name;
      const fullPath = path.join(dir, item.name);
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) {
        entries.push({
          name: item.name,
          path: relPath,
          type: 'directory',
          children: []
        });
        walk(fullPath, relPath);
      } else {
        const stat = fs.statSync(fullPath);
        entries.push({
          name: item.name,
          path: relPath,
          type: 'file',
          size: stat.size,
          category: getFileCategory(relPath),
          modified: stat.mtime.toISOString()
        });
      }
    }
  }

  walk(projectDir, '');

  // Build nested tree
  const tree = [];
  const dirs = {};
  for (const e of entries) {
    if (e.type === 'directory') {
      dirs[e.path] = e;
    }
  }
  for (const e of entries) {
    const parent = e.path.includes('/') ? e.path.split('/').slice(0, -1).join('/') : null;
    if (parent && dirs[parent]) {
      dirs[parent].children.push(e);
    } else {
      tree.push(e);
    }
  }

  // Sort: directories first, then files; within each: always > lazy > optional
  const catOrder = { always: 0, lazy: 1, optional: 2 };
  function sortEntries(arr) {
    arr.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? 1 : -1; // files first at root
      if (a.type === 'file') {
        const ca = catOrder[a.category] ?? 2;
        const cb = catOrder[b.category] ?? 2;
        if (ca !== cb) return ca - cb;
      }
      return a.name.localeCompare(b.name);
    });
    for (const e of arr) {
      if (e.children) sortEntries(e.children);
    }
  }
  sortEntries(tree);

  // Calculate total size
  let totalSize = 0;
  for (const e of entries) {
    if (e.type === 'file') totalSize += e.size;
  }

  return { tree, totalSize, fileCount: entries.filter(e => e.type === 'file').length };
}

// GET /api/projects/:name/files
app.get('/api/projects/:name/files', (req, res) => {
  const result = buildFileTree(req.params.name);
  if (!result) return res.status(404).json({ error: 'Project not found' });
  res.json(result);
});

// GET /api/projects/:name/files/{*filePath} — read file content
app.get('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(resolved);
  if (stat.size > 500 * 1024) {
    return res.status(413).json({ error: 'File too large (max 500KB)' });
  }

  try {
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({
      path: filePath,
      content,
      size: stat.size,
      category: getFileCategory(filePath),
      modified: stat.mtime.toISOString()
    });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name/files/{*filePath} — write file content (Phase 2)
app.put('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content required' });
  if (Buffer.byteLength(content, 'utf8') > 100 * 1024) return res.status(413).json({ error: 'Content too large (max 100KB)' });

  try {
    // Ensure parent directory exists
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(resolved, content);
    const stat = fs.statSync(resolved);
    res.json({
      ok: true,
      path: filePath,
      size: stat.size,
      modified: stat.mtime.toISOString()
    });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/files/{*filePath} — delete files (only context/ and specs/)
app.delete('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  // Only allow deletion in context/ and specs/
  if (!filePath.startsWith('context/') && !filePath.startsWith('specs/')) {
    return res.status(403).json({ error: 'Only files in context/ and specs/ can be deleted' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (fs.statSync(resolved).isDirectory()) {
    return res.status(403).json({ error: 'Cannot delete directories' });
  }

  try {
    fs.unlinkSync(resolved);

    // If it was a spec file, clean up the specFile link
    if (filePath.startsWith('specs/') && filePath !== 'specs/_index.json') {
      if (HZL_ENABLED) {
        const index = hzlService.getSpecsIndex(req.params.name);
        const taskId = Object.keys(index).find(id => index[id] === filePath);
        if (taskId) hzlService.setSpecLink(req.params.name, taskId, null);
      } else {
        const tasksFile = path.join(projectDir, 'tasks.json');
        if (fs.existsSync(tasksFile)) {
          const tasksData = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
          const task = tasksData.tasks.find(t => t.specFile === filePath);
          if (task) {
            task.specFile = null;
            fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2));
          }
        }
      }
    }

    res.json({ ok: true, deleted: filePath });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/specs/:taskId — scaffold a new spec file
app.post('/api/projects/:name/specs/:taskId', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const taskId = req.params.taskId;

  // Get task (from HZL or tasks.json)
  let task;
  if (HZL_ENABLED) {
    task = hzlService.getTask(req.params.name, taskId);
    if (!task) return res.status(404).json({ error: `Task ${taskId} not found` });
  } else {
    const tasksFile = path.join(projectDir, 'tasks.json');
    if (!fs.existsSync(tasksFile)) return res.status(404).json({ error: 'tasks.json not found' });
    const tasksData = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    task = tasksData.tasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: `Task ${taskId} not found` });
  }

  if (task.specFile) {
    const existingSpec = path.join(projectDir, task.specFile);
    if (fs.existsSync(existingSpec) && !fs.statSync(existingSpec).isDirectory()) {
      return res.status(409).json({ error: 'Task already has a spec file', specFile: task.specFile });
    }
    // stale link — allow recreation
  }

  // Generate slug from title
  const slug = task.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');

  const specFilename = `${taskId}-${slug}.md`;
  const specsDir = path.join(projectDir, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });

  const specPath = path.join(specsDir, specFilename);
  const date = new Date().toISOString().slice(0, 10);
  let customContent = req.body?.content;
  // Defensive: replace literal '\n' (escaped newlines from callers) with real newlines
  if (customContent && customContent.includes('\\n')) {
    customContent = customContent.replace(/\\n/g, '\n');
  }
  const template = customContent || `# ${taskId}: ${task.title}\n\n## Goal\n\n\n## Done When\n- [ ] \n\n## Approach\n\n\n## Log\n- ${date}: Spec created\n`;

  fs.writeFileSync(specPath, template);

  const specFileRelPath = `specs/${specFilename}`;

  if (HZL_ENABLED) {
    hzlService.setSpecLink(req.params.name, taskId, specFileRelPath);
    const updatedTask = hzlService.getTask(req.params.name, taskId);
    return res.json({ ok: true, specFile: specFileRelPath, taskId, task: taskWithSpecStatus(req.params.name, updatedTask) });
  } else {
    const tasksFile = path.join(projectDir, 'tasks.json');
    const tasksData = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const legacyTask = tasksData.tasks.find(t => t.id === taskId);
    legacyTask.specFile = specFileRelPath;
    fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2));
    return res.json({ ok: true, specFile: specFileRelPath, taskId, task: taskWithSpecStatus(req.params.name, legacyTask) });
  }
});


// GET /api/projects/:name/canvas
app.get('/api/projects/:name/canvas', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
  res.json(readCanvasFile(req.params.name));
});

// POST /api/projects/:name/canvas/notes
app.post('/api/projects/:name/canvas/notes', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
  const data = readCanvasFile(req.params.name);
  const { text = '', x = 0, y = 0, color = 'yellow', size = 'small' } = req.body;
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > 50 * 1024) {
    return res.status(413).json({ error: 'Note text too large (max 50KB)' });
  }
  const note = {
    id: nextNoteId(data.notes),
    text,
    x,
    y,
    color,
    size,
    created: new Date().toISOString().slice(0, 10)
  };
  data.notes.push(note);
  try {
    writeCanvasFile(req.params.name, data);
    res.json({ ok: true, note });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name/canvas/notes/:id
app.put('/api/projects/:name/canvas/notes/:id', (req, res) => {
  const data = readCanvasFile(req.params.name);
  const note = data.notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if (typeof req.body.text === 'string' && Buffer.byteLength(req.body.text, 'utf8') > 50 * 1024) {
    return res.status(413).json({ error: 'Note text too large (max 50KB)' });
  }
  const allowed = ['text', 'x', 'y', 'color', 'size'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) note[k] = req.body[k];
  }
  try {
    writeCanvasFile(req.params.name, data);
    res.json({ ok: true, note });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/canvas/notes/batch (MUST be before :id route)
app.delete('/api/projects/:name/canvas/notes/batch', (req, res) => {
  const { noteIds } = req.body;
  if (!noteIds || !Array.isArray(noteIds) || noteIds.length === 0) {
    return res.status(400).json({ error: 'noteIds array required' });
  }
  const data = readCanvasFile(req.params.name);
  const deleteSet = new Set(noteIds);
  data.notes = data.notes.filter(n => !deleteSet.has(n.id));
  const remainingIds = new Set(data.notes.map(n => n.id));
  data.connections = data.connections.filter(
    c => remainingIds.has(c.from) && remainingIds.has(c.to)
  );
  try {
    writeCanvasFile(req.params.name, data);
    res.status(204).end();
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/canvas/notes/:id
app.delete('/api/projects/:name/canvas/notes/:id', (req, res) => {
  const data = readCanvasFile(req.params.name);
  const idx = data.notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Note not found' });
  data.notes.splice(idx, 1);
  const noteIds = new Set(data.notes.map(n => n.id));
  data.connections = data.connections.filter(c => noteIds.has(c.from) && noteIds.has(c.to));
  try {
    writeCanvasFile(req.params.name, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/canvas/connections
app.post('/api/projects/:name/canvas/connections', (req, res) => {
  const data = readCanvasFile(req.params.name);
  const { from, to, fromPort, toPort } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (from === to) return res.status(400).json({ error: 'Cannot connect note to itself' });
  const noteIds = new Set(data.notes.map(n => n.id));
  if (!noteIds.has(from) || !noteIds.has(to)) return res.status(404).json({ error: 'Note not found' });
  const existing = data.connections.find(
    c => (c.from === from && c.to === to) || (c.from === to && c.to === from)
  );
  if (existing) {
    // Connection exists — update ports if different (allows re-routing)
    if (fromPort || toPort) {
      if (existing.from === from) {
        existing.fromPort = fromPort || existing.fromPort;
        existing.toPort = toPort || existing.toPort;
      } else {
        existing.fromPort = toPort || existing.fromPort;
        existing.toPort = fromPort || existing.toPort;
      }
      try {
        writeCanvasFile(req.params.name, data);
        return res.json({ ok: true, updated: true, connection: existing });
      } catch (err) {
        console.error('[api]', err); return res.status(500).json({ error: 'Internal server error' });
      }
    }
    return res.json({ ok: true, duplicate: true });
  }
  const conn = { from, to };
  if (fromPort) conn.fromPort = fromPort;
  if (toPort) conn.toPort = toPort;
  data.connections.push(conn);
  try {
    writeCanvasFile(req.params.name, data);
    res.json({ ok: true, connection: conn });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/canvas/connections
app.delete('/api/projects/:name/canvas/connections', (req, res) => {
  const data = readCanvasFile(req.params.name);
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  data.connections = data.connections.filter(
    c => !((c.from === from && c.to === to) || (c.from === to && c.to === from))
  );
  try {
    writeCanvasFile(req.params.name, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/canvas/promote — session bridge to OpenClaw agent
app.post('/api/projects/:name/canvas/promote', async (req, res) => {
  const { notes, connections, mode } = req.body;
  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    return res.status(400).json({ error: 'notes array required' });
  }
  // Verify project exists
  const projectName = req.params.name;
  if (HZL_ENABLED) {
    if (!fs.existsSync(path.join(PROJECTS_DIR, projectName))) return res.status(404).json({ error: 'Project not found' });
  } else {
    const tasksData = readTasksFile(projectName);
    if (!tasksData) return res.status(404).json({ error: 'Project not found' });
  }

  // Format structured message for agent
  const noteLines = notes
    .map(n => `- ${n.id} (${n.color || 'grey'}): "${(n.text || '').replace(/"/g, '\\"')}"`)
    .join('\n');
  const connLines = (connections || [])
    .map(c => `${c.from} → ${c.to}`)
    .join(', ') || 'none';

  // Fire-and-forget: respond immediately, webhook runs async
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN;

  if (!hooksToken) {
    console.error('Promote bridge: OPENCLAW_HOOKS_TOKEN not set');
    return res.status(503).json({ error: 'Agent not configured — hooks token missing' });
  }

  const sourceNoteIds = notes.map(n => n.id);
  const agentId = req.body.agentId || 'default';

  // Create Specify session (errors on duplicate notes or concurrent agent session)
  let session;
  try {
    session = specifySession.createSession({
      project: projectName,
      origin: 'canvas',
      sourceNoteIds,
      agentId,
    });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  const message = `[SPECIFY_SESSION]
Session: ${session.id}
Project: ${projectName}
Origin: canvas
Mode: ${mode || 'single'}

Notes:
${noteLines}
Connections: ${connLines}

--- Specify Instructions ---
Start a Specify session for this input. Follow the Specify workflow from context/specify-prompt.md:

1. ANALYZE: Assess the input across 5 categories (Scope, Users, Data, Behavior, Constraints). Decide: Simple or Complex.
2. CLARIFY (if Complex): Ask max 4 questions, one at a time, with recommended answer.
3. GENERATE: Write a spec following context/specify-spec-template.md. Decide task structure (1 task, parent+subtasks, or parent+subtasks with individual specs).
4. CONFIRM: Show summary to user. Wait for explicit confirmation before persisting.
5. PERSIST (in order): Write spec file(s) → Create task(s) via API → Delete canvas notes via batch-delete.
6. DONE: Send confirmation message.

Dashboard API: http://localhost:${PORT}/api
Source Note IDs for cleanup: ${JSON.stringify(sourceNoteIds)}

If user cancels: persist nothing, notes stay. Call POST /api/specify/sessions/${session.id}/abort
If spec write fails: stop, inform user. Call POST /api/specify/sessions/${session.id}/abort
If task create fails: delete spec file, inform user. Call POST /api/specify/sessions/${session.id}/abort
When fully done: Call POST /api/specify/sessions/${session.id}/complete`;

  // Send immediately, don't await
  res.json({ ok: true, message: 'Idea sent to agent', sessionId: session.id });

  try {
    // T-177-3: route promote-trigger to the agent that issued the promote
    // request, if known. Caller (UI / scripted client) may pass agentId in
    // the request body; if absent, gateway routes/broadcasts.
    const triggerAgentId = req.body?.agentId;
    const hookRes = await fetch(`${gatewayUrl}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({
        message,
        name: 'Canvas Specify',
        agentId: triggerAgentId,
        sessionKey: triggerAgentId ? `agent:${triggerAgentId}:main` : undefined,
        wakeMode: 'now',
      }),
    });
    if (!hookRes.ok) {
      console.error('Promote webhook error:', hookRes.status, await hookRes.text());
    }
  } catch (err) {
    console.error('Promote webhook error:', err.message || err);
  }
});

// (batch delete route is above the :id route to prevent Express param capture)

// --- Specify Session Management Routes ---

// GET /api/specify/sessions — list sessions (optional ?project=, ?status= filters)
app.get('/api/specify/sessions', (req, res) => {
  try {
    const sessions = specifySession.listSessions({
      project: req.query.project || undefined,
      status: req.query.status || undefined,
    });
    res.json(sessions);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/specify/sessions/:id — get session details
app.get('/api/specify/sessions/:id', (req, res) => {
  try {
    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/specify/sessions/:id/abort — abort a session
app.post('/api/specify/sessions/:id/abort', (req, res) => {
  try {
    const session = specifySession.abortSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/specify/sessions/:id/complete — mark session as done
app.post('/api/specify/sessions/:id/complete', (req, res) => {
  try {
    const session = specifySession.completeSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// Phase 5: Coordination Primitives — Claim, Checkpoint, Complete, Comment, Stuck, Handoff
// =============================================================================

// POST /api/projects/:name/tasks/:id/claim
app.post('/api/projects/:name/tasks/:id/claim', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const { agent, lease } = req.body;
    const task = hzlService.claimTask(req.params.name, req.params.id, { agent, lease });
    res.json({ ok: true, task });
  } catch (err) {
    const status = err.code === 'PARENT_NOT_CLAIMABLE' ? 409
                 : err.code === 'ROUTING_MISMATCH' ? 403
                 : err.code === 'ALREADY_CLAIMED' ? 409
                 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/release
app.post('/api/projects/:name/tasks/:id/release', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const { agent, force } = req.body;
    const result = hzlService.releaseTask(req.params.name, req.params.id, { agent, force });
    res.json(result);
  } catch (err) {
    const status = err.code === 'NOT_OWNER' ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/complete
app.post('/api/projects/:name/tasks/:id/complete', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const { agent } = req.body;
    const task = hzlService.completeTask(req.params.name, req.params.id, { agent });
    // Recalculate parent status if this is a subtask
    const full = hzlService.getTask(req.params.name, req.params.id);
    if (full && full.parentId) {
      hzlService.recalcParentStatus(req.params.name, full.parentId);
    }
    res.json({ ok: true, task });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.code === 'AGENT_REQUIRED' || err.code === 'NOT_OWNER' ? 403
                 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/checkpoint
app.post('/api/projects/:name/tasks/:id/checkpoint', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const { message, agent, progress } = req.body;
    const checkpoint = hzlService.addCheckpoint(req.params.name, req.params.id, { message, agent, progress });
    res.json({ ok: true, checkpoint });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : err.code === 'NOT_OWNER' ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/projects/:name/tasks/:id/checkpoints
app.get('/api/projects/:name/tasks/:id/checkpoints', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const checkpoints = hzlService.getCheckpoints(req.params.name, req.params.id);
    res.json({ ok: true, checkpoints });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/comment
app.post('/api/projects/:name/tasks/:id/comment', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const { message, author } = req.body;
    const comment = hzlService.addComment(req.params.name, req.params.id, { message, author });
    res.json({ ok: true, comment });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/projects/:name/tasks/:id/comments
app.get('/api/projects/:name/tasks/:id/comments', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const comments = hzlService.getComments(req.params.name, req.params.id);
    res.json({ ok: true, comments });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// T-161-4: status events stream. Third activity surface alongside
// comments and checkpoints — sourced from the HZL event store so
// things like block/unblock/route/status-change survive panel close
// and are visible to anyone viewing the task, not just the actor.
app.get('/api/projects/:name/tasks/:id/events', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const events = hzlService.getStatusEvents(req.params.name, req.params.id);
    res.json({ ok: true, events });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/tasks/stuck — cross-project stuck tasks (stale + expired)
app.get('/api/tasks/stuck', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const staleThreshold = req.query.staleThreshold !== undefined ? Math.max(0, parseInt(req.query.staleThreshold) || 0) : 10;
    const stuck = hzlService.getStuckTasks({ staleThreshold });
    res.json({ ok: true, stuck });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:name/tasks/:id/handoff — handoff context for CC/ACP spawning
app.get('/api/projects/:name/tasks/:id/handoff', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const context = hzlService.getHandoffContext(req.params.name, req.params.id);
    res.json({ ok: true, ...context });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/route — route a task to a specific agent
app.post('/api/projects/:name/tasks/:id/route', (req, res) => {
  if (!HZL_ENABLED) return res.status(503).json({ error: 'HZL not enabled' });
  try {
    const { agent } = req.body;
    const task = hzlService.routeTask(req.params.name, req.params.id, agent);
    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// =============================================================================
// Hook Receiver — receives on_done callbacks from HZL's hook_outbox
// =============================================================================

app.post('/api/hooks/task-complete', (req, res) => {
  // Called by HookDrainService when a task transitions to done/archived
  // Requires internal hooks token — Telegram auth alone is not sufficient
  // S-02: Timing-safe comparison to prevent timing side-channel attacks
  const hookToken = req.headers['x-hooks-token'] || '';
  const hookBuf = Buffer.from(hookToken, 'utf8');
  const expectedBuf = Buffer.from(HOOKS_TOKEN, 'utf8');
  if (!HOOKS_TOKEN || hookBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(hookBuf, expectedBuf)) {
    return res.status(403).json({ error: 'Invalid or missing hooks token' });
  }
  const payload = req.body;
  console.log('[hook] Task complete notification:', JSON.stringify(payload));
  res.json({ ok: true });
});

// =============================================================================

async function startServer() {
  if (HZL_ENABLED) {
    console.log('[hzl-service] HZL_ENABLED=true, initializing...');
    await hzlService.init(HZL_DB_PATH);
    console.log('[hzl-service] Ready.');

    // Init FlowBoard metadata tables (creates flowboard_projects, flowboard_agents, flowboard_migrations)
    fbMeta.init(hzlService.getCacheDb());

    // Run all pending migrations via the registry. agentId is read directly
    // from OPENCLAW_AGENT_ID env (legacy operator hint, only used by the
    // one-time m003 backfill of ACTIVE-PROJECT.md → flowboard_agents). When
    // unset (the new normal post-T-177-3), m003 logs and skips. The
    // migration is idempotent and already applied on existing installs.
    const migrations = require('./migrations.js');
    migrations.runPending(hzlService.getCacheDb(), {
      hzlService,
      fbMeta,
      projectsDir:       PROJECTS_DIR,
      indexFile:         INDEX_FILE,
      getDisplayName,
      agentId:           process.env.OPENCLAW_AGENT_ID || null,
      activeProjectFile: ACTIVE_PROJECT_FILE,
      openclawHome:      OPENCLAW_HOME,
      sharedProjectsDir: SHARED_PROJECTS_DIR,
    });

    // Completion notification callback — sends to gateway when a task is completed.
    // T-177-3: route to the agent that completed the task (from event payload),
    // not to a static service-default agent.
    hzlService.setOnComplete(({ project, taskId, title, agent }) => {
      const gatewayUrl = process.env.GATEWAY_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 18789}`;
      const token = process.env.HOOKS_TOKEN || '';
      const msg = `✅ Task ${taskId} "${title}" completed by ${agent || 'unknown'} (${project})`;
      fetch(`${gatewayUrl}/hooks/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          text: msg,
          agentId: agent || undefined,
          sessionKey: agent ? `agent:${agent}:main` : undefined,
        }),
      }).catch(e => console.warn('[notify] Gateway unreachable:', e.message));
    });

    // Hook drain — process outbox every 2 minutes
    setInterval(async () => {
      try {
        const result = await hzlService.drainHooks();
        if (result.delivered > 0) console.log(`[hook-drain] Delivered ${result.delivered} hooks`);
      } catch (e) { console.warn('[hook-drain] Error:', e.message); }
    }, 2 * 60 * 1000);

    // Stale-check — detect stuck tasks every 5 minutes, notify via gateway
    setInterval(() => {
      try {
        const staleMinutes = parseInt(process.env.STALE_THRESHOLD_MINUTES) || 30;
        const stuck = hzlService.getStuckTasks({ staleThreshold: staleMinutes });
        if (stuck.stale.length > 0 || stuck.expired.length > 0) {
          const parts = [];
          for (const t of stuck.stale) parts.push(`⚠️ Stale: ${t.id} "${t.title}" (${t.agent}, ${t.staleSinceMinutes}min ohne Checkpoint)`);
          for (const t of stuck.expired) parts.push(`🔴 Lease expired: ${t.id} "${t.title}" (${t.agent})`);
          const msg = `🔍 Stuck-Check:\n${parts.join('\n')}`;

          // T-177-3: stale-check is a periodic broadcast — no caller agent
          // context, so no agentId/sessionKey routing. Gateway handles default
          // delivery. Per-agent grouping is a possible UX improvement (open
          // follow-up), but routing to a single static agent is wrong.
          const gatewayUrl = process.env.GATEWAY_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 18789}`;
          const token = process.env.HOOKS_TOKEN || '';
          fetch(`${gatewayUrl}/hooks/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({
              text: msg,
            }),
          }).catch(e => console.warn('[stale-check] Gateway unreachable:', e.message));
        }
      } catch (e) { console.warn('[stale-check] Error:', e.message); }
    }, 5 * 60 * 1000);

    // Auto-migrate: if any tasks.json files exist, migrate them (idempotent per-task)
    const projectsDir = path.join(WORKSPACE, 'projects');
    const hasTasksJson = fs.readdirSync(projectsDir).some(name =>
      fs.existsSync(path.join(projectsDir, name, 'tasks.json'))
    );
    if (hasTasksJson) {
      console.log('[auto-migrate] Found tasks.json files — migrating...');
      try {
        const { autoMigrate } = require('./migrate-tasks');
        const result = await autoMigrate(hzlService, HZL_DB_PATH);
        console.log(`[auto-migrate] Done: ${result.totalCreated} created, ${result.totalSkipped} skipped, ${result.totalErrors} errors, ${result.renamed.length} projects renamed`);
        // Rebuild RAM cache to pick up patched created dates
        if (result.totalCreated > 0) {
          await hzlService.rebuildCache();
          console.log('[auto-migrate] RAM cache rebuilt with corrected dates.');
        }
      } catch (e) {
        console.error('[auto-migrate] Migration failed:', e.message);
        console.error('[auto-migrate] Server continues with current HZL state. Run migrate-tasks.js manually.');
      }
    }
  }
  // Cleanup expired Specify sessions every 30 minutes
  setInterval(() => {
    const aborted = specifySession.cleanupExpired();
    if (aborted > 0) console.log(`[specify] Cleaned up ${aborted} expired sessions`);
  }, 30 * 60 * 1000);

  app.listen(PORT, HOST, () => {
    console.log(`Dashboard API running on http://${HOST}:${PORT}`);
  });
}
startServer().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
