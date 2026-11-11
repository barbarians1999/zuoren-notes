import { EditorSelection, Transaction, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
export const outlineMotionPlan = (from: number, target: number, height: number) => {
  const distance = Math.abs(target - from), travel = Math.min(480, height * .65);
  return { from: distance > travel ? target - Math.sign(target - from) * travel : from,
    duration: Math.min(200, Math.max(120, 120 + Math.min(distance, travel) * .16)) };
};
export function outlineMotionReduced(host: HTMLElement) {
  return host.closest<HTMLElement>('.app')?.dataset.motion === 'reduced'
    || host.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

// Animates only this scroll container. No cloned content, caret, document
// transaction, CSS transform, or browser-controlled smooth scroll is involved.
export class OutlineScrollMotion {
  private frame = 0;
  private generation = 0;
  private resolveTarget: (() => number | null) | null = null;
  private lastWritten = 0;
  private behavior: { value: string; priority: string } | null = null;
  private win: Window;
  private interrupt = () => { this.cancel(); this.onInterrupt(); };
  private onScroll = () => {
    if (this.resolveTarget && Math.abs(this.host.scrollTop - this.lastWritten) > 1) this.interrupt();
  };
  constructor(readonly host: HTMLElement, private onInterrupt: () => void = () => {}) {
    this.win = host.ownerDocument.defaultView!;
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforeinput', 'compositionstart'])
      host.ownerDocument.addEventListener(type, this.interrupt, { capture: true, passive: true });
    host.addEventListener('scroll', this.onScroll, { passive: true });
    this.win.addEventListener('blur', this.interrupt);
  }
  get active() { return this.resolveTarget !== null; }
  private target(resolve: () => number | null) {
    if (!this.host.isConnected || this.host.clientHeight <= 0) return null;
    let value: number | null;
    try { value = resolve(); } catch { return null; }
    return value !== null && Number.isFinite(value) ? clamp(value, Math.max(0, this.host.scrollHeight - this.host.clientHeight)) : null;
  }
  private write(top: number) { this.host.scrollTop = top; this.lastWritten = this.host.scrollTop; }
  private ownBehavior() {
    this.behavior = { value: this.host.style.getPropertyValue('scroll-behavior'), priority: this.host.style.getPropertyPriority('scroll-behavior') };
    this.host.style.setProperty('scroll-behavior', 'auto', 'important');
  }
  private restoreBehavior() {
    const saved = this.behavior; this.behavior = null;
    if (!saved || this.host.style.getPropertyValue('scroll-behavior') !== 'auto' || this.host.style.getPropertyPriority('scroll-behavior') !== 'important') return;
    if (saved.value) this.host.style.setProperty('scroll-behavior', saved.value, saved.priority);
    else this.host.style.removeProperty('scroll-behavior');
  }
  start(resolve: () => number | null, initialTarget?: number) {
    this.cancel();
    const target = initialTarget === undefined ? this.target(resolve) :
      this.host.isConnected && this.host.clientHeight > 0 && Number.isFinite(initialTarget) ? clamp(initialTarget, Math.max(0, this.host.scrollHeight - this.host.clientHeight)) : null;
    if (target === null) return false;
    this.ownBehavior();
    if (outlineMotionReduced(this.host) || (initialTarget === undefined && Math.abs(this.host.scrollTop - target) < 1)) {
      this.write(target); this.restoreBehavior(); return true;
    }
    const token = this.generation, started = this.win.performance.now();
    const { from, duration } = outlineMotionPlan(this.host.scrollTop, target, this.host.clientHeight);
    const height = this.host.clientHeight, width = this.host.clientWidth;
    this.resolveTarget = resolve; this.write(clamp(from, Math.max(0, this.host.scrollHeight - height)));
    const step = (now: number) => {
      if (token !== this.generation || !this.resolveTarget) return;
      this.frame = 0;
      const next = this.target(resolve);
      if (next === null) { this.cancel(); return; }
      if (Math.abs(next - from) < 1) { this.write(next); this.cancel(); return; }
      if (outlineMotionReduced(this.host) || height !== this.host.clientHeight || width !== this.host.clientWidth ||
          Math.abs(next - target) > Math.min(480, height * .65)) { this.finish(); return; }
      const progress = Math.max(0, Math.min(1, (now - started) / duration));
      this.write(from + (next - from) * (1 - (1 - progress) ** 3));
      if (progress === 1) { this.cancel(); return; }
      this.frame = this.win.requestAnimationFrame(step);
    };
    this.frame = this.win.requestAnimationFrame(step); return true;
  }
  finish() {
    const resolve = this.resolveTarget;
    const target = resolve && this.target(resolve);
    if (typeof target === 'number') this.write(target);
    this.cancel();
  }
  cancel() {
    this.generation++; if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.frame = 0; this.resolveTarget = null; this.restoreBehavior();
  }
  destroy() {
    this.cancel();
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforeinput', 'compositionstart'])
      this.host.ownerDocument.removeEventListener(type, this.interrupt, true);
    this.host.removeEventListener('scroll', this.onScroll); this.win.removeEventListener('blur', this.interrupt);
  }
}

// Convert viewport coordinates into the scroll container's CSS coordinates,
// including non-unit scale and borders. Parent containers never get scrolled.
export function outlineTargetTop(host: HTMLElement, target: Element, margin = 12, scale = host.getBoundingClientRect().height / host.offsetHeight) {
  if (!target.isConnected || !host.contains(target) || !Number.isFinite(scale) || scale <= 0) return null;
  return host.scrollTop + (target.getBoundingClientRect().top - host.getBoundingClientRect().top) / scale - host.clientTop - margin;
}

type SourceRequest = { head: number; doc: Text; selection: EditorSelection; focusEditor: boolean };
type SourceMotion = { motion: OutlineScrollMotion; pending: SourceRequest | null; request: SourceRequest | null; cancelled: SourceRequest | null };
const sources = new WeakMap<EditorView, SourceMotion>();
const sourceComposing = (view: EditorView) => view.composing || view.compositionStarted;
export function cancelSourceOutlineMotion(view: EditorView) {
  const state = sources.get(view); if (!state) return;
  if (state.pending) state.cancelled = state.pending;
  state.pending = state.request = null; state.motion.cancel();
}
export function scrollSourceOutline(view: EditorView, position: number, focusEditor = true) {
  if (sourceComposing(view) || position < 0 || position > view.state.doc.length) return false;
  cancelSourceOutlineMotion(view);
  let state = sources.get(view);
  if (!state) {
    const motion = new OutlineScrollMotion(view.scrollDOM, () => cancelSourceOutlineMotion(view));
    state = { motion, pending: null, request: null, cancelled: null }; sources.set(view, state);
  }
  state.cancelled = null;
  const selection = EditorSelection.create([EditorSelection.cursor(position, 1)]);
  state.pending = state.request = { head: position, doc: view.state.doc, selection, focusEditor };
  // CodeMirror first brings the real heading into its rendered viewport.
  // The scrollHandler below then measures its real coordinates. This avoids
  // guessing from line heights in long, virtualized documents.
  view.dispatch({ selection,
    effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 12 }),
    annotations: Transaction.addToHistory.of(false), userEvent: 'select.outline' });
  if (focusEditor) view.focus(); return true;
}
export const sourceOutlineScrollMotion = [
  EditorView.scrollHandler.of((view, range, options) => {
    const state = sources.get(view), request = state?.pending;
    // Input can interrupt between dispatch and CodeMirror's next measure.
    // Consume that queued outline target once, instead of letting the native
    // fallback jump after the user's wheel/keyboard action. Other destinations
    // and strategies retain their normal handling.
    if (state?.cancelled?.doc === view.state.doc && state.cancelled.head === range.head && options.y === 'start' && options.yMargin === 12) {
      state.cancelled = null; return true;
    }
    if (!state || !request || range.head !== request.head || options.y !== 'start' || options.yMargin !== 12 || request.doc !== view.state.doc) {
      cancelSourceOutlineMotion(view); return false;
    }
    state.pending = null;
    if (sourceComposing(view)) { cancelSourceOutlineMotion(view); return true; }
    if (outlineMotionReduced(view.scrollDOM)) { cancelSourceOutlineMotion(view); return false; }
    const margin = Math.max(0, ...view.state.facet(EditorView.scrollMargins).map(source => source(view)?.top || 0));
    const resolve = () => {
      if (state.request !== request || view.state.doc !== request.doc || sourceComposing(view) || !view.state.selection.eq(request.selection, true)) return null;
      const rect = view.coordsAtPos(request.head, range.assoc || 1), box = view.scrollDOM.getBoundingClientRect(), scale = view.scaleY;
      if (!rect || !Number.isFinite(scale) || scale <= 0) return null;
      return view.scrollDOM.scrollTop + (rect.top - box.top - margin - options.yMargin) / scale - view.scrollDOM.clientTop;
    };
    // A scrollHandler runs in CodeMirror's Updating write phase. Public
    // coordsAtPos/readMeasured are forbidden there. The measured line block
    // and documentTop are available without initiating a CM read/update.
    // Each subsequent RAF resolves the actual glyph position while CM is idle.
    const box = view.scrollDOM.getBoundingClientRect(), scale = view.scaleY;
    if (!Number.isFinite(scale) || scale <= 0) return false;
    const initial = view.scrollDOM.scrollTop + (view.documentTop + view.lineBlockAt(request.head).top - box.top - margin - options.yMargin) / scale - view.scrollDOM.clientTop;
    return state.motion.start(resolve, initial);
  }),
  EditorView.updateListener.of(update => {
    const state = sources.get(update.view), request = state?.request;
    if (state && update.docChanged) {
      for (const key of ['pending', 'cancelled'] as const) if (state[key]) state[key] = {
        ...state[key]!, head: EditorSelection.cursor(state[key]!.head).map(update.changes).head, doc: update.state.doc, selection: state[key]!.selection.map(update.changes),
      };
    }
    if (request && (update.docChanged || sourceComposing(update.view) || (update.focusChanged && request.focusEditor && !update.view.hasFocus) ||
        (update.selectionSet && !update.state.selection.eq(request.selection, true))))
      cancelSourceOutlineMotion(update.view);
  }),
  ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {}
    destroy() { const state = sources.get(this.view); state?.motion.destroy(); sources.delete(this.view); }
  }),
];
