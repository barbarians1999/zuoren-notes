require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function change(doc, head, changes, next, userEvent, extra = {}) {
  const { EditorState } = await import('@codemirror/state');
  const before = EditorState.create({ doc, selection: { anchor: head }, ...extra });
  const tr = before.update({ changes, selection: { anchor: next }, userEvent });
  return { before, after: tr.state, tr };
}

test('plain editing policy accepts adjacent short changes without changing text, selection, or transactions', async () => {
  const { plainEdit } = await import('../src/editor/editMotionPolicy.ts');
  for (const [doc, head, edits, next, event, type] of [
    ['a', 1, { from: 1, insert: '中' }, 2, 'input.type', 'insertText'],
    ['a😀', 3, { from: 1, to: 3 }, 1, 'delete.backward', 'deleteContentBackward'],
    ['abc', 1, { from: 1, to: 2 }, 1, 'delete.forward', 'deleteContentForward'],
  ]) {
    const { before, after, tr } = await change(doc, head, edits, next, event);
    const text = after.doc.toString(), selection = after.selection;
    assert.ok(plainEdit(before, after, [tr], tr.changes, type));
    assert.equal(after.doc.toString(), text);
    assert.equal(after.selection, selection);
  }
});

test('selection edits, multiline, paste, undo, composition and multi-change transactions fall back', async () => {
  const { plainEdit } = await import('../src/editor/editMotionPolicy.ts');
  for (const [edits, next, event] of [
    [{ from: 1, insert: '\n' }, 2, 'input.type'],
    [{ from: 1, insert: '123456789' }, 10, 'input.type'],
    [{ from: 1, insert: 'x' }, 2, 'input.paste'],
    [{ from: 1, insert: 'x' }, 2, 'undo'],
    [{ from: 1, insert: '中' }, 2, 'input.type.compose'],
    [[{ from: 0, insert: '-' }, { from: 1, insert: 'x' }], 3, 'input.type'],
  ]) {
    const { before, after, tr } = await change('abc', 1, edits, next, event);
    assert.equal(plainEdit(before, after, [tr], tr.changes, 'insertText'), null);
  }
  const selected = await change('abc', 0, { from: 0, to: 2 }, 0, 'delete.backward', { selection: { anchor: 0, head: 2 } });
  assert.equal(plainEdit(selected.before, selected.after, [selected.tr], selected.tr.changes, 'deleteContentBackward'), null);
  const newline = await change('a\nb', 2, { from: 1, to: 2 }, 1, 'delete.backward');
  assert.equal(plainEdit(newline.before, newline.after, [newline.tr], newline.tr.changes, 'deleteContentBackward'), null);
});

test('ghost boundaries preserve UTF-16 clusters and skip line boundaries, long lines and large emoji clusters', async () => {
  const { deletionGrapheme } = await import('../src/editor/editMotionPolicy.ts');
  const { EditorState } = await import('@codemirror/state');
  const at = (doc, head, forward = false) => deletionGrapheme(EditorState.create({ doc, selection: { anchor: head } }), forward);
  assert.deepEqual(at('a😀', 3), { from: 1, to: 3, text: '😀' });
  assert.deepEqual(at('ae\u0301', 3), { from: 1, to: 3, text: 'e\u0301' });
  assert.equal(at('a\nb', 2), null);
  assert.equal(at('x'.repeat(1100), 1100), null);
  assert.equal(at('👨‍👩‍👧‍👦', 11), null);
  assert.deepEqual(at('a中', 1, true), { from: 1, to: 2, text: '中' });
});

