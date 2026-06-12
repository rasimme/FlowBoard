'use strict';

// T-310 — GitHub repo status for the overview widget.
//
// Server-side only: the token (FLOWBOARD_GITHUB_TOKEN or GITHUB_TOKEN env)
// never reaches the client. Public repos work unauthenticated within
// GitHub's 60 req/h limit — responses are cached to stay well below it.

const ENV_TOKEN = process.env.FLOWBOARD_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
// optional fallback: a token stored via the settings API (T-320) — env wins
let _tokenProvider = null;
function setTokenProvider(fn) { _tokenProvider = fn; }
function resolveToken() {
  if (ENV_TOKEN) return ENV_TOKEN;
  try { return _tokenProvider ? (_tokenProvider() || '') : ''; } catch { return ''; }
}
const API = 'https://api.github.com';
const TTL_OK = 150 * 1000;
const TTL_ERR = 30 * 1000;
const _cache = new Map(); // repo → { at, ttl, data?, error? }

function validRepo(repo) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo || '');
}

async function gh(path) {
  const token = resolveToken();
  const res = await fetch(`${API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'flowboard-dashboard',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    // serve the last good payload through rate limits/outages — a slightly
    // stale widget beats an error card
    const prior = _cache.get(cacheKey);
    if (prior?.data) {
      _cache.set(cacheKey, { at: Date.now(), ttl: TTL_ERR, data: prior.data });
      return prior.data;
    }
    _cache.set(cacheKey, { at: Date.now(), ttl: TTL_ERR, error: { message: err.message, status: err.status || 502 } });
    throw err;
  }
}

/**
 * T-316..T-319 — view-specific GitHub insights for the gh-* widgets.
 * One fetcher per view, same cache and token rules as fetchRepoStatus.
 */
async function fetchInsight(repo, view, branch = null) {
  const cacheKey = `${repo}#${view}@${branch || ''}`;
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
    let data;
    if (view === 'pulls') {
      const pulls = await gh(`/repos/${repo}/pulls?state=open&per_page=30`);
      data = {
        repo,
        pulls: pulls.map(p => ({
          number: p.number,
          title: p.title,
          author: p.user?.login || null,
          draft: Boolean(p.draft),
          reviewers: (p.requested_reviewers || []).length,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        })),
      };
    } else if (view === 'ci') {
      const effBranch = branch || (await gh(`/repos/${repo}`)).default_branch;
      const runs = await gh(`/repos/${repo}/actions/runs?per_page=20${effBranch ? `&branch=${encodeURIComponent(effBranch)}` : ''}`);
      data = {
        repo,
        branch: effBranch,
        runs: (runs.workflow_runs || []).map(r => ({
          id: r.id,
          name: r.name,
          number: r.run_number,
          status: r.status,                  // queued | in_progress | completed
          conclusion: r.conclusion,          // success | failure | cancelled | ...
          startedAt: r.run_started_at,
          updatedAt: r.updated_at,
          event: r.event,
          url: r.html_url,
        })),
      };
    } else if (view === 'releases') {
      const meta = await gh(`/repos/${repo}`);
      const releases = await gh(`/repos/${repo}/releases?per_page=3`).catch(() => []);
      const latest = releases[0] || null;
      let ahead = null;
      let unreleased = [];
      if (latest) {
        const cmp = await gh(`/repos/${repo}/compare/${encodeURIComponent(latest.tag_name)}...${encodeURIComponent(meta.default_branch)}`).catch(() => null);
        if (cmp) {
          ahead = cmp.ahead_by;
          unreleased = (cmp.commits || []).slice(-4).reverse().map(c => ({
            sha: (c.sha || '').slice(0, 7),
            message: (c.commit?.message || '').split('\n')[0].slice(0, 110),
          }));
        }
      }
      data = {
        repo,
        defaultBranch: meta.default_branch,
        latest: latest ? { tag: latest.tag_name, name: latest.name, publishedAt: latest.published_at, url: latest.html_url, draft: latest.draft, prerelease: latest.prerelease } : null,
        previous: releases.slice(1).map(r => ({ tag: r.tag_name, publishedAt: r.published_at })),
        ahead,
        unreleased,
      };
    } else if (view === 'issues') {
      // /issues includes PRs — filter them out
      const issues = (await gh(`/repos/${repo}/issues?state=open&per_page=50&sort=created&direction=desc`))
        .filter(i => !i.pull_request);
      data = {
        repo,
        issues: issues.map(i => ({
          number: i.number,
          title: i.title,
          author: i.user?.login || null,
          comments: i.comments,
          labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)).slice(0, 3),
          createdAt: i.created_at,
        })),
      };
    } else {
      const err = new Error(`unknown view "${view}"`);
      err.status = 400;
      throw err;
    }
    data.fetchedAt = new Date().toISOString();
    _cache.set(cacheKey, { at: Date.now(), ttl: TTL_OK, data });
    return data;
  } catch (err) {
    console.warn('[github]', repo, view, err.message, err.cause?.code || '');
    const prior = _cache.get(cacheKey);
    if (prior?.data) {
      _cache.set(cacheKey, { at: Date.now(), ttl: TTL_ERR, data: prior.data });
      return prior.data;
    }
    _cache.set(cacheKey, { at: Date.now(), ttl: TTL_ERR, error: { message: err.message, status: err.status || 502 } });
    throw err;
  }
}

const INSIGHT_VIEWS = new Set(['pulls', 'ci', 'releases', 'issues']);

function validBranch(branch) {
  return /^[\w./-]{1,120}$/.test(branch || '');
}

function hasToken() { return Boolean(resolveToken()); }
function clearCache() { _cache.clear(); }

module.exports = { fetchRepoStatus, fetchInsight, INSIGHT_VIEWS, validRepo, validBranch, setTokenProvider, hasToken, clearCache };
