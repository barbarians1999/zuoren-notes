import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { ChangeDesc, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdownMotionVisibilityKey } from './markdownLivePreview';

const DURATION = 120;
const DISTANT_CARET_DURATION = 80;
const MAX_DISTANCE = 88;
type Rect = { left: number; top: number; width: number; height: number };
type RunPosition = { element: HTMLElement; key: string; rect: Rect };
type FirstCaretMeasure = { head: number; from: Rect | null; formatChanged: boolean; runsBefore: RunPosition[]; runsGeometry: string; scrollTop: number; scrollLeft: number };
type SecondCaretMeasure = { head: number; from: Rect | null; to: Rect | null; runs: RunPosition[] | null; runsGeometry: string; scrollTop: number; scrollLeft: number; caretRelative: Rect | null; doc: Text; tree: ReturnType<typeof syntaxTree> };
type MotionMeasureRequest<T> = { key?: unknown; read(view: EditorView): T; write?(measure: T, view: EditorView): void };
type IndentMotionMeasure = { runs: RunPosition[]; geometry: string; caret: Rect | null; scrollTop: number; scrollLeft: number } | null;
type PointerGesture = { x: number; y: number; moved: boolean; ended: boolean; candidate: { head: number; from: Rect; to: Rect; scrollTop: number; scrollLeft: number; generation: number } | null; held: { element: HTMLElement; transform: string; priority: string } | null };

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
  return [...view.contentDOM.querySelectorAll<HTMLElement>('[data-md-motion-key]')].flatMap(element => {
    const rect = rectOf(element), key = element.dataset.mdMotionKey;
    return rect && key ? [{ element, key, rect: { ...rect, left: rect.left - origin.left, top: rect.top - origin.top } }] : [];
  });
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

