'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

async function run() {
  console.log('# Specify Stepper visibility regression test (code inspection)');

  // Since T-340 the stepper opens directly via SpecifyContext (useSpecify),
  // not through a window.__showSpecifyStepper bridge.
  const appPath = path.join(__dirname, 'src', 'App.jsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  ok(!appContent.includes('__showSpecifyStepper'),
    'App.jsx no longer installs a window.__showSpecifyStepper bridge');

  const canvasViewPath = path.join(__dirname, 'src', 'pages', 'CanvasView.jsx');
  const canvasViewContent = fs.readFileSync(canvasViewPath, 'utf8');
  ok(canvasViewContent.includes('useSpecify()'),
    'CanvasView opens the stepper via SpecifyContext');
  ok(canvasViewContent.includes('specify.show'),
    'CanvasView passes specify.show into the promote flow');

  const mutationsPath = path.join(__dirname, 'src', 'state', 'canvasMutations.mjs');
  const mutationsContent = fs.readFileSync(mutationsPath, 'utf8');
  ok(mutationsContent.includes('showStepper(res.sessionId)') &&
      mutationsContent.includes('Specify stepper not available'),
    'promote mutation guards the stepper callback before calling');

  // Read the SpecifyContext.jsx to verify it implements the show function
  const contextPath = path.join(__dirname, 'src', 'context', 'SpecifyContext.jsx');
  const contextContent = fs.readFileSync(contextPath, 'utf8');

  ok(contextContent.includes('const show = useCallback((id) => {'),
    'SpecifyContext.jsx has show function that accepts sessionId');
  ok(contextContent.includes('setIsOpen(true)'),
    'SpecifyContext show function sets isOpen to true');

  const total = pass + fail;
  console.log(`\nPassed: ${pass}/${total}`);
  if (fail > 0) {
    console.log(`\nFailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
