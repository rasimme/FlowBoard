'use strict';

// Semantic-version comparison for the in-dashboard self-update flow (T-353).
// Pure, no IO. Used to decide whether the on-disk plugin version is newer than
// the running dashboard so the SnippetUpgrade panel can offer an update.
//
// Deliberately small: major.minor.patch with an optional pre-release suffix
// that is ignored for ordering except that a pre-release is older than its
// release (5.1.0-rc.1 < 5.1.0). No build metadata, no ranges — we only ever
// compare two concrete versions emitted by our own release process.

/** Parse "5.1.0" / "v5.1.0" / "5.1.0-rc.2" → {major,minor,patch,pre} or null. */
function parseSemver(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || null,
  };
}

/**
 * Compare two semver strings. Returns -1 if a<b, 0 if equal, 1 if a>b.
 * Unparseable inputs sort as "oldest" (treated below any valid version) so a
 * bad/missing on-disk version never spuriously signals an update.
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  // Equal core: a release (no pre) outranks a pre-release of the same core.
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;   // a is the release
  if (!pb.pre) return -1;  // b is the release
  // Both pre-releases: lexical compare of the identifier (good enough for rc.N).
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/** True when `candidate` is strictly newer than `current`. */
function isNewer(candidate, current) {
  return compareSemver(candidate, current) > 0;
}

module.exports = { parseSemver, compareSemver, isNewer };
