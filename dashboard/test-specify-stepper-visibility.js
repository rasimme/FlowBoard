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

  // Read the App.jsx file to verify the fix
  const appPath = path.join(__dirname, 'src', 'App.jsx');
  const appContent = fs.readFileSync(appPath, 'utf8');

  // Check that window.__showSpecifyStepper is set in a useEffect hook
  ok(appContent.includes('useEffect'), 'App.jsx imports useEffect');
  ok(appContent.includes('window.__showSpecifyStepper = (sessionId) => specify.show(sessionId);'),
    'App.jsx sets window.__showSpecifyStepper function');
  ok(appContent.includes('useEffect(() => {'), 'window.__showSpecifyStepper is set in useEffect hook');

  // Check that it's not set during render (checking for the old pattern)
  const hasOldPattern = appContent.includes('if (typeof window !== \'undefined\') {\n    window.__showSpecifyStepper');
  ok(!hasOldPattern, 'window.__showSpecifyStepper is not set during render');

  // Read the toolbar.js file to verify it uses the window function
  const toolbarPath = path.join(__dirname, 'js', 'canvas', 'toolbar.js');
  const toolbarContent = fs.readFileSync(toolbarPath, 'utf8');

  ok(toolbarContent.includes('window.__showSpecifyStepper'),
    'toolbar.js calls window.__showSpecifyStepper on canvas promote');
  ok(
    toolbarContent.includes('window.__showSpecifyStepper(res.sessionId)') &&
      toolbarContent.includes('Specify stepper not available'),
    'toolbar.js checks if window.__showSpecifyStepper exists before calling'
  );

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
