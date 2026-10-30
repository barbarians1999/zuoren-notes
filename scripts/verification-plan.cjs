const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = files => [...new Set(files)].sort();
const ui = ['window-startup', 'session-startup', 'body-font', 'dual-note-splitter', 'path-reuse', 'note-tabs', 'fullscreen-chrome', 'epub-workspace', 'epub-search', 'pdf-toolbar', 'chrome-interaction'];
const markdown = ['source-editor', 'markdown-interaction', 'markdown-presentation', 'markdown-basics', 'markdown-images', 'markdown-habits', 'markdown-link', 'list-alignment', 'clipboard', 'linebreak', 'stability', 'document-lifecycle', 'reading-actions'];
const groups = {
  editor: [...markdown, 'editor-polish', 'note-tabs', 'note-toolbar'],
  readers: ['readers', 'reader-reliability', 'reader-handoff', 'epub-search', 'epub-workspace', 'pdf-toolbar', 'pdf-selection', 'pdf-appearance'],
  workspace: ['startup-preservation', 'settings-startup', 'window-startup', 'session-startup', 'dual-note-splitter', 'fullscreen-chrome', 'appearance', 'body-font', 'input-focus', 'chrome-interaction', 'themes', 'path-reuse', 'recovery', 'wide-review', 'electron', 'ui-motion'],
};
const smoke = names => unique(names.map(name => `tests/${name}-smoke.cjs`));
function testPlan(root, profile, customFile) {
  if (!['ui', 'markdown', 'full', 'directed'].includes(profile)) throw Error('Profile must be ui, markdown, full, or directed');
  const unit = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).map(name => 'tests/' + name).sort();
  let source, packaged, reason;
  if (profile === 'directed') {
    if (!customFile) throw Error('Directed profile requires --plan with explicit test files and reason');
    const custom = JSON.parse(fs.readFileSync(customFile, 'utf8'));
    if (typeof custom.reason !== 'string' || !custom.reason.trim() || !Array.isArray(custom.source) || !Array.isArray(custom.packaged)) throw Error('Invalid directed plan');
    source = unique([...smoke(['source-editor', 'document-lifecycle']), ...custom.source]);
    packaged = unique([...smoke(['platform-package', 'source-editor', 'document-lifecycle']), ...custom.packaged]);
    reason = custom.reason;
  } else {
    const names = profile === 'ui' ? ui : profile === 'markdown' ? markdown : Object.values(groups).flat();
    source = smoke(names);
    packaged = unique([...smoke(['platform-package']), ...source]);
    reason = profile === 'full' ? 'Existing full source and packaged regression sets' : `Directed ${profile} checks; NOT full release regression`;
  }
  for (const file of [...unit, ...source, ...packaged]) {
    if (typeof file !== 'string' || !/^tests\/[a-zA-Z0-9-]+(?:\.test|-smoke)\.cjs$/.test(file) || !fs.statSync(path.join(root, file)).isFile()) throw Error('Unsafe or missing test file: ' + file);
  }
  const plan = { schemaVersion: 1, profile, reason, unit, source, packaged };
  return { ...plan, sha256: digest(plan) };
}
module.exports = { testPlan, groups: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, smoke(value)])), digest };
