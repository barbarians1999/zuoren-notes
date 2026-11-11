require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function withMotionFixture(runTest, docText = 'plain **bold**', selectionHead = 1) {
  const { EditorState } = await import('@codemirror/state');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { attachMarkdownMotion, updateMarkdownMotion, detachMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  const previousElement = global.HTMLElement;
  const previousNode = global.Node;
  const app = { dataset: { motion: 'full' } };
  const geometry = { top: 100, left: 0, width: 700, runReads: 0, runsAvailable: true, runsMeasurable: true,
    runHeight: 20, extraRuns: [], runLeft: {}, caret: { left: 0, top: 100, width: 1, height: 20 } }, animations = [];
  class NodeStub {}
  class ElementStub extends NodeStub {
    constructor(name) {
      super();
      this.name = name; this.isConnected = true; this.dataset = { mdMotionKey: '0:5' }; this.textContent = '';
      this.listeners = new Map();
      this.style = { getPropertyValue: () => '', removeProperty() {}, setProperty() {} };
      this.ownerDocument = { addEventListener() {}, removeEventListener() {}, defaultView: null };
    }
    get clientWidth() { return geometry.width; }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    fire(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener({ target: this, ...event }); }
    contains(node) { return node === this || (this.name === 'content' && [run, ...geometry.extraRuns].includes(node)) || (this.name === 'dom' && (node === content || [run, ...geometry.extraRuns].includes(node))); }
    closest(selector) { return selector === '.app' ? app : selector === '[data-md-motion-key]' && this.dataset.mdMotionKey ? this : null; }
    getBoundingClientRect() {
      if (this.name.startsWith('run')) geometry.runReads++;
      if (this.name.startsWith('run') && !geometry.runsMeasurable) return { left: 0, top: 0, width: 0, height: 0 };
      if (this.name === 'caret') return { ...geometry.caret, top: geometry.caret.top + geometry.top - 100 };
      return { left: this.name.startsWith('run') ? (geometry.runLeft[this.name] ?? geometry.left) : 0, top: this.name === 'content' ? 0 : geometry.top,
        width: 100, height: this.name.startsWith('run') ? geometry.runHeight : 20 };
    }
    animate(frames, options) {
      const animation = { name: this.name, frames, options, playState: 'running',
        cancel() { this.playState = 'idle'; this.oncancel?.(); } };
      animations.push(animation); return animation;
    }
  }
  global.Node = NodeStub;
  global.HTMLElement = ElementStub;
  const dom = new ElementStub('dom'), content = new ElementStub('content'), caret = new ElementStub('caret');
  const run = new ElementStub('run'), run2 = new ElementStub('run2'), scroll = new ElementStub('scroll');
  const markerElements = {
    '.cm-md-list-prefix': new ElementStub('list-prefix'),
    '.cm-md-ordered-marker': new ElementStub('ordered-marker'),
    '.cm-md-list-marker': new ElementStub('list-marker'),
  };
  scroll.scrollTop = 0; scroll.scrollLeft = 0;
  dom.querySelector = () => caret;
  content.querySelectorAll = selector => selector === '[data-md-motion-key]' ? (geometry.runsAvailable ? [run, ...geometry.extraRuns] : [])
    : markerElements[selector] ? [markerElements[selector]] : [];
  content.querySelector = () => geometry.runsAvailable ? run : null;
  const pending = new Map();
  const view = { state: EditorState.create({ doc: docText, selection: { anchor: selectionHead }, extensions: [markdownSyntax()] }),
    hasFocus: true, composing: false, dom, contentDOM: content, scrollDOM: scroll,
    coordsAtPos: () => ({ left: 0, right: 1, top: geometry.top, bottom: geometry.top + 20 }),
    requestMeasure(request) { if (request) pending.set(request.key, request); },
  };
  ensureSyntaxTree(view.state, view.state.doc.length, 100);
  const flush = () => {
    for (let batch = 0; pending.size && batch < 10; batch++) {
      const requests = [...pending.values()]; pending.clear();
      const measured = requests.map(request => request.read(view));
      requests.forEach((request, index) => request.write?.(measured[index], view));
    }
    assert.equal(pending.size, 0, 'measurement settles without a reflow loop');
  };
  const update = (spec = {}, flags = {}) => {
    const startState = view.state, transaction = startState.update(spec); view.state = transaction.state;
    updateMarkdownMotion({ view, startState, state: view.state, transactions: [transaction], changes: transaction.changes,
      docChanged: transaction.docChanged, selectionSet: !!spec.selection, focusChanged: false, geometryChanged: false, ...flags });
  };
  const reflow = () => updateMarkdownMotion({ view, startState: view.state, state: view.state, transactions: [],
    docChanged: false, selectionSet: false, focusChanged: false, geometryChanged: true });
  try {
    attachMarkdownMotion(view); flush();
    await runTest({ EditorState, markdownSyntax, geometry, animations, view, pending, flush, update, reflow, run, run2, caret, markerElements, app,
      keydown: (key, options = {}) => { const event = { key, target: content, ...options }; dom.fire('keydown', event); return event; } });
  } finally {
    detachMarkdownMotion(view);
    if (previousElement === undefined) delete global.HTMLElement; else global.HTMLElement = previousElement;
    if (previousNode === undefined) delete global.Node; else global.Node = previousNode;
  }
}

for (const notification of ['empty', 'geometry', 'between-read-and-write']) test(`pending Tab motion survives its own ${notification} measurement notification`, async () => {
  await withMotionFixture(({ geometry, animations, pending, flush, update, reflow, run, view }) => {
    run.dataset.mdMotionKey = '6:13'; reflow(); flush();
    update({ changes: { from: 0, insert: '\t' }, selection: { anchor: 2 }, userEvent: 'input.indent' });
    run.dataset.mdMotionKey = '7:14'; geometry.left = 8;
    if (notification === 'empty') update({});
    else if (notification === 'geometry') reflow();
    else {
      const requests = [...pending.values()]; pending.clear();
      const measured = requests.map(request => request.read(view));
      reflow();
      requests.forEach((request, index) => request.write?.(measured[index]));
    }
    flush();
    const text = animations.filter(animation => animation.name === 'run');
    assert.equal(text.length, 1, 'a measure-only update must not cancel the indentation that caused it');
    assert.equal(text[0].frames[0].left, '-8px');
  });
});

test('wrapped format motion measures the first line even when the union bounds stay fixed', async () => {
  await withMotionFixture(({ animations, update, reflow, flush, run }) => {
    let firstLeft = 0;
    run.dataset.mdMotionKey = '8:12'; run.textContent = 'bold';
    run.getClientRects = () => [{ left: firstLeft, top: 100, width: 30, height: 20 }];
    reflow(); flush();
    firstLeft = 16; update({ selection: { anchor: 9 } }); flush();
    const motion = animations.find(animation => animation.name === 'run');
    assert.ok(motion, 'the first visual line moves even when the bounding box does not');
    assert.equal(motion.frames[0].left, '-16px');
  });
});

test('wrapped indentation animates matching text runs when the caret reflow is too distant to tween', async () => {
  await withMotionFixture(({ geometry, animations, update, flush, reflow, run }) => {
    run.dataset.mdMotionKey = '6:13'; reflow(); flush();
    update({ changes: { from: 0, insert: '\t' }, selection: { anchor: 2 }, userEvent: 'input.indent' });
    run.dataset.mdMotionKey = '7:14'; geometry.left = 8; geometry.caret.top += 120;
    flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 1,
      'a long reflow no longer suppresses the local text movement');
    assert.equal(animations.filter(animation => animation.name === 'caret').length, 0,
      'the caret still snaps when its displacement is too large');
  });
});

