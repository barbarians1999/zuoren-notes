import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { ChangeDesc, EditorState, Text } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { markdownMotionVisibilityKey } from './markdownLivePreview';
import { EditMotionGate, plainEdit, deletionGrapheme, shortHorizontalMove, EDIT_CARET_DURATION, DELETE_ECHO_DURATION, type EditInputType } from './editMotionPolicy';
import { pulseControl } from '../uiMotion';

const DURATION = 120;
const INDENT_RUN_DURATION = 190;
const DISTANT_CARET_DURATION = 80;
const MAX_DISTANCE = 88;
type Rect = { left: number; top: number; width: number; height: number };
type RunPosition = { element: HTMLElement; key: string; text: string; rect: Rect };
type FirstCaretMeasure = { head: number; from: Rect | null; formatChanged: boolean; runsBefore: RunPosition[]; runsGeometry: string; scrollTop: number; scrollLeft: number };
type SecondCaretMeasure = { head: number; from: Rect | null; to: Rect | null; runs: RunPosition[] | null; runsGeometry: string; scrollTop: number; scrollLeft: number; caretRelative: Rect | null; doc: Text; tree: ReturnType<typeof syntaxTree> };
type MotionMeasureRequest<T> = { key?: unknown; read(view: EditorView): T; write?(measure: T, view: EditorView): void };
type IndentMotionMeasure = { runs: RunPosition[]; geometry: string; caret: Rect | null; scrollTop: number; scrollLeft: number } | null;
type IndentMotionBaseline = { kind: 'input.indent' | 'delete.dedent'; doc: Text; tree: ReturnType<typeof syntaxTree>;
  selection: EditorState['selection']; runs: RunPosition[]; geometry: string; caret: Rect; scrollTop: number; scrollLeft: number };
type PointerRunBaseline = { doc: Text; tree: ReturnType<typeof syntaxTree>; selection: EditorState['selection'];
  runs: RunPosition[]; geometry: string; scrollTop: number; scrollLeft: number };
type PointerGesture = { x: number; y: number; moved: boolean; ended: boolean; candidate: { head: number; from: Rect; to: Rect; scrollTop: number; scrollLeft: number; generation: number } | null; held: { element: HTMLElement; transform: string; priority: string } | null };
type DeleteEcho = { from: number; to: number; text: string; rect: Rect; font: string; color: string; letterSpacing: string };
type EditCapture = { doc: Text; head: number; type: EditInputType; caret: Rect; origin: Rect; scaleX: number; scaleY: number;
  clientLeft: number; clientTop: number; geometry: string; scrollTop: number; scrollLeft: number; time: number; echo: DeleteEcho | null };

export function isSingleLeadingIndentChange(before: Text, after: Text, changes: ChangeDesc, kind: 'input.indent' | 'delete.dedent') {
  const ranges: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
  if (ranges.length !== 1) return false;
  const { fromA, toA, fromB, toB } = ranges[0];
  const oldLine = before.lineAt(fromA), newLine = after.lineAt(fromB);
  if (fromA !== oldLine.from || fromB !== newLine.from) return false;
  const oldIndent = /^[\t ]*/.exec(oldLine.text)![0], newIndent = /^[\t ]*/.exec(newLine.text)![0];
  if (!oldIndent && !newIndent || oldIndent === newIndent) return false;
  if (oldLine.text.slice(oldIndent.length) !== newLine.text.slice(newIndent.length)) return false;
  if (kind === 'input.indent') return newIndent === `\t${oldIndent}` && toA === fromA && toB === fromB + 1;
  const removedPrefixLength = oldIndent.length - newIndent.length;
  const prefixDelete = removedPrefixLength > 0 && oldIndent.slice(removedPrefixLength) === newIndent
    && toA === fromA + removedPrefixLength && toB === fromB;
  const wholeIndentRewrite = toA === fromA + oldIndent.length && toB === fromB + newIndent.length;
  return prefixDelete || wholeIndentRewrite;
}

export function mapMarkdownMotionRangeThroughChanges(from: number, to: number, changes: ChangeDesc, before: Text, after: Text) {
  if (to <= from) return null;
  let overlapsEdit = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA ? fromA >= from && fromA < to : fromA < to && toA > from) overlapsEdit = true;
  });
  if (overlapsEdit) return null;
  const mappedFrom = changes.mapPos(from, 1), mappedTo = changes.mapPos(to, -1);
  if (mappedTo <= mappedFrom || before.sliceString(from, to) !== after.sliceString(mappedFrom, mappedTo)) return null;
  return { from: mappedFrom, to: mappedTo, key: `${mappedFrom}:${mappedTo}` };
}

function indentUserEvent(update: ViewUpdate): 'input.indent' | 'delete.dedent' | null {
  if (update.transactions.length !== 1) return null;
  const transaction = update.transactions[0];
  return transaction.isUserEvent('input.indent') ? 'input.indent'
    : transaction.isUserEvent('delete.dedent') ? 'delete.dedent' : null;
}

function tableAtSelection(view: EditorView) {
  const tree = syntaxTree(view.state), head = view.state.selection.main.head;
  if (!syntaxTreeAvailable(view.state, head) || (head > 0 && !syntaxTreeAvailable(view.state, head - 1))) return true;
  for (const bias of [1, -1] as const) {
    for (let node = tree.resolveInner(head, bias); node; node = node.parent!) {
      if (node.name === 'Table') return true;
      if (/^(FencedCode|CodeBlock)$/.test(node.name)) break;
    }
  }
  return false;
}

function relativeCaretRect(view: EditorView): Rect | null {
  const origin = rectOf(view.contentDOM), caret = rectOf(view.dom.querySelector('.cm-cursor-primary'));
  return origin && caret ? { left: caret.left - origin.left, top: caret.top - origin.top, width: caret.width, height: caret.height } : null;
}

