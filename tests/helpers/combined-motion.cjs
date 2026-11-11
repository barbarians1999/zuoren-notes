// Test-only DOM/WAAPI fixture retained from the reviewed R2 tests.
// It never starts a browser or Electron; the integration wrapper models CM phases.
const assert = require('node:assert/strict');
async function mockView({ enabled = true, echo = true } = {}) {
  const { EditorState } = await import('@codemirror/state');
  const motion = await import('../../src/editor/markdownMotion.ts');
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
    closest(selector) { return selector === '.app' ? app : null; }
    matches() { return false; }
    querySelector(selector) { return selector === '.cm-cursor-primary' ? cursor : null; }
    querySelectorAll(selector) { return selector === '.cm-cursor' ? [cursor] : []; }
    contains(node) { return node === this || this.children.includes(node); }
    setAttribute(k,v) { this.attrs[k] = v; }
    append(node) { this.children.push(node); node.parent = this; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    animate(frames, options) {
      const result = { frames, options, element: this, playState: 'running', cancel() { this.playState = 'idle'; this.oncancel?.(); } };
      animations.push(result); return result;
    }
  }
  const app = new Element(), root = new Element(), content = new Element(), scroll = new Element(), cursor = new Element(), windowEvents = new Element();
  app.dataset = { motion: 'full', editMotion: enabled ? 'soft' : 'off', deleteEcho: echo ? 'on' : 'off' };
  cursor.rect = { left: 130, top: 100, width: 1, height: 20 };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const doc = { addEventListener() {}, removeEventListener() {}, createElement: () => { const node = new Element(); node.ownerDocument = doc; return node; },
    defaultView: { addEventListener: (...args) => windowEvents.addEventListener(...args), removeEventListener: (...args) => windowEvents.removeEventListener(...args), performance: { now: () => clock }, matchMedia: () => media,
      MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} } },
    createRange() { let from, to; return { setStart(_node, pos) { from = pos; }, setEnd(_node, pos) { to = pos; },
      toString: () => view.state.sliceDoc(from, to), getClientRects: () => [{ left: 100 + from * 10, top: 100, width: (to-from)*10, height: 20 }] }; } };
  for (const node of [app, root, content, scroll, cursor]) node.ownerDocument = doc;
  globalThis.HTMLElement = Element; globalThis.Node = FakeNode; globalThis.HTMLImageElement = class extends Element {};
  globalThis.getComputedStyle = () => ({ font: '18px serif', color: '#29231f', letterSpacing: '0px' });
  scroll.scrollTop = scroll.scrollLeft = 0;
  view = { dom: root, contentDOM: content, scrollDOM: scroll, hasFocus: true, composing: false, compositionStarted: false, scaleX: 1, scaleY: 1,
    state: EditorState.create({ doc: 'abc', selection: { anchor: 3 } }),
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
  return { view, root, content, scroll, doc, measures, motion, cursor, app, animations, media, flush, apply,
    input(type = 'insertText') { clock += 120; root.fire('beforeinput', { inputType: type, isComposing: false }); },
    fire: (name,event) => root.fire(name,event), setClock: now => { clock = now; },
    windowFire: name => windowEvents.fire(name),
    reattach() { motion.attachMarkdownMotion(view); flush(); },
    replaceState(state) { motion.detachMarkdownMotion(view); view.state = state; motion.attachMarkdownMotion(view); flush(); },
    notify: () => observers.forEach(observer => observer.cb()),
    close() { motion.detachMarkdownMotion(view); for (const [key,value] of originals) { if (value) Object.defineProperty(globalThis,key,value); else delete globalThis[key]; } },
  };
}


module.exports = { mockView };