test('rapid inputs, repeats and composition have cooldowns and horizontal movement is bounded', async () => {
  const { EditMotionGate, shortHorizontalMove } = await import('../src/editor/editMotionPolicy.ts');
  const gate = new EditMotionGate();
  assert.equal(gate.accept(0), true);
  assert.equal(gate.accept(30), false);
  assert.equal(gate.accept(70), false);
  assert.equal(gate.accept(250), true);
  gate.repeat(260); assert.equal(gate.accept(300), false);
  gate.compositionStart(500); assert.equal(gate.accept(800), false);
  gate.compositionEnd(810); assert.equal(gate.accept(820), false); assert.equal(gate.accept(1000), true);
  const from = { left: 10, top: 5, height: 20 };
  assert.equal(shortHorizontalMove(from, { ...from, left: 25 }), true);
  assert.equal(shortHorizontalMove(from, { ...from, left: 80 }), false);
  assert.equal(shortHorizontalMove(from, { ...from, left: 25, top: 30 }), false);
});

async function mockView({ enabled = true, echo = true, doc: initialDoc = 'abc', extensions = [] } = {}) {
  const { EditorState } = await import('@codemirror/state');
  const motion = await import('../src/editor/markdownMotion.ts');
  const originals = new Map(['HTMLElement', 'Node', 'HTMLImageElement', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const animations = [], observers = [], measures = [];
  let clock = 0, view;
  class FakeNode {} FakeNode.TEXT_NODE = 3;
  class Element extends FakeNode {
    constructor() { super(); this.dataset = {}; this.listeners = new Map(); this.children = []; this.attrs = {}; this.isConnected = true;
      this.style = { setProperty(k,v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; }, getPropertyPriority() { return ''; }, removeProperty(k) { delete this[k]; } };
      this.rect = { left: 100, top: 100, width: 800, height: 20 }; this.clientWidth = 800; this.clientLeft = this.clientTop = 0; }
    addEventListener(name, cb) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(cb); }
    removeEventListener(name, cb) { this.listeners.get(name)?.delete(cb); }
    fire(name, event = {}) { for (const cb of this.listeners.get(name) || []) cb({ target: this, ...event }); }
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    closest(selector) { return selector === '.app' ? app : selector === '[data-md-motion-key]' && this.dataset.mdMotionKey ? this : null; }
    matches() { return false; }
    querySelector(selector) { return selector === '.cm-cursor-primary' ? cursor : null; }
    querySelectorAll(selector) { return selector === '.cm-cursor' ? [cursor] : []; }
    contains(node) { return node === this || this.children.some(child => child === node || child.contains?.(node)); }
    setAttribute(k,v) { this.attrs[k] = v; }
    append(node) { this.children.push(node); node.parent = this; node.parentElement = this; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    animate(frames, options) {
      const result = { frames, options, element: this, playState: 'running', cancel() { this.playState = 'idle'; this.oncancel?.(); } };
      animations.push(result); return result;
    }
  }
  const app = new Element(), root = new Element(), content = new Element(), scroll = new Element(), cursor = new Element(), windowEvents = new Element();
  const documentListeners = new Map();
  content.querySelectorAll = selector => selector === '[data-md-motion-key]' ? content.children.filter(node => node.dataset.mdMotionKey) : [];
  root.contains = node => node === root || node === content || content.contains(node) || root.children.some(child => child === node || child.contains?.(node));
  app.dataset = { motion: 'full', editMotion: enabled ? 'soft' : 'off', deleteEcho: echo ? 'on' : 'off' };
  cursor.rect = { left: 130, top: 100, width: 1, height: 20 };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const doc = { addEventListener(name, cb) { if (!documentListeners.has(name)) documentListeners.set(name, new Set()); documentListeners.get(name).add(cb); },
    removeEventListener(name, cb) { documentListeners.get(name)?.delete(cb); },
    dispatchEvent(event) { for (const cb of documentListeners.get(event.type) || []) cb({ target: doc, ...event }); },
    createElement: () => { const node = new Element(); node.ownerDocument = doc; return node; },
    defaultView: { addEventListener: (...args) => windowEvents.addEventListener(...args), removeEventListener: (...args) => windowEvents.removeEventListener(...args), performance: { now: () => clock }, matchMedia: () => media,
      MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} } },
    createRange() { let from, to; return { setStart(_node, pos) { from = pos; }, setEnd(_node, pos) { to = pos; },
      toString: () => view.state.sliceDoc(from, to), getClientRects: () => [{ left: 100 + from * 10, top: 100, width: (to-from)*10, height: 20 }] }; } };
  for (const node of [app, root, content, scroll, cursor]) node.ownerDocument = doc;
  globalThis.HTMLElement = Element; globalThis.Node = FakeNode; globalThis.HTMLImageElement = class extends Element {};
  globalThis.getComputedStyle = () => ({ font: '18px serif', color: '#29231f', letterSpacing: '0px' });
  scroll.scrollTop = scroll.scrollLeft = 0;
  view = { dom: root, contentDOM: content, scrollDOM: scroll, hasFocus: true, composing: false, compositionStarted: false, scaleX: 1, scaleY: 1,
    state: EditorState.create({ doc: initialDoc, selection: { anchor: initialDoc.length }, extensions }),
    domAtPos: pos => ({ node: { parentElement: content }, offset: pos }),
    coordsAtPos: head => ({ left: 100 + head*10, right: 101 + head*10, top: cursor.rect.top, bottom: cursor.rect.top + 20 }),
    requestMeasure(request) { const index = measures.findIndex(item => request.key !== undefined && item.key === request.key); if (index >= 0) measures[index] = request; else measures.push(request); } };
  function flush() { let count = 0; while (measures.length) { assert.ok(count++ < 20); const batch = measures.splice(0); const values = batch.map(item => item.read(view)); batch.forEach((item,index) => item.write?.(values[index],view)); } }
  function apply(changes, head, userEvent = 'input.type', top = 100) {
    const before = view.state, tr = before.update({ changes, selection: { anchor: head }, userEvent });
    view.state = tr.state; cursor.rect.left = 100 + head*10; cursor.rect.top = top;
    motion.updateMarkdownMotion({ view, state: tr.state, startState: before, transactions: [tr], changes: tr.changes,
      docChanged: tr.docChanged, selectionSet: true, geometryChanged: false, focusChanged: false });
    return tr;
  }
  motion.attachMarkdownMotion(view); flush();
  return { view, root, content, cursor, app, animations, media, flush, apply,
    addRun({ key, text, left, top = 100 }) { const run = new Element(); run.dataset.mdMotionKey = key; run.textContent = text;
      run.rect = { left, top, width: Math.max(1, text.length * 8), height: 20 }; content.append(run); return run; },
    input(type = 'insertText') { clock += 120; root.fire('beforeinput', { inputType: type, isComposing: false }); },
    fire: (name,event) => root.fire(name,event), setClock: now => { clock = now; },
    docFire: (name,event = {}) => doc.dispatchEvent({ type: name, ...event }),
    windowFire: name => windowEvents.fire(name),
    reattach() { motion.attachMarkdownMotion(view); flush(); },
    replaceState(state) { motion.detachMarkdownMotion(view); view.state = state; motion.attachMarkdownMotion(view); flush(); },
    notify: () => observers.forEach(observer => observer.cb()),
    close() { motion.detachMarkdownMotion(view); for (const [key,value] of originals) { if (value) Object.defineProperty(globalThis,key,value); else delete globalThis[key]; } },
  };
}