test('keydown snapshots fresh Tab geometry before it cancels a pending cross-line format animation', async () => {
  const doc = '# Heading\n\n- Parent\n- Child', childFrom = doc.indexOf('- Child'), bodyFrom = childFrom + 2;
  await withMotionFixture(({ geometry, animations, update, reflow, flush, run, keydown, view }) => {
    run.dataset.mdMotionKey = `${bodyFrom}:${doc.length}`; reflowBaseline();
    geometry.left = 30; update({ selection: { anchor: childFrom } }); flush();
    const stale = animations.find(animation => animation.name === 'run' && animation.playState === 'running');
    assert.ok(stale, 'the click/Home state has an older line transition in flight');

    const event = keydown('Tab');
    assert.notEqual(event.defaultPrevented, true, 'the observer leaves Tab available to CodeMirror commands');
    assert.equal(view.state.doc.toString(), doc, 'baseline capture does not edit Markdown');
    assert.equal(stale.playState, 'idle', 'Tab cancels the older transition before taking its own baseline');
    run.dataset.mdMotionKey = `${bodyFrom + 1}:${doc.length + 1}`; geometry.left = 8;
    update({ changes: { from: childFrom, insert: '\t' }, selection: { anchor: childFrom + 1 }, userEvent: 'input.indent' });
    flush();
    const child = animations.filter(animation => animation.name === 'run').at(-1);
    assert.equal(child.frames[0].left, '22px', 'the run uses the pre-command Child geometry, not the prior heading baseline');
    assert.deepEqual(child.frames.map(frame => frame.opacity), [.68, 1]);
    assert.equal(child.options.duration, 190);
    assert.equal(view.state.doc.toString(), doc.slice(0, childFrom) + '\t' + doc.slice(childFrom));

    function reflowBaseline() { reflow(); flush(); }
  }, doc, 1);
});

