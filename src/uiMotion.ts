import { createContext, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const ReducedMotionContext = createContext(false);
export const motionNumber = (style: CSSStyleDeclaration, name: string, fallback: number) => {
  const value = style.getPropertyValue(name).trim();
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)?$/.exec(value);
  if (!match) return fallback;
  const number = Number(match[1]);
  const milliseconds = match[2] === 's' ? number * 1000 : number;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallback;
};
export const motionText = (style: CSSStyleDeclaration, name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;

// Layout changes are immediate; only their shared surface moves. A newer
// request continues from the visible position, and accessibility changes stop
// in-flight motion even when the selected layout has not changed.
export function useLayoutMotion(
  host: RefObject<HTMLElement | null>,
  layout: 'read' | 'note' | 'split',
  ready: boolean,
  reduced: boolean,
  requested: RefObject<boolean>,
) {
  const previousLayout = useRef(layout), initialized = useRef(false);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (reduced || !ready) { animation.current?.cancel(); animation.current = null; }
    if (!ready) { previousLayout.current = layout; return; }
    if (!initialized.current) { initialized.current = true; previousLayout.current = layout; return; }
    const previous = previousLayout.current; previousLayout.current = layout;
    if (previous === layout) return;
    const shouldAnimate = requested.current; requested.current = false;
    const node = host.current, active = animation.current;
    const from = active && node ? getComputedStyle(node).transform : null;
    active?.cancel(); animation.current = null;
    if (!shouldAnimate || reduced || !node) return;
    const positions = { read: 0, note: 1, split: 2 };
    const direction = positions[layout] > positions[previous] ? 1 : -1;
    const style = getComputedStyle(node);
    const next = node.animate([{ transform: from || `translateX(${direction * 12}px)` }, { transform: 'translateX(0px)' }], {
      duration: motionNumber(style, '--motion-mode', 180), easing: motionText(style, '--motion-ease-enter', 'cubic-bezier(.2,.75,.3,1)'),
    });
    animation.current = next;
    next.finished.then(() => { if (animation.current === next) animation.current = null; }).catch(() => {});
  }, [host, layout, ready, reduced, requested]);
  useLayoutEffect(() => () => { animation.current?.cancel(); }, []);
}

// Keep layout stable during motion. Hidden panels are inert until removed.
export function usePanelMotion(
  open: boolean,
  reduced: boolean,
  direction: string,
  returnFocus: () => HTMLElement | null,
  axis: 'x' | 'y' = 'x',
  durationVariables: { enter?: string; exit?: string } = {},
) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLElement>(null);
  const animation = useRef<Animation | null>(null);
  const initialized = useRef(false);
  const previousReduced = useRef(reduced);
  const focus = useRef(returnFocus); focus.current = returnFocus;
  useLayoutEffect(() => {
    const preferenceChanged = previousReduced.current !== reduced;
    previousReduced.current = reduced;
    if (open && !present) { animation.current?.cancel(); animation.current = null; setPresent(true); return; }
    const node = ref.current;
    if (!node) { animation.current?.cancel(); animation.current = null; initialized.current = true; return; }
    const previous = animation.current;
    const style = getComputedStyle(node);
    const activeElement = document.activeElement;
    const focusWasInside = !open && node.contains(activeElement);
    if (open) {
      node.style.pointerEvents = '';
      node.inert = false;
    } else {
      node.style.pointerEvents = 'none';
      if (focusWasInside) {
        const target = focus.current();
        if (target?.isConnected && !node.contains(target) && !target.closest('[inert]')) target.focus({ preventScroll: true });
      }
      node.inert = true;
    }
    const enterEasing = motionText(style, '--motion-ease-enter', 'cubic-bezier(.2,.75,.3,1)');
    const exitEasing = motionText(style, '--motion-ease-exit', 'cubic-bezier(.4,0,.6,1)');
    const translate = (offset: string) => `translate${axis.toUpperCase()}(${offset})`;
    const from = previous ? { transform: style.transform, opacity: style.opacity } :
      { transform: open ? translate(direction) : translate('0'), opacity: open ? 0 : 1 };
    previous?.cancel(); animation.current = null;
    if (reduced || preferenceChanged || !initialized.current) {
      initialized.current = true;
      if (!open) setPresent(false);
      return;
    }
    const frames = open ? [from, { transform: translate('0'), opacity: 1 }] :
      [from, { opacity: from.opacity, offset: .35 }, { transform: translate(direction), opacity: 0 }];
    const duration = open
      ? motionNumber(style, durationVariables.enter || '--motion-panel', 200)
      : motionNumber(style, durationVariables.exit || '--motion-panel', 200);
    const next = node.animate(frames, { duration, easing: open ? enterEasing : exitEasing, fill: 'both' });
    animation.current = next;
    next.finished.then(() => {
      if (animation.current !== next) return;
      if (!open) {
        // Retain the invisible final frame until React actually removes the
        // panel. Cancelling here would briefly restore its visible base CSS.
        setPresent(false);
      } else { animation.current = null; next.cancel(); }
    }).catch(() => {});
  }, [open, present, reduced, direction]);
  useLayoutEffect(() => () => { animation.current?.cancel(); }, []);
  return { present, ref };
}

// A shared accent line marks selection; tab content itself switches instantly.
export function useTabMotion(host: HTMLElement | null, reduced: boolean) {
  useLayoutEffect(() => {
    if (!host) return;
    const line = document.createElement('span');
    line.className = 'tab-motion-line'; line.setAttribute('aria-hidden', 'true');
    host.append(line); host.dataset.tabMotion = 'true';
    let active: HTMLElement | null = null, frame = 0, animation: Animation | null = null, lastTransform = '';
    const resize = new ResizeObserver(() => schedule());
    const update = () => {
      frame = 0;
      const next = host.querySelector<HTMLElement>('.foreground-tab');
      if (!next) { if (active) resize.unobserve(active); line.hidden = true; active = null; lastTransform = ''; animation?.cancel(); animation = null; return; }
      const bounds = next.getBoundingClientRect(), box = host.getBoundingClientRect();
      const transform = `translate(${bounds.left - box.left + host.scrollLeft}px,${bounds.bottom - box.top + host.scrollTop - 2}px) scaleX(${bounds.width})`;
      // ResizeObserver emits once after observing the new active tab. Ignore
      // unchanged geometry so that notification cannot cancel its slide.
      if (active === next && lastTransform === transform) return;
      const from = getComputedStyle(line).transform;
      animation?.cancel(); line.hidden = false; line.style.transform = transform;
      lastTransform = transform;
      const style = getComputedStyle(host);
      if (active && active !== next && !reduced) animation = line.animate([{ transform: from }, { transform }], {
        duration: motionNumber(style, '--motion-feedback', 140), easing: motionText(style, '--motion-ease-enter', 'cubic-bezier(.2,.75,.3,1)'),
      });
      if (active !== next) { if (active) resize.unobserve(active); resize.observe(next); active = next; }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-view-id'] });
    resize.observe(host); host.addEventListener('scroll', schedule); update();
    return () => { cancelAnimationFrame(frame); animation?.cancel(); mutations.disconnect(); resize.disconnect(); host.removeEventListener('scroll', schedule); line.remove(); delete host.dataset.tabMotion; };
  }, [host, reduced]);
}
