import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function PdfPopover({ root, anchor, children, className }: {
  root: RefObject<HTMLElement | null>; anchor: () => { left: number; right: number; top: number; bottom: number } | null;
  children: ReactNode; className: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number; visibility: 'visible' | 'hidden' }>({ left: 0, top: 0, maxWidth: 400, visibility: 'hidden' });
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      const pane = root.current?.querySelector('.pdf-canvas-wrap')?.getBoundingClientRect(), box = host.current?.getBoundingClientRect(), at = anchor();
      if (!pane || !box || !at || at.bottom < pane.top || at.top > pane.bottom) { setPosition(old => old.visibility === 'hidden' ? old : { ...old, visibility: 'hidden' }); return; }
      const minX = Math.max(8, pane.left + 8), maxX = Math.min(innerWidth - 8, pane.right - 8);
      const minY = Math.max(8, pane.top + 8), maxY = Math.min(innerHeight - 8, pane.bottom - 8);
      const width = Math.min(box.width, maxX - minX), height = box.height;
      const left = Math.max(minX, Math.min(at.left, maxX - width));
      // Avoid nearby *unselected* lines as well as the selected fragments.
      // Test only visible page text so this remains bounded during scrolling.
      const text = [...root.current?.querySelectorAll<HTMLElement>('.canvas-holder') || []].filter(page => {
        const bounds = page.getBoundingClientRect(); return bounds.bottom >= minY && bounds.top <= maxY;
      }).flatMap(page => [...page.querySelectorAll<HTMLElement>('.textLayer span')].filter(span => span.firstChild?.nodeType === Node.TEXT_NODE && !span.closest('[role="img"]')).map(span => span.getBoundingClientRect()))
        .filter(rect => rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < left + width && rect.bottom >= minY && rect.top <= maxY);
      const avoid = (candidate: number, direction: 1 | -1) => {
        for (let pass = 0; pass <= text.length; pass++) {
          const collisions = text.filter(rect => rect.bottom > candidate && rect.top < candidate + height);
          if (!collisions.length) return candidate;
          candidate = direction === 1 ? Math.max(...collisions.map(rect => rect.bottom)) + 8 : Math.min(...collisions.map(rect => rect.top)) - height - 8;
          if (candidate < minY || candidate + height > maxY) return candidate;
        }
        return candidate;
      };
      const below = avoid(at.bottom + 8, 1), above = avoid(at.top - height - 8, -1);
      const preferred = below >= minY && below + height <= maxY ? below : above >= minY && above + height <= maxY ? above : at.bottom + height + 8 <= maxY ? at.bottom + 8 : at.top - height - 8;
      const top = Math.max(minY, Math.min(preferred, maxY - height));
      const next = { left, top, maxWidth: maxX - minX, visibility: 'visible' as const };
      setPosition(old => old.left === next.left && old.top === next.top && old.maxWidth === next.maxWidth && old.visibility === next.visibility ? old : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    const observer = new ResizeObserver(schedule);
    if (root.current) observer.observe(root.current); if (host.current) observer.observe(host.current);
    // PDF.js updates page dimensions asynchronously after a zoom; the reader
    // viewport itself does not resize, so observing only the root is stale.
    for (const page of root.current?.querySelectorAll('.canvas-holder') || []) observer.observe(page);
    root.current?.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    place();
    const element = root.current;
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element?.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, [anchor, root]);
  return <div ref={host} role="group" className={className} style={position}>{children}</div>;
}
