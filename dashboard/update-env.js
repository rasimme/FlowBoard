'use strict';

const path = require('path');

/**
 * Build the environment for the detached `setup.mjs --update` spawn (T-406).
 *
 * The dashboard usually runs under launchd/systemd with a MINIMAL PATH that
 * excludes the node/npm bin dir (homebrew, nvm, fnm, volta, asdf, …). setup.mjs
 * shells out to `npm`, so without this it dies at its prerequisite check
 * ("npm not found on PATH") and the in-UI "Update & restart" silently no-ops —
 * the endpoint returns started:true but nothing rebuilds or restarts.
 *
 * npm ships next to node, so prepend the running node binary's directory to
 * PATH (idempotent — no-op if it is already present).
 *
 * @param {NodeJS.ProcessEnv} [env]      base environment (default process.env)
 * @param {string} [execPath]            node binary path (default process.execPath)
 * @returns {Object} env with node's bin dir guaranteed on PATH
 */
function updateSpawnEnv(env = process.env, execPath = process.execPath) {
  const nodeDir = path.dirname(execPath);
  const current = env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(nodeDir)) return { ...env };
  return { ...env, PATH: [nodeDir, ...parts].join(path.delimiter) };
}

module.exports = { updateSpawnEnv };
