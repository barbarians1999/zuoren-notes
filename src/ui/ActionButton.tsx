import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';

// Success is shown only after the caller confirms completion. A late result
// from another selection/view cannot acknowledge a newer action.
export function ActionButton({ identity, action, successLabel, onError, children, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onError' | 'onClick'> & {
  identity: unknown; action: () => Promise<boolean>; successLabel: string; onError: (message: string) => void;
}) {
  const [state, setState] = useState<'ready' | 'busy' | 'done'>('ready');
  const current = useRef(identity); current.current = identity;
  const generation = useRef(0), locked = useRef(false), timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    generation.current++; locked.current = false; setState('ready');
    return () => { generation.current++; window.clearTimeout(timer.current); };
  }, [identity]);
  async function run() {
    if (locked.current) return;
    locked.current = true;
    window.clearTimeout(timer.current);
    const version = generation.current, selection = identity;
    setState('busy');
    try {
      const completed = await action();
      if (generation.current !== version || current.current !== selection) return;
      setState(completed ? 'done' : 'ready');
      if (completed) timer.current = window.setTimeout(() => setState('ready'), 1600);
    } catch (error) {
      if (generation.current === version && current.current === selection) { setState('ready'); onError(`操作失败，请重试：${String(error)}`); }
    } finally { if (generation.current === version) locked.current = false; }
  }
  return <button {...props} className={(props.className || '') + ' action-feedback'} disabled={disabled || state === 'busy'} aria-busy={state === 'busy'}
    data-feedback={state} onClick={() => void run()}><span aria-hidden={state === 'done'}>{children}</span><span className="action-feedback-result" aria-hidden={state !== 'done'}>{successLabel}</span><span className="sr-only" role="status">{state === 'done' ? successLabel : ''}</span></button>;
}
