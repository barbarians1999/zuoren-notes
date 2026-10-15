import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Drag = { pointer: number; x: number; ratio: number; next: number; active: boolean; width: number; original: string };

// Live PDF/Markdown resizing changes only a CSS variable. EPUB previews the
// divider until release, so its rendition receives one committed width change.
export function PaneSplitter({ container, ratio, onChange, deferred = false }: {
  container: RefObject<HTMLDivElement | null>; ratio: number; onChange: (ratio: number) => void; deferred?: boolean;
}) {
  const handle = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null), frame = useRef(0);
  const latest = useRef({ ratio, onChange, deferred }); latest.current = { ratio, onChange, deferred };
  const [dragging, setDragging] = useState(false);
  const cleanupEvents = useRef<() => void>(() => {});
  const clamp = (value: number, width = container.current?.clientWidth || 0) => {
    if (width <= 0) return latest.current.ratio;
    const min = Math.max(25, 240 / width * 100), max = Math.min(75, 100 - 240 / width * 100);
    return min <= max ? Math.max(min, Math.min(max, value)) : 50;
  };
  const finish = (commit: boolean) => {
    const session = drag.current; if (!session) return;
    drag.current = null; cancelAnimationFrame(frame.current); frame.current = 0;
    cleanupEvents.current(); cleanupEvents.current = () => {};
    const root = container.current;
    if (root) {
      root.style.setProperty('--split-at', session.original);
      root.style.removeProperty('--split-preview'); delete root.dataset.paneDragging;
    }
    setDragging(false);
    if (handle.current?.hasPointerCapture(session.pointer)) handle.current.releasePointerCapture(session.pointer);
    if (commit && session.active) latest.current.onChange(clamp(session.next, session.width));
    else handle.current?.setAttribute('aria-valuenow', String(Math.round(latest.current.ratio)));
  };
  useLayoutEffect(() => () => {
    const session = drag.current, root = container.current;
    cancelAnimationFrame(frame.current); cleanupEvents.current();
    if (session && root) { root.style.setProperty('--split-at', session.original); root.style.removeProperty('--split-preview'); delete root.dataset.paneDragging; }
    drag.current = null;
  }, [container]);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current || !container.current) return;
    event.preventDefault();
    const root = container.current;
    drag.current = { pointer: event.pointerId, x: event.clientX, ratio: ratio, next: ratio, active: false,
      width: root.getBoundingClientRect().width, original: root.style.getPropertyValue('--split-at') };
    handle.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
    const cancel = () => finish(false);
    const escape = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || key.isComposing || key.keyCode === 229) return;
      key.preventDefault(); key.stopImmediatePropagation(); cancel();
    };
    window.addEventListener('blur', cancel); window.addEventListener('resize', cancel); document.addEventListener('keydown', escape, true);
    cleanupEvents.current = () => { window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); document.removeEventListener('keydown', escape, true); };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const session = drag.current, root = container.current;
    if (!session || !root || session.pointer !== event.pointerId || session.width <= 0) return;
    const delta = event.clientX - session.x;
    if (!session.active && Math.abs(delta) < 4) return;
    event.preventDefault();
    if (!session.active) { session.active = true; root.dataset.paneDragging = 'true'; setDragging(true); }
    session.next = clamp(session.ratio + delta / session.width * 100, session.width);
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (drag.current !== session) return;
      root.style.setProperty(latest.current.deferred ? '--split-preview' : '--split-at', session.next + '%');
      handle.current?.setAttribute('aria-valuenow', String(Math.round(session.next)));
    });
  };
  return <><div ref={handle} className="splitter" role="separator" tabIndex={0} aria-label="调整阅读与笔记宽度" aria-orientation="vertical"
    aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)} title="拖动调整宽度；双击均分；Esc 撤销拖动；左右键微调"
    onPointerDown={down} onPointerMove={move} onPointerUp={event => { if (event.pointerId === drag.current?.pointer) finish(true); }}
    onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)} onDoubleClick={() => { finish(false); onChange(clamp(50)); }}
    onKeyDown={event => {
      if (drag.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
      const next = event.key === 'ArrowLeft' ? ratio - (event.shiftKey ? 10 : 2) : event.key === 'ArrowRight' ? ratio + (event.shiftKey ? 10 : 2) : event.key === 'Home' ? 25 : event.key === 'End' ? 75 : null;
      if (next !== null) { event.preventDefault(); event.stopPropagation(); onChange(clamp(next)); }
    }}/>
    {dragging && container.current && createPortal(<><div className="splitter-shield" aria-hidden="true"/>{deferred && <div className="splitter-preview" aria-hidden="true"/>}</>, container.current)}
  </>;
}
