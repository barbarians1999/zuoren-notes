const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

// Exercise the production hook's decisions without claiming browser rendering
// coverage. Native ui-motion-smoke checks the same interruption in the UI.
function layoutHarness() {
  const refs = [], effects = [], pending = [];
  let refIndex = 0, effectIndex = 0;
  const hooks = {
    createContext: value => value,
    useRef(value) { return refs[refIndex++] ||= { current: value }; },
    useLayoutEffect(callback, dependencies) {
      const index = effectIndex++, previous = effects[index];
      if (previous && dependencies.every((item, at) => Object.is(item, previous.dependencies[at]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { dependencies, cleanup: callback() };
      });
    },
  };
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../src/uiMotion.ts'), 'utf8'))
    .replace(/^import .* from 'react';/m, 'const { createContext, useLayoutEffect, useRef, useState } = hooks;')
    .replace(/^export /gm, '');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = { useLayoutMotion, motionNumber };', {
    hooks, module, getComputedStyle: node => node.style,
  });
  const animations = [], requested = { current: false };
  const node = { style: { transform: 'none', getPropertyValue: name => name === '--motion-mode' ? '180ms' : '' },
    animate(frames, options) {
      let finish, reject;
      const animation = { frames, options, state: 'running', finished: new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
        cancel() { this.state = 'idle'; node.style.transform = 'none'; reject(Error('cancelled')); },
        finish() { this.state = 'finished'; node.style.transform = 'none'; finish(); },
      };
      animations.push(animation); return animation;
    },
  };
  const host = { current: node };
  const render = (layout, { ready = true, reduced = false, request = false } = {}) => {
    if (request) requested.current = true;
    refIndex = 0; effectIndex = 0;
    module.exports.useLayoutMotion(host, layout, ready, reduced, requested);
    while (pending.length) pending.shift()();
  };
  return { render, animations, node, requested, host, motionNumber: module.exports.motionNumber,
    unmount() { for (const effect of effects) effect.cleanup?.(); } };
}

test('layout motion skips restoration and uses short directional feedback only for requested changes', () => {
  const h = layoutHarness();
  h.render('split', { ready: false }); h.render('note', { ready: false }); h.render('note');
  assert.equal(h.animations.length, 0, 'restored layout does not slide into view');
  h.render('read');
  assert.equal(h.animations.length, 0, 'programmatic changes do not acquire motion');
  h.render('split', { request: true });
  assert.equal(h.animations.length, 1);
  assert.equal(h.animations[0].frames[0].transform, 'translateX(12px)');
  assert.equal(h.animations[0].options.duration, 180);
  assert.equal(h.requested.current, false);
  h.unmount();
});

test('reducing motion cancels an active layout animation without requiring another layout change', () => {
  const h = layoutHarness();
  h.render('split'); h.render('read', { request: true });
  const active = h.animations[0]; h.node.style.transform = 'matrix(1, 0, 0, 1, -5, 0)';
  h.render('read', { reduced: true });
  assert.equal(active.state, 'idle', 'preference changes stop the animation immediately');
  assert.equal(h.node.style.transform, 'none');
  h.render('read');
  assert.equal(h.animations.length, 1, 'enabling motion does not replay the settled layout');
  h.render('note', { request: true, reduced: true });
  assert.equal(h.animations.length, 1, 'a reduced-motion change is immediate');
  assert.equal(h.requested.current, false);
  h.unmount();
});

test('rapid layout changes continue from the visible position and stale completion cannot cancel a successor', async () => {
  const h = layoutHarness();
  h.render('split'); h.render('read', { request: true });
  const first = h.animations[0];
  h.node.style.transform = 'matrix(1, 0, 0, 1, -4, 0)';
  h.render('note', { request: true });
  const second = h.animations[1];
  assert.equal(first.state, 'idle');
  assert.equal(second.frames[0].transform, 'matrix(1, 0, 0, 1, -4, 0)', 'do not restart from the opposite edge');
  assert.equal(second.frames[1].transform, 'translateX(0px)');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(second.state, 'running');
  h.render('split');
  assert.equal(second.state, 'idle', 'a newer nonanimated navigation also removes stale motion');
  assert.equal(h.animations.length, 2);
  h.unmount();
});

test('layout motion releases finished or unmounted animations and handles missing surfaces', async () => {
  const h = layoutHarness();
  h.render('read'); h.render('note', { request: true });
  h.animations[0].finish(); await Promise.resolve();
  h.render('read', { request: true });
  assert.equal(h.animations[1].frames[0].transform, 'translateX(-12px)', 'a finished animation does not override new direction');
  h.unmount(); assert.equal(h.animations[1].state, 'idle');
  const absent = layoutHarness(); absent.render('split'); absent.host.current = null;
  absent.render('note', { request: true }); assert.equal(absent.animations.length, 0); absent.unmount();
});

test('a completed animation’s queued callback cannot forget a newer layout animation', async () => {
  const h = layoutHarness();
  h.render('read'); h.render('note', { request: true });
  h.animations[0].finish();
  h.render('split', { request: true });
  await Promise.resolve();
  h.render('split', { reduced: true });
  assert.equal(h.animations[1].state, 'idle', 'the newer animation remains tracked after the older promise resolves');
  h.unmount();
});

