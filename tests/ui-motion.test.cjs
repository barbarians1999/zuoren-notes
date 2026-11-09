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

test('decorative control lift is restricted to enabled controls', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  const liftRules = css.split('\n').filter(line => line.startsWith('.app[data-motion="full"]') && line.includes('transform: translateY('));
  assert.ok(liftRules.length > 0);
  for (const rule of liftRules) assert.match(rule, /:not\(:disabled\):(hover|active) >/, rule);
});
