// Opaque constructivist chrome and EPUB colors. No changes to document
// contents, typography, editor history or reader instance identity.
const makeTheme = (colorScheme, colors) => Object.freeze({ colorScheme, colors: Object.freeze(colors) });
const day = {
  line: '#d7d7d3', 'line-strong': '#a8a8a2',
  surface: '#ffffff', 'surface-subtle': '#f5f5f3', 'surface-muted': '#f0f0ed',
  canvas: '#f5f5f3', sidebar: '#f5f5f3', chrome: '#f5f5f3', hover: '#e9e9e6',
  scrollbar: '#888880', 'code-bg': '#f0f0ed',
  accent: '#c0222b', 'accent-hover': '#a51c24', 'accent-soft': '#faeded', 'accent-softer': '#fdf6f6', 'on-accent': '#ffffff',
  'action-bg': '#c0222b', 'action-hover': '#a51c24', 'on-action': '#ffffff',
  'mode-bg': '#171717', 'on-mode': '#ffffff', 'brand-yellow': '#efc94f',
  danger: '#b62b2b', 'danger-soft': '#f9eae7',
  text: '#171717', 'text-muted': '#60605b', 'text-faint': '#62625d',
  heading: '#171717', link: '#c63224', quote: '#60605b', 'quote-line': '#808078',
  'mark-bg': '#efc94f', 'mark-text': '#171717', 'toast-bg': '#171717', 'toast-text': '#ffffff',
  'pdf-icon-bg': '#f0f0ed', 'pdf-icon-text': '#60605b', 'epub-icon-bg': '#efc94f', 'epub-icon-text': '#171717',
};
const night = {
  line: '#383838', 'line-strong': '#808078',
  surface: '#000000', 'surface-subtle': '#000000', 'surface-muted': '#000000',
  canvas: '#000000', sidebar: '#000000', chrome: '#000000', hover: '#000000',
  scrollbar: '#888880', 'code-bg': '#000000',
  accent: '#f04438', 'accent-hover': '#ff685d', 'accent-soft': '#000000', 'accent-softer': '#000000', 'on-accent': '#000000',
  'action-bg': '#c0222b', 'action-hover': '#a51c24', 'on-action': '#ffffff',
  'mode-bg': '#efc94f', 'on-mode': '#171717', 'brand-yellow': '#efc94f',
  danger: '#ff8d7f', 'danger-soft': '#000000',
  text: '#ded8cc', 'text-muted': '#aaa18f', 'text-faint': '#989080',
  heading: '#ded8cc', link: '#ef5a43', quote: '#aaa18f', 'quote-line': '#808078',
  'mark-bg': '#efc94f', 'mark-text': '#171717', 'toast-bg': '#000000', 'toast-text': '#ded8cc',
  'pdf-icon-bg': '#000000', 'pdf-icon-text': '#f04438', 'epub-icon-bg': '#000000', 'epub-icon-text': '#efc94f',
};
const THEMES = Object.freeze({
  constructivist: makeTheme('light', day),
  'constructivist-dark': makeTheme('dark', night),
});

// Keep the two palette identities compatible with previous releases. System
// is a preference, not a third palette; resolve it against the current OS.
function parseThemePreference(saved) {
  if (typeof saved !== 'string') return 'constructivist';
  if (saved === 'system') return 'system';
  if (Object.hasOwn(THEMES, saved)) return saved;
  if (saved === 'dark' || saved === 'red-black') return 'constructivist-dark';
  return 'constructivist';
}
function resolveTheme(preference, systemDark = false) {
  const parsed = parseThemePreference(preference);
  return parsed === 'system' ? (systemDark ? 'constructivist-dark' : 'constructivist') : parsed;
}
function themeVariables(theme) {
  return Object.fromEntries(Object.entries(THEMES[theme].colors).map(([key, color]) => ['--' + key, color]));
}

module.exports = { THEMES, parseThemePreference, resolveTheme, themeVariables };
