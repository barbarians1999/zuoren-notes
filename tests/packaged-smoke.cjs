const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { releaseDirectory } = require('../scripts/release-paths.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.argv[2] || path.join(releaseDirectory(root), 'win-unpacked', 'ZuorenNotes.exe');
if (!fs.existsSync(executable)) throw new Error('Build the versioned installer before running packaged smoke tests: ' + executable);
const files = ['source-editor-smoke', 'markdown-interaction-smoke', 'document-lifecycle-smoke', 'clipboard-smoke', 'linebreak-smoke', 'stability-smoke', 'editor-polish-smoke', 'reading-actions-smoke', 'note-tabs-smoke', 'note-toolbar-smoke', 'readers-smoke', 'pdf-toolbar-smoke', 'pdf-selection-smoke', 'pdf-appearance-smoke', 'reader-reliability-smoke', 'epub-search-smoke', 'recovery-smoke', 'startup-preservation-smoke', 'settings-startup-smoke', 'window-startup-smoke', 'appearance-smoke', 'input-focus-smoke', 'themes-smoke', 'path-reuse-smoke', 'wide-review-smoke', 'electron-smoke'];
console.log('Testing packaged executable: ' + executable);
// Legacy tests use ZHAOYE_EXE, newer ones use ZHAOYE_SMOKE_EXECUTABLE.
// Set both to the exact same binary, never silently fall back to source Electron.
const child = spawn(process.execPath, ['--test', ...(process.env.ZUOREN_RELEASE_TAP === '1' ? ['--test-reporter=tap'] : []), '--test-concurrency=1', ...files.map(file => path.join(__dirname, file + '.cjs'))], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ZHAOYE_EXE: executable, ZHAOYE_SMOKE_EXECUTABLE: executable },
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
