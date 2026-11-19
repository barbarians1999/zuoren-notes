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

// Decorative targets only: callers keep button/row hit boxes and editable text still.
export function pulseControl(node: HTMLElement, kind: 'control' | 'task' = 'control', from?: string) {
  const app = node.closest<HTMLElement>('.app'), win = node.ownerDocument.defaultView;
  if (!node.isConnected || app?.dataset.motion === 'reduced' || win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
  let animation: Animation | null | undefined;
  try {
    const style = getComputedStyle(node);
    animation = node.animate([
      { transform: from || (style.transform === 'none' || !style.transform ? 'scale(1)' : style.transform) },
      { transform: kind === 'task' ? 'scale(1.16)' : 'scale(1.08)', offset: .36 },
      { transform: kind === 'task' ? 'scale(.97)' : 'scale(.988)', offset: .74 },
      { transform: 'scale(1)' },
    ], { duration: motionNumber(style, kind === 'task' ? '--motion-task' : '--motion-feedback', kind === 'task' ? 240 : 180),
      easing: motionText(style, '--motion-ease-enter', 'cubic-bezier(.22,1,.36,1)') });
  } catch { return () => {}; } // Feedback never vetoes an accepted operation.
  return () => animation?.cancel?.();
}

export function useControlFeedback(host: RefObject<HTMLElement | null>, reduced: boolean, page: string) {
  useLayoutEffect(() => {
    const root = host.current;
    if (!root || reduced) return;
    const active = new Map<Element, () => void>();
    const clear = () => { active.forEach(cancel => cancel()); active.clear(); };
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button');
      if (!button || !root.contains(button) || button.disabled || button.closest('[inert]')) return;
      // File labels and drag/drop targets stay fixed, including during selection.
      const glyph = button.querySelector<HTMLElement>(':scope > svg, :scope > .folder-icon, :scope > .file-icon, :scope > .action-label, :scope > span:not(.file-name):not(.sr-only)');
      if (!glyph || !glyph.isConnected) return;
      const from = getComputedStyle(glyph).transform;
      active.get(glyph)?.();
      const cancel = pulseControl(glyph, 'control', from); active.set(glyph, cancel);
      // Release references when this short animation ends; do not use a timer.
      void Promise.allSettled(glyph.getAnimations().map(animation => animation.finished)).then(() => {
        if (active.get(glyph) === cancel) active.delete(glyph);
      });
    };
    root.addEventListener('click', click);
    root.addEventListener('dragstart', clear, true);
    root.addEventListener('pointercancel', clear, true);
    root.ownerDocument.defaultView?.addEventListener('blur', clear);
    const preference = root.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const preferenceChanged = () => { if (preference?.matches) clear(); };
    preference?.addEventListener('change', preferenceChanged);
    return () => { clear(); root.removeEventListener('click', click); root.removeEventListener('dragstart', clear, true);
      root.removeEventListener('pointercancel', clear, true); root.ownerDocument.defaultView?.removeEventListener('blur', clear); preference?.removeEventListener('change', preferenceChanged); };
  }, [host, reduced, page]);
}

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
      duration: motionNumber(style, '--motion-mode', 180), easing: motionText(style, '--motion-ease-enter', 'cubic-bezier(.22,1,.36,1)'),
    });
    if (!next) return;
    animation.current = next;
    next.finished?.then(() => { if (animation.current === next) animation.current = null; }).catch(() => {});
  }, [host, layout, ready, reduced, requested]);
  useLayoutEffect(() => () => { animation.current?.cancel(); }, []);
}

