require('./typescript-loader.cjs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// This stub tests binding/lifetime contracts, not browser rendering or hit tests.
class ElementStub {
  constructor(tag, attributes = {}) {
    this.tag = tag; this.attributes = new Map(Object.entries(attributes)); this.dataset = {};
    this.children = []; this.listeners = new Map(); this.isConnected = true;
    this.alt = attributes.alt || ''; this.classList = new Set();
    this.style = { setProperty() {} };
  }
  append(child) { child.parent = this; this.children.push(child); return child; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) { return selector === 'a[href]' ? this.tag === 'a' && this.attributes.has('href') : this.tag === 'img' && this.attributes.has('src'); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  contains(child) { return child === this || this.children.some(node => node.contains(child)); }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(candidate => candidate !== listener)); }
  fire(type, options = {}) {
    const event = { target: this, button: 0, ctrlKey: false, metaKey: false, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options };
    for (const listener of this.listeners.get(type) || []) { listener(event); if (event.stopped) break; }
    return event;
  }
}
const priorElement = global.Element;
before(() => { global.Element = ElementStub; });
after(() => { if (priorElement === undefined) delete global.Element; else global.Element = priorElement; });
const settle = () => new Promise(resolve => setImmediate(resolve));
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture({ images = [], links = [], ...overrides } = {}) {
  const { bindMarkdownTableResources } = await import('../src/editor/markdownTableResources.ts');
  const root = new ElementStub('div'), audit = { assets: [], links: [], errors: [], measures: 0 }, state = { current: true };
  const imageNodes = images.map(src => root.append(new ElementStub('img', { src, alt: '图片' })));
  const linkNodes = links.map(href => root.append(new ElementStub('a', href === null ? {} : { href })));
  const dispose = bindMarkdownTableResources(root, {
    notePath: '/notes/note.md', isCurrent: () => state.current,
    assetUrl: async path => { audit.assets.push(path); return 'reader-asset://local/asset-' + audit.assets.length; },
    openLink: async href => { audit.links.push(href); },
    onError: error => audit.errors.push(error.message), requestMeasure: () => audit.measures++, ...overrides,
  });
  return { root, imageNodes, linkNodes, audit, state, dispose };
}

test('table images use their note directory and decode rendered URL escapes once', async () => {
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  const { decodeHTMLStrict } = await import('entities');
  const source = '| Image | Reference |\n| --- | --- |\n| ![图](<./中文😀 a.png>) | ![ref][pic] |\n| ![percent](a%2520b.png) | ![amp](a&amp;amp;b.png) |\n\n[pic]: a\\(b\\).png';
  const html = parseMarkdown(source);
  const images = [...html.matchAll(/<img src="([^"]*)"/g)].map(match => decodeHTMLStrict(match[1]));
  const f = await fixture({ images, notePath: 'C:\\notes\\note.md' });
  assert.equal(images.length, 4);
  assert.ok(f.imageNodes.every(image => image.getAttribute('src') === null), 'do not fetch note-relative paths from the app directory');
  await settle();
  assert.deepEqual(f.audit.assets, ['C:\\notes\\中文😀 a.png', 'C:\\notes\\a(b).png', 'C:\\notes\\a%20b.png', 'C:\\notes\\a&amp;b.png']);
  assert.ok(f.imageNodes.every(image => image.getAttribute('src').startsWith('reader-asset://local/')));
  f.imageNodes[0].fire('load'); assert.equal(f.audit.measures, 1, 'image height changes request editor measurement');
  f.dispose(); f.imageNodes[0].fire('load'); assert.equal(f.audit.measures, 1);
});

test('safe remote, data, blob and checked asset images retain their URL without local IPC', async () => {
  const images = ['https://example.test/pic.png?a=1&b=2', 'data:image/png;base64,eA==', 'blob:local-image', 'reader-asset://local/token'];
  const f = await fixture({ images }); await settle();
  assert.deepEqual(f.audit.assets, []);
  assert.deepEqual(f.imageNodes.map(image => image.getAttribute('src')), images);
  f.imageNodes[0].fire('load'); assert.equal(f.audit.measures, 1);
  f.dispose();
});

test('malformed and unsupported image URLs fail independently without reaching asset IPC', async () => {
  const f = await fixture({ images: ['./bad%ZZ.png', 'file:///private/a.png', './good.png'] }); await settle();
  assert.deepEqual(f.audit.assets, ['/notes/good.png']);
  assert.equal(f.audit.errors.length, 2);
  for (const image of f.imageNodes.slice(0, 2)) {
    assert.match(image.alt, /无法加载/); assert.ok(image.classList.has('cm-md-image-error')); assert.equal(image.getAttribute('src'), null);
  }
  assert.match(f.imageNodes[2].getAttribute('src'), /^reader-asset:/);
  f.dispose();
});

