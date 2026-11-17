// Refined three-theme palettes: 极简纯白 (constructivist), 温润宣纸 (constructivist-paper),
// and 深墨夜读 (constructivist-dark). Preserves document contents, typography,
// editor history, and reader instance identity.
const makeTheme = (colorScheme, colors) => Object.freeze({ colorScheme, colors: Object.freeze(colors) });

// 1. 极简纯白 — Crisp architectural porcelain white & warm alabaster chrome
const day = {
  line: '#e4e4e0', 'line-strong': '#b8b8b2',
  surface: '#ffffff', 'surface-subtle': '#fafafa', 'surface-muted': '#f1f1ef',
  canvas: '#f1f2f0', sidebar: '#f8f8f7', chrome: '#f4f4f2', hover: '#e9e9e6',
  scrollbar: '#989892', 'code-bg': '#f1f1ef',
  accent: '#bc3c2b', 'accent-hover': '#a23021', 'accent-soft': '#faecea', 'accent-softer': '#fdf5f4', 'on-accent': '#ffffff',
  'action-bg': '#bc3c2b', 'action-hover': '#a23021', 'on-action': '#ffffff',
  'mode-bg': '#ffffff', 'on-mode': '#bc3c2b', 'brand-yellow': '#efc94f',
  danger: '#b62b2b', 'danger-soft': '#f9eae7',
  text: '#1d1d1f', 'text-muted': '#5c5c62', 'text-faint': '#616167',
  heading: '#1d1d1f', link: '#b53524', quote: '#5c5c62', 'quote-line': '#989892',
  'mark-bg': '#efc94f', 'mark-text': '#171717', 'toast-bg': '#1d1d1f', 'toast-text': '#ffffff',
  'pdf-icon-bg': '#f2eae2', 'pdf-icon-text': '#8d531d', 'epub-icon-bg': '#e7f2ed', 'epub-icon-text': '#25644d',
  'topbar-bg': '#f4f4f2', 'topbar-text': '#1d1d1f', 'topbar-hover': '#bc3c2b',
  'selected-row-bg': '#ffffff', 'hover-text': '#bc3c2b',
};

// 2. 温润宣纸 — Subtle warm-white paper stationery & soft alabaster desk
const paperDay = {
  ...day,
  line: '#e6e1d6', 'line-strong': '#b5ada0',
  surface: '#fefcf8', 'surface-subtle': '#faf7f1', 'surface-muted': '#f2eee6',
  canvas: '#f2efe8', sidebar: '#f8f6f1', chrome: '#f5f2eb', hover: '#ece8df',
  scrollbar: '#948b7e', 'code-bg': '#f2eee6',
  accent: '#b33b2b', 'accent-hover': '#992e20', 'accent-soft': '#f6ebe7', 'accent-softer': '#fbf5f3', 'on-accent': '#ffffff',
  'action-bg': '#b33b2b', 'action-hover': '#992e20', 'on-action': '#ffffff',
  'mode-bg': '#fefcf8', 'on-mode': '#b33b2b',
  text: '#2b2520', 'text-muted': '#5e5349', 'text-faint': '#62574d',
  heading: '#2b2520', link: '#a3241d', quote: '#5e5349', 'quote-line': '#a3998b',
  'toast-bg': '#2b2520', 'toast-text': '#fefcf8',
  'pdf-icon-bg': '#f3ebe0', 'pdf-icon-text': '#844e1d', 'epub-icon-bg': '#e5efe9', 'epub-icon-text': '#265f4a',
  'topbar-bg': '#f5f2eb', 'topbar-text': '#2b2520', 'topbar-hover': '#b33b2b',
  'selected-row-bg': '#ffffff', 'hover-text': '#b33b2b',
};

// 3. 深墨夜读 — Layered dark obsidian ink studio, warm bone text & terracotta highlight
const night = {
  line: '#2c2f36', 'line-strong': '#6a6e78',
  surface: '#1b1c20', 'surface-subtle': '#202227', 'surface-muted': '#25272d',
  canvas: '#121316', sidebar: '#17181c', chrome: '#141518', hover: '#2c2f36',
  scrollbar: '#6a6e78', 'code-bg': '#23252b',
  accent: '#e87461', 'accent-hover': '#f28c7b', 'accent-soft': '#2f1d1b', 'accent-softer': '#251816', 'on-accent': '#141518',
  'action-bg': '#c94c3a', 'action-hover': '#b33b2b', 'on-action': '#ffffff',
  'mode-bg': '#24262d', 'on-mode': '#f28c7b', 'brand-yellow': '#efc94f',
  danger: '#ff8d7f', 'danger-soft': '#341e1c',
  text: '#eae6dd', 'text-muted': '#b5b0a6', 'text-faint': '#a09b92',
  heading: '#f2eee6', link: '#e87461', quote: '#b5b0a6', 'quote-line': '#5a5d66',
  'mark-bg': '#efc94f', 'mark-text': '#171717', 'toast-bg': '#282a31', 'toast-text': '#eae6dd',
  'pdf-icon-bg': '#2c241d', 'pdf-icon-text': '#e2a366', 'epub-icon-bg': '#1b2b25', 'epub-icon-text': '#7bc4a8',
  'topbar-bg': '#141518', 'topbar-text': '#eae6dd', 'topbar-hover': '#f28c7b',
  'selected-row-bg': '#24262d', 'hover-text': '#f28c7b',
};

const THEMES = Object.freeze({
  constructivist: makeTheme('light', day),
  'constructivist-paper': makeTheme('light', paperDay),
  'constructivist-dark': makeTheme('dark', night),
});

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
