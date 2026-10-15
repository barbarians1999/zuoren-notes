import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { ContextMenu } from './overlays';

// Measure the reading pane, not the desktop window. Reparent only these small
// controls; the reader, editor and their selection/undo state stay mounted.
export function ResponsiveToolGroup({ container, label, children }: { container: RefObject<HTMLElement | null>; label: string; children: ReactNode }) {
  const [compact, setCompact] = useState(false), [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const resize = () => { const narrow = root.clientWidth < 480; setCompact(narrow); if (!narrow) setOpen(false); };
    const observer = new ResizeObserver(resize); observer.observe(root); resize();
    return () => observer.disconnect();
  }, [container]);
  if (!compact) return <div className="pdf-tools" role="toolbar" aria-label={label}>{children}</div>;
  const box = trigger.current?.getBoundingClientRect();
  return <div className="toolbar-overflow"><button ref={trigger} className="icon-button" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal size={16}/></button>
    {open && <ContextMenu x={box?.left || 0} y={box?.bottom || 0} returnFocus={trigger.current} label={label} onClose={() => setOpen(false)}>
      {Children.map(children, child => isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(child) && child.type === 'button' ? cloneElement(child, {
        role: child.props['aria-pressed'] !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': child.props['aria-pressed'],
        'aria-pressed': undefined,
        onClick: event => { child.props.onClick?.(event); setOpen(false); },
      }) : child)}
    </ContextMenu>}
  </div>;
}