test('Shift+Tab reuses its own keydown baseline for the dedent transaction', async () => {
  const doc = '# Heading\n\n- Parent\n\t- Child', childFrom = doc.indexOf('\t- Child'), bodyFrom = childFrom + 3;
  await withMotionFixture(({ geometry, animations, update, reflow, flush, run, keydown, view }) => {
    run.dataset.mdMotionKey = `${bodyFrom}:${doc.length}`; reflow(); flush();
    geometry.left = 30; update({ selection: { anchor: childFrom } }); flush();
    const stale = animations.find(animation => animation.name === 'run' && animation.playState === 'running');
    assert.ok(stale);
    const event = keydown('Tab', { shiftKey: true });
    assert.notEqual(event.defaultPrevented, true);
    assert.equal(stale.playState, 'idle');
    run.dataset.mdMotionKey = `${bodyFrom - 1}:${doc.length - 1}`; geometry.left = 8;
    update({ changes: { from: childFrom, to: childFrom + 1, insert: '' }, selection: { anchor: childFrom }, userEvent: 'delete.dedent' });
    flush();
    const child = animations.filter(animation => animation.name === 'run').at(-1);
    assert.equal(child.frames[0].left, '22px');
    assert.deepEqual(child.frames.map(frame => frame.opacity), [.68, 1]);
    assert.equal(child.options.duration, 190);
    assert.equal(view.state.doc.toString(), doc.slice(0, childFrom) + doc.slice(childFrom + 1));
  }, doc, 1);
});

test('Tab keydown invalidates deferred geometry writes from the prior line before they can animate stale runs', async () => {
  const doc = '# Heading\n\n- Parent\n- Child', childFrom = doc.indexOf('- Child');
  await withMotionFixture(({ geometry, animations, pending, update, flush, keydown, view }) => {
    geometry.left = 30; update({ selection: { anchor: childFrom } });
    const staleMeasures = [...pending.values()];
    assert.ok(staleMeasures.length, 'the previous line transition has deferred measure work');
    const before = animations.length;
    keydown('Tab');
    for (const measure of staleMeasures) measure.write?.(measure.read(view), view);
    flush();
    assert.equal(animations.length, before, 'a write queued for the previous selection cannot start after Tab keydown');
  }, doc, 1);
});

for (const guard of ['table', 'composition', 'read-only', 'multi-selection', 'modified']) test(`Tab baseline capture skips ${guard}`, async () => {
  const doc = '# Heading\n\n- Item\n\n| A | B |\n|---|---|\n| C | D |';
  await withMotionFixture(({ EditorState, markdownSyntax, geometry, animations, update, reflow, flush, run, keydown, view }) => {
    run.dataset.mdMotionKey = '2:9'; reflow(); flush();
    const target = guard === 'table' ? doc.indexOf('C |') : doc.indexOf('- Item');
    geometry.left = 30; update({ selection: { anchor: target } }); flush();
    const active = animations.find(animation => animation.name === 'run' && animation.playState === 'running');
    assert.ok(active, 'the fixture has an unrelated format transition to preserve');
    if (guard === 'composition') view.composing = true;
    if (guard === 'read-only') view.state = EditorState.create({ doc, selection: view.state.selection, extensions: [markdownSyntax(), EditorState.readOnly.of(true)] });
    if (guard === 'multi-selection') view.state = view.state.update({ selection: { anchor: target, head: target + 2 } }).state;
    const options = guard === 'modified' ? { ctrlKey: true } : {};
    if (guard === 'modified') options.shiftKey = false;
    const event = keydown('Tab', options);
    assert.notEqual(event.defaultPrevented, true);
    assert.equal(active.playState, 'running', 'ineligible Tab leaves unrelated motion alone');
  }, doc, 1);
});

test('list marker presentation animates only when the source marker mode changes', async () => {
  await withMotionFixture(({ animations, update, flush }) => {
    const initial = animations.length;
    update({ selection: { anchor: 2 } }); flush();
    assert.equal(animations.length, initial, 'moving within the active prefix does not restart its motion');
    update({ selection: { anchor: 4 } }); flush();
    assert.equal(animations.filter(animation => animation.name === 'ordered-marker').length, 1,
      'entering ordered item text gently reveals its active source marker');
    update({ selection: { anchor: 10 } }); flush();
    assert.equal(animations.filter(animation => animation.name === 'list-marker').length, 1,
      'leaving the active ordered item gently reveals its marker widget');
    update({ selection: { anchor: 11 } }); flush();
    assert.equal(animations.length, initial + 2, 'ordinary movement outside a list does not repeat marker motion');
  }, '1. item\nplain', 1);
});

test('bullet prefix source transitions to its widget without animating the editable text', async () => {
  await withMotionFixture(({ animations, update, flush }) => {
    update({ selection: { anchor: 3 } }); flush();
    const marker = animations.find(animation => animation.name === 'list-marker');
    assert.ok(marker); assert.deepEqual(marker.frames, [{ opacity: 0 }, { opacity: 1 }]);
    assert.equal(animations.some(animation => animation.name === 'run' || animation.name === 'caret'), false,
      'the marker opacity animation leaves editable text and caret geometry alone');
  }, '- item\nplain', 1);
});

