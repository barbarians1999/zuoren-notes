const { createRequire, registerHooks, stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');

let fallbackTransform;
function transformTypeScript(filename, source) {
  try {
    return stripTypeScriptTypes(source, { mode: 'transform' });
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_ARG_VALUE') throw error;
    if (!fallbackTransform) {
      const vitePkg = require.resolve('vite/package.json');
      fallbackTransform = createRequire(vitePkg)('rolldown/experimental').transformSync;
    }
    return fallbackTransform(filename, source).code;
  }
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) {
      const filename = fileURLToPath(url);
      return { format: 'module', source: transformTypeScript(filename, fs.readFileSync(filename, 'utf8')), shortCircuit: true };
    }
    return next(url, context);
  },
});
module.exports = { transformTypeScript };
