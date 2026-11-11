require('./typescript-loader.cjs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let OutlineScrollMotion, outlineMotionPlan, outlineTargetTop, scrollSourceOutline, sourceOutlineScrollMotion, cancelSourceOutlineMotion;
let EditorState, EditorSelection, EditorView, history, undoDepth;
before(async () => {
  ({ OutlineScrollMotion, outlineMotionPlan, outlineTargetTop, scrollSourceOutline, sourceOutlineScrollMotion, cancelSourceOutlineMotion } = await import('../src/editor/outlineScrollMotion.ts'));
  ({ EditorState, EditorSelection } = await import('@codemirror/state'));
  ({ EditorView } = await import('@codemirror/view'));
  ({ history, undoDepth } = await import('@codemirror/commands'));
});
class Target extends EventTarget {
  constructor() { super(); this.counts = new Map(); }
  addEventListener(type, fn, options) { super.addEventListener(type, fn, options); this.counts.set(type, (this.counts.get(type) || 0) + 1); }
  removeEventListener(type, fn, options) { super.removeEventListener(type, fn, options); this.counts.set(type, (this.counts.get(type) || 0) - 1); }
  signal(type) { this.dispatchEvent(new Event(type)); }
}
function fixture({ top = 0, reduced = false, systemReduced = false, scale = 1 } = {}) {
  const win = new Target(), doc = new Target(), host = new Target(), app = { dataset: { motion: reduced ? 'reduced' : 'full' } };
  let now = 0, id = 0, position = top; const frames = new Map(), allFrames = new Map(), writes = [], styles = new Map();
  win.performance = { now: () => now }; win.matchMedia = () => ({ matches: systemReduced });
  win.requestAnimationFrame = callback => { const key = ++id; frames.set(key, callback); allFrames.set(key, callback); return key; };
  win.cancelAnimationFrame = key => frames.delete(key);
  doc.defaultView = win; host.ownerDocument = doc; host.isConnected = true;
  host.clientHeight = 800; host.clientWidth = 700; host.scrollHeight = 12000; host.offsetHeight = 804; host.clientTop = 2;
  host.closest = () => app; host.contains = target => target.parent === host;
  host.getBoundingClientRect = () => ({ top: 100, height: host.offsetHeight * scale });
  host.style = {
    getPropertyValue: key => styles.get(key)?.value || '', getPropertyPriority: key => styles.get(key)?.priority || '',
    setProperty: (key, value, priority = '') => styles.set(key, { value, priority }), removeProperty: key => styles.delete(key),
  };
  Object.defineProperty(host, 'scrollTop', { get: () => position, set: value => { position = Math.max(0, Math.min(host.scrollHeight - host.clientHeight, value)); writes.push(position); } });
  const step = (ms = 16) => { now += ms; const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(now); };
  const complete = () => { for (let count = 0; frames.size && count < 40; count++) step(); assert.equal(frames.size, 0); };
  const heading = y => ({ parent: host, isConnected: true, getBoundingClientRect: () => ({ top: 100 + (host.clientTop + y - host.scrollTop) * scale }) });
  return { host, win, doc, app, frames, allFrames, writes, step, complete, heading };
}
function sourceFixture(options) {
  const f = fixture(options), text = Array.from({ length: 160 }, (_, n) => `## 标题 ${n} 😀\n段落`).join('\n');
  const view = { state: EditorState.create({ doc: text, extensions: [sourceOutlineScrollMotion, history()] }), dom: f.host, scrollDOM: f.host,
    scaleY: 1, composing: false, hasFocus: true, focused: false, updating: false, coordsReads: 0, glyphOffset: 0,
    get documentTop() { return 100 + f.host.clientTop + 38 - f.host.scrollTop; },
    lineBlockAt(pos) { return { top: this.state.doc.lineAt(pos).number * 40 }; },
    focus() { this.focused = true; },
    dispatch(spec) {
      const before = this.state, transaction = before.update(spec); this.state = transaction.state;
      for (const listener of this.state.facet(EditorView.updateListener)) listener({ view: this, startState: before, state: this.state,
        docChanged: transaction.docChanged, selectionSet: !!transaction.selection, focusChanged: false, changes: transaction.changes, transactions: [transaction] });
    },
    coordsAtPos(pos, side) {
      assert.equal(this.updating, false, 'public coordsAtPos is forbidden in CM Updating phase'); this.coordsReads++;
      assert.equal(side, 1); const line = this.state.doc.lineAt(pos).number;
      return { top: 100 + f.host.clientTop + line * 40 + 38 + this.glyphOffset - f.host.scrollTop, bottom: 100 + line * 40 + 62 - f.host.scrollTop };
    },
  };
  const destination = line => view.state.doc.line(line).from;
  const native = (head = view.state.selection.main.head, y = 'start', yMargin = 12) => {
    view.updating = true;
    try { return view.state.facet(EditorView.scrollHandler)[0](view, EditorSelection.cursor(head, 1), { y, x: 'nearest', yMargin, xMargin: 5 }); }
    finally { view.updating = false; }
  };
  return { ...f, view, destination, native };
}

test('nearby outline movement is monotonic, eases out, and arrives exactly within 200 ms', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 300);
  assert.equal(f.host.scrollTop, 0); f.step(60); const first = f.host.scrollTop; assert.ok(first > 0 && first < 300);
  f.complete(); assert.equal(f.host.scrollTop, 300); assert.equal(motion.active, false);
  assert.ok(f.writes.every((top, i) => i === 0 || top >= f.writes[i - 1])); motion.destroy();
});
test('long jumps preposition near the heading and animate at most 480px rather than flying through the document', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 10000);
  assert.equal(f.host.scrollTop, 9520); f.complete(); assert.equal(f.host.scrollTop, 10000);
  assert.ok(outlineMotionPlan(0, 10000, 800).duration <= 200); motion.destroy();
});
test('long upward jumps and short viewports use the same bounded plan', () => {
  const f = fixture({ top: 8000 }), motion = new OutlineScrollMotion(f.host); f.host.clientHeight = 200;
  motion.start(() => 500); assert.equal(f.host.scrollTop, 630); f.complete(); assert.equal(f.host.scrollTop, 500); motion.destroy();
});
for (const flag of ['reduced', 'systemReduced']) test(`${flag} moves directly with no scheduled animation`, () => {
  const f = fixture({ [flag]: true }), motion = new OutlineScrollMotion(f.host); motion.start(() => 5000);
  assert.equal(f.host.scrollTop, 5000); assert.equal(f.frames.size, 0); motion.destroy();
});
test('enabling reduced motion during a running move finishes directly at the current heading', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 400); f.step(32);
  f.app.dataset.motion = 'reduced'; f.step(); assert.equal(f.host.scrollTop, 400); assert.equal(f.frames.size, 0); motion.destroy();
});
for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforeinput', 'compositionstart']) test(`${event} interrupts without consuming the user event or resuming later`, () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 400); f.step(32);
  const before = f.host.scrollTop, stale = [...f.allFrames.values()].at(-1), input = new Event(event, { cancelable: true });
  f.doc.dispatchEvent(input); stale(1000); f.complete();
  assert.equal(input.defaultPrevented, false); assert.equal(f.host.scrollTop, before); assert.equal(motion.active, false); motion.destroy();
});
test('manual or competing programmatic scroll cancels; own scroll events do not', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 400); f.step(); f.host.signal('scroll'); assert.equal(motion.active, true);
  f.host.scrollTop = 25; f.host.signal('scroll'); f.complete(); assert.equal(f.host.scrollTop, 25); assert.equal(motion.active, false); motion.destroy();
});
test('a newer outline choice starts from the visible position and stale frames cannot move its successor', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 400); f.step(64);
  const visible = f.host.scrollTop, stale = [...f.allFrames.values()].at(-1); motion.start(() => 100);
  assert.equal(f.host.scrollTop, visible); stale(10000); assert.equal(f.host.scrollTop, visible); f.complete(); assert.equal(f.host.scrollTop, 100); motion.destroy();
});
test('layout changes finish at a freshly measured heading rather than chasing a stale target', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); let goal = 300; motion.start(() => goal); f.step(); goal = 350;
  f.host.clientWidth = 600; f.step(); assert.equal(f.host.scrollTop, 350); assert.equal(f.frames.size, 0); motion.destroy();
});
test('removed, hidden, stale or unmeasurable content cancels and restores the prior CSS behavior', () => {
  for (const kind of ['removed', 'hidden', 'null', 'throw']) {
    const f = fixture(), motion = new OutlineScrollMotion(f.host); let valid = true;
    f.host.style.setProperty('scroll-behavior', 'smooth', '');
    motion.start(() => { if (!valid) { if (kind === 'throw') throw Error('detached'); return null; } return 400; }); f.step();
    if (kind === 'removed') f.host.isConnected = false;
    else if (kind === 'hidden') f.host.clientHeight = 0; else valid = false;
    f.step(); assert.equal(motion.active, false); assert.equal(f.host.style.getPropertyValue('scroll-behavior'), 'smooth'); motion.destroy();
  }
});
test('the controller restores CSS priority and never overwrites an intervening style change', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); f.host.style.setProperty('scroll-behavior', 'smooth', 'important');
  motion.start(() => 100); assert.equal(f.host.style.getPropertyValue('scroll-behavior'), 'auto'); motion.cancel();
  assert.equal(f.host.style.getPropertyValue('scroll-behavior'), 'smooth'); assert.equal(f.host.style.getPropertyPriority('scroll-behavior'), 'important');
  motion.start(() => 100); f.host.style.setProperty('scroll-behavior', 'instant', ''); motion.cancel(); assert.equal(f.host.style.getPropertyValue('scroll-behavior'), 'instant'); motion.destroy();
});
test('destroy releases input/scroll/window listeners and pending frames; blur cancels', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 300); f.win.signal('blur'); assert.equal(motion.active, false);
  motion.start(() => 300); motion.destroy(); assert.equal(f.frames.size, 0);
  assert.ok([...f.doc.counts.values(), ...f.host.counts.values(), ...f.win.counts.values()].every(count => count === 0));
});
test('preview heading coordinates account for scale, borders and existing scroll; no parent is scrolled', () => {
  const f = fixture({ top: 200, scale: 1.5 }), heading = f.heading(1000);
  assert.equal(outlineTargetTop(f.host, heading), 988); heading.isConnected = false; assert.equal(outlineTargetTop(f.host, heading), null);
});
test('targets clamp to document bounds and stable empty/small documents have no unnecessary movement', () => {
  const f = fixture(), motion = new OutlineScrollMotion(f.host); motion.start(() => 100000); f.complete(); assert.equal(f.host.scrollTop, 11200);
  motion.start(() => -100); f.complete(); assert.equal(f.host.scrollTop, 0); f.host.scrollHeight = 20; motion.start(() => 10); assert.equal(f.frames.size, 0); motion.destroy();
});
test('source outline delegates target rendering to CodeMirror, changes only selection and preserves history/text', () => {
  const f = sourceFixture(), before = f.view.state.doc, head = f.destination(100);
  assert.equal(scrollSourceOutline(f.view, head), true); assert.equal(f.host.scrollTop, 0, 'no guessed line-height jump before native measure');
  assert.equal(f.native(), true); assert.equal(f.view.coordsReads, 0, 'write phase must not invoke public geometry reads'); assert.equal(f.view.focused, true); f.complete();
  assert.ok(f.view.coordsReads > 0, 'actual glyph is measured in later idle frames');
  assert.equal(f.host.scrollTop, 100 * 40 + 38 - 12); assert.equal(f.view.state.doc, before); assert.equal(f.view.state.selection.main.head, head);
  assert.equal(undoDepth(f.view.state), 0); cancelSourceOutlineMotion(f.view);
});
test('source final alignment uses real glyph geometry rather than only the initial line-block estimate', () => {
  const f = sourceFixture(), head = f.destination(60); f.view.glyphOffset = 7.5;
  scrollSourceOutline(f.view, head); assert.equal(f.native(), true); f.complete();
  assert.equal(f.host.scrollTop, 60 * 40 + 38 + 7.5 - 12); cancelSourceOutlineMotion(f.view);
});
test('a line block already at the target still gets an idle glyph correction', () => {
  const f = sourceFixture({ top: 4 * 40 + 38 - 12 }), head = f.destination(4); f.view.glyphOffset = 7.5;
  scrollSourceOutline(f.view, head); assert.equal(f.native(), true); f.complete();
  assert.equal(f.host.scrollTop, 4 * 40 + 38 + 7.5 - 12); cancelSourceOutlineMotion(f.view);
});
test('source repeated navigation resolves the latest UTF-16 heading and leaves unrelated scrolling native', () => {
  const f = sourceFixture(); scrollSourceOutline(f.view, f.destination(150)); f.native(); f.step();
  const head = f.destination(4); scrollSourceOutline(f.view, head); assert.equal(f.native(), true); f.complete();
  assert.equal(f.host.scrollTop, 4 * 40 + 38 - 12); assert.equal(f.view.state.selection.main.head, head);
  assert.equal(f.native(head, 'center', 5), false); assert.equal(f.native(head, 'nearest', 5), false); cancelSourceOutlineMotion(f.view);
});
test('manual input before the native measure suppresses exactly the queued outline scroll', () => {
  const f = sourceFixture(); scrollSourceOutline(f.view, f.destination(80)); f.doc.signal('wheel'); f.host.scrollTop = 25;
  assert.equal(f.native(), true); assert.equal(f.host.scrollTop, 25); assert.equal(f.frames.size, 0);
  assert.equal(f.native(f.destination(2)), false, 'a different destination is not swallowed');
});
test('pending outline target mapped through a document edit is consumed without a stale jump', () => {
  const f = sourceFixture(), head = f.destination(80); scrollSourceOutline(f.view, head);
  f.view.dispatch({ changes: { from: 0, insert: '😀\n' } }); const mapped = head + 3;
  assert.equal(f.native(mapped), true); assert.equal(f.host.scrollTop, 0); assert.equal(f.frames.size, 0);
});
test('source selection-affinity changes cancel rather than moving a different visual caret', () => {
  const f = sourceFixture(), head = f.destination(4); scrollSourceOutline(f.view, head); f.native(); f.step();
  const top = f.host.scrollTop; f.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(head, -1)]) }); f.complete();
  assert.equal(f.host.scrollTop, top);
});
test('source IME does not dispatch a navigation, and reduced motion falls back to the normal exact scroll', () => {
  const f = sourceFixture({ reduced: true }), before = f.view.state; f.view.composing = true;
  assert.equal(scrollSourceOutline(f.view, f.destination(4)), false); assert.equal(f.view.state, before);
  f.view.composing = false; scrollSourceOutline(f.view, f.destination(4)); assert.equal(f.native(), false); assert.equal(f.frames.size, 0);
});
test('the real CM early composition getters block navigation before the first document change', () => {
  const f = sourceFixture(), before = f.view.state;
  f.view.inputState = { composing: 0 };
  for (const name of ['composing', 'compositionStarted']) Object.defineProperty(f.view, name, { get: Object.getOwnPropertyDescriptor(EditorView.prototype, name).get });
  assert.equal(f.view.composing, false); assert.equal(f.view.compositionStarted, true);
  assert.equal(scrollSourceOutline(f.view, f.destination(4)), false); assert.equal(f.view.state, before); assert.equal(f.view.focused, false);
});
test('early composition beginning before native measure falls back without scheduling any animation', () => {
  const f = sourceFixture(); scrollSourceOutline(f.view, f.destination(4)); f.view.compositionStarted = true;
  assert.equal(f.native(), true); assert.equal(f.host.scrollTop, 0); assert.equal(f.frames.size, 0);
});
test('keyboard outline activation keeps focus on navigation and supports another choice without typing into the editor', () => {
  const f = sourceFixture(); f.view.hasFocus = false;
  scrollSourceOutline(f.view, f.destination(80), false); assert.equal(f.view.focused, false);
  for (const listener of f.view.state.facet(EditorView.updateListener)) listener({ view: f.view, state: f.view.state, docChanged: false, selectionSet: false, focusChanged: true });
  assert.equal(f.native(), true); f.step(); scrollSourceOutline(f.view, f.destination(4), false); assert.equal(f.native(), true); f.complete();
  assert.equal(f.host.scrollTop, 4 * 40 + 38 - 12); assert.equal(f.view.focused, false); assert.equal(undoDepth(f.view.state), 0);
});