test('a soft-wrapped long heading keeps one union run animation for all its visual fragments', async () => {
  const { buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
  await withMotionFixture(({ geometry, animations, view, update, reflow, flush, run }) => {
    const source = `\n# ${'长'.repeat(80)}`, from = 3;
    update({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor: 0 } });
    const keys = [];
    buildMarkdownLivePreview(view.state).between(from, source.length, (start, end, value) => {
      const key = value.spec.attributes?.['data-md-motion-key']; if (key) keys.push(key);
    });
    assert.equal(keys.length, 1, 'soft wrapping does not split the Markdown source identity');
    run.dataset.mdMotionKey = keys[0]; geometry.runHeight = 60; flush();
    const priorCount = animations.filter(animation => animation.name === 'run').length;
    geometry.left = 8; update({ selection: { anchor: from + 1 } }); flush();
    const runs = animations.filter(animation => animation.name === 'run');
    assert.equal(runs.length, priorCount + 1);
    assert.equal(runs.at(-1).frames[0].left, '-8px',
      'one transform on the inline run carries its wrapped visual fragments together');
    assert.equal(view.state.doc.toString(), source);
  });
});

test('clicking a newly scrolled heading captures its visible run before selection replaces the old baseline', async () => {
  const title = `LongTitle ${'wrapped heading text '.repeat(7)}`, doc = `# Plain\n\n# ${title}\n\nAfter`,
    titleFrom = doc.indexOf(title), titleTo = doc.indexOf('\n', titleFrom);
  await withMotionFixture(({ geometry, animations, view, update, reflow, flush, run }) => {
    run.dataset.mdMotionKey = '2:7'; reflow(); flush();
    geometry.top = 300; geometry.runHeight = 60; view.scrollDOM.scrollTop = 450; run.dataset.mdMotionKey = `${titleFrom}:${titleTo}`;
    view.dom.fire('mousedown', { target: run, button: 0, clientX: 500, clientY: 330 });
    geometry.left = 24;
    update({ selection: { anchor: titleFrom + 5 }, userEvent: 'select.pointer' }); flush();
    const motion = animations.filter(animation => animation.name === 'run' && animation.playState === 'running');
    assert.equal(motion.length, 1, 'the clicked title run uses its just-captured pre-selection rect');
    assert.equal(motion[0].frames[0].left, '-24px');
    assert.equal(view.state.doc.toString(), doc, 'pointer baseline capture leaves the title source unchanged');
  }, doc, doc.indexOf('Plain') + 1);
});

for (const format of ['heading', 'bold']) test(`soft edit motion still animates ${format} formatting on pointer selection`, async () => {
  const doc = '# Heading\n\nplain\n\n**bold text**', titleFrom = format === 'heading' ? 2 : doc.indexOf('bold text'),
    titleTo = format === 'heading' ? doc.indexOf('\n') : titleFrom + 'bold text'.length;
  await withMotionFixture(({ geometry, animations, view, update, flush, run, app }) => {
    app.dataset.editMotion = 'soft';
    update({ selection: { anchor: doc.indexOf('plain') + 2 } }); flush();
    run.dataset.mdMotionKey = `${titleFrom}:${titleTo}`;
    view.dom.fire('mousedown', { target: run, button: 0, clientX: 10, clientY: 110 });
    geometry.left = 18;
    update({ selection: { anchor: titleFrom + (format === 'heading' ? 3 : 2) }, userEvent: 'select.pointer' });
    flush();
    assert.equal(animations.some(animation => animation.name === 'run' && animation.playState === 'running'), true,
      'the pointer format transition remains animated while edit caret motion is soft');
    assert.equal(animations.some(animation => animation.name === 'caret' && animation.playState === 'running'), false,
      'soft edit motion keeps pointer caret movement immediate');
  }, doc, 0);
});

test('soft edit motion keeps pointer range selection immediate', async () => {
  const doc = '# Heading\n\nplain', titleFrom = 2, titleTo = doc.indexOf('\n');
  await withMotionFixture(({ animations, view, update, flush, run, app }) => {
    app.dataset.editMotion = 'soft'; run.dataset.mdMotionKey = `${titleFrom}:${titleTo}`;
    view.dom.fire('mousedown', { target: run, button: 0, clientX: 10, clientY: 110 });
    update({ selection: { anchor: titleFrom + 1, head: titleFrom + 5 }, userEvent: 'select.pointer' }); flush();
    assert.equal(animations.some(animation => animation.playState === 'running'), false,
      'a pointer range selection remains native with soft edit motion enabled');
  }, doc, 0);
});