test('pointer formatting motion captures visible runs when the click target has no motion-run wrapper', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { markdown } = await import('@codemirror/lang-markdown');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { markdownMotionVisibilityKey } = await import('../src/editor/markdownLivePreview.ts');
  const doc = '**First bold**\n\n### *Far heading*   ';
  const bold = doc.indexOf('First bold') + 2, italic = doc.indexOf('Far heading') + 2, headingPrefixEnd = doc.indexOf('###') + 3;
  for (const [from, to, targetText] of [[bold, headingPrefixEnd, '###'], [italic, bold, '**'], [bold, doc.length, '   ']]) {
    const mock = await mockView({ doc, extensions: [markdown()] });
    try {
      const state = EditorState.create({ doc, selection: { anchor: from }, extensions: [markdown()] });
      ensureSyntaxTree(state, doc.length, 1000);
      mock.view.state = state; mock.reattach();
      const beforeKey = markdownMotionVisibilityKey(state);
      const moving = mock.addRun({ key: '0:10', text: 'stable heading text', left: 160 });
      const staying = mock.addRun({ key: '14:25', text: 'other stable text', left: 240 });
      const clickTarget = new (mock.content.constructor)(); clickTarget.textContent = targetText; mock.content.append(clickTarget);
      mock.fire('mousedown', { button: 0, target: clickTarget, clientX: 400, clientY: 120 });

      const tr = state.update({ selection: { anchor: to }, userEvent: 'select.pointer' });
      ensureSyntaxTree(tr.state, doc.length, 1000);
      assert.notEqual(markdownMotionVisibilityKey(tr.state), beforeKey, 'the pointer crosses between distinct formatted regions');
      mock.view.state = tr.state; mock.cursor.rect.left = 100 + to * 10;
      moving.rect.left += 4; staying.rect.left -= 3;
      const updateMarkdownMotion = (await import('../src/editor/markdownMotion.ts')).updateMarkdownMotion;
      updateMarkdownMotion({ view: mock.view, state: tr.state, startState: state, transactions: [tr], changes: tr.changes,
        docChanged: false, selectionSet: true, geometryChanged: false, focusChanged: false });
      mock.flush();
      assert.ok(mock.animations.some(animation => animation.element === moving && animation.playState === 'running'),
        `a click on ${JSON.stringify(targetText)} retains the old geometry for the moving run`);
      assert.ok(mock.animations.some(animation => animation.element === staying && animation.playState === 'running'));
    } finally { mock.close(); }
  }
});

