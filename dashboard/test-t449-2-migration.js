'use strict';

const assert = require('node:assert/strict');
const { deriveProjectDisciplines } = require('./migrations.js');
const taskDiscipline = require('./task-discipline.js');

const projects = [
  { name: 'flowboard', description: 'dashboard', github: { repo: 'rasimme/FlowBoard' } },
  { name: 'handbook', description: 'team wiki and notes' },
  { name: 'inbox' },
];
const result = deriveProjectDisciplines(projects);
assert.deepEqual(result.distribution, { list: 1, standard: 1, development: 1 });
assert.equal(result.assignments.find(p => p.name === 'flowboard').discipline, 'development');
assert.equal(taskDiscipline.suggest(projects[0]), 'development');
assert.equal(taskDiscipline.normalize('legacy-value'), 'list');

// A DB-shaped migration fixture: valid values remain untouched by m010.
const updates = [];
const fbMeta = {
  listProjects: () => projects,
  getProject: name => ({ name, config: name === 'inbox' ? '{}' : JSON.stringify({ taskDiscipline: 'standard' }) }),
  updateProjectMeta: (name, patch) => updates.push({ name, patch }),
};
for (const project of fbMeta.listProjects()) {
  const row = fbMeta.getProject(project.name);
  const config = JSON.parse(row.config);
  if (!taskDiscipline.VALUES.includes(config.taskDiscipline)) fbMeta.updateProjectMeta(project.name, { taskDiscipline: taskDiscipline.normalize(taskDiscipline.suggest(project)) });
}
assert.deepEqual(updates, [{ name: 'inbox', patch: { taskDiscipline: 'list' } }]);
console.log('T-449-2 migration derivation tests passed');