test('asset failure stays visible, reports once and does not throw if the error callback fails', async () => {
  const f = await fixture({ images: ['./missing.png'], assetUrl: async () => { throw Error('missing attachment'); }, onError: () => { throw Error('callback'); } });
  await settle(); assert.match(f.imageNodes[0].alt, /无法加载/); assert.equal(f.audit.measures, 1);
  f.imageNodes[0].fire('error'); assert.equal(f.audit.measures, 1, 'one failure is not reported twice');
  f.dispose();
});

for (const invalidation of ['dispose', 'reconfigure', 'disconnect']) {
  test('late table asset resolution is ignored after ' + invalidation, async () => {
    const load = pending(), requests = [];
    const f = await fixture({ images: ['./delayed.png'], assetUrl: path => { requests.push(path); return load.promise; } });
    await settle(); assert.deepEqual(requests, ['/notes/delayed.png']);
    if (invalidation === 'dispose') f.dispose();
    else if (invalidation === 'reconfigure') f.state.current = false;
    else f.root.isConnected = false;
    load.resolve('reader-asset://local/late'); await settle();
    assert.equal(f.imageNodes[0].getAttribute('src'), null);
    f.imageNodes[0].fire('load'); f.imageNodes[0].fire('error');
    assert.equal(f.audit.measures, 0); assert.deepEqual(f.audit.errors, []); f.dispose();
  });
}

test('late rejected image requests do not show an error in a different document', async () => {
  const load = pending();
  const f = await fixture({ images: ['./late.png'], assetUrl: () => load.promise }); await settle();
  f.state.current = false; load.reject(Error('old document')); await settle();
  assert.equal(f.imageNodes[0].alt, '图片'); assert.deepEqual(f.audit.errors, []); f.dispose();
});

test('teardown before the first microtask sends neither asset nor link IPC', async () => {
  const { bindMarkdownTableResources } = await import('../src/editor/markdownTableResources.ts');
  for (const invalidation of ['dispose', 'reconfigure', 'disconnect']) {
    const root = new ElementStub('div'), link = root.append(new ElementStub('a', { href: './other.md' })), requests = [];
    root.append(new ElementStub('img', { src: './a.png' })); let current = true;
    const dispose = bindMarkdownTableResources(root, { notePath: '/notes/note.md', isCurrent: () => current,
      requestMeasure() {}, assetUrl: async path => { requests.push(path); return 'reader-asset://local/a'; },
      openLink: async href => { requests.push(href); } });
    root.fire('mousedown', { target: link, ctrlKey: true });
    if (invalidation === 'dispose') dispose(); else if (invalidation === 'reconfigure') current = false; else root.isConnected = false;
    await settle(); assert.deepEqual(requests, [], invalidation); dispose();
  }
});

test('Ctrl and Cmd open sanitized table hrefs once and do not activate the cell on click', async () => {
  const { parseMarkdown } = await import('../src/editor/markdownParser.ts');
  const { decodeHTMLStrict } = await import('entities');
  const source = '| Direct | Reference |\n| --- | --- |\n| [中文😀](<./a b.md>) | [ref][id] |\n| <person@example.com> | [amp](./a&amp;amp;b.md) |\n\n[id]: ./reference%2520file.md';
  const links = [...parseMarkdown(source).matchAll(/<a href="([^"]*)"/g)].map(match => decodeHTMLStrict(match[1]));
  const f = await fixture({ links }); let activations = 0;
  f.root.addEventListener('mousedown', () => activations++); f.root.addEventListener('click', () => activations++);
  assert.deepEqual(f.linkNodes.map(link => link.dataset.markdownLink), links);
  for (const [index, link] of f.linkNodes.entries()) {
    const target = link.append(new ElementStub('strong'));
    const modifiers = index % 2 ? { metaKey: true } : { ctrlKey: true };
    assert.ok(f.root.fire('mousedown', { target, ...modifiers }).defaultPrevented);
    assert.ok(f.root.fire('click', { target, ...modifiers }).defaultPrevented);
  }
  await settle();
  assert.deepEqual(f.audit.links, ['./a%20b.md', './reference%2520file.md', 'mailto:person@example.com', './a&amp;b.md']);
  assert.equal(activations, 0); f.dispose();
});

test('ordinary clicks, hash links, right clicks and anchors stripped of href keep normal table handling', async () => {
  const f = await fixture({ links: ['./file.md', '#heading', null] }); let clicks = 0;
  f.root.addEventListener('click', () => clicks++);
  for (const [target, options] of [[f.linkNodes[0], {}], [f.linkNodes[1], { ctrlKey: true }], [f.linkNodes[0], { button: 2, ctrlKey: true }], [f.linkNodes[2], { ctrlKey: true }]]) {
    assert.equal(f.root.fire('mousedown', { target, ...options }).defaultPrevented, false);
    assert.equal(f.root.fire('click', { target, ...options }).defaultPrevented, false);
  }
  await settle(); assert.equal(clicks, 4); assert.deepEqual(f.audit.links, []); f.dispose();
});