function rectOf(element: Element | null | undefined): Rect | null {
  if (!(element instanceof HTMLElement) || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width || rect.height ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
}

function reducedMotion(view: EditorView) {
  return view.dom.closest<HTMLElement>('.app')?.dataset.motion === 'reduced'
    || view.dom.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

function runPositions(view: EditorView): RunPosition[] {
  const origin = rectOf(view.contentDOM);
  if (!origin) return [];
  return [...view.contentDOM.querySelectorAll<HTMLElement>('[data-md-motion-key]')]
    .flatMap(element => { const run = runPosition(view, element, origin); return run ? [run] : []; });
}

function runPosition(view: EditorView, element: HTMLElement, origin = rectOf(view.contentDOM)): RunPosition | null {
  const bounds = rectOf(element), first = element.getClientRects?.()[0], key = element.dataset.mdMotionKey;
  // A wrapped inline element's union can stay fixed while its first line moves.
  const rect = first && (first.width || first.height) ? first : bounds;
  return origin && rect && key ? { element, key, text: element.textContent || '',
    rect: { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height } } : null;
}

function remapIndentMotionRuns(before: RunPosition[], after: RunPosition[]) {
  const ranges = new Map(before.map(run => [run, /^([0-9]+):([0-9]+)$/.exec(run.key)]));
  return after.map(run => {
    if (before.some(previous => previous.key === run.key)) return run;
    const current = /^([0-9]+):([0-9]+)$/.exec(run.key);
    if (!current) return run;
    const from = Number(current[1]), to = Number(current[2]);
    const contained = before.filter(previous => {
      const match = ranges.get(previous);
      if (!match) return false;
      const previousFrom = Number(match[1]), previousTo = Number(match[2]);
      return (from <= previousFrom && to >= previousTo) || (previousFrom <= from && previousTo >= to);
    });
    return contained.length === 1 ? { ...run, key: contained[0].key } : run;
  });
}
function runGeometry(view: EditorView) {
  return `${view.contentDOM.clientWidth}:${view.dom.style.getPropertyValue('--md-list-space-width')}`;
}

export function hasMovedIndentRun(before: RunPosition[], after: RunPosition[]) {
  return matchRunFragments(before, after).some(({ before: prior, after: next }) =>
    Math.hypot(next.rect.left - prior.rect.left, next.rect.top - prior.rect.top) >= 1);
}

export function matchRunFragments(before: RunPosition[], after: RunPosition[]) {
  const previous = new Map<string, RunPosition[]>(), used = new Map<string, number>();
  for (const run of before) {
    const identity = `${run.key}\0${run.text}`;
    previous.set(identity, [...(previous.get(identity) || []), run]);
  }
  return after.flatMap(run => {
    const identity = `${run.key}\0${run.text}`, candidates = previous.get(identity) || [], index = used.get(identity) || 0;
    used.set(identity, index + 1);
    return candidates[index] ? [{ before: candidates[index], after: run }] : [];
  });
}

type ListMarkerMotion = { key: string; from: number; to: number; mode: 'source-prefix' | 'source-body' };

export function listMarkerMotion(state: EditorState): ListMarkerMotion | null {
  const selection = state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty || state.readOnly) return null;
  const head = selection.main.head, tree = syntaxTree(state);
  for (const bias of [1, -1] as const) {
    for (let node = tree.resolveInner(head, bias); node; node = node.parent!) {
      if (node.name !== 'ListItem') continue;
      const marker = node.getChild('ListMark');
      if (!marker || node.getChild('Task')) return null;
      const line = state.doc.lineAt(marker.from);
      let end = marker.to;
      while (end < line.to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
      const inPrefix = marker.to === end ? head >= marker.from && head <= end : head >= marker.from && head < end;
      const orderedBody = node.parent?.name === 'OrderedList' && state.doc.lineAt(head).number === line.number;
      if (!inPrefix && !orderedBody) return null;
      const mode = inPrefix ? 'source-prefix' : 'source-body';
      return { key: `${marker.from}:${end}:${mode}`, from: marker.from, to: end, mode };
    }
  }
  return null;
}

class MotionController {
  private readonly editGate = new EditMotionGate();
  private editCapture: EditCapture | null = null;
  private indentMotionBaseline: IndentMotionBaseline | null = null;
  private pointerRunBaseline: PointerRunBaseline | null = null;
  private echoLayer: HTMLElement | null = null;
  private echoAnimation: Animation | null = null;
  private markerAnimation: Animation | null = null;
  private readonly markerAnimationKey = {};
  private markerGeneration = 0;
  private lastRuns: RunPosition[] = [];
  private lastRunGeometry = '';
  private lastCaretRect: Rect | null = null;
  private lastDoc: Text | null = null;
  private lastTree: ReturnType<typeof syntaxTree> | null = null;
  private pendingIndentMotion = false;
  private pendingFormatMotion = false;
  private lastScroll = { top: 0, left: 0 };
  private caretElement: HTMLElement | null = null;
  private caretAnimation: Animation | null = null;
  private runAnimations = new Map<HTMLElement, Animation>();
  private taskPulse: (() => void) | null = null;
  private generation = 0;
  private baselineGeneration = 0;
  private readonly baselineKey = {};
  private pointerGesture: PointerGesture | null = null;
  private motionPreferenceObserver: MutationObserver | null = null;
  private motionPreferenceQuery: MediaQueryList | null = null;
  private imageResizeObserver: ResizeObserver | null = null;
  private imageMutationObserver: MutationObserver | null = null;
  private observedImages = new Set<HTMLImageElement>();

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Node) || !this.view.dom.contains(event.target)) return;
    this.pointerRunBaseline = null;
    if (this.editMotionEnabled()) { this.cancelMotion(); this.pointerGesture = null; }
    const view = this.view, state = view.state, selection = state.selection;
    const target = event.target instanceof HTMLElement ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const editableTarget = !!target && view.contentDOM.contains(event.target as Node)
      && !target.closest('input,textarea,button,[contenteditable="false"],.cm-widgetBuffer');
    if (editableTarget && !state.readOnly && selection.ranges.length === 1 && selection.main.empty
      && !view.composing && !view.compositionStarted && !reducedMotion(view)) {
      // Capture all visible runs: selection can start on a delimiter, trailing
      // whitespace or line area that has no motion-run element of its own.
      this.cancelMotion(); this.captureScroll();
      const runs = runPositions(view);
      if (runs.length) this.pointerRunBaseline = { doc: state.doc, tree: syntaxTree(state), selection, runs,
        geometry: runGeometry(view), scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft };
    }
    if (this.pointerGesture) this.releasePointerHold(this.pointerGesture);
    this.pointerGesture = { x: event.clientX, y: event.clientY, moved: false, ended: false, candidate: null, held: null };
  };
  private readonly onMouseMove = (event: MouseEvent) => {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.ended || !(event.buttons & 1)) return;
    if (!gesture.moved && Math.max(Math.abs(event.clientX - gesture.x), Math.abs(event.clientY - gesture.y)) >= 10) {
      gesture.moved = true; gesture.candidate = null; this.pointerRunBaseline = null;
      this.cancelMotion(); this.captureScroll();
    }
  };
  private readonly onMouseUp = (event: MouseEvent) => {
    const gesture = this.pointerGesture;
    if (!gesture || event.button !== 0 || gesture.ended) return;
    gesture.ended = true;
    this.commitPointerCaret(gesture);
  };
  private readonly onScroll = () => {
    this.taskPulse?.(); this.taskPulse = null;
    const gesture = this.pointerGesture;
    if (gesture?.held) { gesture.candidate = null; this.releasePointerHold(gesture); }
    if (this.pendingIndentMotion || this.pendingFormatMotion || this.runAnimations.size || this.caretAnimation || this.echoAnimation || this.markerAnimation || this.editCapture || this.indentMotionBaseline || this.pointerRunBaseline) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
    }
  };
  private readonly onWindowBlur = () => {
    this.taskPulse?.(); this.taskPulse = null;
    if (this.pointerGesture) this.releasePointerHold(this.pointerGesture);
    this.pointerGesture = null;
    if (this.pendingIndentMotion || this.pendingFormatMotion || this.runAnimations.size || this.caretAnimation || this.echoAnimation || this.markerAnimation || this.editCapture || this.indentMotionBaseline || this.pointerRunBaseline) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
    }
  };
  private readonly onMotionPreferenceChanged = () => { this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); };
  private now() { return this.view.dom.ownerDocument.defaultView?.performance.now() ?? Date.now(); }
  private editMotionEnabled() { return this.view.dom.closest<HTMLElement>('.app')?.dataset.editMotion === 'soft'; }
  private readonly onCompositionStart = () => { this.editGate.compositionStart(this.now()); this.cancelMotion(); };
  private readonly onCompositionEnd = () => { this.editGate.compositionEnd(this.now()); this.cancelMotion(); this.scheduleBaseline(); };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') this.captureIndentMotionBaseline(event);
    else this.indentMotionBaseline = null;
    if (!this.editMotionEnabled()) return;
    if (event.repeat) { this.editGate.repeat(this.now()); this.cancelMotion(); }
    else if (event.key === 'Enter' || event.key === 'Escape') this.cancelMotion();
    else if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      // CodeMirror's desktop keymap often deletes in keydown and suppresses
      // beforeinput. Observe before that command, without handling the key.
      this.captureEditInput(event.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward', event.isComposing, false);
    }
  };
  private captureIndentMotionBaseline(event: KeyboardEvent) {
    const view = this.view, state = view.state, selection = state.selection;
    const target = event.target as Node | null;
    if (event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
      || view.composing || view.compositionStarted || state.readOnly || !view.hasFocus || reducedMotion(view)
      || selection.ranges.length !== 1 || !selection.main.empty || !target || !view.contentDOM.contains(target)
      || (target instanceof HTMLElement && target.closest('input,textarea,button,[contenteditable="false"],.cm-widgetBuffer'))
      || tableAtSelection(view)) { this.indentMotionBaseline = null; return; }
    const kind = event.shiftKey ? 'delete.dedent' : 'input.indent';
    this.cancelMotion(); this.captureScroll();
    try {
      const runs = runPositions(view), caret = relativeCaretRect(view);
      if (!runs.length || !caret) { this.scheduleBaseline(); return; }
      this.indentMotionBaseline = { kind, doc: state.doc, tree: syntaxTree(state), selection,
        runs, geometry: runGeometry(view), caret, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft };
    } catch { this.scheduleBaseline(); }
  }
  private readonly onBeforeInput = (event: InputEvent) => this.captureEditInput(event.inputType, event.isComposing, true);
  private captureEditInput(inputType: string, composing: boolean, nativeBeforeInput: boolean) {
    if (!this.editMotionEnabled()) return;
    const view = this.view, now = this.now(), prior = this.editCapture;
    // Some platforms emit both events for the same deletion. Keep one capture
    // and one cadence sample, not a false rapid-input cancellation.
    if (nativeBeforeInput && prior && inputType !== 'insertText' && prior.type === inputType && prior.doc === view.state.doc
        && prior.head === view.state.selection.main.head && now - prior.time < 120 && !composing && !view.composing
        && !view.compositionStarted && !reducedMotion(view)) return;
    try {
      const allowed = inputType === 'insertText' || inputType === 'deleteContentBackward' || inputType === 'deleteContentForward';
      const eligibleInput = allowed && !composing && !view.composing && !view.compositionStarted && !reducedMotion(view)
        && view.hasFocus && view.state.selection.ranges.length === 1 && view.state.selection.main.empty
        && Number.isFinite(view.scaleX) && view.scaleX > 0 && Number.isFinite(view.scaleY) && view.scaleY > 0
        && this.editGate.accept(now);
      const caret = eligibleInput ? rectOf(view.dom.querySelector('.cm-cursor-primary')) : null;
      const origin = eligibleInput ? rectOf(view.dom) : null;
      const eligible = eligibleInput && !!caret && !!origin;
      const echo = eligible && inputType !== 'insertText' && view.dom.closest<HTMLElement>('.app')?.dataset.deleteEcho === 'on'
        ? this.captureDeleteEcho(inputType === 'deleteContentForward') : null;
      this.cancelMotion();
      if (eligible) this.editCapture = { doc: view.state.doc, head: view.state.selection.main.head, type: inputType as EditInputType,
        caret: caret!, origin: origin!, scaleX: view.scaleX, scaleY: view.scaleY, clientLeft: view.dom.clientLeft, clientTop: view.dom.clientTop,
        geometry: runGeometry(view), scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft, time: now, echo };
    } catch { this.cancelMotion(); } // Presentation must never cancel or dispatch an input event.
  }

  constructor(private readonly view: EditorView) {
    this.lastScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    view.dom.addEventListener('mousedown', this.onMouseDown, true);
    view.dom.addEventListener('beforeinput', this.onBeforeInput as EventListener, true);
    view.dom.addEventListener('keydown', this.onKeyDown, true);
    view.dom.addEventListener('compositionstart', this.onCompositionStart, true);
    view.dom.addEventListener('compositionend', this.onCompositionEnd, true);
    view.dom.ownerDocument.addEventListener('mousemove', this.onMouseMove, true);
    view.dom.ownerDocument.addEventListener('mouseup', this.onMouseUp, true);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    const window = view.dom.ownerDocument.defaultView;
    if (window?.ResizeObserver) {
      this.imageResizeObserver = new window.ResizeObserver(() => {
        this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
      });
      this.observeImageTree(view.contentDOM);
      if (window.MutationObserver) {
        this.imageMutationObserver = new window.MutationObserver(records => {
          for (const record of records) {
            for (const node of record.removedNodes) this.unobserveImageTree(node);
            for (const node of record.addedNodes) this.observeImageTree(node);
          }
        });
        this.imageMutationObserver.observe(view.contentDOM, { childList: true, subtree: true });
      }
    }
    window?.addEventListener('blur', this.onWindowBlur);
    const app = view.dom.closest<HTMLElement>('.app');
    if (app && window?.MutationObserver) {
      this.motionPreferenceObserver = new window.MutationObserver(this.onMotionPreferenceChanged);
      this.motionPreferenceObserver.observe(app, { attributes: true, attributeFilter: ['data-motion', 'data-edit-motion', 'data-delete-echo'] });
    }
    this.motionPreferenceQuery = window?.matchMedia('(prefers-reduced-motion: reduce)') || null;
    this.motionPreferenceQuery?.addEventListener('change', this.onMotionPreferenceChanged);
    this.scheduleBaseline();
  }

  update(update: ViewUpdate) {
    const capturedIndent = this.indentMotionBaseline, updateIndent = indentUserEvent(update);
    if (capturedIndent && (capturedIndent.kind !== updateIndent || capturedIndent.doc !== update.startState.doc
      || capturedIndent.tree !== syntaxTree(update.startState) || !capturedIndent.selection.eq(update.startState.selection, true))) {
      this.indentMotionBaseline = null;
    }
    const pointerSelection = update.transactions.some(transaction => transaction.isUserEvent('select.pointer'));
    const pointerBaseline = this.pointerRunBaseline;
    const pointerFocusChange = update.focusChanged && !update.docChanged && !update.selectionSet
      && !!this.pointerGesture && !this.pointerGesture.moved;
    if (pointerBaseline && ((!pointerSelection && !pointerFocusChange) || update.docChanged || pointerBaseline.doc !== update.startState.doc
      || pointerBaseline.tree !== syntaxTree(update.startState) || !pointerBaseline.selection.eq(update.startState.selection, true)
      || update.state.readOnly || update.state.selection.ranges.length !== 1 || !update.state.selection.main.empty
      || !update.view.hasFocus || update.view.composing || update.view.compositionStarted || reducedMotion(update.view)
      || pointerBaseline.geometry !== runGeometry(update.view) || pointerBaseline.scrollTop !== update.view.scrollDOM.scrollTop
      || pointerBaseline.scrollLeft !== update.view.scrollDOM.scrollLeft)) this.pointerRunBaseline = null;
    if (update.state.readOnly) { this.taskPulse?.(); this.taskPulse = null; }
    if ((update.docChanged || update.selectionSet || update.focusChanged) && !update.transactions.some(tr => tr.isUserEvent('input.task'))) { this.taskPulse?.(); this.taskPulse = null; }
    const view = update.view, selection = update.state.selection;
    if (update.transactions.some(transaction => transaction.isUserEvent('select.outline'))) {
      // Give scrolling sole ownership before the first moving frame; browser
      // scroll events may arrive after a caret transform has already painted.
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); return;
    }
    // CM starts composition before its first text-changing transaction.
    // Keep its native caret/format geometry throughout that early window.
    if (view.composing || view.compositionStarted) { this.cancelMotion(); this.captureScroll(); return; }
    // Once a native pointer gesture becomes a drag, let CodeMirror own every
    // selection frame. The threshold handler has already cancelled stale
    // visual motion; repeating cancelMotion here would invalidate two measure
    // queues and cancel animations for every mousemove during range selection.
    if (!update.docChanged && pointerSelection && this.pointerGesture?.moved) {
      this.captureScroll();
      return;
    }
    if (update.docChanged && this.tryTaskMotion(update)) return;
    if (update.docChanged && this.tryEditMotion(update)) return;
    if (this.editMotionEnabled() && !update.docChanged && update.selectionSet) {
      this.editCapture = null; this.clearDeleteEcho();
      // A wrap/bidi association can move the visible cursor while head stays
      // unchanged. Never carry an old transform into that new native position.
      if (selection.main.head === update.startState.selection.main.head && !selection.eq(update.startState.selection, true)) {
        this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); return;
      }
    }
    if (this.editMotionEnabled() && update.transactions.some(transaction => transaction.isUserEvent('select.pointer'))) {
      this.cancelCaretAnimation(); this.editCapture = null; this.clearDeleteEcho();
    }
    this.tryListMarkerMotion(update);
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (!update.docChanged && treeChanged) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
      return;
    }
    // Images/fonts can move runs without changing the width. Once motion's
    // own measure cycle has settled, a layout-only notification invalidates
    // the baseline. Keep geometry reports from a pending format change so
    // its final read can observe the intended new layout.
    const independentGeometry = update.geometryChanged && !update.docChanged && !update.selectionSet && !update.focusChanged
      && !this.pendingFormatMotion && !this.pendingIndentMotion;
    if (update.geometryChanged && (independentGeometry || runGeometry(view) !== this.lastRunGeometry)) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
      return;
    }
    // CodeMirror may report the layout caused by this Tab between our read
    // and write. Only a real input/focus/selection change supersedes it;
    // the scheduled write still checks the exact document, tree and selection.
    if (this.pendingIndentMotion && (update.docChanged || update.selectionSet || update.focusChanged)
      && !(update.docChanged && indentUserEvent(update))) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
      return;
    }
    if (!update.selectionSet && !update.docChanged && !update.focusChanged) return;
    if (this.tryIndentMotion(update)) return;
    const eligible = !update.docChanged && view.hasFocus && !view.composing && !view.compositionStarted && !reducedMotion(view)
      && selection.ranges.length === 1 && selection.main.empty;
    if (!eligible) {
      this.cancelMotion();
      if (update.docChanged && view.hasFocus && !view.composing && !view.compositionStarted && !reducedMotion(view)
        && selection.ranges.length === 1 && selection.main.empty) this.scheduleBaseline();
      else if (view.composing || view.compositionStarted || selection.ranges.length !== 1 || !selection.main.empty) this.lastRuns = [];
      this.captureScroll();
      return;
    }
    // A focus/selection interruption can clear the text baseline. Restore it
    // even when focus and selection arrive together (or the head stays put).
    // Merely checking for a run does not read layout, and a valid baseline
    // keeps ordinary arrows on the geometry-free path.
    const missingRunBaseline = !this.lastRuns.length && !!view.contentDOM.querySelector('[data-md-motion-key]');
    if (update.focusChanged || missingRunBaseline) this.scheduleBaseline();
    if (!update.selectionSet) { this.captureScroll(); return; }

    const fromHead = update.startState.selection.main.head, head = selection.main.head;
    if (fromHead === head) return;
    const livePointerBaseline = pointerSelection ? this.pointerRunBaseline : null;
    if ((view.scrollDOM.scrollTop !== this.lastScroll.top || view.scrollDOM.scrollLeft !== this.lastScroll.left) && !livePointerBaseline) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
      return;
    }
    const formatChanged = markdownMotionVisibilityKey(update.startState) !== markdownMotionVisibilityKey(update.state);
    this.pointerRunBaseline = null;
    const pointerGesture = pointerSelection ? this.pointerGesture : null;
    const scrollTop = view.scrollDOM.scrollTop, scrollLeft = view.scrollDOM.scrollLeft;
    const runsBefore = livePointerBaseline && formatChanged
      ? livePointerBaseline.runs
      : this.lastRuns;
    const generation = ++this.generation;
    this.pendingFormatMotion = formatChanged;
    const request: MotionMeasureRequest<FirstCaretMeasure> = {
      key: this,
      read: measuringView => {
        const caret = measuringView.dom.querySelector<HTMLElement>('.cm-cursor-primary');
        const from = rectOf(caret);
        return { head, from, formatChanged, runsBefore, runsGeometry: livePointerBaseline?.geometry ?? this.lastRunGeometry, scrollTop, scrollLeft };
      },
      write: first => {
        if (generation !== this.generation) return;
        if (view.composing || view.compositionStarted) { this.cancelMotion(); this.captureScroll(); return; }
        if (view.state.selection.main.head !== first.head || !view.hasFocus || view.composing || view.compositionStarted || reducedMotion(view)) { this.pendingFormatMotion = false; return; }
        const scrollStable = view.scrollDOM.scrollTop === first.scrollTop && view.scrollDOM.scrollLeft === first.scrollLeft;
        if (!scrollStable) { this.pendingFormatMotion = false; this.cancelCaretAnimation(); this.captureScroll(); this.scheduleBaseline(); return; }

        // The cursor layer's own requestMeasure write runs before this request.
        // Invalidate the prior path only after saving the old visual rect in the read phase.
        this.cancelCaretAnimation();
        const finalRequest: MotionMeasureRequest<SecondCaretMeasure> = {
          key: this,
          read: measuringView => {
            const caret = measuringView.dom.querySelector<HTMLElement>('.cm-cursor-primary');
            const to = rectOf(caret);
            const runs = first.formatChanged ? runPositions(measuringView) : null;
            return { head: first.head, from: first.from, to, runs, runsGeometry: runGeometry(measuringView), scrollTop: first.scrollTop, scrollLeft: first.scrollLeft,
              caretRelative: relativeCaretRect(measuringView), doc: measuringView.state.doc, tree: syntaxTree(measuringView.state) };
          },
          write: final => {
            if (generation !== this.generation) return;
            this.pendingFormatMotion = false;
            if (view.composing || view.compositionStarted) { this.cancelMotion(); this.captureScroll(); return; }
            if (view.state.selection.main.head !== final.head || view.state.doc !== final.doc
              || syntaxTree(view.state) !== final.tree || !view.hasFocus || view.composing || view.compositionStarted || reducedMotion(view)) return;
            this.lastCaretRect = final.caretRelative; this.lastDoc = final.doc; this.lastTree = final.tree;
            const caret = view.dom.querySelector<HTMLElement>('.cm-cursor-primary');
            const stable = view.scrollDOM.scrollTop === final.scrollTop && view.scrollDOM.scrollLeft === final.scrollLeft;
            const distance = final.from && final.to ? Math.hypot(final.from.left - final.to.left, final.from.top - final.to.top) : Infinity;
            const eligibleCaret = (!this.editMotionEnabled() || !pointerSelection) && !!caret && stable && !!final.from && !!final.to && distance >= 1
              && (distance <= MAX_DISTANCE || pointerSelection);
            if (eligibleCaret && distance > MAX_DISTANCE) {
              if (pointerGesture && pointerGesture === this.pointerGesture) {
                pointerGesture.candidate = { head: final.head, from: final.from!, to: final.to!, scrollTop: final.scrollTop,
                  scrollLeft: final.scrollLeft, generation };
                if (!pointerGesture.ended && !pointerGesture.moved) this.holdPointerCaret(pointerGesture, caret!, final.from!, final.to!);
                this.commitPointerCaret(pointerGesture);
              }
            } else if (eligibleCaret) this.startCaret(caret!, final.from!, final.to!, DURATION);
            else this.cancelCaretAnimation();
            if (first.formatChanged && stable && final.runs) {
              if (first.runsGeometry === final.runsGeometry) this.animateRuns(first.runsBefore, final.runs);
              else this.cancelRunAnimations();
              this.lastRuns = final.runs; this.lastRunGeometry = final.runsGeometry;
            }
            if (!stable) this.scheduleBaseline();
            this.captureScroll();
          },
        };
        view.requestMeasure(finalRequest);
      },
    };
    view.requestMeasure(request);
  }

  private observeImageTree(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const images = [...(element.matches('.cm-md-image') && element instanceof HTMLImageElement ? [element] : []),
      ...element.querySelectorAll<HTMLImageElement>('.cm-md-image')];
    for (const image of images) {
      if (this.observedImages.has(image)) continue;
      this.observedImages.add(image); this.imageResizeObserver?.observe(image);
    }
  }

  private unobserveImageTree(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const images = [...(element.matches('.cm-md-image') && element instanceof HTMLImageElement ? [element] : []),
      ...element.querySelectorAll<HTMLImageElement>('.cm-md-image')];
    for (const image of images) {
      if (!this.observedImages.delete(image)) continue;
      this.imageResizeObserver?.unobserve(image);
    }
  }

  destroy() {
    this.imageMutationObserver?.disconnect(); this.imageMutationObserver = null;
    this.imageResizeObserver?.disconnect(); this.imageResizeObserver = null; this.observedImages.clear();
    this.view.dom.removeEventListener('mousedown', this.onMouseDown, true);
    this.view.dom.removeEventListener('beforeinput', this.onBeforeInput as EventListener, true);
    this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
    this.view.dom.removeEventListener('compositionstart', this.onCompositionStart, true);
    this.view.dom.removeEventListener('compositionend', this.onCompositionEnd, true);
    this.view.dom.ownerDocument.removeEventListener('mousemove', this.onMouseMove, true);
    this.view.dom.ownerDocument.removeEventListener('mouseup', this.onMouseUp, true);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.onWindowBlur);
    this.motionPreferenceObserver?.disconnect(); this.motionPreferenceObserver = null;
    this.motionPreferenceQuery?.removeEventListener('change', this.onMotionPreferenceChanged); this.motionPreferenceQuery = null;
    if (this.pointerGesture) this.releasePointerHold(this.pointerGesture);
    this.pointerGesture = null;
    this.invalidatePending(); this.cancelCaretAnimation(); this.cancelRunAnimations(); this.cancelMarkerAnimation(); this.taskPulse?.(); this.taskPulse = null; this.clearDeleteEcho(); this.editCapture = null; this.indentMotionBaseline = null; this.pointerRunBaseline = null;
  }

  private captureDeleteEcho(forward: boolean): DeleteEcho | null {
    const view = this.view, candidate = deletionGrapheme(view.state, forward);
    if (!candidate) return null;
    const start = view.domAtPos(candidate.from), end = view.domAtPos(candidate.to);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const rects = [...range.getClientRects()];
    if (range.toString() !== candidate.text || rects.length !== 1 || rects[0].width < .5) return null;
    const element = start.node instanceof HTMLElement ? start.node : start.node.parentElement;
    if (!element || element.closest('[contenteditable="false"], .cm-widgetBuffer')) return null;
    const style = getComputedStyle(element), rect = rects[0];
    return { ...candidate, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      font: style.font, color: style.color, letterSpacing: style.letterSpacing };
  }

  private tryEditMotion(update: ViewUpdate) {
    const capture = this.editCapture; this.editCapture = null;
    if (!capture || !this.editMotionEnabled() || reducedMotion(update.view) || update.view.composing || update.view.compositionStarted
        || capture.doc !== update.startState.doc || capture.head !== update.startState.selection.main.head || this.now() - capture.time > 120) return false;
    const edit = plainEdit(update.startState, update.state, update.transactions, update.changes, capture.type);
    if (!edit) return false;
    const view = update.view, doc = update.state.doc, selection = update.state.selection;
    this.cancelMotion();
    const generation = this.generation;
    view.requestMeasure({ key: this,
      read: measuringView => {
        const caret = measuringView.dom.querySelector<HTMLElement>('.cm-cursor-primary');
        const to = measuringView.coordsAtPos(selection.main.head, selection.main.assoc || 1);
        const origin = rectOf(measuringView.dom);
        return { caret, to, origin, scaleX: measuringView.scaleX, scaleY: measuringView.scaleY,
          clientLeft: measuringView.dom.clientLeft, clientTop: measuringView.dom.clientTop,
          geometry: runGeometry(measuringView), count: measuringView.dom.querySelectorAll('.cm-cursor').length };
      },
      write: result => {
        if (generation !== this.generation || !result.caret?.isConnected || !result.to || !result.origin || result.count !== 1
            || view.state.doc !== doc || !view.state.selection.eq(selection, true) || !view.hasFocus || view.composing || view.compositionStarted
            || !this.editMotionEnabled() || reducedMotion(view) || capture.geometry !== result.geometry
            || capture.scaleX !== result.scaleX || capture.scaleY !== result.scaleY
            || capture.clientLeft !== result.clientLeft || capture.clientTop !== result.clientTop
            || Math.abs(capture.origin.left - result.origin.left) > .5 || Math.abs(capture.origin.top - result.origin.top) > .5
            || Math.abs(capture.origin.width - result.origin.width) > .5 || Math.abs(capture.origin.height - result.origin.height) > .5
            || view.scrollDOM.scrollTop !== capture.scrollTop || view.scrollDOM.scrollLeft !== capture.scrollLeft) return;
        const to = { left: result.to.left, top: result.to.top, width: 1, height: result.to.bottom - result.to.top };
        if (!shortHorizontalMove(capture.caret, to, true)) { this.scheduleBaseline(); return; }
        try {
          if (shortHorizontalMove(capture.caret, to)) this.startCaret(result.caret, { ...capture.caret, top: to.top }, to, EDIT_CARET_DURATION);
          const caretAnimation = this.caretAnimation;
          if (caretAnimation) {
            const finish = caretAnimation.onfinish;
            caretAnimation.onfinish = event => { finish?.call(caretAnimation, event); if (generation === this.generation) this.scheduleBaseline(); };
          }
          const echo = capture.echo;
          if (echo && echo.from === edit.fromA && echo.to === edit.toA && view.dom.closest<HTMLElement>('.app')?.dataset.deleteEcho === 'on') {
            const layer = view.dom.ownerDocument.createElement('div');
            layer.className = 'cm-edit-echo-layer'; layer.setAttribute('aria-hidden', 'true');
            const ghost = view.dom.ownerDocument.createElement('span'); ghost.className = 'cm-edit-echo'; ghost.textContent = echo.text;
            Object.assign(ghost.style, { left: `${(echo.rect.left - result.origin.left) / result.scaleX - result.clientLeft}px`,
              top: `${(echo.rect.top - result.origin.top) / result.scaleY - result.clientTop}px`,
              font: echo.font, color: echo.color, letterSpacing: echo.letterSpacing, lineHeight: `${echo.rect.height / result.scaleY}px` });
            layer.append(ghost); view.dom.append(layer); this.echoLayer = layer;
            const animation = ghost.animate([{ opacity: .32, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(.65px)' }],
              { duration: DELETE_ECHO_DURATION, easing: 'ease-out' });
            this.echoAnimation = animation;
            animation.onfinish = () => { if (this.echoAnimation === animation) this.clearDeleteEcho(); };
          }
        } catch { this.cancelCaretAnimation(); this.clearDeleteEcho(); }
        this.captureScroll(); this.scheduleBaseline();
      },
    });
    return true;
  }

  private clearDeleteEcho() { const animation = this.echoAnimation; this.echoAnimation = null; animation?.cancel(); this.echoLayer?.remove(); this.echoLayer = null; }

  private commitPointerCaret(gesture: PointerGesture) {
    const candidate = gesture.candidate, view = this.view;
    if (!gesture.ended || !candidate) return;
    gesture.candidate = null;
    if (gesture.moved || gesture !== this.pointerGesture || candidate.generation !== this.generation
      || view.state.selection.main.head !== candidate.head || !view.state.selection.main.empty || !view.hasFocus
      || view.composing || view.compositionStarted || reducedMotion(view) || view.scrollDOM.scrollTop !== candidate.scrollTop
      || view.scrollDOM.scrollLeft !== candidate.scrollLeft) { this.releasePointerHold(gesture); return; }
    const caret = view.dom.querySelector<HTMLElement>('.cm-cursor-primary');
    this.releasePointerHold(gesture);
    if (caret?.isConnected) this.startCaret(caret, candidate.from, candidate.to, DISTANT_CARET_DURATION);
    this.pointerGesture = null;
  }

  private holdPointerCaret(gesture: PointerGesture, caret: HTMLElement, from: Rect, to: Rect) {
    this.releasePointerHold(gesture);
    gesture.held = { element: caret, transform: caret.style.getPropertyValue('transform'), priority: caret.style.getPropertyPriority('transform') };
    caret.style.setProperty('transform', `translate(${from.left - to.left}px, ${from.top - to.top}px)`);
  }

  private releasePointerHold(gesture: PointerGesture) {
    const held = gesture.held; gesture.held = null;
    if (!held) return;
    if (held.transform) held.element.style.setProperty('transform', held.transform, held.priority);
    else held.element.style.removeProperty('transform');
  }

  private scheduleBaseline() {
    const generation = ++this.baselineGeneration;
    this.view.requestMeasure({ key: this.baselineKey,
      read: view => ({ runs: runPositions(view), geometry: runGeometry(view), caret: relativeCaretRect(view), doc: view.state.doc, tree: syntaxTree(view.state) }),
      write: result => {
        if (generation !== this.baselineGeneration) return;
        if (this.view.state.doc !== result.doc || syntaxTree(this.view.state) !== result.tree) { this.scheduleBaseline(); return; }
        this.lastRuns = result.runs; this.lastRunGeometry = result.geometry; this.lastCaretRect = result.caret;
        this.lastDoc = result.doc; this.lastTree = result.tree;
      },
    });
  }

  private tryIndentMotion(update: ViewUpdate) {
    const kind = indentUserEvent(update), view = update.view, selection = update.state.selection;
    const captured = this.indentMotionBaseline; this.indentMotionBaseline = null;
    const startTree = syntaxTree(update.startState);
    const capturedMatches = !!captured && captured.kind === kind && captured.doc === update.startState.doc
      && captured.tree === startTree && captured.selection.eq(update.startState.selection, true)
      && captured.geometry === runGeometry(view) && captured.scrollTop === view.scrollDOM.scrollTop
      && captured.scrollLeft === view.scrollDOM.scrollLeft;
    if (!kind || !update.docChanged || !update.selectionSet || !view.hasFocus || view.composing || view.compositionStarted || reducedMotion(view)
      || selection.ranges.length !== 1 || !selection.main.empty) return false;
    const targetTree = syntaxTree(update.state);
    if (this.pendingIndentMotion || this.caretAnimation?.playState === 'running' || this.runAnimations.size > 0
      || (!capturedMatches && (this.lastDoc !== update.startState.doc || this.lastTree !== startTree || !this.lastRuns.length || !this.lastCaretRect))
      || (!capturedMatches && this.lastRunGeometry !== runGeometry(view))
      || (!capturedMatches && (view.scrollDOM.scrollTop !== this.lastScroll.top || view.scrollDOM.scrollLeft !== this.lastScroll.left))
      || !isSingleLeadingIndentChange(update.startState.doc, update.state.doc, update.changes, kind)) return false;

    const beforeRuns = capturedMatches ? captured!.runs : this.lastRuns;
    const beforeCaret = capturedMatches ? captured!.caret : this.lastCaretRect!;
    const beforeGeometry = capturedMatches ? captured!.geometry : this.lastRunGeometry;
    const beforeScroll = capturedMatches ? { top: captured!.scrollTop, left: captured!.scrollLeft } : { top: this.lastScroll.top, left: this.lastScroll.left };
    const mappedBefore: RunPosition[] = [];
    for (const run of beforeRuns) {
      const match = /^(\d+):(\d+)$/.exec(run.key);
      if (!match) continue;
      const mapped = mapMarkdownMotionRangeThroughChanges(Number(match[1]), Number(match[2]), update.changes, update.startState.doc, update.state.doc);
      if (mapped) mappedBefore.push({ ...run, key: mapped.key });
    }
    if (!mappedBefore.length) return false;

    const generation = ++this.generation, targetDoc = update.state.doc, targetSelection = update.state.selection;
    this.pendingFormatMotion = false; this.pendingIndentMotion = true;
    const measuredBeforeRuns = mappedBefore;
    view.requestMeasure({ key: this,
      read: measuringView => {
        if (measuringView.state.doc !== targetDoc || !measuringView.state.selection.eq(targetSelection)
          || syntaxTree(measuringView.state) !== targetTree) return null;
        return { runs: runPositions(measuringView), geometry: runGeometry(measuringView), caret: relativeCaretRect(measuringView),
          scrollTop: measuringView.scrollDOM.scrollTop, scrollLeft: measuringView.scrollDOM.scrollLeft } satisfies IndentMotionMeasure;
      },
      write: (result: IndentMotionMeasure) => {
        if (generation !== this.generation) return;
        this.pendingIndentMotion = false;
        const stable = !!result && result.geometry === beforeGeometry && result.scrollTop === beforeScroll.top
          && result.scrollLeft === beforeScroll.left && view.state.doc === targetDoc && view.state.selection.eq(targetSelection)
          && syntaxTree(view.state) === targetTree && view.hasFocus && !view.composing && !view.compositionStarted && !reducedMotion(view);
        if (!stable || !result?.caret) { this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); return; }

        const afterRuns = remapIndentMotionRuns(measuredBeforeRuns, result.runs);
        const hasMovedRun = hasMovedIndentRun(measuredBeforeRuns, afterRuns);
        const caret = view.dom.querySelector<HTMLElement>('.cm-cursor-primary');
        const caretDistance = Math.hypot(beforeCaret.left - result.caret.left, beforeCaret.top - result.caret.top);
        if (!caret || !hasMovedRun) {
          this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); return;
        }

        this.animateRuns(measuredBeforeRuns, afterRuns, INDENT_RUN_DURATION, true);
        if (caretDistance >= 1 && caretDistance <= MAX_DISTANCE) this.startCaret(caret, beforeCaret, result.caret, DURATION);
        else this.cancelCaretAnimation();
        this.lastRuns = result.runs; this.lastRunGeometry = result.geometry; this.lastCaretRect = result.caret;
        this.lastDoc = targetDoc; this.lastTree = targetTree; this.captureScroll();
      },
    });
    return true;
  }

  private tryListMarkerMotion(update: ViewUpdate) {
    if (!update.selectionSet || update.docChanged) { if (update.docChanged) this.cancelMarkerAnimation(); return; }
    const before = listMarkerMotion(update.startState), after = listMarkerMotion(update.state);
    if (before?.key === after?.key) return;
    this.cancelMarkerAnimation();
    const view = update.view;
    if (!before && !after || update.state.readOnly || update.state.selection.ranges.length !== 1 || !update.state.selection.main.empty
      || !view.hasFocus || view.composing || view.compositionStarted || reducedMotion(view)) return;
    const marker = after || before!, mode = after?.mode || 'widget', generation = this.markerGeneration;
    const selector = mode === 'source-prefix' ? '.cm-md-list-prefix'
      : mode === 'source-body' ? '.cm-md-ordered-marker' : '.cm-md-list-marker';
    const doc = view.state.doc, tree = syntaxTree(view.state), selection = view.state.selection;
    view.requestMeasure({ key: this.markerAnimationKey,
      read: measuringView => {
        if (generation !== this.markerGeneration || measuringView.state.doc !== doc || syntaxTree(measuringView.state) !== tree
          || !measuringView.state.selection.eq(selection) || !measuringView.dom.isConnected) return null;
        const source = measuringView.coordsAtPos(marker.from, 1);
        if (!source) return null;
        const candidates = [...measuringView.contentDOM.querySelectorAll<HTMLElement>(selector)].flatMap(element => {
          const rect = rectOf(element);
          return rect ? [{ element, score: Math.abs(rect.top - source.top) + Math.abs(rect.left - source.left) }] : [];
        });
        return candidates.sort((left, right) => left.score - right.score)[0]?.element || null;
      },
      write: element => {
        if (generation !== this.markerGeneration || !element?.isConnected || view.state.doc !== doc
          || syntaxTree(view.state) !== tree || !view.state.selection.eq(selection) || !view.hasFocus
          || view.composing || view.compositionStarted || reducedMotion(view)) return;
        try {
          const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 115, easing: 'cubic-bezier(.2,.75,.3,1)' });
          this.markerAnimation = animation;
          animation.onfinish = () => { if (this.markerAnimation === animation) this.markerAnimation = null; };
          animation.oncancel = () => { if (this.markerAnimation === animation) this.markerAnimation = null; };
        } catch { this.markerAnimation = null; }
      },
    });
  }

  private cancelMarkerAnimation() { this.markerGeneration++; this.markerAnimation?.cancel(); this.markerAnimation = null; }

  private startCaret(caret: HTMLElement, from: Rect, to: Rect, duration: number) {
    this.cancelCaretAnimation();
    caret.style.willChange = 'transform';
    this.caretElement = caret;
    let animation: Animation;
    try { animation = caret.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration, easing: 'cubic-bezier(.2,.75,.3,1)' }); }
    catch { this.cancelCaretAnimation(); return; }
    this.caretAnimation = animation;
    animation.onfinish = () => {
      if (this.caretAnimation !== animation) return;
      this.caretAnimation = null; this.caretElement = null; caret.style.willChange = '';
    };
    animation.oncancel = () => {
      if (this.caretAnimation !== animation) return;
      this.caretAnimation = null; this.caretElement = null; caret.style.willChange = '';
    };
  }

  private animateRuns(before: RunPosition[], after: RunPosition[], duration = DURATION, fade = false) {
    this.cancelRunAnimations();
    const moves: { element: HTMLElement; dx: number; dy: number }[] = [];
    for (const { before: previous, after: current } of matchRunFragments(before, after)) {
      const { element, rect: to } = current, from = previous.rect;
      const dx = from.left - to.left, dy = from.top - to.top;
      // Reflow can overlap a requested format change. Let distant runs settle
      // directly while keeping nearby source motion local and readable.
      if (Math.hypot(dx, dy) > MAX_DISTANCE) continue;
      if (Math.hypot(dx, dy) < 1) continue;
      moves.push({ element, dx, dy });
    }
    for (const { element, dx, dy } of moves) {
      element.style.willChange = fade ? 'left, top, opacity' : 'left, top';
      const animation = element.animate([
        { left: `${dx}px`, top: `${dy}px`, ...(fade ? { opacity: .68 } : {}) },
        { left: '0px', top: '0px', ...(fade ? { opacity: 1 } : {}) },
      ], { duration, easing: 'cubic-bezier(.2,.75,.3,1)' });
      this.runAnimations.set(element, animation);
      animation.onfinish = () => {
        element.style.willChange = '';
        if (this.runAnimations.get(element) === animation) this.runAnimations.delete(element);
      };
      animation.oncancel = () => { element.style.willChange = ''; };
    }
  }

  private captureScroll() { this.lastScroll = { top: this.view.scrollDOM.scrollTop, left: this.view.scrollDOM.scrollLeft }; }
  private cancelMotion() { this.editCapture = null; this.indentMotionBaseline = null; this.pointerRunBaseline = null; this.clearDeleteEcho(); this.cancelAnimations(); this.cancelMarkerAnimation(); this.lastRuns = []; this.lastCaretRect = null; this.lastDoc = null; this.lastTree = null; this.pendingIndentMotion = false; if (this.pointerGesture) { this.pointerGesture.candidate = null; this.releasePointerHold(this.pointerGesture); } }
  private invalidatePending() {
    this.generation++; this.baselineGeneration++; this.pendingFormatMotion = false;
    this.view.requestMeasure({ key: this, read: () => null, write: () => {} });
    this.view.requestMeasure({ key: this.baselineKey, read: () => [], write: () => {} });
  }
  private cancelRunAnimations() { for (const animation of this.runAnimations.values()) animation.cancel(); this.runAnimations.clear(); }
  private cancelCaretAnimation() {
    const animation = this.caretAnimation, element = this.caretElement;
    this.caretAnimation = null; this.caretElement = null;
    animation?.cancel();
    if (element) element.style.willChange = '';
  }
  private cancelAnimations() { this.invalidatePending(); this.cancelCaretAnimation(); this.cancelRunAnimations(); this.taskPulse?.(); this.taskPulse = null; }

  private tryTaskMotion(update: ViewUpdate) {
    if (update.transactions.length !== 1 || !update.transactions[0].isUserEvent('input.task')) return false;
    this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
    if (reducedMotion(this.view) || update.state.readOnly) return true;
    const changes: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => changes.push({ fromA, toA, fromB, toB }));
    if (changes.length !== 1) return true;
    const change = changes[0], before = update.startState.sliceDoc(change.fromA, change.toA), after = update.state.sliceDoc(change.fromB, change.toB);
    if (change.toA - change.fromA !== 1 || change.toB - change.fromB !== 1 || !/^[ xX]$/.test(before) || !/^[ xX]$/.test(after) || before.toLowerCase() === after.toLowerCase()) return true;
    const view = this.view, doc = update.state.doc, generation = this.generation;
    view.requestMeasure({ key: this,
      read: () => view.dom.querySelector<HTMLInputElement>(`.cm-md-task-checkbox[data-task-position="${change.fromB}"]`),
      write: input => {
        if (generation !== this.generation || view.state.doc !== doc || view.state.readOnly || view.composing || view.compositionStarted || reducedMotion(view)
          || !input?.isConnected || !view.dom.contains(input) || input.disabled || input.checked !== (after.toLowerCase() === 'x')) return;
        this.taskPulse = pulseControl(input, 'task');
      },
    });
    return true;
  }
}

const controllers = new WeakMap<EditorView, MotionController>();

export function attachMarkdownMotion(view: EditorView) { controllers.get(view)?.destroy(); controllers.set(view, new MotionController(view)); }
export function detachMarkdownMotion(view: EditorView) { controllers.get(view)?.destroy(); controllers.delete(view); }

export function updateMarkdownMotion(update: ViewUpdate) {
  controllers.get(update.view)?.update(update);
}
