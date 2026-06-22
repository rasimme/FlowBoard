const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { renderSnippetBaseUrl, resolveDashboardBaseUrl } = require('./flowboard-url.cjs');

const app = express();
const PORT = parseInt(process.env.FLOWBOARD_PORT, 10) || 18790;
// S-17: Default to localhost — Cloudflare Tunnel connects via 127.0.0.1 anyway
const HOST = process.env.FLOWBOARD_HOST || '127.0.0.1';

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, '.openclaw', 'workspace');
const OPENCLAW_HOME = path.resolve(WORKSPACE, '..');
const SHARED_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || path.join(OPENCLAW_HOME, 'projects');
const PROJECTS_DIR = fs.existsSync(SHARED_PROJECTS_DIR) ? SHARED_PROJECTS_DIR : path.join(WORKSPACE, 'projects');
// LEGACY (T-161): file read by m003-active-project-to-db migration only;
// flowboard_agents table is now the source of truth. No code writes this.
const ACTIVE_PROJECT_FILE = path.join(WORKSPACE, 'ACTIVE-PROJECT.md');
const INDEX_FILE = path.join(PROJECTS_DIR, '_index.md');

const HZL_DB_PATH = process.env.HZL_DB_PATH || path.join(WORKSPACE, '.hzl', 'flowboard.db');
const HZL_INTEGRITY_STRICT = process.env.HZL_INTEGRITY_STRICT === 'true';
const INTEGRITY_WEBHOOK_URL = process.env.INTEGRITY_WEBHOOK_URL || '';
const INTEGRITY_WEBHOOK_TOKEN = process.env.INTEGRITY_WEBHOOK_TOKEN || '';
const hzlService = require('./hzl-service.js');
const fbMeta = require('./flowboard-metadata.js');
const hzlIntegrity = require('./hzl-integrity.js');
// Boot-time integrity snapshot — set by startServer(), exposed via
// GET /api/health/integrity. Null until the check has run at least once.
let _bootIntegrity = null;
// AGENT_ID was a service-default-identity that defaulted to OPENCLAW_AGENT_ID
// or "main". It silently routed agent-less callers into a foreign agent's row
// (T-177 trace 2026-04-29). Removed in favour of explicit agentId on every
// per-agent call (T-177-2) and routing-by-action-context for outbound paths
// (T-177-3 Option C). The dashboard service has no own identity.
const specifySession = require('./specify-sessions');
const specifyWorkerBridge = require('./specify-worker-bridge');
const specifyWorkerOpenclaw = require('./specify-worker-openclaw');
const specifyPolicy = require('./specify-policy');

// Production Specify worker: OpenClaw CLI one-shot adapter (T-262-11).
// Tests configure their own (fake) adapter; SPECIFY_WORKER_DISABLED opts out.
if (process.env.NODE_ENV !== 'test' && process.env.SPECIFY_WORKER_DISABLED !== 'true') {
  specifyWorkerBridge.setWorkerAdapter(specifyWorkerOpenclaw.createOpenClawCliAdapter());
} else if (process.env.NODE_ENV === 'test' && process.env.SPECIFY_WORKER_MOCK) {
  // Regression tests (T-262-13) inject a scripted worker into the spawned
  // server. Only honored under NODE_ENV=test.
  specifyWorkerBridge.setWorkerAdapter(require(process.env.SPECIFY_WORKER_MOCK));
}
const rulesApi = require('./rules-api.js');
const snippetsDoctor = require('./snippets-doctor.js');
const agentIdentity = require('./agent-identity.js');
const taskTransitionGuard = require('./task-transition-guard.js');
const { autoPlaceNote } = require('./canvas-placement.js');
const versionCheck = require('./version-check.js');
const { updateSpawnEnv } = require('./update-env.js');
const overview = require('./overview.js');
const github = require('./github.js');
const { isEditorVisible } = require('./file-visibility.js');
const { buildStuckNotifications } = require('./stuck-notify.js');
const { formatSessionEntry, insertEntry } = require('./session-log.js');

// Gateway webhook config (for project-switch wake events).
// Resolution contract (docs/reference/env-vars.md): OPENCLAW_-prefixed vars
// take precedence over their bare aliases; URL form wins over port-only form.
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || process.env.GATEWAY_URL
  || `http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || process.env.HOOKS_TOKEN || '';
const FLOWBOARD_NOTIFICATION_CHANNEL = process.env.FLOWBOARD_NOTIFICATION_CHANNEL
  || process.env.STUCK_NOTIFICATION_CHANNEL
  || 'telegram';
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
const TELEGRAM_AGENT_IDS = (process.env.FLOWBOARD_TELEGRAM_AGENT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const JWT_SECRET = process.env.JWT_SECRET || '';
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
const FLOWBOARD_NOTIFICATION_TARGET = process.env.FLOWBOARD_NOTIFICATION_TARGET
  || process.env.FLOWBOARD_NOTIFICATION_TO
  || (FLOWBOARD_NOTIFICATION_CHANNEL === 'telegram' && ALLOWED_USER_IDS.length === 1
    ? String(ALLOWED_USER_IDS[0])
    : '');
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

function flowboardNotificationDelivery() {
  return {
    channel: FLOWBOARD_NOTIFICATION_CHANNEL,
    ...(FLOWBOARD_NOTIFICATION_TARGET ? {
      target: FLOWBOARD_NOTIFICATION_TARGET,
      to: FLOWBOARD_NOTIFICATION_TARGET,
    } : {}),
  };
}
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
  let matchedBotIndex = -1;
  const isValid = TELEGRAM_BOT_TOKENS.some((token, index) => {
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const checkBuf = Buffer.from(checkHash, 'utf8');
    const hashBuf = Buffer.from(hash, 'utf8');
    if (checkBuf.length !== hashBuf.length) return false;
    const valid = crypto.timingSafeEqual(checkBuf, hashBuf);
    if (valid) matchedBotIndex = index;
    return valid;
  });

  if (!isValid) return null;
  const user = JSON.parse(params.get('user') || 'null');
  if (!user || !ALLOWED_USER_IDS.includes(user.id)) return null;
  const mappedAgentId = TELEGRAM_AGENT_IDS[matchedBotIndex] || null;
  if (mappedAgentId) user.agentId = mappedAgentId;
  return user;
}

// Session token helpers (T-355): single source for TTL, cookie flags, the
// pinned HMAC algorithm, and the verify/issue logic that was previously copied
// inline several times in the auth middleware.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const SESSION_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'none', maxAge: SESSION_TTL_MS };
// Pin HS256 so a token cannot be presented under a different (or "none") alg.
function verifySession(token) { return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); }
function issueSession(res, user) {
  const sessionToken = jwt.sign(
    { id: user.id, username: user.username, agentId: user.agentId || null },
    JWT_SECRET, { expiresIn: '8h', algorithm: 'HS256' }
  );
  res.cookie('flowboard_session', sessionToken, SESSION_COOKIE_OPTS);
}
// Shared challenge: accept a valid session cookie, else validate Telegram
// init-data and mint a session, else 403. Identical for tunnel and direct paths.
function authenticateOrChallenge(req, res, next) {
  const token = req.cookies?.flowboard_session;
  if (token) {
    try { req.user = verifySession(token); return next(); } catch { /* expired/invalid → fall through */ }
  }
  const user = validateTelegramWebApp(req.headers['x-telegram-init-data']);
  if (!user) {
    console.warn(`[auth] Failed attempt from ${req.headers['cf-connecting-ip'] || req.ip} — ${new Date().toISOString()}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  issueSession(res, user);
  req.user = user;
  return next();
}

function telegramAuthMiddleware(req, res, next) {
  // Cloudflare Tunnel bypass: cloudflared connects from 127.0.0.1 so IP check can't distinguish
  // local vs external. cf-ray is ONLY set by Cloudflare edge — if present, request is external.
  // Cloudflare Tunnel bypass: cloudflared connects from 127.0.0.1 so the IP
  // check can't distinguish local vs external. cf-ray is ONLY set by the
  // Cloudflare edge — if present, the request is external and must authenticate.
  if (req.headers['cf-ray']) {
    if (!AUTH_ENABLED) {
      // Auth not configured but request is external via tunnel — block it
      console.warn(`[auth] Blocked tunnel request — auth not configured. cf-connecting-ip=${req.headers['cf-connecting-ip']} ${new Date().toISOString()}`);
      return res.status(403).json({ error: 'Auth not configured — tunnel access denied' });
    }
    return authenticateOrChallenge(req, res, next);
  }
  if (!AUTH_ENABLED) {
    // Fail-closed: only allow localhost when auth is not configured (direct local access only)
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
    return res.status(403).json({ error: 'Auth not configured — only localhost access permitted' });
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
  return authenticateOrChallenge(req, res, next);
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
  // Skip ONLY genuinely-local requests. cloudflared connects from 127.0.0.1, so
  // without excluding the tunnel marker (cf-ray) every external request would be
  // treated as local and skip the limit entirely (T-355). Tunneled requests are
  // keyed by their real client IP below.
  skip: (req) => !req.headers['cf-ray'] && (req.ip === '127.0.0.1' || req.ip === '::1'),
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

// Warn loud when the frontend was never built — a fresh clone has no dist/
// (gitignored) and would otherwise 500 on every page without a hint (T-288-4).
// The API stays up (CI and headless/agent installs need it), only the UI
// route explains what is missing.
const DIST_BUILT = fs.existsSync(path.join(__dirname, 'dist', 'index.html'));
if (!DIST_BUILT) {
  console.error(
    '[startup] ⚠️  dashboard/dist/index.html not found — the frontend is not built.\n' +
    '[startup] ⚠️  Run "npm run build" in the dashboard/ directory to serve the UI.'
  );
}

// Serve index.html with injected config (from dist/ — never serve raw source)
app.get('/', (req, res) => {
  if (!DIST_BUILT && !fs.existsSync(path.join(__dirname, 'dist', 'index.html'))) {
    res.status(503).type('html').send(
      '<!doctype html><title>FlowBoard — build required</title>' +
      '<body style="font-family:system-ui;background:#12141a;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div><h1>Frontend not built yet</h1>' +
      '<p>Run <code style="background:#262a35;padding:2px 6px;border-radius:4px">npm run build</code> in the <code>dashboard/</code> directory, then restart the server.</p>' +
      '<p style="color:#71717a">The FlowBoard API is running normally on this port.</p></div></body>'
    );
    return;
  }
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizeTaskBreakdown(proposal) {
  const raw = proposal?.taskBreakdown || proposal?.tasks || proposal?.subtasks || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{
      title: proposal?.summary || proposal?.title || 'Specify task',
      description: proposal?.summary || proposal?.specContent || '',
      priority: 'medium',
    }];
  }
  return raw.map((item, idx) => {
    if (typeof item === 'string') {
      return { title: item, description: '', priority: 'medium', role: null, specContent: null };
    }
    return {
      title: item.title || item.name || `Specify task ${idx + 1}`,
      description: item.description || item.summary || '',
      priority: normalizePriority(item.priority) || 'medium',
      role: item.role === 'parent' || item.role === 'subtask' ? item.role : null,
      specContent: typeof item.specContent === 'string' && item.specContent.trim() ? item.specContent : null,
    };
  });
}

function persistSpecifyProposal(session, opts = {}) {
  // Note cleanup is the default; the proposal confirm step offers an opt-out
  // checkbox (customizations.cleanupNotes === false keeps the notes).
  const cleanupNotes = opts.cleanupNotes !== false;
  const proposal = session.draftProposal;
  if (!proposal) throw new Error('No draft proposal to persist');

  const tasks = normalizeTaskBreakdown(proposal);
  const specContent = proposal.specContent || [
    `# ${proposal.summary || tasks[0]?.title || 'Specify proposal'}`,
    '',
    '## Goal',
    proposal.summary || tasks[0]?.title || '',
  ].join('\n');

  // Structure walk (decomposition rules in specify-workflow.md):
  //  * explicit roles: each role=parent entry starts a group, role=subtask
  //    entries attach to the closest preceding parent ("Multiple parents")
  //  * no roles + taskStructure "Parent ...": first entry parent, rest subtasks
  //  * otherwise: standalone task(s)
  // Specs go through the canonical path (writeSpecFileForTask). The session
  // spec attaches to the first parent (or single task); entries may carry
  // their own specContent ("... with individual specs" / multi-parent).
  const usesRoles = tasks.some(t => t.role);
  const legacyParentMode = !usesRoles && /^parent/i.test(proposal.taskStructure || '') && tasks.length > 1;

  const createdTaskIds = [];
  const cleanedNoteIds = [];
  const specFiles = [];

  try {
    let currentParentId = null;
    let sessionSpecPlaced = false;
    tasks.forEach((taskDef, idx) => {
      const role = usesRoles
        ? (taskDef.role || 'subtask')
        : (legacyParentMode ? (idx === 0 ? 'parent' : 'subtask') : 'standalone');
      const parentId = role === 'subtask' ? currentParentId : null;

      const task = hzlService.createTask(session.project, {
        title: taskDef.title,
        description: taskDef.description,
        priority: taskDef.priority,
        parentId,
        // New Specify tasks land in Backlog (Kanban semantics) — picking
        // them up into Open is a deliberate user/agent decision.
        status: 'backlog',
      });
      createdTaskIds.push(task.id);
      if (role === 'parent') currentParentId = task.id;

      let entrySpec = taskDef.specContent;
      if (!sessionSpecPlaced && role !== 'subtask') {
        entrySpec = specContent || entrySpec;
        sessionSpecPlaced = true;
      }
      if (entrySpec) {
        specFiles.push(writeSpecFileForTask(session.project, task, entrySpec));
      }
    });

    // Defensive: a breakdown of only subtask-role entries (policy-invalid,
    // but reachable via permissive callers) would otherwise drop the session
    // spec entirely — anchor it to the first created task.
    if (!sessionSpecPlaced && specContent && createdTaskIds.length > 0) {
      const firstTask = hzlService.getTask(session.project, createdTaskIds[0]);
      if (firstTask) specFiles.push(writeSpecFileForTask(session.project, firstTask, specContent));
    }

    if (cleanupNotes && session.origin === 'canvas' && session.sourceNoteIds?.length > 0) {
      // ADR-0016 "notes deleted last" — runs through the same dual-read
      // switch as the canvas endpoints (T-344-2), so migrated projects clean
      // up in the DB and unmigrated ones in canvas.json.
      const result = canvasBackend(session.project)
        .canvasDeleteNotesBatch(session.project, session.sourceNoteIds);
      if (result.deleted > 0) {
        cleanedNoteIds.push(...session.sourceNoteIds);
      }
    }

    return {
      specFiles,
      taskIds: createdTaskIds,
      cleanedNoteIds,
    };
  } catch (err) {
    // Roll back partial writes: spec files first, then created task records
    // (subtasks before the parent so parent archiving never blocks).
    // Rollback failures must be visible — silent leftovers look like bugs.
    for (const rel of specFiles) {
      try {
        fs.rmSync(path.join(PROJECTS_DIR, session.project, rel), { force: true });
      } catch (e) {
        console.warn(`[specify] rollback: failed to remove spec ${rel}: ${e.message}`);
      }
    }
    for (const id of [...createdTaskIds].reverse()) {
      try {
        hzlService.deleteTask(session.project, id, 'all');
      } catch (e) {
        console.warn(`[specify] rollback: failed to remove task ${id}: ${e.message} — manual cleanup may be needed`);
      }
    }
    throw err;
  }
}

function nextNoteId(notes) {
  let max = 0;
  for (const n of notes) {
    const m = n.id.match(/N-(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `N-${String(max + 1).padStart(3, '0')}`;
}

// --- Canvas dual-read switch (T-344-2) ---
// Per-project backend selection: projects flagged in canvas_meta.migrated_at
// use the DB store (hzl-service canvas* functions); unmigrated projects keep
// the legacy canvas.json behavior byte-for-byte. canvasBackend() is the ONLY
// switch — the 8 canvas endpoints and the Specify PERSIST cleanup all go
// through it. Both backends share one calling convention: same function
// names/signatures as the hzl-service store, errors carry `.status`
// (400/404/413) with the exact legacy messages.

function canvasHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertCanvasNoteTextSize(text) {
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > 50 * 1024) {
    throw canvasHttpError(413, 'Note text too large (max 50KB)');
  }
}

// Legacy file backend — the former endpoint bodies, moved verbatim behind the
// store interface (readCanvasFile/writeCanvasFile stay the source of truth
// for unmigrated projects).
const fileCanvasStore = {
  canvasGet(project) {
    return readCanvasFile(project);
  },
  canvasCreateNote(project, { text = '', x = 0, y = 0, color = 'yellow', size = 'small' } = {}) {
    assertCanvasNoteTextSize(text);
    const data = readCanvasFile(project);
    const note = {
      id: nextNoteId(data.notes),
      text,
      x,
      y,
      color,
      size,
      created: new Date().toISOString().slice(0, 10),
    };
    data.notes.push(note);
    writeCanvasFile(project, data);
    return { ok: true, note };
  },
  canvasUpdateNote(project, id, fields = {}) {
    const data = readCanvasFile(project);
    const note = data.notes.find(n => n.id === id);
    if (!note) throw canvasHttpError(404, 'Note not found');
    assertCanvasNoteTextSize(fields.text);
    const allowed = ['text', 'x', 'y', 'color', 'size'];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) note[k] = fields[k];
    }
    writeCanvasFile(project, data);
    return { ok: true, note };
  },
  canvasDeleteNote(project, id) {
    const data = readCanvasFile(project);
    const idx = data.notes.findIndex(n => n.id === id);
    if (idx === -1) throw canvasHttpError(404, 'Note not found');
    data.notes.splice(idx, 1);
    const noteIds = new Set(data.notes.map(n => n.id));
    data.connections = data.connections.filter(c => noteIds.has(c.from) && noteIds.has(c.to));
    writeCanvasFile(project, data);
    return { ok: true };
  },
  canvasDeleteNotesBatch(project, noteIds) {
    if (!noteIds || !Array.isArray(noteIds) || noteIds.length === 0) {
      throw canvasHttpError(400, 'noteIds array required');
    }
    const data = readCanvasFile(project);
    const deleteSet = new Set(noteIds);
    const before = data.notes.length;
    data.notes = data.notes.filter(n => !deleteSet.has(n.id));
    const remainingIds = new Set(data.notes.map(n => n.id));
    data.connections = data.connections.filter(
      c => remainingIds.has(c.from) && remainingIds.has(c.to)
    );
    writeCanvasFile(project, data);
    return { ok: true, deleted: before - data.notes.length };
  },
  canvasSaveConnection(project, { from, to, fromPort, toPort } = {}) {
    if (!from || !to) throw canvasHttpError(400, 'from and to required');
    if (from === to) throw canvasHttpError(400, 'Cannot connect note to itself');
    const data = readCanvasFile(project);
    const noteIds = new Set(data.notes.map(n => n.id));
    if (!noteIds.has(from) || !noteIds.has(to)) throw canvasHttpError(404, 'Note not found');
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
        writeCanvasFile(project, data);
        return { ok: true, updated: true, connection: existing };
      }
      return { ok: true, duplicate: true };
    }
    const conn = { from, to };
    if (fromPort) conn.fromPort = fromPort;
    if (toPort) conn.toPort = toPort;
    data.connections.push(conn);
    writeCanvasFile(project, data);
    return { ok: true, connection: conn };
  },
  canvasDeleteConnection(project, { from, to } = {}) {
    if (!from || !to) throw canvasHttpError(400, 'from and to required');
    const data = readCanvasFile(project);
    data.connections = data.connections.filter(
      c => !((c.from === from && c.to === to) || (c.from === to && c.to === from))
    );
    writeCanvasFile(project, data);
    return { ok: true };
  },
};