test('releasing the modifier before click does not reveal source, and a later ordinary click still can', async () => {
  const f = await fixture({ links: ['./file.md'] }), target = f.linkNodes[0]; let clicks = 0;
  f.root.addEventListener('click', () => clicks++);
  f.root.fire('mousedown', { target, ctrlKey: true }); f.root.fire('click', { target }); await settle();
  assert.equal(clicks, 0); assert.deepEqual(f.audit.links, ['./file.md']);
  f.root.fire('mousedown', { target }); f.root.fire('click', { target });
  assert.equal(clicks, 1); f.dispose();
});

test('link rejection is reported without changing source or leaving an unhandled promise', async () => {
  const f = await fixture({ links: ['./outside.md'], openLink: async () => { throw Error('not authorized'); } });
  f.root.fire('mousedown', { target: f.linkNodes[0], ctrlKey: true }); await settle();
  assert.deepEqual(f.audit.errors, ['not authorized']); f.dispose();
});

test('table widget identity includes note configuration to avoid reusing URLs from another note', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { buildMarkdownLivePreview, markdownLivePreviewConfig } = await import('../src/editor/markdownLivePreview.ts');
  const doc = 'cursor\n\n| 图片 | 链接 |\n| --- | --- |\n| ![图](./a.png) | [x](./b.md) |';
  const firstConfig = { notePath: '/one/note.md', openImage: async () => {} }, secondConfig = { ...firstConfig, notePath: '/two/note.md' };
  const widgets = [];
  for (const config of [firstConfig, firstConfig, secondConfig]) {
    const state = EditorState.create({ doc, extensions: [markdownSyntax(), markdownLivePreviewConfig.of(config)] });
    buildMarkdownLivePreview(state).between(0, doc.length, (_from, _to, value) => {
      if (value.spec.widget?.constructor.name === 'TableWidget') widgets.push(value.spec.widget);
    });
    assert.equal(state.doc.toString(), doc);
  }
  assert.equal(widgets.length, 3); assert.equal(widgets[0].eq(widgets[1]), true);
  assert.equal(widgets[0].eq(widgets[2]), false); assert.equal(widgets[0].config, firstConfig);
});

test('an equal widget taking over a wrapped table DOM still destroys its original resource binding', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { buildMarkdownLivePreview, markdownLivePreviewConfig } = await import('../src/editor/markdownLivePreview.ts');
  const { default: DOMPurify } = await import('dompurify');
  const { decodeHTMLStrict } = await import('entities');
  const doc = 'cursor\n\n> | 图片 | 链接 |\n> | --- | --- |\n> | ![图](./a.png) | [x](./b.md) |';
  const config = { notePath: '/notes/note.md', openImage: async () => {} }, widgets = [], states = [];
  for (let index = 0; index < 2; index++) {
    const state = EditorState.create({ doc, extensions: [markdownSyntax(), markdownLivePreviewConfig.of(config)] }); states.push(state);
    buildMarkdownLivePreview(state).between(0, doc.length, (_from, _to, value) => {
      if (value.spec.widget?.constructor.name === 'TableWidget') widgets.push(value.spec.widget);
    });
  }
  assert.equal(widgets.length, 2); assert.notEqual(widgets[0], widgets[1]); assert.ok(widgets[0].eq(widgets[1]));
  const oldDocument = global.document, oldWindow = global.window, sanitize = DOMPurify.sanitize, load = pending(), requests = [];
  try {
    // A controlled DOM/sanitizer boundary isolates widget ownership. Native
    // smoke tests, not this stub, cover actual sanitization and HTML layout.
    DOMPurify.sanitize = html => html;
    global.document = { createElement(tag) {
      const element = new ElementStub(tag);
      Object.defineProperty(element, 'innerHTML', { set(html) {
        for (const match of html.matchAll(/<(img|a) (src|href)="([^"]*)"/g)) {
          element.append(new ElementStub(match[1], { [match[2]]: decodeHTMLStrict(match[3]) }));
        }
      } });
      return element;
    } };
    global.window = { reader: { assetUrl: path => { requests.push(path); return load.promise; }, openMarkdownLink: async () => {} } };
    const view = { state: states[0], requestMeasure() {}, dispatch() {}, focus() {} };
    const dom = widgets[0].toDOM(view), table = dom.children[0], image = table.children.find(child => child.tag === 'img');
    assert.equal(dom.className, 'cm-md-block-wrapper'); assert.equal(table.className, 'cm-md-table');
    await settle(); assert.deepEqual(requests, ['/notes/a.png']);
    widgets[1].destroy(dom); // Mirrors CodeMirror WidgetTile DOM reuse via eq.
    load.resolve('reader-asset://local/too-late'); await settle();
    assert.equal(image.getAttribute('src'), null, 'the first instance cannot update the disposed, reused DOM');
    assert.equal(image.listeners.get('load').length, 0);
    assert.equal(image.listeners.get('error').length, 0);
    assert.equal(table.listeners.get('mousedown').length, 1, 'only the cell activation listener remains');
    widgets[1].destroy(dom);
  } finally {
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
    if (sanitize === undefined) delete DOMPurify.sanitize; else DOMPurify.sanitize = sanitize;
  }
});
