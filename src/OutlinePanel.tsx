import { useContext } from 'react';
import { ReducedMotionContext, usePanelMotion } from './uiMotion';

export type OutlineItem = { id: string; label: string; depth: number; indicator?: string; active?: boolean };

// Markdown supplies headings; readers supply their navigation trees. Their source
// semantics stay separate while the panel, focus and motion are shared.
export function OutlinePanel({ open, label, items, emptyText, introduction, onSelect, returnFocus, className = '' }: {
  open: boolean; label: string; items: OutlineItem[]; emptyText: string;
  introduction?: string;
  onSelect: (item: OutlineItem) => void; returnFocus: () => HTMLElement | null; className?: string;
}) {
  const reduced = useContext(ReducedMotionContext);
  const panel = usePanelMotion(open, reduced, '100%', 200, returnFocus);
  if (!panel.present) return null;
  return <aside ref={panel.ref} aria-hidden={!open} className={'note-outline ' + className} aria-label={label}>
    <div className="outline-title">大纲</div>
    {introduction && <p>{introduction}</p>}
    {items.length ? items.map(item => <button key={item.id} style={{ paddingLeft: 10 + Math.min(12, Math.max(0, item.depth)) * 10 }}
      title={item.label} aria-current={item.active ? 'location' : undefined} onClick={() => onSelect(item)}>
      {item.indicator && <small>{item.indicator}</small>}<span>{item.label}</span>
    </button>) : <p>{emptyText}</p>}
  </aside>;
}