test('clicking a second heading preserves the old selected heading run baseline', async () => {
  const doc = '# First title\n\n# Second title\n\nplain', firstFrom = 2,
    firstTo = doc.indexOf('\n'), secondFrom = doc.indexOf('Second title'), secondTo = doc.indexOf('\n', secondFrom);
  await withMotionFixture(({ geometry, animations, view, update, flush, run, run2 }) => {
    geometry.extraRuns = [run2]; geometry.runLeft.run = 0; geometry.runLeft.run2 = 40;
    run.dataset.mdMotionKey = `${firstFrom}:${firstTo}`; run.textContent = 'First title';
    run2.dataset.mdMotionKey = `${secondFrom}:${secondTo}`; run2.textContent = 'Second title';
    update({ selection: { anchor: firstFrom + 2 } }); flush();
    const prior = animations.filter(animation => animation.name.startsWith('run')).length;
    view.dom.fire('mousedown', { target: run2, button: 0, clientX: 40, clientY: 110 });
    geometry.runLeft.run = 12; geometry.runLeft.run2 = 52;
    update({ selection: { anchor: secondFrom + 2 }, userEvent: 'select.pointer' }); flush();
    const motions = animations.filter(animation => animation.name.startsWith('run') && animation.playState === 'running');
    assert.equal(motions.length, 2, 'both the previously selected heading and clicked heading move from their actual prior positions');
    assert.equal(animations.filter(animation => animation.name.startsWith('run')).length, prior + 2);
    assert.deepEqual(motions.map(animation => animation.frames[0].left).sort(), ['-12px', '-12px']);
  }, doc, firstFrom + 2);
});

test('a first click captures preselection text geometry across a separate focus update', async () => {
  const doc = '# Heading\n\nplain', titleFrom = 2, titleTo = doc.indexOf('\n');
  await withMotionFixture(({ geometry, animations, view, update, flush, run }) => {
    run.dataset.mdMotionKey = `${titleFrom}:${titleTo}`;
    view.hasFocus = false; update({}, { focusChanged: true }); flush();
    view.dom.fire('mousedown', { target: run, button: 0, clientX: 10, clientY: 110 });
    view.hasFocus = true; update({}, { focusChanged: true });
    geometry.left = 20;
    update({ selection: { anchor: titleFrom + 3 }, userEvent: 'select.pointer' }); flush();
    const motion = animations.find(animation => animation.name === 'run' && animation.playState === 'running');
    assert.ok(motion, 'the first click animates from its mousedown snapshot after focus returns');
    assert.equal(motion.frames[0].left, '-20px');
  }, doc, doc.indexOf('plain') + 2);
});

for (const guard of ['range-selection', 'composition', 'reduced-motion', 'invisible-run', 'scroll-change']) test(`heading pointer baseline ignores ${guard}`, async () => {
  const title = `LongTitle ${'wrapped heading text '.repeat(3)}`, doc = `# Plain\n\n# ${title}\n\nAfter`,
    titleFrom = doc.indexOf(title), titleTo = doc.indexOf('\n', titleFrom);
  await withMotionFixture(({ geometry, animations, view, update, reflow, flush, run, app }) => {
    run.dataset.mdMotionKey = '2:7'; reflowBaseline();
    geometry.runHeight = 60; run.dataset.mdMotionKey = `${titleFrom}:${titleTo}`; view.scrollDOM.scrollTop = 450;
    if (guard === 'composition') view.composing = true;
    if (guard === 'reduced-motion') app.dataset.motion = 'reduced';
    if (guard === 'invisible-run') geometry.runsMeasurable = false;
    view.dom.fire('mousedown', { target: run, button: 0, clientX: 500, clientY: 330 });
    if (guard === 'scroll-change') view.scrollDOM.scrollTop++;
    geometry.left = 24;
    const selection = guard === 'range-selection' ? { anchor: titleFrom + 1, head: titleFrom + 5 } : { anchor: titleFrom + 5 };
    update({ selection, userEvent: 'select.pointer' });
    geometry.runsMeasurable = true; flush();
    assert.equal(animations.some(animation => animation.name === 'run' && animation.playState === 'running'), false,
      'an invalid pointer snapshot cannot become a text animation baseline');

    function reflowBaseline() { reflow(); flush(); }
  }, doc, doc.indexOf('Plain') + 1);
});

for (const guard of ['composition', 'range-selection', 'reduced-motion', 'blur']) test(`list marker motion respects ${guard}`, async () => {
  await withMotionFixture(({ animations, update, flush, view, app }) => {
    if (guard === 'composition') view.composing = true;
    if (guard === 'reduced-motion') app.dataset.motion = 'reduced';
    if (guard === 'blur') view.hasFocus = false;
    if (guard === 'range-selection') update({ selection: { anchor: 1, head: 4 } });
    else update({ selection: { anchor: 4 } });
    flush();
    assert.equal(animations.some(animation => /marker/.test(animation.name)), false);
  }, '1. item\nplain', 1);
});