// Keep layout stable during motion. Hidden panels are inert until removed.
export function usePanelMotion(
  open: boolean,
  reduced: boolean,
  direction: string,
  returnFocus: () => HTMLElement | null,
  axis: 'x' | 'y' | 'scale' | 'opacity' = 'x',
  durationVariables: { enter?: string; exit?: string; initial?: boolean } = {},
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
    const enterEasing = motionText(style, '--motion-ease-enter', 'cubic-bezier(.22,1,.36,1)');
    const exitEasing = motionText(style, '--motion-ease-exit', 'cubic-bezier(.36,0,.58,1)');
    const translate = (offset: string) => axis === 'scale' ? (offset === '0' ? 'translateY(0) scale(1)' : 'translateY(5px) scale(.972)') : axis === 'opacity' ? 'none' : `translate${axis.toUpperCase()}(${offset})`;
    const from = previous ? { transform: style.transform, opacity: style.opacity } :
      { transform: open ? translate(direction) : translate('0'), opacity: open ? 0 : 1 };
    previous?.cancel(); animation.current = null;
    if (reduced || preferenceChanged || !initialized.current && !durationVariables.initial) {
      initialized.current = true;
      if (!open) setPresent(false);
      return;
    }
    initialized.current = true;
    const frames = open ? axis === 'scale' ? [from, { transform: 'translateY(-1px) scale(1.005)', opacity: 1, offset: .72 }, { transform: 'translateY(0) scale(1)', opacity: 1 }] : [from, { transform: translate('0'), opacity: 1 }] :
      [from, { opacity: from.opacity, offset: .35 }, { transform: translate(direction), opacity: 0 }];
    const duration = open
      ? motionNumber(style, durationVariables.enter || '--motion-panel', 200)
      : motionNumber(style, durationVariables.exit || '--motion-panel', 200);
    let next: Animation | null | undefined;
    try { next = node.animate(frames, { duration, easing: open ? enterEasing : exitEasing, fill: 'both' }); }
    catch { if (!open) setPresent(false); return; }
    if (!next) { if (!open) setPresent(false); return; }
    animation.current = next;
    next.finished?.then(() => {
      if (animation.current !== next) return;
      if (!open) {
        // Retain the invisible final frame until React actually removes the
        // panel. Cancelling here would briefly restore its visible base CSS.
        setPresent(false);
      } else { animation.current = null; next?.cancel?.(); }
    }).catch(() => {});
  }, [open, present, reduced, direction, axis, durationVariables.enter, durationVariables.exit, durationVariables.initial]);
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
        duration: motionNumber(style, '--motion-feedback', 140), easing: motionText(style, '--motion-ease-enter', 'cubic-bezier(.22,1,.36,1)'),
      });
      if (active !== next) { if (active) resize.unobserve(active); resize.observe(next); active = next; }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutations = new MutationObserver(() => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      update();
    });
    mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-view-id'] });
    resize.observe(host); host.addEventListener('scroll', schedule); update();
    return () => { cancelAnimationFrame(frame); animation?.cancel(); mutations.disconnect(); resize.disconnect(); host.removeEventListener('scroll', schedule); line.remove(); delete host.dataset.tabMotion; };
  }, [host, reduced]);
}

type PillRect = { x: number; y: number; width: number; height: number };
type PillController = {
  sync(activeKey: string, ready: boolean, reduced: boolean): void;
};

const APPLE_SPRING_LINEAR = 'linear(0, 0.008, 0.035, 0.138, 0.33, 0.555, 0.76, 0.912, 1.006, 1.042, 1.04, 1.022, 1.006, 0.997, 0.998, 1)';