/** The dual-read switch: DB store for migrated projects, file store otherwise. */
function canvasBackend(project) {
  return hzlService.canvasIsMigrated(project) ? hzlService : fileCanvasStore;
}

// --- Canvas migration workflow (T-344-3) ---
// Detection + gated import of legacy canvas.json files into the DB store.
// canvasImportFromJson (T-344-1) does the transactional write; the helpers
// here only orchestrate: validate file -> import -> verify counts -> flip the
// dual-read switch -> rename the file to canvas.json.pre-db.bak. The file is
// NEVER deleted, and only renamed AFTER the import has been verified.

/**
 * Apply the same cleanup the import applies, without writing anything:
 * notes without a string id dropped, duplicate note ids collapsed, orphaned
 * connections dropped (readCanvasFile parity), reverse duplicates dropped
 * (undirected invariant, first wins). Count verification after an import
 * compares the DB against THESE cleaned counts, not the raw file counts.
 */
function cleanCanvasData(data) {
  const noteIds = new Set();
  for (const n of data.notes || []) {
    if (n && typeof n.id === 'string') noteIds.add(n.id);
  }
  const seen = new Set();
  let connections = 0;
  for (const c of data.connections || []) {
    if (!c || !c.from || !c.to) continue;
    if (!noteIds.has(c.from) || !noteIds.has(c.to)) continue;
    if (seen.has(`${c.from}|${c.to}`) || seen.has(`${c.to}|${c.from}`)) continue;
    seen.add(`${c.from}|${c.to}`);
    connections += 1;
  }
  return { notes: noteIds.size, connections };
}

/** Scan PROJECTS_DIR for unmigrated projects that still have a canvas.json. */
function scanPendingCanvasMigrations() {
  let entries = [];
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const pending = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!sanitizeProjectName(name)) continue;
    const file = path.join(PROJECTS_DIR, name, 'canvas.json');
    if (!fs.existsSync(file)) continue;
    if (hzlService.canvasIsMigrated(name)) continue;
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch {}
    // Tolerant read for display counts: corrupt files show 0/0 here and fail
    // loudly in the run step (which parses strictly).
    const cleaned = cleanCanvasData(readCanvasFile(name));
    pending.push({ project: name, notes: cleaned.notes, connections: cleaned.connections, bytes });
  }
  pending.sort((a, b) => a.project.localeCompare(b.project));
  return pending;
}

// --- Canvas conflict detection (T-344-5, ADR-0018) ---
// A workspace restore from a pre-migration backup (or a failed post-import
// rename, T-344-3) can put a canvas.json back next to a project whose canvas
// data already lives in the DB. The dual-read switch keeps serving the DB —
// the file is ignored but may hold edits the DB never saw, so resolution is
// strictly an operator decision (T-344-8 docs): inspect the file, then delete
// it or re-import deliberately. NEVER auto-merge, never silently overwrite in
// either direction. Only the literal `canvas.json` counts — `.pre-db.bak` and
// `.pre-db.bak.<epoch>` files are legitimate migration leftovers.
//
// NOT a conflict: imported rows in the DB while migrated_at is unset (a run
// that failed count verification). The dual-read switch still serves the
// file, the project stays `pending`, and a later successful run repairs the
// state via the transactional re-import. Harmless by design — no alarm.

// Warn once per project per process — the status endpoint is polled by the
// UI banner and must not flood the log with the same conflict.
const _warnedCanvasConflicts = new Set();

/** Scan for migrated projects that have a literal canvas.json again. */
function scanCanvasConflicts() {
  let rows = [];
  try {
    rows = hzlService.getEventsDb()
      .prepare('SELECT project, migrated_at FROM canvas_meta WHERE migrated_at IS NOT NULL ORDER BY project')
      .all();
  } catch {
    return [];
  }
  const conflicts = [];
  for (const row of rows) {
    if (!sanitizeProjectName(row.project)) continue;
    const file = path.join(PROJECTS_DIR, row.project, 'canvas.json');
    let stat;
    try { stat = fs.statSync(file); } catch { continue; } // exact name only — .bak variants never match
    if (!stat.isFile()) continue;
    conflicts.push({ project: row.project, bytes: stat.size, migratedAt: row.migrated_at });
    if (!_warnedCanvasConflicts.has(row.project)) {
      _warnedCanvasConflicts.add(row.project);
      console.warn(
        `[canvas-migration] ⚠️ CONFLICT: project "${row.project}" is DB-migrated (${row.migrated_at}) `
        + `but a canvas.json exists again (${stat.size} bytes) — likely a workspace restore from a `
        + `pre-migration backup. The DB stays authoritative and the file is ignored. `
        + `Operator action required: inspect ${file}, then delete it or re-import deliberately. No auto-merge.`
      );
    }
  }
  return conflicts;
}

/**
 * Migrate one project's canvas.json into the DB store. Returns a result row
 * for the run response: { project, ok, notes, connections, error?, warning?,
 * skipped?, conflict? }. Never throws for per-project failures — partial
 * failures must not stop the other projects.
 */
function migrateCanvasProject(name) {
  const file = path.join(PROJECTS_DIR, name, 'canvas.json');

  // Idempotency: a migrated project is a no-op, never re-imported. EXCEPT
  // when a canvas.json exists again (ADR-0018 restore conflict, T-344-5):
  // an explicit request must fail loudly instead of silently skipping — and
  // it must NOT re-import over the DB data without an operator decision.
  if (hzlService.canvasIsMigrated(name)) {
    if (fs.existsSync(file)) {
      return {
        project: name,
        ok: false,
        conflict: true,
        error: 'conflict: project is already DB-migrated but a canvas.json exists again (likely restored '
          + 'from a pre-migration backup) — refusing to re-import over the DB data. Inspect the file, '
          + 'then delete it or resolve manually (see migration docs).',
      };
    }
    const current = hzlService.canvasGet(name);
    return { project: name, ok: true, skipped: true, notes: current.notes.length, connections: current.connections.length };
  }
  if (!fs.existsSync(file)) {
    return { project: name, ok: false, error: 'no canvas.json found' };
  }

  // Strict read + validation — corrupt JSON fails here, file untouched.
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { project: name, ok: false, error: `invalid canvas.json: ${e.message}` };
  }
  if (!data || !Array.isArray(data.notes) || !Array.isArray(data.connections)) {
    return { project: name, ok: false, error: 'invalid canvas.json: notes and connections arrays required' };
  }

  const expected = cleanCanvasData(data);
  try {
    hzlService.canvasImportFromJson(name, data); // transactional (T-344-1)
  } catch (e) {
    return { project: name, ok: false, error: `import failed: ${e.message}` };
  }

  // Count verification against the cleaned file counts. On mismatch the
  // migrated flag stays unset, so the dual-read switch keeps serving the file.
  const inDb = hzlService.canvasGet(name);
  if (inDb.notes.length !== expected.notes || inDb.connections.length !== expected.connections) {
    return {
      project: name,
      ok: false,
      error: `count mismatch after import: db has ${inDb.notes.length} notes/${inDb.connections.length} connections, `
        + `file has ${expected.notes}/${expected.connections} — project left unmigrated`,
    };
  }

  hzlService.canvasMarkMigrated(name);
  const result = { project: name, ok: true, notes: inDb.notes.length, connections: inDb.connections.length };

  // Report notes the importer dropped (non-string / duplicate id). Count
  // verification still passes (cleanCanvasData applies the same filter), so the
  // drop would otherwise be silent. Not expected for real N-xxx data, but
  // surface it for foreign/hand-edited canvas.json (T-344-5 review).
  const skipped = data.notes.length - expected.notes;
  if (skipped > 0) result.warning = `${skipped} note(s) skipped (invalid or duplicate id)`;

  // Rename ONLY after the verified import flipped the switch. Rename failure
  // is a warning, not a failure — the drift check (T-344-5) catches leftovers.
  try {
    let bak = `${file}.pre-db.bak`;
    if (fs.existsSync(bak)) bak = `${bak}.${Date.now()}`; // never overwrite an older backup
    fs.renameSync(file, bak);
  } catch (e) {
    const renameWarn = `migrated, but renaming canvas.json failed: ${e.message}`;
    result.warning = result.warning ? `${result.warning}; ${renameWarn}` : renameWarn;
  }
  return result;
}

/** Map store errors (`.status` = 400/404/413) to the legacy JSON responses. */
function sendCanvasError(res, err) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error('[api]', err);
  return res.status(500).json({ error: 'Internal server error' });
}

// --- Project Context Helpers ---

// NOTE: trimSessionLog removed by T-131-4/m005 — session logs now live in SESSIONS.md

async function sendWakeEvent(text) {
  if (!HOOKS_TOKEN) {
    console.log('[wake] No OPENCLAW_HOOKS_TOKEN set, skipping wake event');
    return;
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/hooks/wake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HOOKS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, mode: 'now', ...flowboardNotificationDelivery() })
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
  const identity = agentIdentity.validateAgentId(req.query.agentId || req.headers['x-openclaw-agent-id']);
  if (!identity.ok) {
    return res.status(400).json({
      error: identity.error + ' (?agentId=<id> query parameter or x-openclaw-agent-id header)',
    });
  }
  const agentId = identity.id;
  // T-231: this read is the per-run heartbeat — the bootstrap hook calls it
  // before every agent run. Refresh last_seen so a live agent is never
  // auto-deactivated as idle. (Upsert keeps any existing active_project.)
  fbMeta.touchAgentLastSeen(agentId);
  // T-131-3: DB is canonical. Unknown agents → null, no file fallback.
  // (The pre-backfill `agentId === AGENT_ID` branch is removed in T-177-3 —
  // there is no service-default agent anymore. The m003 migration handles
  // file→DB backfill for the legacy ACTIVE-PROJECT.md case.)
  const row = fbMeta.getAgentRow(agentId);
  const activeProject = row?.active_project || null;
  const readiness = activeProject
    ? rulesApi.getBootstrapReadiness(activeProject)
    : { contextReady: false, missingSections: [] };
  const statusBody = { activeProject, agentId, contextReady: readiness.contextReady, agentIdentity: agentIdentity.responseMeta(identity) };
  // T-296: surface the rules pointer on activation so external agents learn
  // the /rules endpoint and the action→section mapping.
  if (activeProject) statusBody.rules = rulesApi.buildRulesPointer(activeProject);
  res.json(statusBody);
});

