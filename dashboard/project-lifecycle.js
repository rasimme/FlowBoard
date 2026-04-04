'use strict';

// project-lifecycle.js — T-131-6: Canonical project creation orchestration.
// Called by POST /api/projects in server.js.

const path = require('path');
const fs = require('fs');

// Slug validation: lowercase letters, digits, hyphens; must start with a letter or digit
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate and normalize project creation input.
 * Throws { code: 'VALIDATION_ERROR', message } on failure.
 */
function _validateInput({ name, displayName, description }) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('name is required'), { code: 'VALIDATION_ERROR' });
  }
  const slug = name.trim().toLowerCase();
  if (!NAME_RE.test(slug)) {
    throw Object.assign(
      new Error('name must be a lowercase slug (letters, digits, hyphens; max 63 chars)'),
      { code: 'VALIDATION_ERROR' }
    );
  }
  return {
    name: slug,
    displayName: (typeof displayName === 'string' && displayName.trim()) || slug,
    description: (typeof description === 'string' && description.trim()) || '',
  };
}

/**
 * Scaffold filesystem project structure under projectsDir/<name>/.
 * Required: project root dir, PROJECT.md, SESSIONS.md, DECISIONS.md.
 * Optional: context/, specs/, canvas.json (failures produce warnings).
 * Throws if required pieces cannot be created.
 * Returns { warnings: string[] }.
 */
function _scaffoldFilesystem(projectsDir, name, displayName, description) {
  const projectDir = path.join(projectsDir, name);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Required: project root directory
  fs.mkdirSync(projectDir, { recursive: true });

  // Required: PROJECT.md (post-m005 — no embedded session log)
  const projectMd = [
    `# ${displayName}`,
    '',
    description ? `${description}\n` : '',
    '## Goal',
    '[What should be achieved?]',
    '',
    '## Current Status',
    'Project created.',
    '',
    '## Key Next Steps',
    '- [ ] Define project scope',
    '',
  ].join('\n');

  // Required: SESSIONS.md
  const sessionsMd = [
    `# Sessions — ${displayName}`,
    '',
    `### ${today}`,
    '- Project created',
    '',
  ].join('\n');

  // Required: DECISIONS.md
  const decisionsMd = [
    `# Decisions — ${displayName}`,
    '',
    'Decisions are logged here when significant choices are made. Only loaded on demand.',
    '',
    '<!-- Format:',
    '### [DATE] — [Short Title]',
    '**Decision:** What was decided',
    '**Reasoning:** Why',
    '**Alternatives considered:** What else was on the table',
    '-->',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(projectDir, 'PROJECT.md'), projectMd);
  fs.writeFileSync(path.join(projectDir, 'SESSIONS.md'), sessionsMd);
  fs.writeFileSync(path.join(projectDir, 'DECISIONS.md'), decisionsMd);

  // Optional pieces — failures become warnings
  const warnings = [];

  try {
    fs.mkdirSync(path.join(projectDir, 'context'), { recursive: true });
  } catch (e) {
    warnings.push(`Could not create context/: ${e.message}`);
  }

  try {
    fs.mkdirSync(path.join(projectDir, 'specs'), { recursive: true });
  } catch (e) {
    warnings.push(`Could not create specs/: ${e.message}`);
  }

  try {
    fs.writeFileSync(
      path.join(projectDir, 'canvas.json'),
      JSON.stringify({ notes: [], connections: [] }, null, 2)
    );
  } catch (e) {
    warnings.push(`Could not create canvas.json: ${e.message}`);
  }

  return { warnings };
}

/**
 * Create a new project — canonical orchestration.
 *
 * @param {object} input        - { name, displayName?, description? }
 * @param {object} deps
 * @param {object} deps.hzlService  - hzl-service module (must be initialized)
 * @param {object} deps.fbMeta      - flowboard-metadata module (must be initialized)
 * @param {string} deps.projectsDir - absolute path to shared projects root
 *
 * @returns {{ project: object, warnings: string[] }}
 * @throws Error with .code in:
 *   'VALIDATION_ERROR' | 'DUPLICATE' | 'HZL_ERROR' | 'METADATA_ERROR' | 'SCAFFOLD_ERROR'
 */
function createProject(input, { hzlService, fbMeta, projectsDir }) {
  // 1. Validate
  const { name, displayName, description } = _validateInput(input);

  // 2. Duplicate detection across all canonical layers
  const hzlProjects = hzlService.listHzlProjects();
  if (hzlProjects.some(p => p.name === name)) {
    throw Object.assign(
      new Error(`Project "${name}" already exists in HZL`),
      { code: 'DUPLICATE' }
    );
  }

  if (fbMeta.getProject(name)) {
    throw Object.assign(
      new Error(`Project "${name}" already exists in FlowBoard metadata`),
      { code: 'DUPLICATE' }
    );
  }

  const projectDir = path.join(projectsDir, name);
  if (fs.existsSync(projectDir)) {
    throw Object.assign(
      new Error(`Project directory already exists: ${projectDir}`),
      { code: 'DUPLICATE' }
    );
  }

  // 3. Create HZL project (hard failure — abort on error)
  try {
    hzlService.createProject(name, description || null);
  } catch (e) {
    throw Object.assign(
      new Error(`HZL project creation failed: ${e.message}`),
      { code: 'HZL_ERROR' }
    );
  }

  // 4. Create FlowBoard metadata row (hard failure — do not silently continue)
  try {
    fbMeta.upsertProject(name, {
      displayName,
      status: 'active',
      createdAt: new Date().toISOString(),
    }, true);
  } catch (e) {
    throw Object.assign(
      new Error(`FlowBoard metadata creation failed: ${e.message}`),
      { code: 'METADATA_ERROR' }
    );
  }

  if (!fbMeta.getProject(name)) {
    throw Object.assign(
      new Error('FlowBoard metadata row missing after creation'),
      { code: 'METADATA_ERROR' }
    );
  }

  // 5. Scaffold filesystem (required files → hard failure; optional → warnings)
  let warnings = [];
  try {
    ({ warnings } = _scaffoldFilesystem(projectsDir, name, displayName, description));
  } catch (e) {
    throw Object.assign(
      new Error(`Filesystem scaffold failed: ${e.message}`),
      { code: 'SCAFFOLD_ERROR' }
    );
  }

  const project = { name, displayName, description: description || null, status: 'active' };
  return { project, warnings };
}

module.exports = { createProject };
