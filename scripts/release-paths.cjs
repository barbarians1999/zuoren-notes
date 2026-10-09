const path = require('node:path');
const fs = require('node:fs');

function releaseDirectory(root, override) {
  if (override) return path.resolve(override);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return path.resolve(root, manifest.build?.directories?.output || 'releases', manifest.version);
}

module.exports = { releaseDirectory };