class MotionController {
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
    if (this.pointerGesture) this.releasePointerHold(this.pointerGesture);
    this.pointerGesture = { x: event.clientX, y: event.clientY, moved: false, ended: false, candidate: null, held: null };
  };
  private readonly onMouseMove = (event: MouseEvent) => {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.ended || !(event.buttons & 1)) return;
    if (Math.max(Math.abs(event.clientX - gesture.x), Math.abs(event.clientY - gesture.y)) >= 10) {
      gesture.moved = true; gesture.candidate = null; this.releasePointerHold(gesture);
    }
  };
  private readonly onMouseUp = (event: MouseEvent) => {
    const gesture = this.pointerGesture;
    if (!gesture || event.button !== 0 || gesture.ended) return;
    gesture.ended = true;
    this.commitPointerCaret(gesture);
  };
  private readonly onScroll = () => {
    const gesture = this.pointerGesture;
    if (gesture?.held) { gesture.candidate = null; this.releasePointerHold(gesture); }
    if (this.pendingIndentMotion || this.pendingFormatMotion || this.runAnimations.size || this.caretAnimation) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
    }
  };
  private readonly onWindowBlur = () => {
    if (this.pointerGesture) this.releasePointerHold(this.pointerGesture);
    this.pointerGesture = null;
    if (this.pendingIndentMotion || this.pendingFormatMotion || this.runAnimations.size || this.caretAnimation) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
    }
  };
  private readonly onMotionPreferenceChanged = () => { this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); };

  constructor(private readonly view: EditorView) {
    this.lastScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    view.dom.addEventListener('mousedown', this.onMouseDown, true);
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
      this.motionPreferenceObserver.observe(app, { attributes: true, attributeFilter: ['data-motion'] });
    }
    this.motionPreferenceQuery = window?.matchMedia('(prefers-reduced-motion: reduce)') || null;
    this.motionPreferenceQuery?.addEventListener('change', this.onMotionPreferenceChanged);
    this.scheduleBaseline();
  }

  update(update: ViewUpdate) {
    const view = update.view, selection = update.state.selection;
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
    const eligible = !update.docChanged && view.hasFocus && !view.composing && !reducedMotion(view)
      && selection.ranges.length === 1 && selection.main.empty;
    if (!eligible) {
      this.cancelMotion();
      if (update.docChanged && view.hasFocus && !view.composing && !reducedMotion(view)
        && selection.ranges.length === 1 && selection.main.empty) this.scheduleBaseline();
      else if (view.composing || selection.ranges.length !== 1 || !selection.main.empty) this.lastRuns = [];
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
    if (view.scrollDOM.scrollTop !== this.lastScroll.top || view.scrollDOM.scrollLeft !== this.lastScroll.left) {
      this.cancelMotion(); this.captureScroll(); this.scheduleBaseline();
      return;
    }
    const formatChanged = markdownMotionVisibilityKey(update.startState) !== markdownMotionVisibilityKey(update.state);
    const pointerSelection = update.transactions.some(transaction => transaction.isUserEvent('select.pointer'));
    const pointerGesture = pointerSelection ? this.pointerGesture : null;
    const scrollTop = view.scrollDOM.scrollTop, scrollLeft = view.scrollDOM.scrollLeft;
    const generation = ++this.generation;
    this.pendingFormatMotion = formatChanged;
    const request: MotionMeasureRequest<FirstCaretMeasure> = {
      key: this,
      read: measuringView => {
        const caret = measuringView.dom.querySelector<HTMLElement>('.cm-cursor-primary');
        const from = rectOf(caret);
        return { head, from, formatChanged, runsBefore: this.lastRuns, runsGeometry: this.lastRunGeometry, scrollTop, scrollLeft };
      },
      write: first => {
        if (generation !== this.generation) return;
        if (view.state.selection.main.head !== first.head || !view.hasFocus || view.composing || reducedMotion(view)) { this.pendingFormatMotion = false; return; }
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
            if (view.state.selection.main.head !== final.head || view.state.doc !== final.doc
              || syntaxTree(view.state) !== final.tree || !view.hasFocus || view.composing || reducedMotion(view)) return;
            this.lastCaretRect = final.caretRelative; this.lastDoc = final.doc; this.lastTree = final.tree;
            const caret = view.dom.querySelector<HTMLElement>('.cm-cursor-primary');
            const stable = view.scrollDOM.scrollTop === final.scrollTop && view.scrollDOM.scrollLeft === final.scrollLeft;
            const distance = final.from && final.to ? Math.hypot(final.from.left - final.to.left, final.from.top - final.to.top) : Infinity;
            const eligibleCaret = !!caret && stable && !!final.from && !!final.to && distance >= 1
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
    this.view.dom.ownerDocument.removeEventListener('mousemove', this.onMouseMove, true);
    this.view.dom.ownerDocument.removeEventListener('mouseup', this.onMouseUp, true);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.onWindowBlur);
    this.motionPreferenceObserver?.disconnect(); this.motionPreferenceObserver = null;
    this.motionPreferenceQuery?.removeEventListener('change', this.onMotionPreferenceChanged); this.motionPreferenceQuery = null;
    if (this.pointerGesture) this.releasePointerHold(this.pointerGesture);
    this.pointerGesture = null;
    this.invalidatePending(); this.cancelCaretAnimation(); this.cancelRunAnimations();
  }

  private commitPointerCaret(gesture: PointerGesture) {
    const candidate = gesture.candidate, view = this.view;
    if (!gesture.ended || !candidate) return;
    gesture.candidate = null;
    if (gesture.moved || gesture !== this.pointerGesture || candidate.generation !== this.generation
      || view.state.selection.main.head !== candidate.head || !view.state.selection.main.empty || !view.hasFocus
      || view.composing || reducedMotion(view) || view.scrollDOM.scrollTop !== candidate.scrollTop
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
    if (!kind || !update.docChanged || !update.selectionSet || !view.hasFocus || view.composing || reducedMotion(view)
      || selection.ranges.length !== 1 || !selection.main.empty) return false;
    const startTree = syntaxTree(update.startState), targetTree = syntaxTree(update.state);
    if (this.pendingIndentMotion || this.caretAnimation?.playState === 'running' || this.runAnimations.size > 0
      || this.lastDoc !== update.startState.doc || this.lastTree !== startTree || !this.lastRuns.length || !this.lastCaretRect
      || this.lastRunGeometry !== runGeometry(view)
      || view.scrollDOM.scrollTop !== this.lastScroll.top || view.scrollDOM.scrollLeft !== this.lastScroll.left
      || !isSingleLeadingIndentChange(update.startState.doc, update.state.doc, update.changes, kind)) return false;

    const mappedBefore: RunPosition[] = [];
    for (const run of this.lastRuns) {
      const match = /^(\d+):(\d+)$/.exec(run.key);
      if (!match) continue;
      const mapped = mapMarkdownMotionRangeThroughChanges(Number(match[1]), Number(match[2]), update.changes, update.startState.doc, update.state.doc);
      if (mapped) mappedBefore.push({ ...run, key: mapped.key });
    }
    if (!mappedBefore.length) return false;

    const generation = ++this.generation, targetDoc = update.state.doc, targetSelection = update.state.selection;
    this.pendingFormatMotion = false; this.pendingIndentMotion = true;
    const beforeRuns = mappedBefore, beforeCaret = this.lastCaretRect, beforeGeometry = this.lastRunGeometry;
    const beforeScroll = { top: this.lastScroll.top, left: this.lastScroll.left };
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
          && syntaxTree(view.state) === targetTree && view.hasFocus && !view.composing && !reducedMotion(view);
        if (!stable || !result?.caret) { this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); return; }

        const afterRuns = remapIndentMotionRuns(beforeRuns, result.runs);
        const priorByKey = new Map<string, RunPosition[]>();
        for (const run of beforeRuns) priorByKey.set(run.key, [...(priorByKey.get(run.key) || []), run]);
        const afterByKey = new Map<string, RunPosition[]>();
        for (const run of afterRuns) afterByKey.set(run.key, [...(afterByKey.get(run.key) || []), run]);
        let hasMovedRun = false, fragmentMismatch = false;
        for (const [key, prior] of priorByKey) {
          const after = afterByKey.get(key);
          if (!after) continue;
          if (after.length !== prior.length) { fragmentMismatch = true; break; }
          if (after.some((run, index) => Math.hypot(run.rect.left - prior[index].rect.left, run.rect.top - prior[index].rect.top) >= 1)) hasMovedRun = true;
        }
        const caret = view.dom.querySelector<HTMLElement>('.cm-cursor-primary');
        const caretDistance = Math.hypot(beforeCaret.left - result.caret.left, beforeCaret.top - result.caret.top);
        if (!caret || fragmentMismatch || !hasMovedRun || caretDistance > MAX_DISTANCE) {
          this.cancelMotion(); this.captureScroll(); this.scheduleBaseline(); return;
        }

        this.animateRuns(beforeRuns, afterRuns);
        if (caretDistance >= 1) this.startCaret(caret, beforeCaret, result.caret, DURATION);
        this.lastRuns = result.runs; this.lastRunGeometry = result.geometry; this.lastCaretRect = result.caret;
        this.lastDoc = targetDoc; this.lastTree = targetTree; this.captureScroll();
      },
    });
    return true;
  }

  private startCaret(caret: HTMLElement, from: Rect, to: Rect, duration: number) {
    this.cancelCaretAnimation();
    caret.style.willChange = 'transform';
    const animation = caret.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration, easing: 'cubic-bezier(.2,.75,.3,1)' });
    this.caretElement = caret; this.caretAnimation = animation;
    animation.onfinish = () => {
      if (this.caretAnimation !== animation) return;
      this.caretAnimation = null; this.caretElement = null; caret.style.willChange = '';
    };
    animation.oncancel = () => {
      if (this.caretAnimation !== animation) return;
      this.caretAnimation = null; this.caretElement = null; caret.style.willChange = '';
    };
  }

  private animateRuns(before: RunPosition[], after: RunPosition[]) {
    this.cancelRunAnimations();
    const previous = new Map<string, Rect[]>();
    for (const item of before) previous.set(item.key, [...(previous.get(item.key) || []), item.rect]);
    const used = new Map<string, number>();
    const moves: { element: HTMLElement; dx: number; dy: number }[] = [];
    for (const current of after) {
      const { element, key, rect: to } = current, old = previous.get(key);
      if (!old?.length) continue;
      const index = used.get(key) || 0; used.set(key, index + 1);
      const from = old[index];
      if (!from || !to) continue;
      const dx = from.left - to.left, dy = from.top - to.top;
      // Reflow can overlap a requested format change. Let distant runs settle
      // directly while keeping nearby source motion local and readable.
      if (Math.hypot(dx, dy) > MAX_DISTANCE) continue;
      if (Math.hypot(dx, dy) < 1) continue;
      moves.push({ element, dx, dy });
    }
    for (const { element, dx, dy } of moves) {
      element.style.willChange = 'left, top';
      const animation = element.animate([
        { left: `${dx}px`, top: `${dy}px` },
        { left: '0px', top: '0px' },
      ], { duration: DURATION, easing: 'cubic-bezier(.2,.75,.3,1)' });
      this.runAnimations.set(element, animation);
      animation.onfinish = () => {
        element.style.willChange = '';
        if (this.runAnimations.get(element) === animation) this.runAnimations.delete(element);
      };
      animation.oncancel = () => { element.style.willChange = ''; };
    }
  }

  private captureScroll() { this.lastScroll = { top: this.view.scrollDOM.scrollTop, left: this.view.scrollDOM.scrollLeft }; }
  private cancelMotion() { this.cancelAnimations(); this.lastRuns = []; this.lastCaretRect = null; this.lastDoc = null; this.lastTree = null; this.pendingIndentMotion = false; if (this.pointerGesture) { this.pointerGesture.candidate = null; this.releasePointerHold(this.pointerGesture); } }
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
  private cancelAnimations() { this.invalidatePending(); this.cancelCaretAnimation(); this.cancelRunAnimations(); }
}

const controllers = new WeakMap<EditorView, MotionController>();

export function attachMarkdownMotion(view: EditorView) { controllers.set(view, new MotionController(view)); }
export function detachMarkdownMotion(view: EditorView) { controllers.get(view)?.destroy(); controllers.delete(view); }

export function updateMarkdownMotion(update: ViewUpdate) {
  controllers.get(update.view)?.update(update);
}
