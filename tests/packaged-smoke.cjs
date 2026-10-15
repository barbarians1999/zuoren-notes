const path = require('node:path');
const fs = require('node:fs');
const { runUiTests } = require('../scripts/test-ui.cjs');
const { testPlan } = require('../scripts/verification-plan.cjs');
const { releaseDirectory } = require('../scripts/release-paths.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.argv[2] || path.join(releaseDirectory(root), 'win-unpacked', 'ZuorenNotes.exe');
if (!fs.existsSync(executable)) throw new Error('Build the versioned installer before running packaged smoke tests: ' + executable);
const files = testPlan(root, 'full').packaged;
console.log('Testing packaged executable: ' + executable);
// Legacy tests use ZHAOYE_EXE, newer ones use ZHAOYE_SMOKE_EXECUTABLE.
// Set both to the exact same binary, never silently fall back to source Electron.
runUiTests(files, { root, env: { ...process.env, ZHAOYE_EXE: executable, ZHAOYE_SMOKE_EXECUTABLE: executable } })
  .then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
