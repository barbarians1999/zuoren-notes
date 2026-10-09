import { createContext, useLayoutEffect, useRef, useState } from 'react';

export const ReducedMotionContext = createContext(false);
const easing = 'cubic-bezier(.2,.75,.3,1)';
const exitEasing = 'cubic-bezier(.4,0,.6,1)';

// Keep layout stable during motion. Hidden panels are inert until removed.
export function usePanelMotion(open: boolean, reduced: boolean, direction: string, duration: number, returnFocus: () => HTMLElement | null) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLElement>(null);
  const animation = useRef<Animation | null>(null);
  const initialized = useRef(false);
  const previousReduced = useRef(reduced);
  const focus = useRef(returnFocus); focus.current = returnFocus;
  useLayoutEffect(() => {
    const preferenceChanged = previousReduced.current !== reduced;
    previousReduced.current = reduced;
    if (open && !present) { setPresent(true); return; }
    const node = ref.current;
    if (!node) { animation.current?.cancel(); animation.current = null; initialized.current = true; return; }
    node.inert = !open;
    if (!open && node.contains(document.activeElement)) focus.current()?.focus();
    const previous = animation.current;
    const style = getComputedStyle(node);
    const from = previous ? { transform: style.transform, opacity: style.opacity } :
      { transform: open ? `translateX(${direction})` : 'translateX(0)', opacity: open ? 0 : 1 };
    previous?.cancel(); animation.current = null;
    if (reduced || preferenceChanged || !initialized.current) {
      initialized.current = true;
      if (!open) setPresent(false);
      return;
    }
    const frames = open ? [from, { transform: 'translateX(0)', opacity: 1 }] :
      [from, { opacity: from.opacity, offset: .35 }, { transform: `translateX(${direction})`, opacity: 0 }];
    const next = node.animate(frames, { duration, easing: open ? easing : exitEasing, fill: 'both' });
    animation.current = next;
    next.finished.then(() => {
      if (animation.current !== next) return;
      if (!open) {
        // Retain the invisible final frame until React actually removes the
        // panel. Cancelling here would briefly restore its visible base CSS.
        setPresent(false);
      } else { animation.current = null; next.cancel(); }
    }).catch(() => {});
  }, [open, present, reduced, direction, duration]);
  useLayoutEffect(() => () => { animation.current?.cancel(); }, []);
  return { present, ref };
}

// One decorative line follows the active tab; document switching stays instant.
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
      if (active && active !== next && !reduced) animation = line.animate([{ transform: from }, { transform }], { duration: 140, easing });
      if (active !== next) { if (active) resize.unobserve(active); resize.observe(next); active = next; }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-view-id'] });
    resize.observe(host); host.addEventListener('scroll', schedule); update();
    return () => { cancelAnimationFrame(frame); animation?.cancel(); mutations.disconnect(); resize.disconnect(); host.removeEventListener('scroll', schedule); line.remove(); delete host.dataset.tabMotion; };
  }, [host, reduced]);
}