// PUT /api/status
//
// Requires an explicit agentId in the request body. No silent fallback to a
// service-default agent — that would route the activation into the wrong
// flowboard_agents row (see T-177 trace from 2026-04-29).
app.put('/api/status', async (req, res) => {
  const { project } = req.body;
  const identity = agentIdentity.validateAgentId(req.body.agentId);
  if (!identity.ok) {
    return res.status(400).json({ error: identity.error + ' in request body' });
  }
  const agentId = identity.id;
  let effectiveProject = (project && project !== 'none') ? project : null;

  // Resolve to canonical project name. Clients sometimes send displayName
  // ("FlowBoard") instead of the canonical name ("flowboard"); accept both,
  // but always store the canonical name so downstream lookups by p.name work.
  if (effectiveProject) {
    const canonical = fbMeta.resolveProjectName(effectiveProject, hzlService.listHzlProjects());
    if (!canonical) {
      return res.status(400).json({ error: `Unknown project: ${project}` });
    }
    effectiveProject = canonical;
  }

  // Read previous state from canonical source
  const previousProject = getCanonicalActiveProject(agentId);

  try {
    // T-131-3: write DB state (canonical). The dashboard no longer writes
    // ACTIVE-PROJECT.md or any other agent-workspace file — flowboard_agents
    // is the source of truth, and agents fetch state via /api/agents and
    // /api/projects/:name/bootstrap.
    fbMeta.setAgentActiveProject(agentId, effectiveProject);

    // Send wake event to notify agent of project switch (English — this
    // ships to third-party installs; T-288-8)
    if (effectiveProject) {
      const apiHints =
        `Check your status: GET /api/status?agentId=${agentId}. ` +
        `If activeProject=${effectiveProject}: load context via GET /api/projects/${effectiveProject}/bootstrap ` +
        `and rules on demand via GET /api/projects/${effectiveProject}/rules/<section>. ` +
        `Manage tasks through the API — see GET /api/projects/${effectiveProject}/rules/api-access.`;
      const wakeText = previousProject && previousProject !== effectiveProject
        ? `Project switched from ${previousProject} to ${effectiveProject}. ${apiHints}`
        : `Project ${effectiveProject} activated. ${apiHints}`;
      sendWakeEvent(wakeText);
    } else if (previousProject) {
      sendWakeEvent(`Project ${previousProject} deactivated. No active project.`);
    }

    const readiness = effectiveProject
      ? rulesApi.getBootstrapReadiness(effectiveProject)
      : { contextReady: false };
    const body = { ok: true, activeProject: effectiveProject, agentId, contextReady: readiness.contextReady, agentIdentity: agentIdentity.responseMeta(identity) };
    // T-296: same rules pointer on the activation (PUT) path.
    if (effectiveProject) body.rules = rulesApi.buildRulesPointer(effectiveProject);
    res.json(body);
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});


// GET /api/agents — list all known agents and their active project (T-131-3)
app.get('/api/agents', (req, res) => {
  try {
    // T-231: lazy idle auto-deactivation. Clear active_project for agents idle
    // past the TTL that hold no *live* task claim (lease protection). Done on
    // read so /api/agents reflects truth without a scheduler. Correctness of
    // the idle window relies on the bootstrap hook calling GET /api/status
    // before every agent run (that refreshes last_seen) — see GET /api/status.
    const nowMs = Date.now();
    const ttlHours = fbMeta.AGENT_IDLE_TTL_HOURS;
    const agents = fbMeta.listAgents();
    for (const a of agents) {
      // Lease-aware: an expired-lease claim is dead work and must not protect.
      const claimCount = fbMeta.countLiveClaims(hzlService.listTasksClaimedBy(a.agent_id), nowMs);
      if (fbMeta.isAgentIdleExpired(a, { nowMs, ttlHours, claimCount })) {
        if (fbMeta.clearAgentActiveProject(a.agent_id)) {
          const idleH = Math.round((nowMs - Date.parse(a.last_seen)) / 3600000);
          console.log(`[flowboard-meta] auto-deactivated idle agent "${a.agent_id}" (idle ${idleH}h, no active claims)`);
        }
        a.active_project = null;
      }
    }
    res.json({ ok: true, agents });
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

// GET /api/health/integrity — exposes the boot-time integrity watermark
// alongside the current event-table state. Returns { stored, current,
// regression, strict_mode } so external monitoring tools can poll for
// rollback events without depending on a particular notification channel.
// No auth — mirrors /api/health.
app.get('/api/health/integrity', (req, res) => {
  try {
    const current = hzlIntegrity.getCurrentWatermark(hzlService.getEventsDb());
    const stored = hzlIntegrity.getStoredWatermark(hzlService.getCacheDb());
    const regression = hzlIntegrity.checkRegression(stored, current);
    return res.json({
      stored,
      current,
      regression,
      boot_check: _bootIntegrity,
      strict_mode: HZL_INTEGRITY_STRICT,
    });
  } catch (e) {
    console.error('[integrity] endpoint failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/info — public discovery endpoint for external agents (T-179).
// Returns service metadata + the bundled external-trigger snippet so an
// agent in a project repo can self-onboard with a single curl. No auth
// (matches /api/health pattern); no agentId required.
//
// T-181: snippet content is read from disk per-request rather than cached
// at boot. The discovery endpoint is low-frequency, the file is ~5 KB,
// and live-update without dashboard restart is worth more than the
// negligible IO cost. A boot-time smoke check stays as warning-only.
const EXTERNAL_TRIGGER_PATH = path.resolve(__dirname, '..', 'snippets', 'external-trigger.md');
try {
  fs.readFileSync(EXTERNAL_TRIGGER_PATH, 'utf8');
} catch (e) {
  console.warn(`[api/info] Smoke check: could not load ${EXTERNAL_TRIGGER_PATH}: ${e.message}`);
}
let _packageVersion = 'unknown';
try {
  _packageVersion = require('./package.json').version;
} catch { /* version stays 'unknown' */ }

function renderExternalTriggerSnippet(content) {
  return renderSnippetBaseUrl(content, resolveDashboardBaseUrl({ dashboardPort: PORT }, process.env, { includeLegacyApi: false }));
}

app.get('/api/info', (req, res) => {
  let triggerSnippet = '';
  try {
    triggerSnippet = renderExternalTriggerSnippet(fs.readFileSync(EXTERNAL_TRIGGER_PATH, 'utf8'));
  } catch (e) {
    // Per-request read failed — serve empty snippet but warn so the operator
    // can investigate (file deleted, permissions changed, etc.). Not fatal.
    console.warn(`[api/info] request-time read of ${EXTERNAL_TRIGGER_PATH} failed: ${e.message}`);
  }
  res.json({
    service: 'FlowBoard',
    version: _packageVersion,
    api_base: resolveDashboardBaseUrl({ dashboardPort: PORT }, process.env, { includeLegacyApi: false }),
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
      "Do not use generated cwd/session names like 'codex-workspace'. " +
      'Stable external ids are auto-registered in flowboard_agents on first PUT /api/status.',
    anti_trust_rule:
      'Always pass agentId on per-agent calls (?agentId= or x-openclaw-agent-id header for GET, body for POST/PUT). ' +
      "Distrust responses where response.agentId differs from yours.",
    trigger_snippet: triggerSnippet,
  });
});

// Auth-Endpoint (vor dem generellen API-Auth)
app.post('/api/auth', (req, res) => {
  // Existing session cookies created before FLOWBOARD_TELEGRAM_AGENT_IDS do not
  // carry agentId. If fresh Telegram initData is present, re-read the signed
  // payload so the dashboard can still infer the caller agent immediately.
  const freshUser = validateTelegramWebApp(req.headers['x-telegram-init-data']);
  const mergedUser = freshUser || req.user || {};
  const agentId = freshUser?.agentId || req.user?.agentId || null;
  const { agentId: _agentId, ...user } = mergedUser;
  res.json({ ok: true, user, agentId });
});

// Auth auf alle API-Routes wird jetzt global oben angewendet (nach Debug-Logger)

// --- Helpers ---

// T-177-3: agentId is required; no default. Pass the explicit caller agent.
function getCanonicalActiveProject(agentId) {
  if (!agentId) return null;
  const row = fbMeta.getAgentRow(agentId);
  return row?.active_project || null;
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
  return hzlService.getTaskCounts(projectName);
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

// T-366: recalc a subtask's parent after a lifecycle change and describe the
// resulting parent state for the API response. claim/release/complete set the
// subtask status OUTSIDE the generic updateTask path, so the explicit recalc
// here performs the aggregation; approve/reject go THROUGH updateTask (which
// already recalcs the parent, T-299), so this call is then a no-op.
// T-409 (review): recalcParentStatus only returns a row when IT changed the
// status, so for approve/reject (already recalced) it returned null and
// response.parentUpdated was always dropped — even when the parent genuinely
// changed. Read the parent's CURRENT state and report it whenever a parent
// exists; the client merges it (mergeParentUpdated) idempotently.
// Returns { id, status, progress } or null (no parent / not found).
function recalcParentForResponse(project, parentId) {
  if (!parentId) return null;
  try {
    const changed = hzlService.recalcParentStatus(project, parentId);
    const tasks = hzlService.listTasks(project);
    const parent = changed || tasks.find(t => t.id === parentId);
    if (!parent) return null;
    return { id: parent.id, status: parent.status, progress: getSubtaskProgress(tasks, parentId) };
  } catch (e) { console.warn('[recalcParent]', e); return null; }
}

function getSubtaskProgress(tasks, parentId) {
  const subtasks = tasks.filter(t => t.parentId === parentId);
  return {
    done: subtasks.filter(t => t.status === 'done').length,
    inProgress: subtasks.filter(t => t.status === 'in-progress' || t.status === 'review').length,
    total: subtasks.length
  };
}

// T-293: single error -> HTTP status mapping for service-layer errors.
// err.code wins; the "not found" message check is the fallback for
// hzl-service errors that don't carry a code yet.
const ERROR_CODE_STATUS = {
  NOT_FOUND: 404,
  NOT_OWNER: 403,
  AGENT_REQUIRED: 403,
  ROUTING_MISMATCH: 403,
  NOT_IN_REVIEW: 409,
  PARENT_NOT_CLAIMABLE: 409,
  ALREADY_CLAIMED: 409,
  REASON_REQUIRED: 400,
  IS_SUBTASK: 400,
  HAS_SUBTASKS: 409,
};
function httpStatusForError(err, fallback = 400) {
  if (err && err.code && ERROR_CODE_STATUS[err.code]) return ERROR_CODE_STATUS[err.code];
  if (err && err.message && /not found/i.test(err.message)) return 404;
  return fallback;
}

function projectExists(projectName) {
  try {
    // Same definition of existence as GET /api/projects: the canonical
    // flowboard_projects registry merged with the HZL project list (T-293).
    hzlService.ensureProject(projectName);
    return fbMeta.listProjects(hzlService.listHzlProjects()).some(p => p.name === projectName);
  } catch {
    return false;
  }
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
    return '\u{1F4A1} Add a one-line `description` for context (most tasks should have one). Then evaluate a spec: multiple files, new UI pattern, unclear scope or complex logic \u2192 create a spec; a simple fix needs only title + description.';
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
  const lifecycle = require('./project-lifecycle.js');
  try {
    const result = lifecycle.createProject(req.body, {
      hzlService,
      fbMeta,
      projectsDir: PROJECTS_DIR,
    });
    const response = { project: result.project };
    if (result.warnings.length > 0) response.warnings = result.warnings;
    // T-365: best-fit overview suggestion at creation (Model D). The UI (human
    // present) only gets a suggestion to confirm; any other caller (agent /
    // headless) gets the non-default best fit applied straight away. A default
    // suggestion is never written — the fallback already serves it. This never
    // fails project creation.
    try {
      // The client header is advisory, not a trust boundary: the only effect is
      // whether a non-default preset is auto-applied vs offered for confirmation
      // (worst case a suggest-vs-auto mismatch, both reversible). Do not rely on
      // it for anything security-sensitive.
      const isUi = req.get('X-FlowBoard-Client') === 'dashboard';
      const { preset, rationale } = overview.suggestPreset({
        name: result.project.name,
        displayName: result.project.displayName,
        description: result.project.description,
        group: result.project.group,
      });
      if (isUi) {
        response.overview = { preset, rationale, applied: false, mode: 'suggested' };
      } else {
        const applied = preset !== overview.DEFAULT_PRESET;
        if (applied) overview.writeOverview(PROJECTS_DIR, result.project.name, overview.presetConfig(preset));
        response.overview = { preset, rationale, applied, mode: 'auto' };
      }
    } catch (e) {
      console.warn('[overview] creation-time suggestion failed:', e.message);
    }
    return res.status(201).json(response);
  } catch (e) {
    if (e.code === 'VALIDATION_ERROR') return res.status(400).json({ error: e.message });
    if (e.code === 'DUPLICATE') return res.status(409).json({ error: e.message });
    console.error('[projects] createProject failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/heal — backfill missing HZL event or metadata row
// for a project that exists at the filesystem or metadata layer. Idempotent:
// returns 200 with actions=[] when the project is already fully registered.
// Use the GET /api/projects/drift endpoint to discover candidates.
app.post('/api/projects/:name/heal', (req, res) => {
  const lifecycle = require('./project-lifecycle.js');
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = lifecycle.healProject(
      { name: req.params.name, displayName: body.displayName, description: body.description },
      { hzlService, fbMeta, projectsDir: PROJECTS_DIR }
    );
    return res.json(result);
  } catch (e) {
    if (e.code === 'VALIDATION_ERROR') return res.status(400).json({ error: e.message });
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    console.error('[heal] failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/drift — read-only listing of names that exist in metadata
// or on disk but lack a canonical HZL project_created event. Empty array
// means the system is consistent.
app.get('/api/projects/drift', (req, res) => {
  const lifecycle = require('./project-lifecycle.js');
  try {
    const drift = lifecycle.detectProjectDrift({
      hzlService, fbMeta, projectsDir: PROJECTS_DIR,
    });
    return res.json({ drift });
  } catch (e) {
    console.error('[drift] failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name — T-136: update metadata (displayName, archived, group, order)
app.put('/api/projects/:name', (req, res) => {
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
  if (req.query.confirm !== req.params.name) {
    return res.status(400).json({ error: 'Missing or mismatched ?confirm=<projectName>' });
  }
  // Guardrail (T-357): the project name alone is trivially known to any caller,
  // so `confirm` is not real proof of destructive intent. Require an explicit
  // hardDelete acknowledgement on top of it, and point a caller that merely
  // wanted to deactivate at the safe, reversible PUT path. This is what stops
  // an agent that means "deactivate" from accidentally hard-deleting a project.
  const ack = req.query.hardDelete === 'true' || req.body?.hardDelete === true;
  if (!ack) {
    return res.status(400).json({
      error: `Refusing to hard-delete "${req.params.name}" without explicit acknowledgement. `
        + `To DEACTIVATE and keep all data (reversible), use PUT /api/projects/${req.params.name} { "archived": true }. `
        + 'To permanently trash it (moves the dir to .trash/ and tombstones it), repeat this DELETE with hardDelete=true.',
      code: 'HARD_DELETE_NOT_ACKNOWLEDGED',
    });
  }
  // T-358: two-step delete — a project must be DEACTIVATED (archived) before it
  // can be hard-deleted. This makes "deactivate" a required, reversible first
  // step that can never be one-shot-confused with permanent deletion.
  const meta = fbMeta.getProject(req.params.name);
  if (!meta || meta.status !== 'archived') {
    return res.status(409).json({
      error: `"${req.params.name}" must be deactivated before it can be deleted. `
        + `First PUT /api/projects/${req.params.name} { "archived": true } (reversible), then delete.`,
      code: 'NOT_ARCHIVED',
    });
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

// GET /api/projects/deleted — T-358: tombstoned (hard-deleted) projects so the
// UI can offer restore. Defined before any /:name GET to avoid capture.
app.get('/api/projects/deleted', (req, res) => {
  try {
    return res.json({ projects: fbMeta.listDeletedProjects() });
  } catch (e) {
    console.error('[projects] listDeleted failed:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/restore — T-358: reverse a hard-delete (untombstone +
// move the dir back from .trash/). The tasks reappear from the HZL projection.
app.post('/api/projects/:name/restore', (req, res) => {
  const lifecycle = require('./project-lifecycle.js');
  try {
    const result = lifecycle.restoreProject(req.params.name, { fbMeta, projectsDir: PROJECTS_DIR });
    const response = { ok: true, restoredFrom: result.restoredFrom };
    if (result.warnings && result.warnings.length > 0) response.warnings = result.warnings;
    return res.json(response);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    console.error('[projects] restoreProject failed:', e.message);
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

// --- In-dashboard self-update (T-353) -------------------------------------
// After `openclaw plugins update flowboard`, the on-disk plugin source carries
// a higher version than the running dashboard (which baked its version at
// startup). The SnippetUpgrade panel surfaces this and can trigger a rebuild +
// restart via scripts/setup.mjs --update.
const REPO_ROOT = path.join(__dirname, '..');
const SETUP_SCRIPT_REL = path.join('scripts', 'setup.mjs');

// Re-read the on-disk version (NOT require(), which is cached) so we see the
// version a rebuild would bake in. dashboard/package.json is the file the
// server reads at startup; the plugin manifest is bumped in lockstep.
function readInstalledVersion() {
  for (const rel of ['package.json', path.join('..', 'openclaw.plugin.json')]) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const v = JSON.parse(raw).version;
      if (typeof v === 'string') return v;
    } catch { /* try next source */ }
  }
  return null;
}

// GET /api/update/status — { running, installed, updateAvailable }. Fail-silent:
// a missing/unparseable on-disk version reports updateAvailable:false, never 500.
app.get('/api/update/status', (req, res) => {
  const running = _packageVersion;
  const installed = readInstalledVersion();
  const updateAvailable = !!installed && versionCheck.isNewer(installed, running);
  res.json({ ok: true, running, installed, updateAvailable });
});

// POST /api/update/run — rebuild + restart via setup.mjs --update. Fixed command,
// no request input. Detached so it survives this process being killed by the
// restart; responds 202 immediately (the caller then polls /api/health +
// /api/info for the new version). FLOWBOARD_UPDATE_DRY=1 skips the spawn (tests).
app.post('/api/update/run', (req, res) => {
  const command = [process.execPath, SETUP_SCRIPT_REL, '--update'];
  if (process.env.FLOWBOARD_UPDATE_DRY) {
    return res.status(202).json({ ok: true, started: false, dryRun: true, command });
  }
  try {
    const child = require('child_process').spawn(
      process.execPath,
      [SETUP_SCRIPT_REL, '--update'],
      // T-406: the service often runs with a minimal launchd/systemd PATH that
      // lacks node/npm — augment it so setup.mjs's `npm` prerequisite resolves.
      { cwd: REPO_ROOT, detached: true, stdio: 'ignore', env: updateSpawnEnv(process.env, process.execPath) }
    );
    child.unref();
    res.status(202).json({ ok: true, started: true, command });
  } catch (err) {
    console.error('[update/run]', err);
    res.status(500).json({ error: 'Failed to start update', detail: err.message });
  }
});

// --- Rules-endpoint telemetry (diagnostic, env-gated) ---------------------
// Off by default. Enable via `FLOWBOARD_RULES_TELEMETRY=1` in the service env
// to log every /rules/* hit to stdout (picked up by the service manager log).
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

// GET /api/projects/:name/bootstrap — fetch full project context document.
// Contract: never return a successful empty document. A caller either receives
// substantial markdown context or an explicit not-ready/error response.
app.get('/api/projects/:name/bootstrap', (req, res) => {
  try {
    const bootstrapOptions = {};
    try {
      if (projectExists(req.params.name)) {
        const tasks = hzlService.listTasks(req.params.name, { includeArchived: false });
        bootstrapOptions.tasks = enrichTasks(req.params.name, tasks);
      } else {
        bootstrapOptions.taskStateBlocker = `Could not fetch live task state for project \`${req.params.name}\`: project not found.`;
      }
    } catch (taskErr) {
      bootstrapOptions.taskStateBlocker = `Could not fetch live task state for project \`${req.params.name}\` (${taskErr?.message || 'task read failed'}).`;
    }

    const content = rulesApi.buildBootstrapDocument(req.params.name, bootstrapOptions);
    res.type('text/markdown; charset=utf-8').send(content);
  } catch (err) {
    if (err.code === 'CONTEXT_NOT_READY') {
      return res.status(503).json({
        error: 'Project context is not ready',
        project: req.params.name,
        contextReady: false,
        missingSections: err.missingSections || [],
      });
    }
    if (err.code === 'CONTEXT_EMPTY') {
      return res.status(500).json({
        error: 'Project context rendered empty',
        project: req.params.name,
        contextReady: false,
      });
    }
    console.error('[api] bootstrap context error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:name/tasks
app.get('/api/projects/:name/tasks', (req, res) => {
  if (!projectExists(req.params.name)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const includeArchived = req.query.includeArchived === 'true';
  const tasks = hzlService.listTasks(req.params.name, { includeArchived });
  const result = enrichTasks(req.params.name, tasks);
  const response = { tasks: result };

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

// FlowBoard uses exactly three priorities (T-246-8). "critical" is accepted
// as a legacy alias and normalized to high; anything else unknown is invalid.
function normalizePriority(value) {
  if (value === undefined || value === null || value === '') return 'medium';
  if (['low', 'medium', 'high'].includes(value)) return value;
  if (value === 'critical') return 'high';
  return null;
}

// POST /api/projects/:name/tasks
app.post('/api/projects/:name/tasks', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  const { title, priority, parentId } = req.body;
  // Reject empty/whitespace-only titles and bound the length (T-355).
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Title required' });
  }
  const cleanTitle = title.trim();
  if (cleanTitle.length > 500) {
    return res.status(400).json({ error: 'Title too long (max 500 characters)' });
  }

  const normalizedPriority = normalizePriority(priority);
  if (!normalizedPriority) {
    return res.status(400).json({ error: `Invalid priority "${priority}" — use low, medium or high` });
  }

  if (parentId) {
    const parent = hzlService.getTask(req.params.name, parentId);
    if (!parent) return res.status(400).json({ error: 'Parent task not found' });
    if (parent.parentId) return res.status(400).json({ error: 'Cannot nest subtasks (max 1 level)' });
  }

  let effectivePriority = normalizedPriority;
  if (parentId) {
    const parent = hzlService.getTask(req.params.name, parentId);
    if (parent) effectivePriority = normalizePriority(parent.priority) || 'medium';
  }

  // T-300: optional per-task stale threshold (minutes)
  const staleAfterMinutes = req.body.staleAfterMinutes ?? null;
  if (staleAfterMinutes !== null && (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes <= 0)) {
    return res.status(400).json({ error: 'staleAfterMinutes must be a positive integer or null' });
  }

  if (req.body.tags !== undefined && (!Array.isArray(req.body.tags) || req.body.tags.some(t => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }

  // T-396: optional inline description (short context). Max 16KB.
  if (req.body.description !== undefined && (typeof req.body.description !== 'string' || req.body.description.length > 16384)) {
    return res.status(400).json({ error: 'description must be a string of at most 16KB' });
  }

  try {
    const task = hzlService.createTask(req.params.name, {
      title: cleanTitle,
      priority: effectivePriority,
      parentId: parentId || null,
      status: req.body.status || 'backlog',
      staleAfterMinutes,
      ...(req.body.tags !== undefined ? { tags: req.body.tags } : {}),
      ...(req.body.description !== undefined ? { description: req.body.description } : {}),
    });
    const response = { ok: true, task: taskWithSpecStatus(req.params.name, task) };
    try {
      const r = getTaskReminder(task, 'create');
      if (r) response.reminder = r;
    } catch (e) { console.warn('[reminder]', e); }
    return res.json(response);
  } catch (err) {
    console.error('[api]', err); return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name/tasks/:id
app.put('/api/projects/:name/tasks/:id', (req, res) => {
  const task = hzlService.getTask(req.params.name, req.params.id, { includeArchived: true });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updates = req.body;

  if (updates.priority !== undefined) {
    const normalized = normalizePriority(updates.priority);
    if (!normalized) {
      return res.status(400).json({ error: `Invalid priority "${updates.priority}" — use low, medium or high` });
    }
    updates.priority = normalized;
  }

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
  const prevParentStatus = task.parentId
    ? (hzlService.getTask(req.params.name, task.parentId)?.status ?? null)
    : null;

  if (updates.status === 'done' && task.status !== 'done') {
    updates.completed = new Date().toISOString().slice(0, 10);
  }
  if (updates.status && updates.status !== 'done' && task.status === 'done') {
    updates.completed = null;
  }

  // T-396: inline description (short context). Max 16KB.
  if (Object.prototype.hasOwnProperty.call(updates, 'description')
      && (typeof updates.description !== 'string' || updates.description.length > 16384)) {
    return res.status(400).json({ error: 'description must be a string of at most 16KB' });
  }

  const ALLOWED = ['title', 'status', 'priority', 'completed', 'agent', 'staleAfterMinutes', 'tags', 'order', 'description'];
  const hzlUpdates = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      hzlUpdates[key] = updates[key];
    }
  }

  if (hzlUpdates.tags !== undefined && (!Array.isArray(hzlUpdates.tags) || hzlUpdates.tags.some(t => typeof t !== 'string'))) {
    return res.status(400).json({ error: 'tags must be an array of strings' });
  }
  // T-130: manual per-column ordering rank — a finite number, or null to clear it.
  if (hzlUpdates.order !== undefined && hzlUpdates.order !== null && !Number.isFinite(hzlUpdates.order)) {
    return res.status(400).json({ error: 'order must be a finite number or null' });
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

    // T-186: guard sensitive transitions. Generic PUT may still drive most
    // status edits, but review->done and done->reopen must go through their
    // explicit endpoints (or pass adminOverride with a reason for the
    // legacy/cleanup case). The override is recorded as an audit comment so
    // the activity feed reflects who took the back-door path.
    const fromStatus = prevStatus;
    const toStatus = hzlUpdates.status;
    if (taskTransitionGuard.isSensitiveTransition(fromStatus, toStatus)) {
      const override = updates.adminOverride === true;
      if (!override) {
        return res.status(409).json({ error: taskTransitionGuard.transitionErrorMessage(fromStatus, toStatus) });
      }
      const reasonError = taskTransitionGuard.adminOverrideReasonError(updates.reason);
      if (reasonError) {
        return res.status(400).json({ error: reasonError });
      }
      const overrideReason = updates.reason && String(updates.reason).trim();
      const actor = updates.actor && String(updates.actor).trim();
      const auditMsg = `admin-status-override by ${actor || 'unknown'} (${fromStatus} -> ${toStatus})` +
        (overrideReason ? ` — Reason: ${overrideReason}` : '');
      try {
        hzlService.addComment(req.params.name, req.params.id, { message: auditMsg, author: actor || null });
      } catch (e) {
        console.warn('[admin-status-override audit]', e);
      }
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
        // Aggregation already ran inside updateTask (T-299) — compare the
        // parent's status against its pre-update state so the response
        // reports the change even when the recalc below is a no-op.
        const parentAfter = hzlService.getTask(req.params.name, updatedTask.parentId);
        parentUpdated = hzlService.recalcParentStatus(req.params.name, updatedTask.parentId);
        if (!parentUpdated && parentAfter && prevParentStatus !== null && parentAfter.status !== prevParentStatus) {
          parentUpdated = { id: parentAfter.id, status: parentAfter.status };
        }
        if (parentUpdated) {
          const allTasks = hzlService.listTasks(req.params.name);
          parentUpdated.progress = getSubtaskProgress(allTasks, updatedTask.parentId);
        }
      } catch (e) { console.warn('[recalcParent]', e); }
    }

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
});

// T-161-4: DELETE /api/projects/:name/tasks/trash — Empty Trash.
// Hard-deletes every task in the project whose metadata.flowboard.trashedAt
// is set. Confirmation happens in the UI (dialog before the call); the
// server trusts the caller. Must be registered before the :id variant so
// Express does not match the literal "trash" as a task id.
app.delete('/api/projects/:name/tasks/trash', (req, res) => {
  try {
    const result = hzlService.emptyTrash(req.params.name);
    return res.json({ ok: true, removed: result.removed, failed: result.failed });
  } catch (err) {
    console.error('[api]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/tasks/:id
app.delete('/api/projects/:name/tasks/:id', (req, res) => {
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

  return res.json({ ok: true });
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

function buildFileTree(projectName, { includeHidden = false } = {}) {
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
        // T-375-1: the editor shows the knowledge layer (Markdown). Operational
        // JSON and migration/backup artifacts are hidden unless includeHidden.
        const hidden = !isEditorVisible(relPath);
        if (hidden && !includeHidden) continue;
        const stat = fs.statSync(fullPath);
        const version = `${stat.mtimeMs}:${stat.size}`;
        entries.push({
          name: item.name,
          path: relPath,
          type: 'file',
          size: stat.size,
          category: getFileCategory(relPath),
          hidden,
          modified: stat.mtime.toISOString(),
          modifiedMs: stat.mtimeMs,
          version
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
  const includeHidden = req.query.includeHidden === 'true';
  const result = buildFileTree(req.params.name, { includeHidden });
  if (!result) return res.status(404).json({ error: 'Project not found' });
  res.json(result);
});

// Symlink-aware path containment for the file endpoints (T-355 security).
// path.resolve() collapses `..` but does NOT resolve symlinks, while fs.* DO
// follow them — so a symlink inside a project dir could otherwise escape the
// tree. Reads may legitimately follow symlinks (e.g. a project's
// PROJECT-RULES.md → the FlowBoard repo docs), so reads are allowed to resolve
// within the project, the projects dir, or the FlowBoard install. Writes/deletes
// are stricter: the real parent must stay inside the project and the target is
// never followed through a symlink.
const REPO_ROOT_REAL = (() => { try { return fs.realpathSync(path.join(__dirname, '..')); } catch { return path.join(__dirname, '..'); } })();
function withinReal(target, root) {
  return target === root || target.startsWith(root + path.sep);
}
function resolveProjectFile(projectDir, filePath, { forWrite = false } = {}) {
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return { ok: false, code: 403, error: 'Path traversal not allowed' };
  }
  let projReal;
  try { projReal = fs.realpathSync(projectDir); } catch { return { ok: false, code: 404, error: 'Project not found' }; }

  if (forWrite) {
    // Never write/delete through a symlink, and the real parent must stay inside the project.
    try { if (fs.lstatSync(resolved).isSymbolicLink()) return { ok: false, code: 403, error: 'Refusing to operate through a symlink' }; } catch { /* target may not exist yet (create) */ }
    let parentReal = null;
    try { parentReal = fs.realpathSync(path.dirname(resolved)); } catch { /* parent created on demand */ }
    if (parentReal && !withinReal(parentReal, projReal)) {
      return { ok: false, code: 403, error: 'Resolved path escapes the project directory' };
    }
    return { ok: true, resolved };
  }

  // Read: the file must exist and its REAL target must stay within an allowed root.
  if (!fs.existsSync(resolved)) return { ok: false, code: 404, error: 'File not found' };
  let real;
  try { real = fs.realpathSync(resolved); } catch { return { ok: false, code: 404, error: 'File not found' }; }
  const roots = [projReal, REPO_ROOT_REAL];
  try { roots.push(fs.realpathSync(PROJECTS_DIR)); } catch { /* ignore */ }
  if (!roots.some(r => withinReal(real, r))) {
    return { ok: false, code: 403, error: 'Resolved path escapes the allowed roots' };
  }
  return { ok: true, resolved };
}

// GET /api/projects/:name/files/{*filePath} — read file content
app.get('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  const safe = resolveProjectFile(projectDir, filePath, { forWrite: false });
  if (!safe.ok) return res.status(safe.code).json({ error: safe.error });
  const resolved = safe.resolved;

  if (fs.statSync(resolved).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(resolved);
  if (stat.size > 500 * 1024) {
    return res.status(413).json({ error: 'File too large (max 500KB)' });
  }

  try {
    const content = fs.readFileSync(resolved, 'utf8');
    const version = `${stat.mtimeMs}:${stat.size}`;
    res.json({
      path: filePath,
      content,
      size: stat.size,
      category: getFileCategory(filePath),
      modified: stat.mtime.toISOString(),
      modifiedMs: stat.mtimeMs,
      version
    });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:name/files/{*filePath} — write file content (Phase 2)
app.put('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Only editable areas may be written via the API. Agent-consumed control
  // files (AGENTS.md, PROJECT-RULES.md, rules, PROJECT.md, canvas.json, …) live
  // outside context/ and specs/ and must not be overwritable through this route
  // (indirect instruction injection). Mirrors the DELETE allow-list (T-355).
  if (!filePath.startsWith('context/') && !filePath.startsWith('specs/')) {
    return res.status(403).json({ error: 'Only files in context/ and specs/ can be written' });
  }

  // Security: prevent path traversal + symlink escape (no write through a symlink).
  const safe = resolveProjectFile(projectDir, filePath, { forWrite: true });
  if (!safe.ok) return res.status(safe.code).json({ error: safe.error });
  const resolved = safe.resolved;

  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content required' });
  if (Buffer.byteLength(content, 'utf8') > 100 * 1024) return res.status(413).json({ error: 'Content too large (max 100KB)' });

  try {
    // Ensure parent directory exists
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(resolved, content);
    const stat = fs.statSync(resolved);
    const version = `${stat.mtimeMs}:${stat.size}`;
    res.json({
      ok: true,
      path: filePath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      modifiedMs: stat.mtimeMs,
      version
    });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/files/context — upload a markdown file to context/ (T-222)
//
// Accepts JSON { filename, content } so we avoid pulling in multer for a
// markdown-only upload path. The body parser is scoped to 5 MB just for this
// route — global express.json() stays at its default 100 KB limit.
app.post('/api/projects/:name/files/context', express.json({ limit: '5mb' }), (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  const projectDir = path.join(PROJECTS_DIR, req.params.name);

  const { filename, content } = req.body || {};
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename required' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content (string) required' });
  }
  // Reject path separators / traversal in the filename — uploads are flat,
  // single files into context/. No nested directories from the UI.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0') || filename.startsWith('.')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (!filename.toLowerCase().endsWith('.md')) {
    return res.status(400).json({ error: 'Only .md files are allowed' });
  }
  if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'Content too large (max 5MB)' });
  }

  const contextDir = path.join(projectDir, 'context');
  const resolved = path.resolve(contextDir, filename);
  if (!resolved.startsWith(contextDir + path.sep)) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  try {
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(resolved, content, { flag: 'wx' });
    const stat = fs.statSync(resolved);
    const version = `${stat.mtimeMs}:${stat.size}`;
    res.json({
      ok: true,
      path: `context/${filename}`,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      modifiedMs: stat.mtimeMs,
      version
    });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return res.status(409).json({ error: 'File already exists' });
    }
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:name/files/{*filePath} — delete files (only context/ and specs/)
app.delete('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Only allow deletion in context/ and specs/
  if (!filePath.startsWith('context/') && !filePath.startsWith('specs/')) {
    return res.status(403).json({ error: 'Only files in context/ and specs/ can be deleted' });
  }

  // Security: prevent path traversal + symlink escape (never delete through a symlink).
  const safe = resolveProjectFile(projectDir, filePath, { forWrite: true });
  if (!safe.ok) return res.status(safe.code).json({ error: safe.error });
  const resolved = safe.resolved;

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
      const index = hzlService.getSpecsIndex(req.params.name);
      const taskId = Object.keys(index).find(id => index[id] === filePath);
      if (taskId) hzlService.setSpecLink(req.params.name, taskId, null);
    }

    res.json({ ok: true, deleted: filePath });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/specs/:taskId — scaffold a new spec file
app.post('/api/projects/:name/specs/:taskId', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  const projectDir = path.join(PROJECTS_DIR, req.params.name);

  const taskId = req.params.taskId;

  // Get task from HZL
  let task;
  task = hzlService.getTask(req.params.name, taskId);
  if (!task) return res.status(404).json({ error: `Task ${taskId} not found` });

  if (task.specFile) {
    const existingSpec = path.join(projectDir, task.specFile);
    if (fs.existsSync(existingSpec) && !fs.statSync(existingSpec).isDirectory()) {
      return res.status(409).json({ error: 'Task already has a spec file', specFile: task.specFile });
    }
    // stale link — allow recreation
  }

  const date = new Date().toISOString().slice(0, 10);
  let customContent = req.body?.content;
  // Defensive: replace literal '\n' (escaped newlines from callers) with real newlines
  if (customContent && customContent.includes('\\n')) {
    customContent = customContent.replace(/\\n/g, '\n');
  }
  const template = customContent || `# ${taskId}: ${task.title}\n\n## Goal\n\n\n## Done When\n- [ ] \n\n## Approach\n\n\n## Log\n- ${date}: Spec created\n`;

  const specFileRelPath = writeSpecFileForTask(req.params.name, task, template);
  const updatedTask = hzlService.getTask(req.params.name, task.id);
  return res.json({ ok: true, specFile: specFileRelPath, taskId, task: taskWithSpecStatus(req.params.name, updatedTask) });
});

// POST /api/projects/:name/sessions — append a SESSIONS.md entry (T-375-3).
// Append-only, newest-first. Called by an agent (or the session-end hook) when
// a working session ends; see agent-bridge.md § Session end.
app.post('/api/projects/:name/sessions', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  const { summary, title } = req.body || {};
  const identity = agentIdentity.validateAgentId(req.body?.agent);
  if (!identity.ok) return res.status(400).json({ error: identity.error + ' in request body' });
  if (typeof summary !== 'string' || !summary.trim()) {
    return res.status(400).json({ error: 'summary required (non-empty string)' });
  }
  if (summary.length > 8192) return res.status(400).json({ error: 'summary too long (max 8KB)' });
  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
    return res.status(400).json({ error: 'title must be a string ≤ 200 chars' });
  }

  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(PROJECTS_DIR, req.params.name, 'SESSIONS.md');
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { content = `# Session Log — ${req.params.name}\n\n## Session Log\n`; }

  const block = formatSessionEntry({ date, agent: identity.id, summary, title });
  try {
    fs.writeFileSync(file, insertEntry(content, block));
  } catch (err) {
    console.error('[sessions]', err);
    return res.status(500).json({ error: 'Failed to write SESSIONS.md' });
  }
  return res.json({ ok: true, date, agent: identity.id, file: 'SESSIONS.md' });
});

/**
 * Canonical spec file creation — single source for naming
 * (`specs/<taskId>-<title-slug>.md`) and task linking. Used by the specs API
 * and by Specify persistence; never duplicate this logic.
 */
function writeSpecFileForTask(projectName, task, content) {
  const slug = task.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');

  const specsDir = path.join(PROJECTS_DIR, projectName, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });

  const specFilename = `${task.id}-${slug}.md`;
  fs.writeFileSync(path.join(specsDir, specFilename), content);

  const specFileRelPath = `specs/${specFilename}`;
  hzlService.setSpecLink(projectName, task.id, specFileRelPath);
  return specFileRelPath;
}


// The canvas CRUD endpoints below are thin wrappers around canvasBackend()
// (dual-read switch, T-344-2). Behavior, response shapes and status codes are
// unchanged for both backends — the legacy file logic lives in
// fileCanvasStore, the DB logic in hzl-service.

// GET /api/projects/:name/canvas
app.get('/api/projects/:name/canvas', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json(canvasBackend(req.params.name).canvasGet(req.params.name));
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// POST /api/projects/:name/canvas/notes
app.post('/api/projects/:name/canvas/notes', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    const backend = canvasBackend(req.params.name);
    const body = { ...(req.body || {}) };
    // T-352: auto-place when NEITHER x nor y was supplied (agent/API convenience:
    // POST {text} lands collision-free instead of stacking at (0,0)). Explicit
    // coordinates — including an explicit 0 — are always honored. Optional
    // `near: <noteId>` anchors the search beside a related note.
    const hasX = body.x !== undefined && body.x !== null;
    const hasY = body.y !== undefined && body.y !== null;
    if (!hasX && !hasY) {
      const existing = backend.canvasGet(req.params.name).notes || [];
      const slot = autoPlaceNote(existing, { near: body.near });
      body.x = slot.x;
      body.y = slot.y;
    }
    res.json(backend.canvasCreateNote(req.params.name, body));
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// PUT /api/projects/:name/canvas/notes/:id
app.put('/api/projects/:name/canvas/notes/:id', (req, res) => {
  try {
    res.json(canvasBackend(req.params.name).canvasUpdateNote(req.params.name, req.params.id, req.body));
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// DELETE /api/projects/:name/canvas/notes/batch (MUST be before :id route)
app.delete('/api/projects/:name/canvas/notes/batch', (req, res) => {
  try {
    canvasBackend(req.params.name).canvasDeleteNotesBatch(req.params.name, (req.body || {}).noteIds);
    res.status(204).end();
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// DELETE /api/projects/:name/canvas/notes/:id
app.delete('/api/projects/:name/canvas/notes/:id', (req, res) => {
  try {
    canvasBackend(req.params.name).canvasDeleteNote(req.params.name, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// POST /api/projects/:name/canvas/connections
app.post('/api/projects/:name/canvas/connections', (req, res) => {
  try {
    res.json(canvasBackend(req.params.name).canvasSaveConnection(req.params.name, req.body));
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// DELETE /api/projects/:name/canvas/connections
app.delete('/api/projects/:name/canvas/connections', (req, res) => {
  try {
    canvasBackend(req.params.name).canvasDeleteConnection(req.params.name, req.body);
    res.json({ ok: true });
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// --- Canvas migration endpoints (T-344-3) ---
// Same auth/loopback behavior as every other admin endpoint: the global
// /api/ auth middleware applies, nothing extra here.

// GET /api/migrations/canvas/status
// -> { pending: [{ project, displayName, notes, connections, bytes }],
//      migrated: [{ project, migratedAt }],
//      conflicts: [{ project, displayName, bytes, migratedAt }], total }
// Pending = projects with a canvas.json on disk and no canvas_meta.migrated_at.
// Empty scaffold files count as pending with notes:0 so the state stays
// unambiguous. Counts are the CLEANED counts (orphans + reverse duplicates
// dropped) — exactly what a run would import.
// Conflicts (T-344-5, ADR-0018, additive) = migrated projects with a literal
// canvas.json on disk again (restore from a pre-migration backup). They also
// stay in `migrated` (the DB is still authoritative) and `total` keeps its
// pending+migrated semantics.
app.get('/api/migrations/canvas/status', (req, res) => {
  try {
    const displayNames = new Map();
    try {
      for (const p of fbMeta.listProjects(hzlService.listHzlProjects())) {
        displayNames.set(p.name, p.displayName || p.name);
      }
    } catch {} // registry unavailable -> fall back to project names
    const pending = scanPendingCanvasMigrations().map(p => ({
      project: p.project,
      displayName: displayNames.get(p.project) || p.project,
      notes: p.notes,
      connections: p.connections,
      bytes: p.bytes,
    }));
    const migrated = hzlService.getEventsDb()
      .prepare('SELECT project, migrated_at FROM canvas_meta WHERE migrated_at IS NOT NULL ORDER BY project')
      .all()
      .map(r => ({ project: r.project, migratedAt: r.migrated_at }));
    const conflicts = scanCanvasConflicts().map(c => ({
      project: c.project,
      displayName: displayNames.get(c.project) || c.project,
      bytes: c.bytes,
      migratedAt: c.migratedAt,
    }));
    res.json({ pending, migrated, conflicts, total: pending.length + migrated.length });
  } catch (err) {
    sendCanvasError(res, err);
  }
});

// POST /api/migrations/canvas/run  Body: { projects?: [name] }
// Without projects: migrate ALL pending. Per project: read+validate ->
// canvasImportFromJson (transaction) -> count verification -> mark migrated ->
// rename canvas.json -> canvas.json.pre-db.bak. Partial failures don't stop
// the other projects; re-runs skip migrated projects (idempotent).
// -> { results: [{ project, ok, notes, connections, error?, warning?, skipped? }], failed }
app.post('/api/migrations/canvas/run', (req, res) => {
  try {
    const body = req.body || {};
    let targets;
    if (body.projects !== undefined) {
      if (!Array.isArray(body.projects) || body.projects.length === 0
        || body.projects.some(p => typeof p !== 'string' || !sanitizeProjectName(p))) {
        return res.status(400).json({ error: 'projects must be a non-empty array of project names' });
      }
      targets = [...new Set(body.projects)];
    } else {
      targets = scanPendingCanvasMigrations().map(p => p.project);
    }
    const results = targets.map(name => migrateCanvasProject(name));
    res.json({ results, failed: results.filter(r => !r.ok).length });
  } catch (err) {
    sendCanvasError(res, err);
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
  if (!projectExists(projectName)) return res.status(404).json({ error: 'Project not found' });

  // Format structured message for agent
  const noteLines = notes
    .map(n => `- ${n.id} (${n.color || 'grey'}): "${(n.text || '').replace(/"/g, '\\"')}"`)
    .join('\n');
  const connLines = (connections || [])
    .map(c => `${c.from} → ${c.to}`)
    .join(', ') || 'none';

  // Fire-and-forget: respond immediately, webhook runs async
  const gatewayUrl = GATEWAY_URL;
  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN;

  const sourceNoteIds = notes.map(n => n.id);
  const hasTriggerAgent = req.body.agentId !== undefined && req.body.agentId !== null && String(req.body.agentId).trim() !== '';
  const identity = hasTriggerAgent ? agentIdentity.validateAgentId(req.body.agentId) : null;
  if (identity && !identity.ok) return res.status(400).json({ error: identity.error });
  const triggerAgentId = identity?.id || null;
  const sessionAgentId = triggerAgentId || 'human';

  // The hooks token is only needed for the chat-agent webhook path. The
  // dashboard path (no agentId) runs the Specify Stepper and must work on
  // installations without any hook configuration (SC-001).
  if (triggerAgentId && !hooksToken) {
    console.error('Promote bridge: OPENCLAW_HOOKS_TOKEN not set');
    return res.status(503).json({ error: 'Agent not configured — hooks token missing' });
  }

  // Create Specify session (errors on duplicate notes or concurrent agent session)
  let session;
  try {
    session = specifySession.createSession({
      project: projectName,
      origin: 'canvas',
      sourceNoteIds,
      agentId: sessionAgentId,
      sourceDescription: `${noteLines}\nConnections: ${connLines}`,
      transport: triggerAgentId ? 'chat' : 'dashboard',
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
  res.json({ ok: true, message: 'Idea sent to session', sessionId: session.id });

  // T-177-3: Only send webhook if agentId was explicitly provided (scripted callers).
  // Dashboard UI (no agentId) handles the session directly via the Specify Stepper.
  if (triggerAgentId) {
    try {
      const hookRes = await fetch(`${gatewayUrl}/hooks/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hooksToken}`,
        },
        body: JSON.stringify({
          message,
          name: 'Canvas Specify',
          ...flowboardNotificationDelivery(),
          agentId: triggerAgentId,
          sessionKey: `agent:${triggerAgentId}:main`,
          wakeMode: 'now',
        }),
      });
      if (!hookRes.ok) {
        console.error('Promote webhook error:', hookRes.status, await hookRes.text());
      }
    } catch (err) {
      console.error('Promote webhook error:', err.message || err);
    }
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

// POST /api/specify/sessions — create a new session
app.post('/api/specify/sessions', (req, res) => {
  try {
    const { project, origin, agentId, sourceNoteIds = [], sourceDescription = '', transport = 'api' } = req.body;
    if (!project) return res.status(400).json({ error: 'project is required' });
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    // Path-traversal guard + existence check (review finding): the project
    // name becomes a filesystem path segment during persistence. Same
    // fs-based check as the canvas promote path.
    if (/[/\\]|\.\./.test(project) || !projectExists(project)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const session = specifySession.createSession({
      project,
      origin: origin || 'canvas',
      agentId,
      sourceNoteIds,
      sourceDescription,
      transport,
    });

    res.status(201).json({ session });
  } catch (err) {
    console.error('[api]', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/specify/sessions/:id — get session details
app.get('/api/specify/sessions/:id', (req, res) => {
  try {
    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // maxQuestions: UI label stays correct when SPECIFY_MAX_QUESTIONS overrides
    res.json({ ...session, maxQuestions: specifyPolicy.MAX_CLARIFICATIONS });
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

// Shared step handler for /next, /skip, /retry and /revise (T-262-11/17).
// mode: 'next' → normal step; 'skip' → produce proposal from defaults;
//       'retry' → recover an errored session, then run a normal step;
//       'revise' → record proposal feedback, then request improved proposal.
async function handleSpecifyStep(req, res, mode) {
  try {
    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (mode === 'retry') {
      if (session.status !== 'error') {
        return res.status(409).json({ error: `Session is not in error state (${session.status})` });
      }
      specifySession.recoverFromError(req.params.id);
    }

    if (mode === 'revise') {
      if (session.status !== 'proposal-ready') {
        return res.status(409).json({ error: `Session has no proposal to revise (${session.status})` });
      }
      const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : '';
      if (!feedback) return res.status(400).json({ error: 'feedback is required' });
      specifySession.updateSession(req.params.id, {
        status: 'analyzing',
        revisionNotes: [...(session.revisionNotes || []), feedback],
      });
    }

    // Status guard (review finding): /next and /skip on a session that is
    // not awaiting a worker step would burn a full worker call (up to 90s)
    // only to fail the state transition afterwards.
    if ((mode === 'next' || mode === 'skip') &&
        !['created', 'analyzing', 'clarifying'].includes(session.status)) {
      return res.status(409).json({ error: `Session is not awaiting a worker step (${session.status})` });
    }

    // Transition created → analyzing on first call
    if (specifySession.getSession(req.params.id).status === 'created') {
      specifySession.updateSession(req.params.id, { status: 'analyzing' });
    }

    const result = mode === 'skip'
      ? await specifyWorkerBridge.skipRemaining(req.params.id)
      : mode === 'revise'
        ? await specifyWorkerBridge.reviseProposal(req.params.id)
        : await specifyWorkerBridge.requestNext(req.params.id);

    // Update session based on worker response.
    // Re-fetch the session: concatenating onto the pre-step snapshot would
    // drop concurrent updates (same stale-snapshot class as in /answer).
    if (result.action === 'question') {
      const fresh = specifySession.getSession(req.params.id);
      const qId = `q-${fresh.clarifications.length + 1}`;
      const updated = fresh.clarifications.concat([{
        id: qId,
        question: result.workerRequest.question,
        options: result.workerRequest.options || [],
        recommended: result.workerRequest.recommended,
        answer: null,
        affectedFields: result.workerRequest.affectedFields || [],
      }]);
      specifySession.updateSession(req.params.id, {
        status: 'clarifying',
        clarifications: updated,
      });
    } else if (result.action === 'proposal') {
      specifySession.updateSession(req.params.id, {
        status: 'proposal-ready',
        draftProposal: result.workerRequest,
      });
    } else if (result.action === 'error') {
      specifySession.updateSession(req.params.id, {
        status: 'error',
        failureState: {
          action: 'worker-request',
          error: result.message || 'Worker returned error',
          timestamp: Date.now(),
        },
      });
    }

    res.json({
      action: result.action,
      session: specifySession.getSession(req.params.id),
      workerRequest: result.workerRequest,
    });
  } catch (err) {
    console.error('[api]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// POST /api/specify/sessions/:id/next — request next action from worker
app.post('/api/specify/sessions/:id/next', (req, res) => handleSpecifyStep(req, res, 'next'));

// POST /api/specify/sessions/:id/skip — skip remaining questions, request proposal from defaults
app.post('/api/specify/sessions/:id/skip', (req, res) => handleSpecifyStep(req, res, 'skip'));

// POST /api/specify/sessions/:id/retry — recover an errored session and re-request
app.post('/api/specify/sessions/:id/retry', (req, res) => handleSpecifyStep(req, res, 'retry'));

// POST /api/specify/sessions/:id/revise — reject draft proposal with feedback, request improved one
app.post('/api/specify/sessions/:id/revise', (req, res) => handleSpecifyStep(req, res, 'revise'));

// POST /api/specify/sessions/:id/answer — record user answer to clarification or proposal
app.post('/api/specify/sessions/:id/answer', async (req, res) => {
  try {
    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { action, clarificationId, answer, specContent, taskBreakdown } = req.body;

    if (action === 'error') {
      specifySession.updateSession(req.params.id, {
        status: 'error',
        failureState: {
          action: 'worker-error',
          error: req.body.error || req.body.message || 'Worker returned error',
          timestamp: Date.now(),
        },
      });
      return res.json({
        action: 'error',
        session: specifySession.getSession(req.params.id),
      });
    }

    if (action === 'question') {
      if (!req.body.question || !answer) {
        return res.status(400).json({ error: 'question and answer are required' });
      }
      const qId = `q-${session.clarifications.length + 1}`;
      const updated = session.clarifications.concat([{
        id: qId,
        question: req.body.question,
        options: req.body.options || [],
        recommended: req.body.recommended || null,
        answer,
        affectedFields: req.body.affectedFields || [],
      }]);
      if (session.status === 'created') specifySession.updateSession(req.params.id, { status: 'analyzing' });
      if (['analyzing', 'clarifying'].includes(specifySession.getSession(req.params.id).status)) {
        specifySession.updateSession(req.params.id, { status: 'clarifying', clarifications: updated });
      } else {
        specifySession.updateSession(req.params.id, { clarifications: updated });
      }
      return res.json({
        action: 'question',
        session: specifySession.getSession(req.params.id),
      });
    }

    // Handle action-based flow (chat-origin: proposal directly).
    // Validate against the same policy contract as worker proposals
    // (review finding) — chat agents must not bypass the schema either.
    if (action === 'proposal') {
      const proposal = {
        summary: req.body.summary ||
          (specContent || '').split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') ||
          'Specify proposal',
        taskStructure: req.body.taskStructure || 'Single task',
        specContent: specContent || '',
        taskBreakdown: taskBreakdown || [],
        quality: 'draft',
      };
      const check = specifyPolicy.validateWorkerResponse({ action: 'proposal', proposal });
      if (!check.ok) {
        return res.status(400).json({ error: `Invalid proposal: ${check.errors.join('; ')}` });
      }
      if (session.status === 'created') specifySession.updateSession(req.params.id, { status: 'analyzing' });
      specifySession.updateSession(req.params.id, {
        status: 'proposal-ready',
        draftProposal: proposal,
      });
      return res.json({
        action: 'proposal',
        session: specifySession.getSession(req.params.id),
        workerRequest: proposal,
      });
    }

    // Original flow: clarification questions via worker
    if (!clarificationId || !answer) {
      return res.status(400).json({ error: 'For question action, clarificationId and answer are required' });
    }

    const result = await specifyWorkerBridge.recordAnswer(req.params.id, clarificationId, answer);

    // Update session based on worker response.
    // Re-fetch the session: recordAnswer just persisted the user's answer,
    // and concatenating onto the stale pre-answer snapshot would drop it.
    if (result.action === 'question') {
      const fresh = specifySession.getSession(req.params.id);
      const qId = `q-${fresh.clarifications.length + 1}`;
      const updated = fresh.clarifications.concat([{
        id: qId,
        question: result.workerRequest.question,
        options: result.workerRequest.options || [],
        recommended: result.workerRequest.recommended,
        answer: null,
        affectedFields: result.workerRequest.affectedFields || [],
      }]);
      specifySession.updateSession(req.params.id, {
        clarifications: updated,
      });
    } else if (result.action === 'proposal') {
      specifySession.updateSession(req.params.id, {
        status: 'proposal-ready',
        draftProposal: result.workerRequest,
      });
    } else if (result.action === 'done') {
      specifySession.updateSession(req.params.id, {
        status: 'done',
      });
    } else if (result.action === 'error') {
      specifySession.updateSession(req.params.id, {
        status: 'error',
        failureState: {
          action: 'answer-processing',
          error: result.message || 'Worker error processing answer',
          timestamp: Date.now(),
        },
      });
    }

    res.json({
      action: result.action,
      session: specifySession.getSession(req.params.id),
      workerRequest: result.workerRequest,
    });
  } catch (err) {
    console.error('[api]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// POST /api/specify/sessions/:id/confirm — confirm proposal and persist
app.post('/api/specify/sessions/:id/confirm', async (req, res) => {
  try {
    const session = specifySession.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Accept both 'userApproval' and 'approved' for compatibility with different flows
    const approval = req.body.userApproval !== undefined ? req.body.userApproval : req.body.approved;
    if (approval === undefined) {
      return res.status(400).json({ error: 'userApproval or approved is required' });
    }

    const { customizations } = req.body;

    if (!approval) {
      specifySession.updateSession(req.params.id, { status: 'aborted' });
      return res.json({
        session: specifySession.getSession(req.params.id),
      });
    }

    const result = await specifyWorkerBridge.confirmProposal(req.params.id, approval, customizations);
    const artifacts = persistSpecifyProposal(result.session, {
      cleanupNotes: customizations?.cleanupNotes,
    });

    specifySession.updateSession(req.params.id, { createdArtifacts: artifacts });
    specifySession.updateSession(req.params.id, { status: 'done' });

    res.json({
      session: specifySession.getSession(req.params.id),
      createdArtifacts: artifacts,
      specPath: artifacts.specFiles[0] || null,
      createdTasks: artifacts.taskIds,
      cleanedNotes: artifacts.cleanedNoteIds,
    });
  } catch (err) {
    console.error('[api]', err);
    let session = specifySession.getSession(req.params.id);
    if (session) {
      // Review finding: without this, a persist failure strands the session
      // in non-terminal 'persisting' — unretryable, unabortable, and (via the
      // shared 'human' agent id) blocking every new dashboard session until
      // the 2h cleanup. error is reachable from any active state and the
      // stepper offers retry/close there.
      if (!specifySession.isTerminal(session.status)) {
        try {
          session = specifySession.recordFailure(req.params.id, 'persist', err) || session;
        } catch (transitionErr) {
          console.error('[specify] failed to record persist failure:', transitionErr.message);
        }
      }
      res.status(err.message.includes('Session not found') ? 404 : 400).json({
        error: err.message,
        session,
      });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  }
});

// =============================================================================
// Phase 5: Coordination Primitives — Claim, Checkpoint, Complete, Comment, Stuck, Handoff
// =============================================================================

// POST /api/projects/:name/tasks/:id/claim
app.post('/api/projects/:name/tasks/:id/claim', (req, res) => {
  try {
    const { agent, lease } = req.body;
    const identity = agentIdentity.validateAgentId(agent, 'agent');
    if (!identity.ok) return res.status(400).json({ error: identity.error });
    const task = hzlService.claimTask(req.params.name, req.params.id, { agent: identity.id, lease });
    // T-366: claiming a subtask moves it to in-progress; pull the parent along
    // (backlog/open → in-progress) so a started subtask never sits under an
    // idle parent. claimTask bypasses the generic aggregation path.
    const response = { ok: true, task, agentIdentity: agentIdentity.responseMeta(identity) };
    const parentUpdated = recalcParentForResponse(req.params.name, task.parentId);
    if (parentUpdated) response.parentUpdated = parentUpdated;
    res.json(response);
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/release
app.post('/api/projects/:name/tasks/:id/release', (req, res) => {
  try {
    const { agent, force } = req.body;
    const identity = agentIdentity.validateAgentId(agent, 'agent');
    if (!identity.ok) return res.status(400).json({ error: identity.error });
    const result = hzlService.releaseTask(req.params.name, req.params.id, { agent: identity.id, force });
    // T-366: releasing a subtask reverts it (in-progress → its previous status);
    // if no sibling is still active the parent should drop back to open/backlog.
    const full = hzlService.getTask(req.params.name, req.params.id);
    const parentUpdated = recalcParentForResponse(req.params.name, full?.parentId);
    if (parentUpdated) result.parentUpdated = parentUpdated;
    res.json(result);
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/complete
app.post('/api/projects/:name/tasks/:id/complete', (req, res) => {
  try {
    const { agent } = req.body;
    const identity = agentIdentity.validateAgentId(agent, 'agent');
    if (!identity.ok) return res.status(400).json({ error: identity.error });
    const task = hzlService.completeTask(req.params.name, req.params.id, { agent: identity.id });
    // Recalculate parent status if this is a subtask (T-366: also report it back)
    const response = { ok: true, task };
    const parentUpdated = recalcParentForResponse(req.params.name, task.parentId);
    if (parentUpdated) response.parentUpdated = parentUpdated;
    res.json(response);
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// T-186: POST /api/projects/:name/tasks/:id/approve
// Review/admin action — accept work in review and finalise (review -> done).
// Unlike /complete this is NOT owner-gated: it represents a human/admin
// reviewer signing off on completed work, which is typically a different
// actor than the agent that filed it for review.
app.post('/api/projects/:name/tasks/:id/approve', (req, res) => {
  try {
    const { actor, reason } = req.body || {};
    const task = hzlService.approveTask(req.params.name, req.params.id, { actor, reason });
    const response = { ok: true, task };
    const parentUpdated = recalcParentForResponse(req.params.name, task.parentId);
    if (parentUpdated) response.parentUpdated = parentUpdated;
    res.json(response);
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// T-186: POST /api/projects/:name/tasks/:id/reject
// Review/admin action — send task back to actionable work with a reason.
// Body: { actor?, reason (required), target? ('in-progress'|'blocked') }
app.post('/api/projects/:name/tasks/:id/reject', (req, res) => {
  try {
    const { actor, reason, target } = req.body || {};
    if (target !== undefined && target !== null && target !== 'in-progress' && target !== 'blocked') {
      return res.status(400).json({ error: `Invalid target: "${target}". Must be "in-progress" or "blocked".` });
    }
    const task = hzlService.rejectTask(req.params.name, req.params.id, { actor, reason, target });
    // T-366: rejecting a subtask back to in-progress/blocked may pull a parent
    // that had reached review back into in-progress.
    const response = { ok: true, task };
    const parentUpdated = recalcParentForResponse(req.params.name, task.parentId);
    if (parentUpdated) response.parentUpdated = parentUpdated;
    res.json(response);
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/checkpoint
app.post('/api/projects/:name/tasks/:id/checkpoint', (req, res) => {
  try {
    const { message, agent, progress } = req.body;
    const identity = agentIdentity.validateAgentId(agent, 'agent');
    if (!identity.ok) return res.status(400).json({ error: identity.error });
    const checkpoint = hzlService.addCheckpoint(req.params.name, req.params.id, { message, agent: identity.id, progress });
    res.json({ ok: true, checkpoint, agentIdentity: agentIdentity.responseMeta(identity) });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// GET /api/projects/:name/tasks/:id/checkpoints
app.get('/api/projects/:name/tasks/:id/checkpoints', (req, res) => {
  try {
    const checkpoints = hzlService.getCheckpoints(req.params.name, req.params.id);
    res.json({ ok: true, checkpoints });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/comment
app.post('/api/projects/:name/tasks/:id/comment', (req, res) => {
  try {
    const { message } = req.body;
    // T-232: accept `agent` (validated, consistent with checkpoint/claim) as the
    // author source; fall back to the free-form `author` the UI sends for humans.
    const resolved = agentIdentity.resolveActivityAuthor(req.body);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    // T-307: typed comments — questions from agents, answers that resolve them
    const kind = req.body.kind ?? null;
    if (kind !== null && !['question', 'answer'].includes(kind)) {
      return res.status(400).json({ error: "kind must be 'question' or 'answer'" });
    }
    const questionId = req.body.questionId ?? null;
    if (kind === 'answer' && (questionId === null || questionId === undefined || !Number.isInteger(Number(questionId)))) {
      return res.status(400).json({ error: 'answers need the questionId they resolve' });
    }
    const comment = hzlService.addComment(req.params.name, req.params.id, { message, author: resolved.author, kind, questionId });
    res.json({ ok: true, comment });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// GET /api/projects/:name/tasks/:id/comments
app.get('/api/projects/:name/tasks/:id/comments', (req, res) => {
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
  try {
    const events = hzlService.getStatusEvents(req.params.name, req.params.id);
    res.json({ ok: true, events });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/move — move task (+subtasks) to another project (T-302)
app.post('/api/projects/:name/tasks/:id/move', (req, res) => {
  try {
    const toProject = String(req.body?.toProject || '').trim();
    if (!toProject) return res.status(400).json({ error: 'toProject required' });
    if (/[/\\]|\.\./.test(toProject)) return res.status(400).json({ error: 'Invalid project name' });
    if (!projectExists(toProject)) return res.status(404).json({ error: 'Target project not found' });
    const task = hzlService.moveTaskToProject(req.params.name, req.params.id, toProject);
    res.json({ ok: true, task });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/parent — re-parent within the project (T-302)
app.post('/api/projects/:name/tasks/:id/parent', (req, res) => {
  try {
    const parentId = req.body?.parentId ?? null;
    if (parentId !== null && typeof parentId !== 'string') {
      return res.status(400).json({ error: 'parentId must be a task id string or null' });
    }
    const task = hzlService.setTaskParent(req.params.name, req.params.id, parentId);
    res.json({ ok: true, task });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// --- Overview (T-305): per-project modular landing page, SDUI ---

// GET /api/overview/widgets — trusted widget registry + presets (for agents and the picker)
// GET /api/github/repo-status?repo=owner/name — feeds the repo-status
// widget (T-310). Server-side fetch so the GitHub token stays here.
app.get('/api/github/repo-status', async (req, res) => {
  const repo = String(req.query.repo || '');
  if (!github.validRepo(repo)) {
    return res.status(400).json({ error: 'repo must be "owner/name"' });
  }
  const branch = req.query.branch ? String(req.query.branch) : null;
  if (branch && !github.validBranch(branch)) {
    return res.status(400).json({ error: 'invalid branch name' });
  }
  try {
    res.json({ ok: true, status: await github.fetchRepoStatus(repo, branch) });
  } catch (err) {
    const status = err.status === 404 ? 404 : 502;
    res.status(status).json({ error: `GitHub fetch failed: ${err.message}` });
  }
});

// T-328 — project-level GitHub binding: one repo/branch every gh-* widget
// on the project's overview shares. Widget props.repo stays as override.
app.get('/api/projects/:name/github', (req, res) => {
  const meta = fbMeta.getProject(req.params.name);
  if (!meta) return res.status(404).json({ error: 'Project not found' });
  const config = (() => { try { return JSON.parse(meta.config || '{}'); } catch { return {}; } })();
  res.json({ ok: true, github: config.github || null });
});

app.put('/api/projects/:name/github', (req, res) => {
  const body = req.body || {};
  if (body.github === null || body.repo === null) {
    fbMeta.updateProjectMeta(req.params.name, { github: null });
    return res.json({ ok: true, github: null });
  }
  const repo = String(body.repo || '');
  if (!github.validRepo(repo)) return res.status(400).json({ error: 'repo must be "owner/name"' });
  const branch = body.branch ? String(body.branch) : null;
  if (branch && !github.validBranch(branch)) return res.status(400).json({ error: 'invalid branch name' });
  const meta = fbMeta.updateProjectMeta(req.params.name, { github: { repo, ...(branch ? { branch } : {}) } });
  if (!meta) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true, github: { repo, ...(branch ? { branch } : {}) } });
});

// T-320 — GitHub token, stored server-side and write-only: GET only says
// whether one is configured, the value is never echoed back to a client.
// An env token (FLOWBOARD_GITHUB_TOKEN/GITHUB_TOKEN) takes precedence.
app.get('/api/settings/github-token', (req, res) => {
  const envSet = Boolean(process.env.FLOWBOARD_GITHUB_TOKEN || process.env.GITHUB_TOKEN);
  res.json({ ok: true, set: github.hasToken(), source: envSet ? 'env' : (fbMeta.getSetting('github_token') ? 'settings' : null) });
});

app.put('/api/settings/github-token', (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !/^[\w.-]{20,255}$/.test(token.trim())) {
    return res.status(400).json({ error: 'token must be a GitHub personal access token' });
  }
  fbMeta.setSetting('github_token', token.trim());
  github.clearCache(); // drop rate-limited/stale entries so the token applies now
  res.json({ ok: true });
});

app.delete('/api/settings/github-token', (req, res) => {
  fbMeta.setSetting('github_token', null);
  github.clearCache();
  res.json({ ok: true });
});

// GET /api/github/insight?repo=owner/name&view=pulls|ci|releases|issues[&branch=]
// — feeds the gh-* overview widgets (T-316..T-319)
app.get('/api/github/insight', async (req, res) => {
  const repo = String(req.query.repo || '');
  const view = String(req.query.view || '');
  if (!github.validRepo(repo)) {
    return res.status(400).json({ error: 'repo must be "owner/name"' });
  }
  if (!github.INSIGHT_VIEWS.has(view)) {
    return res.status(400).json({ error: `view must be one of: ${[...github.INSIGHT_VIEWS].join(', ')}` });
  }
  const branch = req.query.branch ? String(req.query.branch) : null;
  if (branch && !github.validBranch(branch)) {
    return res.status(400).json({ error: 'invalid branch name' });
  }
  try {
    res.json({ ok: true, insight: await github.fetchInsight(repo, view, branch) });
  } catch (err) {
    const status = err.status === 404 ? 404 : err.status === 400 ? 400 : 502;
    res.status(status).json({ error: `GitHub fetch failed: ${err.message}` });
  }
});

app.get('/api/overview/widgets', (req, res) => {
  res.json({ ok: true, ...overview.widgetManifest() });
});

// GET /api/projects/:name/overview — layout config (default preset when no file exists)
app.get('/api/projects/:name/overview', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  const ov = overview.readOverview(PROJECTS_DIR, req.params.name);
  // T-365-3: when the project never tailored its overview but now has tasks,
  // attach a gentle best-fit nudge so an agent is reminded to tailor it at a
  // useful moment. Best-effort — never break the read.
  if (ov.source === 'default') {
    try {
      const meta = fbMeta.getProject(req.params.name) || {};
      const taskCount = hzlService.listTasks(req.params.name, { includeArchived: false }).length;
      // fbMeta.getProject returns the raw row — the column is `display_name`.
      const nudge = overview.buildNudge(
        ov,
        { name: req.params.name, displayName: meta.display_name, description: meta.description, group: meta.group },
        taskCount,
      );
      if (nudge) ov.nudge = nudge;
    } catch (e) {
      console.warn('[overview] nudge computation failed:', e.message);
    }
  }
  res.json({ ok: true, overview: ov });
});

// PUT /api/projects/:name/overview — body: { preset } to materialize a named
// preset, or a full { version, layout, widgets } config (validated against
// the registry). Agents and the edit-mode UI write the same schema.
app.put('/api/projects/:name/overview', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    let config;
    if (req.body && typeof req.body.preset === 'string' && !req.body.widgets) {
      config = overview.presetConfig(req.body.preset);
      if (!config) return res.status(400).json({ error: `Unknown preset "${req.body.preset}"`, presets: Object.keys(overview.PRESETS) });
    } else if (req.body && req.body.layout === 'flow') {
      // Coordinate-free flow authoring (T-365): the caller sends an ordered list
      // of { type, size?, props?, title? } and the server packs it into a grid,
      // then runs the same trusted validator as any other config.
      const result = overview.validateOverview(overview.packFlow(req.body.widgets));
      if (!result.ok) return res.status(400).json({ error: 'Invalid overview config', errors: result.errors });
      config = result.config;
    } else {
      const result = overview.validateOverview(req.body);
      if (!result.ok) return res.status(400).json({ error: 'Invalid overview config', errors: result.errors });
      config = result.config;
    }
    overview.writeOverview(PROJECTS_DIR, req.params.name, config);
    res.json({ ok: true, overview: { source: 'file', ...config } });
  } catch (err) {
    console.error('[overview]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:name/overview/ops — incremental patch-ops (T-365-2).
// Body: { ops:[...] } of small, coordinate-free operations (add/remove/resize/
// reorder). The current layout is loaded, the ops are applied and re-packed
// into a clean grid, then run through the same trusted validator as any other
// write. Lets agents refine a layout without rewriting the whole thing.
app.post('/api/projects/:name/overview/ops', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    const current = overview.readOverview(PROJECTS_DIR, req.params.name);
    let packed;
    try {
      packed = overview.applyOps(current, req.body && req.body.ops);
    } catch (opErr) {
      return res.status(400).json({ error: opErr.message });
    }
    const result = overview.validateOverview(packed);
    if (!result.ok) return res.status(400).json({ error: 'Invalid overview config', errors: result.errors });
    overview.writeOverview(PROJECTS_DIR, req.params.name, result.config);
    res.json({ ok: true, overview: { source: 'file', ...result.config } });
  } catch (err) {
    console.error('[overview]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:name/stats — project metrics (T-303), same numbers
// the task-stats widget shows, for agents to query programmatically
app.get('/api/projects/:name/stats', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json({ ok: true, stats: hzlService.getProjectStats(req.params.name) });
  } catch (err) {
    console.error('[stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:name/questions — open agent questions (T-307)
app.get('/api/projects/:name/questions', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json({ ok: true, questions: hzlService.getOpenQuestions(req.params.name, req.query.limit) });
  } catch (err) {
    console.error('[questions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:name/activity/daily?days=14 — per-day counts (T-323)
app.get('/api/projects/:name/activity/daily', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json({ ok: true, ...hzlService.getProjectActivityDaily(req.params.name, req.query.days) });
  } catch (err) {
    console.error('[activity-daily]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:name/activity — project-wide activity feed (T-306)
app.get('/api/projects/:name/activity', (req, res) => {
  if (!projectExists(req.params.name)) return res.status(404).json({ error: 'Project not found' });
  try {
    const since = req.query.since ? String(req.query.since) : null;
    if (since && Number.isNaN(new Date(since).getTime())) {
      return res.status(400).json({ error: 'since must be an ISO timestamp' });
    }
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit) || 50 : 50;
    const activity = hzlService.getProjectActivity(req.params.name, { since, limit });
    res.json({ ok: true, activity });
  } catch (err) {
    console.error('[activity]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/search — cross-project full-text task search (T-301)
app.get('/api/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const limit = req.query.limit !== undefined ? Math.max(1, Math.min(50, parseInt(req.query.limit) || 20)) : 20;
    const offset = req.query.offset !== undefined ? Math.max(0, parseInt(req.query.offset) || 0) : 0;
    const project = req.query.project || undefined;
    // T-369: smart in-memory task search (id lookup, operators, infix + fuzzy,
    // custom ranking). Notes and project-name matching below stay as-is.
    const result = hzlService.smartSearchTasks(q, { project, limit, offset });

    // T-349: unified search also covers canvas notes and project names
    const { notes } = hzlService.searchNotes(q, { project, limit: 10 });
    const ql = q.toLowerCase();
    let projects = [];
    try {
      projects = fbMeta.listProjects(hzlService.listHzlProjects())
        .filter(p => !p.archived)
        .filter(p => String(p.name || '').toLowerCase().includes(ql)
          || String(p.displayName || p.display_name || '').toLowerCase().includes(ql))
        .slice(0, 8)
        .map(p => ({ name: p.name, displayName: p.displayName || p.display_name || p.name }));
    } catch (e) { console.warn('[search] project match:', e.message); }

    res.json({ ok: true, query: q, ...result, notes, projects });
  } catch (err) {
    console.error('[search]', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/tasks/stuck — cross-project stuck tasks (stale + expired)
app.get('/api/tasks/stuck', (req, res) => {
  try {
    const staleThreshold = req.query.staleThreshold !== undefined ? Math.max(0, parseInt(req.query.staleThreshold) || 0) : 10;
    const stuck = hzlService.getStuckTasks({ staleThreshold });
    res.json({ ok: true, stuck });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tasks/notifiable-stuck — T-248: stuck tasks due for notification (filters by window)
app.get('/api/tasks/notifiable-stuck', (req, res) => {
  try {
    const staleThreshold = req.query.staleThreshold !== undefined ? Math.max(0, parseInt(req.query.staleThreshold) || 0) : 30;
    const notificationWindow = req.query.notificationWindow !== undefined ? Math.max(1, parseInt(req.query.notificationWindow) || 60) : 60;
    const notifiable = hzlService.getNotifiableStuckTasks({
      staleThreshold,
      notificationWindow,
    });
    res.json({ ok: true, notifiable, appliedThresholds: { staleThreshold, notificationWindow } });
  } catch (err) {
    console.error('[api]', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/workflows/start — resume current agent work or claim next eligible task
app.post('/api/workflows/start', (req, res) => {
  try {
    const { agent, project, lease, resumePolicy, includeAlternates } = req.body || {};
    const identity = agentIdentity.validateAgentId(agent, 'agent');
    if (!identity.ok) return res.status(400).json({ error: identity.error });
    if (!project) return res.status(400).json({ error: 'project is required' });
    const result = hzlService.workflowStart(project, {
      agent: identity.id,
      lease,
      resumePolicy,
      includeAlternates,
    });
    res.json({ ok: true, ...result, agentIdentity: agentIdentity.responseMeta(identity) });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/workflows/handoff — complete source task and create follow-on work
app.post('/api/workflows/handoff', (req, res) => {
  try {
    const { project, fromTaskId, title, agent, carryCheckpoints, carryMaxChars, opId } = req.body || {};
    if (!project) return res.status(400).json({ error: 'project is required' });
    let routedAgent = null;
    if (agent !== undefined && agent !== null && agent !== '') {
      const identity = agentIdentity.validateAgentId(agent, 'agent');
      if (!identity.ok) return res.status(400).json({ error: identity.error });
      routedAgent = identity.id;
    }
    const result = hzlService.workflowHandoff(project, {
      fromTaskId,
      title,
      agent: routedAgent,
      carryCheckpoints,
      carryMaxChars,
      opId,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// POST /api/workflows/delegate — create delegated child work from a source task
app.post('/api/workflows/delegate', (req, res) => {
  try {
    const { project, fromTaskId, title, agent, noDepends, pauseParent, checkpoint, opId } = req.body || {};
    if (!project) return res.status(400).json({ error: 'project is required' });
    let routedAgent = null;
    if (agent !== undefined && agent !== null && agent !== '') {
      const identity = agentIdentity.validateAgentId(agent, 'agent');
      if (!identity.ok) return res.status(400).json({ error: identity.error });
      routedAgent = identity.id;
    }
    const result = hzlService.workflowDelegate(project, {
      fromTaskId,
      title,
      agent: routedAgent,
      noDepends: noDepends === true,
      pauseParent: pauseParent === true,
      checkpoint,
      opId,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = httpStatusForError(err);
    res.status(status).json({ error: err.message });
  }
});

// GET /api/projects/:name/tasks/:id/handoff — handoff context for CC/ACP spawning
app.get('/api/projects/:name/tasks/:id/handoff', (req, res) => {
  try {
    // T-296: default to the markdown startup contract (what AGENTS.md tells
    // agents to fetch and follow). ?format=json returns the legacy structured
    // context. Previously this endpoint only returned JSON, so the markdown
    // contract never reached HTTP callers — a drift the old test missed by
    // reimplementing the route instead of exercising the real one.
    if (req.query.format === 'json') {
      const context = hzlService.getHandoffContext(req.params.name, req.params.id);
      return res.json({ ok: true, ...context });
    }
    const markdown = hzlService.buildHandoffMarkdown(req.params.name, req.params.id, {
      apiBase: `http://127.0.0.1:${PORT}`,
      targetAgentId: req.query.agentId || req.query.agent || undefined,
    });
    res.type('text/markdown; charset=utf-8').send(markdown);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/projects/:name/tasks/:id/route — route a task to a specific agent
app.post('/api/projects/:name/tasks/:id/route', (req, res) => {
  try {
    const { agent } = req.body;
    if (agent === null || agent === undefined || agent === '') {
      const task = hzlService.routeTask(req.params.name, req.params.id, null);
      return res.json({ ok: true, task });
    }
    const identity = agentIdentity.validateAgentId(agent, 'agent');
    if (!identity.ok) return res.status(400).json({ error: identity.error });
    const task = hzlService.routeTask(req.params.name, req.params.id, identity.id);
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
  console.log('[hzl-service] Initializing...');
  await hzlService.init(HZL_DB_PATH);
  console.log('[hzl-service] Ready.');

    // Boot-time integrity check — detects filesystem-level rollback of the
    // events table that the events_no_update / events_no_delete triggers
    // cannot catch (see ADR-0018). Watermark is the highest seen events.id
    // plus total row count, persisted in hzl_local_meta between boots.
    try {
      const eventsDb = hzlService.getEventsDb();
      const cacheDb = hzlService.getCacheDb();
      const current = hzlIntegrity.getCurrentWatermark(eventsDb);
      const stored = hzlIntegrity.getStoredWatermark(cacheDb);
      const regression = hzlIntegrity.checkRegression(stored, current);
      _bootIntegrity = { stored, current, regression, checked_at: new Date().toISOString() };

      if (regression) {
        console.error(
          `[integrity] ⚠️ REGRESSION DETECTED — events ${regression.type === 'max_id_regressed' ? 'max_id' : 'count'} ` +
          `shrank from ${regression.before} to ${regression.after}.\n` +
          `  This signals filesystem-level rollback of flowboard.db ` +
          `(restore script, snapshot revert, or manual overwrite).\n` +
          `  Inspect ~/.openclaw/workspace git history or your backup chain for the last good state.\n` +
          `  Operator action: once data is recovered, clear the watermark via\n` +
          `  DELETE FROM hzl_local_meta WHERE key LIKE 'integrity.%'; — next boot will reset the baseline.`
        );

        // Optional push notification via configurable webhook. Body has both
        // a human-readable `text` field (consumed by gateway-style routers)
        // and structured fields (`regression`, `current`, `stored`, `host`)
        // for monitoring tools. No alerting framework hard-coded.
        let notifyPromise = null;
        if (INTEGRITY_WEBHOOK_URL) {
          const body = hzlIntegrity.buildWebhookBody(
            regression, current, stored, process.env.LOCAL_HOSTNAME || null
          );
          Object.assign(body, flowboardNotificationDelivery());
          notifyPromise = fetch(INTEGRITY_WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(INTEGRITY_WEBHOOK_TOKEN ? { Authorization: `Bearer ${INTEGRITY_WEBHOOK_TOKEN}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
          }).then(r => {
            if (!r.ok) console.warn(`[integrity] webhook returned HTTP ${r.status}`);
          }).catch(e => console.warn('[integrity] webhook failed:', e.message));
        }

        if (HZL_INTEGRITY_STRICT) {
          // Await webhook (capped by AbortSignal.timeout) so the push lands
          // before SIGTERM-equivalent process.exit cuts it off.
          if (notifyPromise) await notifyPromise;
          console.error('[integrity] HZL_INTEGRITY_STRICT=true → refusing to start.');
          process.exit(1);
        }
        // Non-strict: keep the older (higher) watermark so subsequent boots
        // still flag the regression until the operator clears it explicitly.
      } else {
        hzlIntegrity.storeWatermark(cacheDb, current);
      }
    } catch (e) {
      console.warn('[integrity] boot check failed:', e.message);
    }

    // Boot-time canvas conflict scan (T-344-5, ADR-0018): a canvas.json that
    // reappeared next to a DB-migrated project (workspace restore from a
    // pre-migration backup) is logged here once; GET /api/migrations/canvas/
    // status reports it as `conflicts` for the UI banner. Read-only — the
    // operator resolves it (see migration docs).
    try {
      const canvasConflicts = scanCanvasConflicts();
      if (canvasConflicts.length) {
        console.warn(`[canvas-migration] boot scan: ${canvasConflicts.length} canvas.json conflict(s) — see GET /api/migrations/canvas/status`);
      }
    } catch (e) {
      console.warn('[canvas-migration] boot conflict scan failed:', e.message);
    }

    // Init FlowBoard metadata tables (creates flowboard_projects, flowboard_agents, flowboard_migrations)
    fbMeta.init(hzlService.getCacheDb());
    github.setTokenProvider(() => fbMeta.getSetting('github_token'));

    // Run all pending migrations via the registry. agentId is read directly
    // from OPENCLAW_AGENT_ID env (legacy operator hint, only used by the
    // one-time m003 backfill of ACTIVE-PROJECT.md → flowboard_agents). When
    // unset (the new normal post-T-177-3), m003 logs and skips. The
    // migration is idempotent and already applied on existing installs.
    // T-407: guarantee the projects dir exists before migrations run. On a
    // fresh install nothing creates it yet, and m005 writes a symlink into it —
    // a missing dir made fs.symlinkSync throw ENOENT and blocked startup.
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
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
    // T-177-3: route to the agent that completed the task (from event payload).
    // T-400: OFF by default — a finished task does not need to wake or ping
    // anyone (it is visible in the dashboard activity feed/timeline). Opt back
    // in with FLOWBOARD_NOTIFY_ON_COMPLETE=true.
    if (process.env.FLOWBOARD_NOTIFY_ON_COMPLETE === 'true') {
      hzlService.setOnComplete(({ project, taskId, title, agent }) => {
        const gatewayUrl = GATEWAY_URL;
        const token = HOOKS_TOKEN;
        const msg = `✅ Task ${taskId} "${title}" completed by ${agent || 'unknown'} (${project})`;
        fetch(`${gatewayUrl}/hooks/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            message: msg,
            name: 'FlowBoard',
            ...flowboardNotificationDelivery(),
            wakeMode: 'now',
            agentId: agent || undefined,
            sessionKey: agent ? `agent:${agent}:main` : undefined,
          }),
        }).catch(e => console.warn('[notify] Gateway unreachable:', e.message));
      });
    }

    // Hook drain — process outbox every 2 minutes
    setInterval(async () => {
      try {
        const result = await hzlService.drainHooks();
        if (result.delivered > 0) console.log(`[hook-drain] Delivered ${result.delivered} hooks`);
      } catch (e) { console.warn('[hook-drain] Error:', e.message); }
    }, 2 * 60 * 1000);

    // T-248: Stale-check — detect stuck tasks every 5 minutes, notify via gateway
    // Uses getNotifiableStuckTasks() to filter out duplicates within notification window (60min default)
    setInterval(() => {
      try {
        const staleMinutes = parseInt(process.env.STALE_THRESHOLD_MINUTES) || 30;
        const notificationWindowMinutes = parseInt(process.env.NOTIFICATION_WINDOW_MINUTES) || 60;

        // Get only tasks that should trigger a notification (avoids duplicates).
        // consume: true — the scheduler is the only consumer of the window
        // guard; API reads stay side-effect free (T-304).
        const notifiable = hzlService.getNotifiableStuckTasks({
          staleThreshold: staleMinutes,
          notificationWindow: notificationWindowMinutes,
          consume: true,
        });

        const staleList   = (notifiable && Array.isArray(notifiable.stale))   ? notifiable.stale   : [];
        const expiredList = (notifiable && Array.isArray(notifiable.expired)) ? notifiable.expired : [];
        const routedList  = (notifiable && Array.isArray(notifiable.routedUnclaimed)) ? notifiable.routedUnclaimed : [];

        if (staleList.length > 0 || expiredList.length > 0 || routedList.length > 0) {
          // T-400: owned stuck tasks wake ONLY their own agent's session
          // (channel 'none' → no operator Telegram); tasks without a responsible
          // agent escalate to the operator in one message. Replaces the old
          // blanket fallback to the `main` agent that spammed the operator.
          const payloads = buildStuckNotifications(
            { stale: staleList, expired: expiredList, routedUnclaimed: routedList },
            {
              operatorDelivery: flowboardNotificationDelivery(),
              wakeChannel: process.env.FLOWBOARD_STUCK_WAKE_CHANNEL || 'none',
            }
          );

          const gatewayUrl = GATEWAY_URL;
          const token = HOOKS_TOKEN;
          for (const body of payloads) {
            const who = body.agentId || 'unowned';
            fetch(`${gatewayUrl}/hooks/agent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
              body: JSON.stringify(body),
            }).then(r => {
              console.log(`[stale-check] notified ${who}: ${(body.stuck || []).length} task(s) (gateway ${r.status})`);
            }).catch(e => console.warn(`[stale-check] Gateway unreachable (${who}):`, e.message));
          }
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

    // Drift check: surface metadata rows or filesystem dirs that lack a HZL
    // project_created event. The dashboard hides such projects from
    // /api/projects, so silent drift means invisible work. Operators can heal
    // each entry with POST /api/projects/<name>/heal.
    try {
      const { detectProjectDrift } = require('./project-lifecycle.js');
      const drift = detectProjectDrift({ hzlService, fbMeta, projectsDir: PROJECTS_DIR });
      if (drift.length > 0) {
        const lines = drift.map(d => `  - ${d.name} (sources: ${d.sources.join(', ')})`);
        console.warn(
          `[invariant] ${drift.length} project(s) present at metadata/filesystem layer ` +
          `but missing HZL event:\n${lines.join('\n')}\n` +
          `  → POST /api/projects/<name>/heal to backfill, or GET /api/projects/drift for a JSON view.`
        );
      }
    } catch (e) {
      console.warn('[invariant] drift check failed:', e.message);
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
startServer().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