test('motion tokens accept seconds and milliseconds and reject unusable durations', () => {
  const { motionNumber } = layoutHarness();
  for (const [value, expected] of [['180ms', 180], ['.2s', 200], [' 140 ', 140], ['0ms', 80], ['-2s', 80], ['invalid', 80], ['', 80]]) {
    assert.equal(motionNumber({ getPropertyValue: () => value }, '--duration', 80), expected);
  }
});

test('frequent controls stay still on hover and use only a brief enabled press response', () => {
  const src = path.join(__dirname, '../src');
  const collectCss = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? collectCss(file) : entry.isFile() && file.endsWith('.css') ? [file] : [];
  });
  const css = collectCss(src).map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].map(([, selector, declarations]) => ({ selector, declarations }));
  const hoverMoves = rules.filter(rule => /:hover\b/.test(rule.selector) && /transform\s*:\s*translateY\(\s*-1px\s*\)/.test(rule.declarations));
  assert.deepEqual(hoverMoves, [], 'hover feedback changes color or surface without shifting controls');
  const verticalPresses = rules.filter(rule => /:active/.test(rule.selector) && /transform\s*:\s*translateY/.test(rule.declarations));
  assert.deepEqual(verticalPresses, [], 'controls do not bounce vertically');
  const pressMoves = rules.filter(rule => /transform\s*:\s*scale\(1\.025\)/.test(rule.declarations));
  assert.ok(pressMoves.length > 0, 'direct press feedback remains available');
  for (const rule of pressMoves) assert.match(rule.selector, /:not\(:disabled\):active/, rule.selector);
});

test('settings controls share compact chrome corners and context menus expose a clear focus ring', () => {
  const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  const chrome = fs.readFileSync(path.join(__dirname, '../src/ui/chrome.css'), 'utf8');
  assert.match(styles, /\.font-size-control button[^\n]*border-radius: var\(--control-radius\)/);
  assert.match(styles, /\.note-font-control select[^\n]*border-radius: var\(--control-radius\)/);
  assert.match(chrome, /\.settings-popover \.settings-row, \.app \.settings-popover \.theme-options button \{ border-radius: var\(--control-radius\); \}/);
  assert.match(chrome, /\.app \.file-context-menu button:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/s);
});

function productionFunction(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker); assert.ok(start >= 0, marker);
  let end = source.indexOf('{', start) + 1, depth = 1;
  for (; end < source.length && depth; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0, 'production callback has a complete body');
  return stripTypeScriptTypes(source.slice(start, end));
}

test('a late file move preserves unrelated entries from the newly selected root', () => {
  const operations = require('../src/fileOperations.cjs');
  const other = Object.freeze({ path: '/root-B/other.md', name: 'other.md', relative: 'other.md', moveVersion: 'new-root-version' });
  let files = [other, { path: '/root-A/source.md', name: 'source.md', relative: 'source.md' }];
  const remap = vm.runInNewContext(`(${productionFunction('main.tsx', 'remapWorkspacePath')})`, {
    root: '/root-A', ...operations,
    sessionRecovery: { current: { remap(_old, _next, apply) { apply(); } } }, workspace: { remap() {} }, readerSession: { remapPath() {} },
    setFiles: update => { files = update(files); }, setDirectory: update => update(null), setScrollMemory: update => update([]),
  });
  remap('/root-A/source.md', '/root-A/destination/source.md');
  assert.equal(files[0], other, 'an unaffected entry keeps its identity and all metadata');
  assert.equal(files[0].relative, 'other.md');
  assert.equal(files[1].path, '/root-A/destination/source.md');
  assert.equal(files[1].relative, 'destination/source.md');
});

test('a late old-root move names its paths without promising an unavailable undo', async () => {
  const messages = [], undo = [], received = [];
  const current = { current: { root: '/root-B', message: value => messages.push(value), reload: async () => {} } };
  const accept = vm.runInNewContext(`(${productionFunction('workspace/fileMoveUi.tsx', 'accept')})`, {
    current, setIssue() {}, setProposal() {}, setUndo: value => undo.push(value), setReceived: value => received.push(value),
    sameOrDescendantPath: require('../src/fileOperations.cjs').sameOrDescendantPath,
    parentPath: value => value.replace(/[\\/][^\\/]*$/, ''),
  });
  const outcome = { status: 'moved', result: { oldPath: '/root-A/source.md', entry: { path: '/root-A/destination/source.md', name: 'source.md' }, undoToken: 'receipt', warning: '附件仍在原位置。' } };
  assert.equal(await accept(outcome, '/root-A'), true);
  assert.equal(undo.length, 0); assert.equal(received.length, 0);
  assert.ok(messages[0].includes(outcome.result.oldPath)); assert.ok(messages[0].includes(outcome.result.entry.path));
  assert.match(messages[0], /当前资料目录已切换/); assert.doesNotMatch(messages[0], /可撤销/); assert.match(messages[0], /附件仍在原位置/);
  current.current.root = '/root-A'; delete outcome.result.warning;
  assert.equal(await accept(outcome, '/root-A'), true);
  assert.equal(undo.length, 1); assert.equal(received.length, 1); assert.match(messages.at(-1), /可撤销/);
});
