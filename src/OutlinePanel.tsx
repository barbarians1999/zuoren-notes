import { useContext, useLayoutEffect, useState } from 'react';
import { ChevronsRight } from 'lucide-react';
import { ReducedMotionContext, usePanelMotion } from './uiMotion';

export type OutlineItem = { id: string; label: string; depth: number; indicator?: string; active?: boolean };

// Markdown supplies headings; readers supply their navigation trees. Their source
// semantics stay separate while the panel, focus and motion are shared.
export function OutlinePanel({ open, label, items, emptyText, introduction, onSelect, onClose, returnFocus, className = '' }: {
  open: boolean; label: string; items: OutlineItem[]; emptyText: string;
  introduction?: string;
  onSelect: (item: OutlineItem, activation: { keyboard: boolean }) => void; onClose?: () => void; returnFocus: () => HTMLElement | null; className?: string;
}) {
  const reduced = useContext(ReducedMotionContext);
  const panel = usePanelMotion(open, reduced, '100%', returnFocus);
  const activeId = items.find(item => item.active)?.id;
  const [markerTop, setMarkerTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const host = panel.ref.current;
    const row = host?.querySelector<HTMLButtonElement>('button[aria-current="location"]');
    if (!host || !row || !open) { setMarkerTop(null); return; }
    const measure = () => setMarkerTop(row.offsetTop + row.offsetHeight / 2);
    measure();
    const top = row.offsetTop - 8, bottom = row.offsetTop + row.offsetHeight + 8;
    if (top < host.scrollTop || bottom > host.scrollTop + host.clientHeight) {
      host.scrollTo({ top: top < host.scrollTop ? top : bottom - host.clientHeight, behavior: reduced ? 'instant' : 'smooth' });
    }
    const resize = new ResizeObserver(measure);
    resize.observe(row); resize.observe(host);
    return () => resize.disconnect();
  }, [activeId, items.length, introduction, open, panel.present, panel.ref, reduced]);
  if (!panel.present) return null;
  return <aside ref={panel.ref} aria-hidden={!open} className={'note-outline ' + className} aria-label={label}>
    {markerTop !== null && <span className="outline-location-marker" aria-hidden="true" style={{ transform: `translateY(${markerTop}px)` }}/>}
    <div className="outline-title"><span>大纲</span>{onClose && <button type="button" className="outline-close" aria-label={'收起' + label} title="收起大纲" onClick={onClose}><ChevronsRight size={14}/></button>}</div>
    {introduction && <p>{introduction}</p>}
    {items.length ? items.map(item => <button key={item.id} style={{ paddingLeft: 10 + Math.min(12, Math.max(0, item.depth)) * 10 }}
      title={item.label} aria-current={item.active ? 'location' : undefined} onClick={event => onSelect(item, { keyboard: event.detail === 0 })}>
      {item.indicator && <small>{item.indicator}</small>}<span>{item.label}</span>
    </button>) : <p>{emptyText}</p>}
  </aside>;
}
