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
  'topbar-bg': '#ffffff', 'topbar-text': '#171717', 'topbar-hover': '#171717',
  'selected-row-bg': '#ffffff', 'hover-text': '#c0222b',
};
// Paper/ink/brick palette from the user's Dayboard and Zuoren Shelf.
// Keep the original day palette and annotation/highlight semantics intact.
const paperDay = {
  ...day,
  line: '#d2d0c9', 'line-strong': '#918e86',
  surface: '#fcfbf8', 'surface-subtle': '#f5f4f0', 'surface-muted': '#ebeae5',
  canvas: '#f5f4f0', sidebar: '#f5f4f0', chrome: '#f5f4f0', hover: '#ebeae5',
  scrollbar: '#65615b', 'code-bg': '#ebeae5',
  accent: '#b52d24', 'accent-hover': '#a3241d', 'accent-soft': '#ece0d7', 'accent-softer': '#f4ede7',
  'action-bg': '#b52d24', 'action-hover': '#a3241d',
  'mode-bg': '#b52d24',
  text: '#22221f', 'text-muted': '#65615b', 'text-faint': '#65615b',
  heading: '#22221f', link: '#a3241d', quote: '#56534c', 'quote-line': '#8d8980',
  'toast-bg': '#22221f', 'toast-text': '#fcfbf8',
  'pdf-icon-bg': '#ebeae5', 'pdf-icon-text': '#65615b',
  'topbar-bg': '#21211e', 'topbar-text': '#fcfbf8', 'topbar-hover': '#f0826d',
  'selected-row-bg': '#ebeae5', 'hover-text': '#b52d24',
};
const night = {
  line: '#292723', 'line-strong': '#706b62',
  surface: '#000000', 'surface-subtle': '#000000', 'surface-muted': '#000000',
  canvas: '#000000', sidebar: '#000000', chrome: '#000000', hover: '#000000',
  scrollbar: '#888880', 'code-bg': '#000000',
  accent: '#ef6a5b', 'accent-hover': '#ff8a7b', 'accent-soft': '#000000', 'accent-softer': '#000000', 'on-accent': '#000000',
  'action-bg': '#b52d24', 'action-hover': '#a3241d', 'on-action': '#ffffff',
  'mode-bg': '#b52d24', 'on-mode': '#ffffff', 'brand-yellow': '#efc94f',
  danger: '#ff8d7f', 'danger-soft': '#000000',
  text: '#ece9e0', 'text-muted': '#bdb7ab', 'text-faint': '#a69f92',
  heading: '#ece9e0', link: '#ef6a5b', quote: '#bdb7ab', 'quote-line': '#706b62',
  'mark-bg': '#efc94f', 'mark-text': '#171717', 'toast-bg': '#000000', 'toast-text': '#ece9e0',
  'pdf-icon-bg': '#000000', 'pdf-icon-text': '#ef6a5b', 'epub-icon-bg': '#000000', 'epub-icon-text': '#efc94f',
  'topbar-bg': '#000000', 'topbar-text': '#ece9e0', 'topbar-hover': '#ff8a7b',
  'selected-row-bg': '#22221f', 'hover-text': '#ff8a7b',
};
const THEMES = Object.freeze({
  constructivist: makeTheme('light', day),
  'constructivist-paper': makeTheme('light', paperDay),
  'constructivist-dark': makeTheme('dark', night),
});

// Existing preferences keep their identities. System still resolves to the
// original day palette or the shared night palette, not the optional paper day.
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