for (const level of [1, 2, 3, 4, 5, 6]) test(`level ${level} heading animates on first entry, exit, and repeated disclosure`, async () => {
  const { buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
  await withMotionFixture(({ geometry, animations, view, flush, update, run }) => {
    const source = `${'#'.repeat(level)} 标题😀正文\n\n普通正文`, bodyFrom = level + 1, bodyTo = source.indexOf('\n');
    const syncRun = () => {
      const keys = [];
      buildMarkdownLivePreview(view.state).between(0, bodyTo, (from, to, value) => {
        if (from === bodyFrom && to === bodyTo && value.spec.attributes?.['data-md-motion-key']) keys.push(value.spec.attributes['data-md-motion-key']);
      });
      assert.equal(keys.length, 1, 'the fixture takes its actual heading body key from live preview');
      run.dataset.mdMotionKey = keys[0];
    };
    update({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor: source.length } });
    syncRun(); flush();
    for (const [anchor, left] of [[bodyFrom + 1, 8], [source.length, 0], [bodyTo, 8], [source.length, 0]]) {
      const count = animations.filter(animation => animation.name === 'run').length;
      geometry.left = left; update({ selection: { anchor } }); syncRun(); flush();
      const text = animations.filter(animation => animation.name === 'run');
      assert.equal(text.length, count + 1);
      assert.equal(text.at(-1).frames[0].left, left ? '-8px' : '8px');
    }
    assert.equal(view.state.doc.toString(), source, 'animation and the level label do not edit Markdown');
  });
});

for (const interruption of ['typing', 'selection', 'focus', 'width', 'distant-reflow']) test(`pending Tab still cancels safely for ${interruption}`, async () => {
  await withMotionFixture(({ geometry, animations, view, flush, update, reflow, run }) => {
    run.dataset.mdMotionKey = '6:13'; reflow(); flush();
    update({ changes: { from: 0, insert: '\t' }, selection: { anchor: 2 }, userEvent: 'input.indent' });
    run.dataset.mdMotionKey = '7:14'; geometry.left = 8;
    if (interruption === 'typing') update({ changes: { from: view.state.doc.length, insert: '!' } });
    if (interruption === 'selection') update({ selection: { anchor: 3 } });
    if (interruption === 'focus') { view.hasFocus = false; update({}, { focusChanged: true }); }
    if (interruption === 'width') { geometry.width = 600; reflow(); }
    if (interruption === 'distant-reflow') { geometry.top += 200; reflow(); }
    flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 0);
  });
});

test('same-width asynchronous height changes refresh text motion positions before a later format toggle', async () => {
  await withMotionFixture(({ geometry, pending, reflow, flush, update, animations }) => {
    geometry.top = 400;
    reflow();
    assert.ok(pending.size > 0, 'an image/font height change schedules a new baseline even when width is unchanged');
    flush();
    geometry.left = 8;
    update({ selection: { anchor: 8 } }); flush();
    const text = animations.filter(animation => animation.name === 'run');
    assert.equal(text.length, 1, 'the later format toggle still gets its own local motion');
    assert.deepEqual(text[0].frames, [{ left: '-8px', top: '0px' }, { left: '0px', top: '0px' }]);
  });
});

test('geometry reported together with a format selection change preserves its intended local animation', async () => {
  await withMotionFixture(({ geometry, update, flush, animations }) => {
    geometry.left = 8;
    update({ selection: { anchor: 8 } }, { geometryChanged: true }); flush();
    const text = animations.filter(animation => animation.name === 'run');
    assert.equal(text.length, 1);
    assert.equal(text[0].frames[0].left, '-8px');
    assert.equal(text[0].options.duration, 120);
  });
});

test('the measure-cycle geometry report preserves pending format motion, and later reflow stops it', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations }) => {
    geometry.left = 8;
    update({ selection: { anchor: 8 } });
    reflow(); flush();
    const active = animations.find(animation => animation.name === 'run');
    assert.ok(active, 'the editor can report geometry during the requested change’s measurement');
    assert.equal(active.frames[0].left, '-8px'); assert.equal(active.frames[0].top, '0px');
    geometry.top = 500; reflow(); flush();
    assert.equal(active.playState, 'idle', 'an active text animation stops when the layout moves independently');
  });
});

test('large reflow overlapping a pending format change settles directly and refreshes the next baseline', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations }) => {
    geometry.left = 8;
    update({ selection: { anchor: 8 } });
    geometry.top = 400; reflow(); flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 0,
      'an ambiguous 300px reflow is not animated as a local formatting action');
    geometry.left = 0;
    update({ selection: { anchor: 1 } }); flush();
    const next = animations.find(animation => animation.name === 'run');
    assert.ok(next); assert.equal(next.frames[0].left, '8px'); assert.equal(next.frames[0].top, '0px');
  });
});

test('a pending plain caret move does not mask an unrelated height change', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations }) => {
    update({ selection: { anchor: 2 } });
    geometry.top = 400; reflow(); flush();
    geometry.left = 8;
    update({ selection: { anchor: 8 } }); flush();
    const text = animations.find(animation => animation.name === 'run');
    assert.ok(text); assert.equal(text.frames[0].left, '-8px'); assert.equal(text.frames[0].top, '0px');
  });
});

test('typing supersedes pending format motion before an image-height change', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations, view }) => {
    geometry.left = 8;
    update({ selection: { anchor: 8 } });
    update({ changes: { from: view.state.doc.length, insert: '!' } });
    geometry.top = 400; reflow(); flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 0);
    geometry.left = 0;
    update({ selection: { anchor: 1 } }); flush();
    const next = animations.find(animation => animation.name === 'run');
    assert.ok(next); assert.equal(next.frames[0].top, '0px');
  });
});

