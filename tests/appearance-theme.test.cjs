const { test } = require('node:test');
const assert = require('node:assert/strict');
const { THEMES, parseThemePreference, resolveTheme, themeVariables } = require('../src/appearanceTheme.cjs');

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('legacy, custom and invalid theme preferences resolve safely', () => {
  assert.deepEqual(Object.keys(THEMES), ['constructivist', 'constructivist-dark']);
  for (const name of Object.keys(THEMES)) assert.equal(parseThemePreference(name), name);
  for (const invalid of [null, undefined, '', 'unknown', '__proto__', 'constructor', {}, Object.create(null)]) {
    assert.equal(parseThemePreference(invalid), 'constructivist');
  }
  for (const legacy of ['light', 'blue-white', 'red-white']) assert.equal(parseThemePreference(legacy), 'constructivist');
  for (const legacy of ['dark', 'red-black']) assert.equal(parseThemePreference(legacy), 'constructivist-dark');
  assert.equal(parseThemePreference('system'), 'system');
  assert.equal(resolveTheme('system', false), 'constructivist');
  assert.equal(resolveTheme('system', true), 'constructivist-dark');
  for (const name of Object.keys(THEMES)) {
    assert.equal(resolveTheme(name), name);
  }
  assert.equal(THEMES['constructivist-dark'].colorScheme, 'dark');
  assert.equal(THEMES.constructivist.colorScheme, 'light');
});

test('constructivist colors keep yellow out of broad day surfaces and night remains pure black', () => {
  const structure = ['surface', 'surface-subtle', 'surface-muted', 'canvas', 'sidebar', 'chrome', 'hover', 'code-bg'];
  for (const key of structure) {
    assert.equal(THEMES['constructivist-dark'].colors[key], '#000000', key);
    assert.notEqual(THEMES.constructivist.colors[key], THEMES.constructivist.colors['brand-yellow'], key);
  }
  for (const theme of Object.values(THEMES)) {
    assert.equal(theme.colors['action-bg'], '#c0222b');
    assert.equal(theme.colors['mark-bg'], '#efc94f');
    assert.equal(theme.colors['mark-text'], '#171717');
  }
  assert.equal(parseThemePreference(undefined), 'constructivist');
});

test('all palettes provide matching, opaque colors with readable text and controls', () => {
  const keys = Object.keys(THEMES.constructivist.colors).sort();
  for (const [name, theme] of Object.entries(THEMES)) {
    assert.deepEqual(Object.keys(theme.colors).sort(), keys, name);
    for (const color of Object.values(theme.colors)) assert.match(color, /^#[a-f0-9]{6}$/, name);
    const variables = themeVariables(name);
    for (const key of keys) assert.equal(variables['--' + key], theme.colors[key]);
    const c = theme.colors;
    for (const fg of ['text', 'text-muted', 'text-faint', 'heading', 'link']) {
      for (const bg of ['surface', 'surface-muted', 'sidebar']) {
        assert.ok(contrast(c[fg], c[bg]) >= 4.5, `${name}: ${fg} / ${bg}`);
      }
    }
    for (const [fg, bg] of [['accent', 'accent-soft'], ['on-accent', 'accent'], ['mark-text', 'mark-bg'], ['toast-text', 'toast-bg'], ['on-action', 'action-bg'], ['on-action', 'action-hover'], ['on-mode', 'mode-bg']]) {
      assert.ok(contrast(c[fg], c[bg]) >= 4.5, `${name}: ${fg} / ${bg}`);
    }
    assert.equal(Object.isFrozen(theme.colors), true);
  }
});

test('day chrome is neutral and night focal controls retain contrast on pure black', () => {
  const c = THEMES.constructivist.colors;
  assert.equal(c.surface, '#ffffff');
  for (const key of ['sidebar', 'chrome', 'canvas']) assert.equal(c[key], '#f5f5f3');
  assert.equal(c.accent, '#c0222b');
  const n = THEMES['constructivist-dark'].colors;
  assert.equal(n.surface, '#000000');
  assert.equal(n['mode-bg'], '#efc94f');
  assert.ok(contrast(n['brand-yellow'], n.surface) >= 4.5);
  assert.ok(contrast(n['line-strong'], n.surface) >= 3);
});