test('pointer formatting baseline stays limited to editable, stationary content clicks', async () => {
  const { EditorSelection, EditorState } = await import('@codemirror/state');
  const { markdown } = await import('@codemirror/lang-markdown');
  const { updateMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  const doc = '**First bold**\n\n### *Far heading*';
  const from = doc.indexOf('First bold') + 2, to = doc.indexOf('Far heading') + 2;
  for (const stop of ['drag', 'scroll', 'outside', 'reduced', 'composing', 'readonly', 'multiple']) {
    const mock = await mockView({ doc, extensions: [markdown()] });
    try {
      const extensions = [markdown(), ...(stop === 'readonly' ? [EditorState.readOnly.of(true)] : []),
        ...(stop === 'multiple' ? [EditorState.allowMultipleSelections.of(true)] : [])];
      const state = EditorState.create({ doc, selection: { anchor: from }, extensions });
      mock.view.state = state; mock.reattach();
      const run = mock.addRun({ key: '0:12', text: 'visible formatted text', left: 160 });
      const target = new (mock.content.constructor)(); target.textContent = '**';
      if (stop === 'outside') mock.root.append(target); else mock.content.append(target);
      if (stop === 'reduced') mock.app.dataset.motion = 'reduced';
      if (stop === 'composing') mock.view.composing = true;
      mock.fire('mousedown', { button: 0, target, clientX: 200, clientY: 100 });
      if (stop === 'drag') mock.docFire('mousemove', { buttons: 1, clientX: 215, clientY: 100 });
      if (stop === 'scroll') { mock.view.scrollDOM.scrollTop = 20; mock.view.scrollDOM.fire('scroll'); }
      const selection = stop === 'multiple'
        ? EditorSelection.create([EditorSelection.cursor(to), EditorSelection.cursor(to + 4)]) : { anchor: to };
      const tr = state.update({ selection, userEvent: 'select.pointer' });
      if (stop === 'multiple') assert.equal(tr.state.selection.ranges.length, 2);
      mock.view.state = tr.state; run.rect.left += 4;
      updateMarkdownMotion({ view: mock.view, state: tr.state, startState: state, transactions: [tr], changes: tr.changes,
        docChanged: false, selectionSet: true, geometryChanged: false, focusChanged: false });
      mock.flush();
      assert.equal(mock.animations.some(animation => animation.playState === 'running'), false,
        `${stop} must cancel or avoid taking the formatting baseline`);
    } finally { mock.close(); }
  }
});

test('controller paints only the native caret after immediate insertion and cancels on rapid input', async () => {
  const mock = await mockView();
  try {
    mock.input(); mock.apply({ from: 3, insert: 'd' }, 4);
    assert.equal(mock.view.state.doc.toString(), 'abcd', 'document updates before the measure/animation');
    mock.flush();
    const first = mock.animations.find(animation => animation.options.duration === 75);
    assert.deepEqual(first.frames[0], { transform: 'translate(-10px, 0px)' });
    let reads = 0;
    const originalRect = mock.cursor.getBoundingClientRect.bind(mock.cursor);
    mock.cursor.getBoundingClientRect = () => { reads++; return originalRect(); };
    mock.setClock(140); mock.fire('beforeinput', { inputType: 'insertText' });
    assert.equal(reads, 0, 'rapid input takes no new caret geometry read before editing');
    mock.apply({ from: 4, insert: 'e' }, 5); mock.flush();
    assert.equal(mock.view.state.doc.toString(), 'abcde');
    assert.equal(first.playState, 'idle');
    assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
  } finally { mock.close(); }
});

test('a deletion echo lives outside editable content, is aria-hidden, and never delays deletion', async () => {
  const mock = await mockView();
  try {
    mock.setClock(200); mock.fire('keydown', { key: 'Backspace', repeat: false });
    mock.apply({ from: 2, to: 3 }, 2, 'delete.backward');
    assert.equal(mock.view.state.doc.toString(), 'ab'); mock.flush();
    const layer = mock.root.children.find(node => node.className === 'cm-edit-echo-layer');
    assert.ok(layer); assert.equal(layer.attrs['aria-hidden'], 'true'); assert.equal(layer.children[0].textContent, 'c');
    const echo = mock.animations.find(animation => animation.options.duration === 110);
    assert.equal(echo.frames.at(-1).opacity, 0); echo.onfinish(); assert.equal(layer.isConnected, false);
    assert.equal(mock.view.state.selection.main.head, 2);
  } finally { mock.close(); }
});

test('keydown plus beforeinput for one deletion shares a capture, and animation failures leave editing intact', async () => {
  const mock = await mockView();
  try {
    mock.setClock(200); mock.fire('keydown', { key: 'Backspace', repeat: false });
    mock.fire('beforeinput', { inputType: 'deleteContentBackward', isComposing: false });
    mock.apply({ from: 2, to: 3 }, 2, 'delete.backward'); mock.flush();
    assert.ok(mock.root.children.some(node => node.className === 'cm-edit-echo-layer'));
    mock.setClock(500); mock.cursor.animate = () => { throw Error('animation unavailable'); };
    mock.fire('beforeinput', { inputType: 'insertText', isComposing: false });
    mock.apply({ from: 2, insert: '中' }, 3); assert.doesNotThrow(mock.flush);
    assert.equal(mock.cursor.style.willChange, '', 'WAAPI failure must not retain a layer hint');
    assert.equal(mock.view.state.doc.toString(), 'ab中');
    assert.equal(mock.view.state.selection.main.head, 3);
    assert.equal(mock.root.children.some(node => node.className === 'cm-edit-echo-layer'), false);
  } finally { mock.close(); }
});

test('scaled deletion echoes convert viewport geometry to editor CSS coordinates', async () => {
  const mock = await mockView();
  try {
    mock.view.scaleX = mock.view.scaleY = 2;
    mock.root.rect.width = 1600; mock.root.rect.height = 40;
    mock.cursor.rect = { left: 160, top: 100, width: 1, height: 40 };
    mock.view.coordsAtPos = head => ({ left: 100 + head*20, right: 101 + head*20, top: 100, bottom: 140 });
    mock.root.ownerDocument.createRange = () => { let from, to; return {
      setStart(_node,pos) { from = pos; }, setEnd(_node,pos) { to = pos; },
      toString: () => mock.view.state.sliceDoc(from,to),
      getClientRects: () => [{ left: 100 + from*20, top: 100, width: (to-from)*20, height: 40 }],
    }; };
    mock.setClock(200); mock.fire('keydown', { key: 'Backspace', repeat: false });
    mock.apply({ from: 2, to: 3 }, 2, 'delete.backward'); mock.flush();
    const ghost = mock.root.children.find(node => node.className === 'cm-edit-echo-layer').children[0];
    assert.equal(ghost.style.left, '20px');
    assert.equal(100 + parseFloat(ghost.style.left)*2, 140, 'rendered glyph viewport x matches the captured x');
    assert.equal(ghost.style.lineHeight, '20px');
  } finally { mock.close(); }
});

test('real Backspace command affinity skips a soft-wrap crossing after CM layer writes', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { deleteCharBackward } = await import('@codemirror/commands');
  const { updateMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  const mock = await mockView();
  try {
    mock.view.state = EditorState.create({ doc: 'abcdefgh', selection: { anchor: 5 } });
    mock.cursor.rect = { left: 110, top: 120, width: 1, height: 20 };
    const sides = [];
    mock.view.coordsAtPos = (head, side = 1) => {
      assert.equal(head, 4); sides.push(side);
      return side < 0 ? { left: 140, right: 140, top: 100, bottom: 120 } : { left: 100, right: 100, top: 120, bottom: 140 };
    };
    mock.root.ownerDocument.createRange = () => { let from, to; return {
      setStart(_node,pos) { from = pos; }, setEnd(_node,pos) { to = pos; },
      toString: () => mock.view.state.sliceDoc(from,to), getClientRects: () => [{ left: 100, top: 120, width: 10, height: 20 }],
    }; };
    mock.setClock(200); mock.fire('keydown', { key: 'Backspace', repeat: false });
    let transaction;
    assert.equal(deleteCharBackward({ state: mock.view.state, dispatch: value => { transaction = value; } }), true);
    const before = mock.view.state; mock.view.state = transaction.state;
    mock.view.requestMeasure({ key: {}, read: () => ({ left: 140, top: 100, width: 1, height: 20 }), write: rect => { mock.cursor.rect = rect; } });
    updateMarkdownMotion({ view: mock.view, state: transaction.state, startState: before, transactions: [transaction],
      changes: transaction.changes, docChanged: true, selectionSet: true, geometryChanged: false, focusChanged: false });
    mock.flush();
    assert.equal(transaction.state.selection.main.assoc, -1);
    assert.deepEqual(sides, [-1]);
    assert.equal(mock.animations.length, 0, 'crossing actual visual lines must snap, never tween on the wrong line');
    assert.equal(mock.view.state.doc.toString(), 'abcdfgh');
    assert.equal(mock.cursor.rect.top, 100);
  } finally { mock.close(); }
});

test('root movement or a scale change invalidates queued editing geometry', async () => {
  for (const kind of ['position', 'scale']) {
    const mock = await mockView();
    try {
      mock.input('deleteContentBackward'); mock.apply({ from: 2, to: 3 }, 2, 'delete.backward');
      if (kind === 'position') mock.root.rect.left += 100;
      else mock.view.scaleX = 1.5;
      mock.flush();
      assert.equal(mock.animations.length, 0);
      assert.equal(mock.root.children.length, 0);
      assert.equal(mock.view.state.doc.toString(), 'ab');
    } finally { mock.close(); }
  }
});

test('soft edit motion keeps 120ms caret animation for keyboard navigation and clears echoes before selection changes', async () => {
  const { EditorSelection } = await import('@codemirror/state');
  const { updateMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  const mock = await mockView();
  try {
    mock.input('deleteContentBackward'); mock.apply({ from: 2, to: 3 }, 2, 'delete.backward'); mock.flush();
    assert.equal(mock.animations.filter(animation => animation.element === mock.cursor && animation.playState === 'running').length, 1);
    const before = mock.view.state, tr = before.update({ selection: EditorSelection.create([EditorSelection.cursor(1)]), userEvent: 'select' });
    mock.view.state = tr.state;
    mock.view.requestMeasure({ key: {}, read: () => ({ left: 110, top: 100, width: 1, height: 20 }), write: rect => { mock.cursor.rect = rect; } });
    updateMarkdownMotion({ view: mock.view, state: tr.state, startState: before, transactions: [tr], changes: tr.changes,
      docChanged: false, selectionSet: true, geometryChanged: false, focusChanged: false });
    assert.equal(mock.root.children.length, 0, 'a keyboard navigation immediately removes the text echo');
    mock.flush();
    assert.equal(mock.animations.filter(animation => animation.element === mock.cursor && animation.playState === 'running').length, 1);
    assert.equal(mock.animations.filter(animation => animation.element === mock.cursor).at(-1).options.duration, 120);
    mock.input(); mock.apply({ from: 1, insert: 'x' }, 2); mock.flush();
    assert.equal(mock.animations.filter(animation => animation.element === mock.cursor && animation.playState === 'running').length, 1);
    assert.equal(mock.animations.filter(animation => animation.element === mock.cursor).at(-1).options.duration, 75);
    mock.view.scrollDOM.fire('scroll');
    assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
    mock.input(); mock.apply({ from: 2, insert: 'y' }, 3); mock.flush();
    mock.windowFire('blur');
    assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
    assert.equal(mock.view.state.doc.toString(), 'axyb');
  } finally { mock.close(); }
});

test('a same-head affinity change cancels an old caret transform instead of moving it to a different visual side', async () => {
  const { EditorSelection } = await import('@codemirror/state');
  const { updateMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  const mock = await mockView();
  try {
    mock.input(); mock.apply({ from: 3, insert: 'd' }, 4); mock.flush();
    const before = mock.view.state, tr = before.update({ selection: EditorSelection.create([EditorSelection.cursor(4, -1)]), userEvent: 'select' });
    mock.view.state = tr.state;
    updateMarkdownMotion({ view: mock.view, state: tr.state, startState: before, transactions: [tr], changes: tr.changes,
      docChanged: false, selectionSet: true, geometryChanged: false, focusChanged: false });
    mock.flush();
    assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
    assert.equal(mock.cursor.style.willChange, '');
    assert.equal(mock.view.state.selection.main.assoc, -1);
  } finally { mock.close(); }
});

test('reattaching and replacing document state remove old effects and retain only one observer set', async () => {
  const { EditorState } = await import('@codemirror/state');
  const mock = await mockView();
  try {
    mock.input('deleteContentBackward'); mock.apply({ from: 2, to: 3 }, 2, 'delete.backward'); mock.flush();
    const source = mock.view.state;
    mock.reattach(); mock.reattach();
    assert.equal(mock.root.listeners.get('beforeinput').size, 1);
    assert.equal(mock.root.listeners.get('keydown').size, 1);
    assert.equal(mock.root.children.length, 0);
    assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
    assert.equal(mock.view.state, source, 'reattaching presentation does not replace document or history');
    mock.input(); mock.apply({ from: 2, insert: 'c' }, 3);
    const next = EditorState.create({ doc: '另一篇', selection: { anchor: 0 } });
    mock.replaceState(next); mock.flush();
    assert.equal(mock.view.state, next);
    assert.equal(mock.root.children.length, 0);
    assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0, 'old queued measures cannot draw in the new document');
  } finally { mock.close(); }
});

test('actual CodeMirror undo and redo see only the original insertion or deletion transaction', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { history, undo, redo, deleteCharBackward } = await import('@codemirror/commands');
  const { updateMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  for (const operation of ['insert', 'delete']) {
    const mock = await mockView();
    try {
      mock.view.state = EditorState.create({ doc: 'abc', selection: { anchor: 3 }, extensions: [history()] });
      const dispatch = tr => {
        const before = mock.view.state; mock.view.state = tr.state;
        mock.cursor.rect.left = 100 + tr.state.selection.main.head*10;
        updateMarkdownMotion({ view: mock.view, state: tr.state, startState: before, transactions: [tr], changes: tr.changes,
          docChanged: tr.docChanged, selectionSet: true, geometryChanged: false, focusChanged: false }); mock.flush();
      };
      if (operation === 'insert') { mock.input(); mock.apply({ from: 3, insert: '中' }, 4); mock.flush(); }
      else { mock.setClock(200); mock.fire('keydown', { key: 'Backspace' }); assert.equal(deleteCharBackward({ state: mock.view.state, dispatch }), true); }
      const edited = mock.view.state.doc.toString();
      assert.equal(undo({ state: mock.view.state, dispatch }), true);
      assert.equal(mock.view.state.doc.toString(), 'abc');
      assert.equal(mock.view.state.selection.main.head, 3);
      assert.equal(undo({ state: mock.view.state, dispatch }), false, 'motion created no extra undo entry');
      assert.equal(redo({ state: mock.view.state, dispatch }), true);
      assert.equal(mock.view.state.doc.toString(), edited);
      assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
    } finally { mock.close(); }
  }
});

test('forward deletion can fade its glyph while a logically stationary caret stays still', async () => {
  const mock = await mockView();
  try {
    mock.view.state = mock.view.state.update({ selection: { anchor: 1 } }).state;
    mock.cursor.rect.left = 110;
    mock.setClock(200); mock.fire('keydown', { key: 'Delete', repeat: false });
    mock.apply({ from: 1, to: 2 }, 1, 'delete.forward'); mock.flush();
    assert.equal(mock.view.state.doc.toString(), 'ac');
    assert.equal(mock.animations.some(animation => animation.options.duration === 75), false);
    assert.equal(mock.animations.some(animation => animation.options.duration === 110), true);
  } finally { mock.close(); }
});

test('composition, repeat deletion, wrap and pointer interruption preserve immediate text and cancel effects', async () => {
  const mock = await mockView();
  try {
    mock.fire('compositionstart'); mock.input('insertCompositionText'); mock.apply({ from: 3, insert: '中' }, 4, 'input.type.compose'); mock.flush();
    mock.fire('compositionend'); mock.setClock(150); mock.fire('beforeinput', { inputType: 'insertText' }); mock.apply({ from: 4, insert: '文' }, 5); mock.flush();
    assert.equal(mock.view.state.doc.toString(), 'abc中文'); assert.equal(mock.animations.length, 0);
    mock.setClock(500); mock.input(); mock.apply({ from: 5, insert: 'a' }, 6, 'input.type', 140); mock.flush();
    assert.equal(mock.animations.length, 0, 'a wrapped caret snaps to the new line');
    mock.fire('keydown', { repeat: true, key: 'Backspace' }); mock.fire('beforeinput', { inputType: 'deleteContentBackward' });
    mock.apply({ from: 5, to: 6 }, 5, 'delete.backward'); mock.flush(); assert.equal(mock.view.state.doc.toString(), 'abc中文');
    assert.equal(mock.animations.length, 0);
    mock.setClock(1000); mock.input(); mock.apply({ from: 5, insert: 'b' }, 6); mock.flush();
    assert.ok(mock.animations.some(animation => animation.playState === 'running'));
    mock.fire('mousedown', { button: 0 }); assert.equal(mock.animations.filter(animation => animation.playState === 'running').length, 0);
  } finally { mock.close(); }
});

test('off, reduced motion, remote edits and stale queued measures never animate or mutate the document', async () => {
  const mock = await mockView({ enabled: false });
  try {
    mock.input(); mock.apply({ from: 3, insert: 'd' }, 4); mock.flush(); assert.equal(mock.animations.length, 0);
    mock.app.dataset.editMotion = 'soft'; mock.notify();
    mock.apply({ from: 4, insert: 'r' }, 5); mock.flush(); assert.equal(mock.animations.length, 0, 'another pane/remote update has no local input capture');
    mock.input(); mock.apply({ from: 5, insert: 'a' }, 6);
    mock.app.dataset.motion = 'reduced'; mock.notify(); mock.flush(); assert.equal(mock.animations.length, 0);
    assert.equal(mock.view.state.doc.toString(), 'abcdra');
  } finally { mock.close(); }
});
