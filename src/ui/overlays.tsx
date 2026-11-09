import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ReducedMotionContext, usePanelMotion } from '../uiMotion';

// Only the foremost layer handles Escape/focus. No editor selection or document
// state lives here; closing a layer must leave the underlying view intact.
const layers: HTMLElement[] = [];
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(focusable)]
  .filter(item => item.getClientRects().length && !item.closest('[inert], [hidden], [aria-hidden="true"]'));

export function useOverlayFocus(open: boolean, ref: RefObject<HTMLElement | null>, options: {
  kind: 'menu' | 'popover' | 'modal'; onDismiss?: () => void; returnFocus?: () => HTMLElement | null;
}) {
  const latest = useRef(options); latest.current = options;
  const origin = useRef<HTMLElement | null>(null);
  const restore = () => {
    const target = origin.current;
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const kind = latest.current.kind;
    origin.current = latest.current.returnFocus?.() || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.push(root);
    const foremost = () => layers.at(-1) === root;
    const focusFirst = () => (root.querySelector<HTMLElement>('[data-dialog-default]') || items(root)[0] || root).focus({ preventScroll: true });
    focusFirst();
    const key = (event: KeyboardEvent) => {
      if (!foremost() || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && (latest.current.onDismiss || kind === 'modal')) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (latest.current.onDismiss) { restore(); latest.current.onDismiss(); } return;
      }
      if (kind !== 'modal' || event.key !== 'Tab' || root.closest('[inert]')) return;
      const controls = items(root), index = controls.indexOf(document.activeElement as HTMLElement);
      if (!controls.length || index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
        event.preventDefault(); (controls[event.shiftKey ? controls.length - 1 : 0] || root).focus({ preventScroll: true });
      }
    };
    const pointer = (event: PointerEvent) => {
      if (kind !== 'modal' && foremost() && event.target instanceof Node && !root.contains(event.target)) {
        const trigger = latest.current.returnFocus?.();
        if (trigger?.contains(event.target) && (kind === 'popover' || trigger.getAttribute('aria-haspopup') === 'menu')) return;
        latest.current.onDismiss?.();
      }
    };
    const focus = (event: FocusEvent) => {
      if (!foremost() || !(event.target instanceof Node) || root.contains(event.target)) return;
      if (kind === 'modal') { if (document.hasFocus() && !root.closest('[inert]')) focusFirst(); }
      else if (kind === 'popover' && !latest.current.returnFocus?.()?.contains(event.target)) latest.current.onDismiss?.();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus);
    return () => {
      const index = layers.indexOf(root); if (index >= 0) layers.splice(index, 1);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus);
      if (kind === 'modal') {
        // A successor dialog or a newly focused editor owns focus from here.
        queueMicrotask(() => {
          if (!layers.length && document.hasFocus() && (document.activeElement === document.body || root.contains(document.activeElement))) restore();
        });
      }
    };
  }, [open, ref, options.kind]);
  return restore;
}

export function ContextMenu({ open, x, y, children, onClose, returnFocus, label = '快捷菜单' }: {
  open: boolean; x: number; y: number; children: ReactNode; onClose: () => void; returnFocus?: HTMLElement | null; label?: string;
}) {
  const reducedMotion = useContext(ReducedMotionContext);
  const savedReturnFocus = useRef<HTMLElement | null>(returnFocus || null);
  if (open && returnFocus) savedReturnFocus.current = returnFocus;
  const motion = usePanelMotion(open, reducedMotion, '4px', () => savedReturnFocus.current, 'y', { enter: '--motion-overlay', exit: '--motion-exit' });
  const ref = motion.ref as RefObject<HTMLDivElement | null>;
  const restore = useOverlayFocus(open && motion.present, ref, { kind: 'menu', onDismiss: onClose, returnFocus: () => returnFocus || null });
  const previousChildren = useRef(children); if (open) previousChildren.current = children;
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    if (!open || !motion.present) return;
    ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]').forEach(item => { item.tabIndex = -1; });
    const box = ref.current?.getBoundingClientRect();
    if (box) setPosition({ left: Math.max(8, Math.min(x, innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, innerHeight - box.height - 8)) });
  }, [x, y, open, motion.present]);
  useLayoutEffect(() => {
    if (!open || !motion.present) return;
    const close = () => onClose();
    // Focus/scrollIntoView can emit scroll events while a keyboard menu opens.
    // Only an actual wheel gesture outside the menu dismisses it.
    const wheel = (event: WheelEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) onClose(); };
    window.addEventListener('blur', close); window.addEventListener('resize', close); window.addEventListener('wheel', wheel, { capture: true, passive: true });
    return () => { window.removeEventListener('blur', close); window.removeEventListener('resize', close); window.removeEventListener('wheel', wheel, true); };
  }, [open, motion.present, onClose]);
  if (!motion.present) return null;
  return createPortal(<div ref={ref} className="file-context-menu" role="menu" aria-label={label} tabIndex={-1} style={position}
    aria-hidden={!open}
    onClickCapture={event => { if ((event.target as Element).closest('button:not(:disabled)')) restore(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === 'Tab') { restore(); onClose(); return; }
      const menuItems = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];
      const index = menuItems.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % menuItems.length : event.key === 'ArrowUp' ? (index - 1 + menuItems.length) % menuItems.length : event.key === 'Home' ? 0 : event.key === 'End' ? menuItems.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); event.stopPropagation(); menuItems[next]?.focus({ preventScroll: true }); }
    }}>{open ? children : previousChildren.current}</div>, document.querySelector('.app') || document.body);
}

export function ToastMessage({ open, message, onDismiss }: { open: boolean; message: string; onDismiss: () => void }) {
  const reducedMotion = useContext(ReducedMotionContext);
  const lastMessage = useRef(''), returnFocus = useRef<HTMLElement | null>(null), previousOpen = useRef(false);
  const motion = usePanelMotion(open, reducedMotion, '4px', () => returnFocus.current, 'y', { enter: '--motion-feedback', exit: '--motion-exit' });
  if (open) {
    if (!previousOpen.current && !motion.present) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lastMessage.current = message;
  }
  previousOpen.current = open;
  useEffect(() => {
    if (open || motion.present) return;
    lastMessage.current = ''; returnFocus.current = null;
  }, [open, motion.present]);
  if (!motion.present) return null;
  return <div ref={motion.ref as RefObject<HTMLDivElement | null>} className="toast" aria-hidden={!open}>
    <span role="status">{message || lastMessage.current}</span><button aria-label="关闭提示" onClick={onDismiss}><span aria-hidden="true">×</span></button>
  </div>;
}

export function DialogFrame({ children, labelledBy, describedBy, className = '', onCancel, busy = false, returnFocus }: {
  children: ReactNode; labelledBy: string; describedBy?: string; className?: string; onCancel?: () => void; busy?: boolean; returnFocus?: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlayFocus(true, ref, { kind: 'modal', onDismiss: busy ? undefined : onCancel, returnFocus });
  return <div className="modal-backdrop"><div ref={ref} className={'dialog ' + className} role="dialog" aria-modal="true"
    aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy} tabIndex={-1}>{children}</div></div>;
}
