import { useEffect } from 'react';
import { reader } from './readerContext';

const chrome = '.topbar, .note-workspace-bar, .pdf-navigation, .epub-navigation';

// Hover changes only the overlay, never the reader viewport or document state.
export function useFullscreenChrome(fullscreen: boolean) {
  useEffect(() => {
    // DOM fallback for synthetic input and iframe-forwarded shortcuts. Native
    // F11 is consumed before dispatch, so a real key cannot toggle twice.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'F11' && !event.repeat && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); void reader().windowControl('fullscreen');
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.app');
    if (!root) return;
    let timer = 0, keyboardFocus = false, overChrome = false;
    const show = () => { clearTimeout(timer); timer = 0; root.dataset.chromeVisible = 'true'; };
    const hide = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        const focus = document.activeElement;
        const editingControl = focus?.matches('input, select, textarea');
        if (overChrome || (focus?.closest(chrome) && (keyboardFocus || editingControl)) || document.querySelector('[role="menu"], [role="dialog"]')) {
          hide(); return;
        }
        root.dataset.chromeVisible = 'false';
      }, 650);
    };
    root.dataset.chromeVisible = fullscreen ? 'false' : 'true';
    if (!fullscreen) return;
    const move = (event: PointerEvent) => {
      if (event.buttons) return; // Do not interrupt selection or a slider drag.
      overChrome = !!(event.target instanceof Element && event.target.closest(chrome));
      if (event.clientY <= 8 || overChrome) show(); else hide();
    };
    const out = (event: PointerEvent) => {
      if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(chrome)) { overChrome = false; hide(); }
    };
    const down = () => { keyboardFocus = false; hide(); };
    const focus = () => { if (document.activeElement?.closest(chrome)) show(); else hide(); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Tab') { keyboardFocus = true; show(); hide(); }
      if (event.key === 'F6') {
        event.preventDefault(); keyboardFocus = true; show();
        root.querySelector<HTMLElement>('.topbar button')?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerout', out, { passive: true });
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('focusin', focus);
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(timer);
      delete root.dataset.chromeVisible;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('focusin', focus);
      window.removeEventListener('keydown', key, true);
    };
  }, [fullscreen]);
}