test('rapid format reversal overlapping reflow settles before the next ordinary format action', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations }) => {
    geometry.left = 8; update({ selection: { anchor: 8 } });
    geometry.left = 0; update({ selection: { anchor: 1 } });
    geometry.top = 400; reflow(); flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 0);
    geometry.left = 8; update({ selection: { anchor: 8 } }); flush();
    const next = animations.find(animation => animation.name === 'run');
    assert.ok(next); assert.equal(next.frames[0].left, '-8px'); assert.equal(next.frames[0].top, '0px');
  });
});

test('typing cancels active format motion before an independent reflow', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations, view }) => {
    geometry.left = 8; update({ selection: { anchor: 8 } }); flush();
    const active = animations.find(animation => animation.name === 'run'); assert.ok(active);
    update({ changes: { from: view.state.doc.length, insert: '!' } });
    assert.equal(active.playState, 'idle');
    geometry.top = 400; reflow(); flush();
    geometry.left = 0; update({ selection: { anchor: 1 } }); flush();
    assert.equal(animations.filter(animation => animation.name === 'run').at(-1).frames[0].top, '0px');
  });
});

test('ordinary caret movement still avoids reading every text run', async () => {
  await withMotionFixture(({ geometry, update, flush, animations }) => {
    geometry.runReads = 0;
    update({ selection: { anchor: 2 } }); flush();
    assert.equal(geometry.runReads, 0);
    assert.equal(animations.filter(animation => animation.name === 'run').length, 0);
  });
});

for (const anchor of [1, 2]) test(`focus recovery with selection at ${anchor} restores text baseline before the next format change`, async () => {
  await withMotionFixture(({ geometry, update, flush, view, animations }) => {
    view.hasFocus = false; update({}, { focusChanged: true }); flush();
    view.hasFocus = true; update({ selection: { anchor } }, { focusChanged: true }); flush();
    geometry.runReads = 0;
    update({ selection: { anchor: 3 } }); flush();
    assert.equal(geometry.runReads, 0, 'ordinary movement after recovery still reads no text geometry');
    geometry.left = 8;
    update({ selection: { anchor: 8 } }); flush();
    const text = animations.filter(animation => animation.name === 'run');
    assert.equal(text.length, 1, 'the first later format change has a usable baseline');
    assert.deepEqual(text[0].frames, [{ left: '-8px', top: '0px' }, { left: '0px', top: '0px' }]);
  });
});

test('an empty text baseline recovers only when motion runs exist, then ordinary arrows stay measurement-free', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow, animations }) => {
    geometry.runsAvailable = false; reflow(); flush();
    geometry.runReads = 0;
    update({ selection: { anchor: 2 } }); flush();
    assert.equal(geometry.runReads, 0, 'a legitimate empty layout has no text geometry to sample');
    geometry.runsAvailable = true;
    update({ selection: { anchor: 3 } }); flush();
    assert.equal(geometry.runReads, 1, 'newly available text is sampled once to repair the empty baseline');
    geometry.runReads = 0;
    update({ selection: { anchor: 4 } }); flush();
    assert.equal(geometry.runReads, 0, 'a valid baseline is not remeasured on every arrow');
    geometry.left = 8;
    update({ selection: { anchor: 8 } }); flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 1);
  });
});

test('a format change with no prior baseline settles directly rather than inventing old text positions', async () => {
  await withMotionFixture(({ geometry, update, flush, view, animations }) => {
    view.hasFocus = false; update({}, { focusChanged: true }); flush();
    geometry.left = 8;
    view.hasFocus = true; update({ selection: { anchor: 8 } }, { focusChanged: true }); flush();
    assert.equal(animations.filter(animation => animation.name === 'run').length, 0);
    geometry.left = 0;
    update({ selection: { anchor: 1 } }); flush();
    const text = animations.filter(animation => animation.name === 'run');
    assert.equal(text.length, 1, 'the next format change uses the newly established baseline');
    assert.equal(text[0].frames[0].left, '8px');
  });
});

test('temporarily zero-size runs do not create a baseline measurement loop', async () => {
  await withMotionFixture(({ geometry, update, flush, reflow }) => {
    geometry.runsMeasurable = false; reflow(); flush();
    geometry.runReads = 0;
    update({ selection: { anchor: 2 } }); flush();
    assert.equal(geometry.runReads, 1, 'one recovery request settles even if its run still has no rectangle');
    geometry.runsMeasurable = true;
    update({ selection: { anchor: 3 } }); flush();
    geometry.runReads = 0;
    update({ selection: { anchor: 4 } }); flush();
    assert.equal(geometry.runReads, 0, 'a measurable restored baseline stops recovery reads');
  });
});

