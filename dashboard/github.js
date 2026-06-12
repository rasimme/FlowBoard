'use strict';

// T-310 — GitHub repo status for the overview widget.
//
// Server-side only: the token (FLOWBOARD_GITHUB_TOKEN or GITHUB_TOKEN env)
// never reaches the client. Public repos work unauthenticated within
// GitHub's 60 req/h limit — responses are cached to stay well below it.

const TOKEN = process.env.FLOWBOARD_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const TTL_OK = 90 * 1000;
const TTL_ERR = 30 * 1000;
const _cache = new Map(); // repo → { at, ttl, data?, error? }

function validRepo(repo) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo || '');
}

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'flowboard-dashboard',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(res.status === 403 ? 'rate limited or forbidden' : `GitHub responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchRepoStatus(repo, branchOverride = null) {
  const cacheKey = `${repo}@${branchOverride || ''}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.at < cached.ttl) {
    if (cached.error) {
      const err = new Error(cached.error.message);
      err.status = cached.error.status;
      throw err;
    }
    return cached.data;
  }
  try {
    const meta = await gh(`/repos/${repo}`);
    const branch = branchOverride || meta.default_branch;
    const [pulls, commits, checks, branchList] = await Promise.all([
      gh(`/repos/${repo}/pulls?state=open&per_page=5`),
      gh(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=5`),
      // check-runs need no extra scope; repos without Actions just 404/empty
      gh(`/repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=30`).catch(() => null),
      gh(`/repos/${repo}/branches?per_page=50`).catch(() => null),
    ]);
    const runs = checks?.check_runs || [];
    let ci = 'none';
    if (runs.length) {
      if (runs.some(r => r.status !== 'completed')) ci = 'pending';
      else if (runs.some(r => ['failure', 'timed_out'].includes(r.conclusion))) ci = 'failing';
      else ci = 'passing';
    }
    const data = {
      repo,
      branch,
      defaultBranch: meta.default_branch,
      branches: (branchList || []).map(b => b.name),
      ci,
      pulls: (pulls || []).map(p => ({
        number: p.number,
        title: p.title,
        author: p.user?.login || null,
        draft: Boolean(p.draft),
        updatedAt: p.updated_at,
      })),
      commits: (commits || []).map(c => ({
        sha: (c.sha || '').slice(0, 7),
        message: (c.commit?.message || '').split('\n')[0].slice(0, 110),
        author: c.commit?.author?.name || c.author?.login || null,
        date: c.commit?.author?.date || null,
      })),
      fetchedAt: new Date().toISOString(),
    };
    _cache.set(cacheKey, { at: Date.now(), ttl: TTL_OK, data });
    return data;
  } catch (err) {
    console.warn('[github]', repo, err.message, err.cause?.code || err.cause?.message || '');
    _cache.set(cacheKey, { at: Date.now(), ttl: TTL_ERR, error: { message: err.message, status: err.status || 502 } });
    throw err;
  }
}

function validBranch(branch) {
  return /^[\w./-]{1,120}$/.test(branch || '');
}

module.exports = { fetchRepoStatus, validRepo, validBranch, hasToken: Boolean(TOKEN) };
