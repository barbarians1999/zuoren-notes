export type ThemeName = 'constructivist' | 'constructivist-dark';
export type ThemePreference = ThemeName | 'system';
export type ThemeColor = 'accent' | 'accent-hover' | 'accent-soft' | 'accent-softer' | 'on-accent'
  | 'danger' | 'danger-soft' | 'text' | 'text-muted' | 'text-faint' | 'line' | 'line-strong'
  | 'surface' | 'surface-subtle' | 'surface-muted' | 'canvas' | 'sidebar' | 'chrome' | 'hover'
  | 'heading' | 'link' | 'quote' | 'quote-line' | 'code-bg' | 'scrollbar' | 'mark-bg' | 'mark-text'
  | 'toast-bg' | 'toast-text' | 'pdf-icon-bg' | 'pdf-icon-text' | 'epub-icon-bg' | 'epub-icon-text'
  | 'action-bg' | 'action-hover' | 'on-action' | 'mode-bg' | 'on-mode' | 'brand-yellow';
export const THEMES: Readonly<Record<ThemeName, { readonly colorScheme: 'light' | 'dark'; readonly colors: Readonly<Record<ThemeColor, string>> }>>;
export function parseThemePreference(saved: unknown): ThemePreference;
export function resolveTheme(preference: ThemePreference, systemDark?: boolean): ThemeName;
export function themeVariables(theme: ThemeName): Record<string, string>;