test('outline navigation cancels a running native-caret transform before any scroll event arrives', async () => {
  await withMotionFixture(({ geometry, animations, pending, flush, update, view }) => {
    update({ selection: { anchor: 2 } });
    const requests = [...pending.values()]; pending.clear();
    const measured = requests.map(request => request.read(view)); geometry.top += 20;
    requests.forEach((request, index) => request.write?.(measured[index])); flush();
    const caret = animations.find(animation => animation.name === 'caret' && animation.playState === 'running'); assert.ok(caret);
    update({ selection: { anchor: 3 }, userEvent: 'select.outline' });
    assert.equal(caret.playState, 'idle', 'navigation owns scrolling before the browser can deliver scroll');
    geometry.top += 20; flush(); assert.equal(animations.filter(animation => animation.playState === 'running').length, 0);
  });
});
test('outline navigation invalidates queued old-caret writes as well as active animations', async () => {
  await withMotionFixture(({ geometry, animations, pending, flush, update, view }) => {
    update({ selection: { anchor: 2 } }); const requests = [...pending.values()]; pending.clear();
    const measured = requests.map(request => request.read(view));
    update({ selection: { anchor: 3 }, userEvent: 'select.outline' }); geometry.top += 20;
    requests.forEach((request, index) => request.write?.(measured[index])); flush();
    assert.equal(animations.filter(animation => animation.playState === 'running').length, 0);
  });
});

for (const phase of ['before-selection', 'between-first-read-write', 'between-final-read-write']) test(`early IME composition prevents format motion ${phase}`, async () => {
  await withMotionFixture(({ geometry, animations, view, pending, flush, update }) => {
    if (phase === 'before-selection') view.compositionStarted = true;
    geometry.left = 8; update({ selection: { anchor: 8 } });
    if (phase !== 'before-selection') {
      const batch = () => { const requests = [...pending.values()]; pending.clear(); return { requests, measured: requests.map(request => request.read(view)) }; };
      let current = batch();
      if (phase === 'between-final-read-write') { current.requests.forEach((request,index) => request.write?.(current.measured[index],view)); current = batch(); }
      view.compositionStarted = true;
      current.requests.forEach((request,index) => request.write?.(current.measured[index],view));
    }
    flush();
    assert.equal(view.composing, false, 'this covers the window before the first IME text transaction');
    assert.equal(animations.filter(animation => animation.playState === 'running').length, 0, 'early composition must use native geometry directly');
    assert.equal(view.state.doc.toString(), 'plain **bold**');
  });
});
for (const phase of ['before-transaction', 'before-read', 'between-read-write']) test(`early IME keeps Tab text immediate without motion ${phase}`, async () => {
  await withMotionFixture(({ geometry, animations, view, pending, flush, update, reflow, run }) => {
    run.dataset.mdMotionKey = '6:13'; reflow(); flush();
    if (phase === 'before-transaction') view.compositionStarted = true;
    update({ changes: { from: 0, insert: '\t' }, selection: { anchor: 2 }, userEvent: 'input.indent' });
    run.dataset.mdMotionKey = '7:14'; geometry.left = 8;
    if (phase === 'before-read') view.compositionStarted = true;
    if (phase === 'between-read-write') {
      const requests = [...pending.values()]; pending.clear(); const values = requests.map(request => request.read(view));
      view.compositionStarted = true; requests.forEach((request,index) => request.write?.(values[index],view));
    }
    flush(); assert.equal(view.state.doc.toString(), '\tplain **bold**'); assert.equal(view.state.selection.main.head, 2);
    assert.equal(animations.filter(animation => animation.playState === 'running').length, 0);
    // A leading Tab makes this sample an indented code block. Restore prose
    // before asserting a new emphasis disclosure; code intentionally has none.
    view.compositionStarted = false;
    update({ changes: { from: 0, to: 1 }, selection: { anchor: 1 }, userEvent: 'input.type' });
    run.dataset.mdMotionKey = '6:13'; geometry.left = 0; flush();
    geometry.left = 8; update({ selection: { anchor: 8 } }); flush();
    assert.ok(animations.some(animation => animation.name === 'run' && animation.playState === 'running'), 'ordinary formatting can resume from a fresh native baseline');
  });
});
for (const phase of ['between-first-read-write', 'between-final-read-write']) test(`early IME late write cancels an older active format animation ${phase}`, async () => {
  await withMotionFixture(({ geometry, animations, view, pending, flush, update }) => {
    geometry.left = 8; update({ selection: { anchor: 8 } }); flush();
    assert.ok(animations.some(animation => animation.name === 'run' && animation.playState === 'running'));
    geometry.left = 0; update({ selection: { anchor: 1 } });
    const batch = () => { const requests = [...pending.values()]; pending.clear(); return { requests, values: requests.map(request => request.read(view)) }; };
    let current = batch();
    if (phase === 'between-final-read-write') { current.requests.forEach((request,index) => request.write?.(current.values[index],view)); current = batch(); }
    view.compositionStarted = true;
    current.requests.forEach((request,index) => request.write?.(current.values[index],view)); flush();
    assert.equal(animations.filter(animation => animation.playState === 'running').length, 0, 'the prior animation must be cancelled, not only the new animation refused');
    assert.equal(view.state.doc.toString(), 'plain **bold**');
  });
});