// Shared sliding liquid-glass pill thumb for segmented switchers (layout tabs & edit/preview switch).
export function useSegmentedPillMotion(
  host: RefObject<HTMLElement | null>,
  activeKey: string,
  ready: boolean,
  reduced: boolean,
) {
  const controllerRef = useRef<PillController | null>(null);
  const latestRef = useRef({ activeKey, ready, reduced });
  latestRef.current = { activeKey, ready, reduced };

  useLayoutEffect(() => {
    const root = host.current;
    if (!root) return;
    const thumb = document.createElement('span');
    thumb.className = 'mode-switch-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    thumb.hidden = true;
    root.prepend(thumb);
    root.dataset.pillMotion = 'true';

    let settledKey = '';
    let wasReady = false;
    let lastRect: PillRect | null = null;
    let animation: Animation | null = null;
    let observedBtn: HTMLElement | null = null;
    let frame = 0;

    const measureActive = (): { button: HTMLElement; rect: PillRect } | null => {
      const button = root.querySelector<HTMLElement>('button.active');
      if (!button || !button.isConnected) return null;
      const width = button.offsetWidth, height = button.offsetHeight;
      if (width <= 0 || height <= 0) return null;
      return { button, rect: { x: button.offsetLeft, y: button.offsetTop, width, height } };
    };

    const stopAnimation = () => {
      animation?.cancel();
      animation = null;
      thumb.classList.remove('is-gliding');
    };

    const snapThumb = (rect: PillRect) => {
      thumb.hidden = false;
      thumb.style.width = `${rect.width}px`;
      thumb.style.height = `${rect.height}px`;
      thumb.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0) scale(1, 1)`;
      lastRect = rect;
    };

    const resize = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const measured = measureActive();
        if (!measured) { stopAnimation(); thumb.hidden = true; lastRect = null; return; }
        if (animation?.playState === 'running') return;
        snapThumb(measured.rect);
      });
    });

    const observeButton = (button: HTMLElement | null) => {
      if (observedBtn === button) return;
      if (observedBtn) resize.unobserve(observedBtn);
      observedBtn = button;
      if (button) resize.observe(button);
    };

    const sync = (nextKey: string, nextReady: boolean, nextReduced: boolean) => {
      const measured = measureActive();
      observeButton(measured?.button ?? null);
      if (!measured) {
        stopAnimation();
        thumb.hidden = true;
        lastRect = null;
        settledKey = nextKey;
        wasReady = nextReady;
        return;
      }
      const { rect: target } = measured;
      const appReduced = nextReduced || root.closest<HTMLElement>('.app')?.dataset.motion === 'reduced';
      const canAnimate = nextReady && !appReduced && wasReady && !!lastRect && settledKey !== '' && settledKey !== nextKey;

      if (!canAnimate) {
        stopAnimation();
        snapThumb(target);
        settledKey = nextKey;
        wasReady = nextReady;
        return;
      }

      let fromX = lastRect!.x, fromY = lastRect!.y, fromW = lastRect!.width, fromH = lastRect!.height;
      if (animation && animation.playState === 'running') {
        try {
          const style = getComputedStyle(thumb);
          const matrix = new DOMMatrixReadOnly(style.transform);
          if (Number.isFinite(matrix.m41) && Number.isFinite(matrix.m42)) {
            const baseW = parseFloat(thumb.style.width) || target.width;
            const baseH = parseFloat(thumb.style.height) || target.height;
            fromX = matrix.m41;
            fromY = matrix.m42;
            fromW = baseW * (matrix.a || 1);
            fromH = baseH * (matrix.d || 1);
          }
        } catch {}
      }
      stopAnimation();
      snapThumb(target);
      settledKey = nextKey;
      wasReady = nextReady;

      const dx = target.x - fromX, dy = target.y - fromY;
      if (Math.hypot(dx, dy) < 1 && Math.abs(fromW - target.width) < 1) return;

      const sx = Math.max(0.5, fromW / target.width);
      const sy = Math.max(0.5, fromH / target.height);
      const midStretchX = 1 + Math.min(0.055, Math.abs(dx) / Math.max(target.width, 40) * 0.032);
      const midSquashY = Math.abs(dx) >= 4 ? 0.96 : 1;
      const midShiftX = -target.width * (midStretchX - 1) * 0.5;
      const midShiftY = -target.height * (midSquashY - 1) * 0.5;
      const midX = fromX + dx * 0.56 + midShiftX;
      const midY = fromY + dy * 0.56 + midShiftY;

      const frames: Keyframe[] = [
        { transform: `translate3d(${fromX}px, ${fromY}px, 0) scale(${sx}, ${sy})` },
        { transform: `translate3d(${midX}px, ${midY}px, 0) scale(${midStretchX}, ${midSquashY})`, offset: 0.42 },
        { transform: `translate3d(${target.x}px, ${target.y}px, 0) scale(1, 1)` },
      ];
      const hostStyle = getComputedStyle(root);
      const duration = Math.max(240, motionNumber(hostStyle, '--motion-mode', 180) + 120);
      let nextAnim: Animation | null = null;
      try {
        nextAnim = thumb.animate(frames, { duration, easing: APPLE_SPRING_LINEAR });
      } catch {
        try {
          nextAnim = thumb.animate(frames, { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        } catch {
          nextAnim = null;
        }
      }
      if (!nextAnim) return;
      animation = nextAnim;
      thumb.classList.add('is-gliding');
      nextAnim.onfinish = () => {
        if (animation !== nextAnim) return;
        animation = null;
        thumb.classList.remove('is-gliding');
      };
      nextAnim.oncancel = () => {
        if (animation !== nextAnim) return;
        animation = null;
        thumb.classList.remove('is-gliding');
      };
    };

    controllerRef.current = { sync };
    resize.observe(root);
    sync(latestRef.current.activeKey, latestRef.current.ready, latestRef.current.reduced);

    return () => {
      cancelAnimationFrame(frame);
      stopAnimation();
      resize.disconnect();
      controllerRef.current = null;
      thumb.remove();
      delete root.dataset.pillMotion;
    };
  }, [host]);

  useLayoutEffect(() => {
    controllerRef.current?.sync(activeKey, ready, reduced);
  }, [host, activeKey, ready, reduced]);
}
