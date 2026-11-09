require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function withMotionFixture(runTest) {
  const { EditorState } = await import('@codemirror/state');
  const { ensureSyntaxTree } = await import('@codemirror/language');
  const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
  const { attachMarkdownMotion, updateMarkdownMotion, detachMarkdownMotion } = await import('../src/editor/markdownMotion.ts');
  const previousElement = global.HTMLElement;
  const geometry = { top: 100, left: 0, width: 700, runReads: 0, runsAvailable: true, runsMeasurable: true }, animations = [];
  class ElementStub {
    constructor(name) {
      this.name = name; this.isConnected = true; this.dataset = { mdMotionKey: '0:5' };
      this.style = { getPropertyValue: () => '', removeProperty() {}, setProperty() {} };
      this.ownerDocument = { addEventListener() {}, removeEventListener() {}, defaultView: null };
    }
    get clientWidth() { return geometry.width; }
    addEventListener() {}
    removeEventListener() {}
    closest() { return null; }
    getBoundingClientRect() {
      if (this.name === 'run') geometry.runReads++;
      if (this.name === 'run' && !geometry.runsMeasurable) return { left: 0, top: 0, width: 0, height: 0 };
      return { left: this.name === 'run' ? geometry.left : 0, top: this.name === 'content' ? 0 : geometry.top, width: 100, height: 20 };
    }
    animate(frames, options) {
      const animation = { name: this.name, frames, options, playState: 'running',
        cancel() { this.playState = 'idle'; this.oncancel?.(); } };
      animations.push(animation); return animation;
    }
  }
  global.HTMLElement = ElementStub;
  const dom = new ElementStub('dom'), content = new ElementStub('content'), caret = new ElementStub('caret');
  const run = new ElementStub('run'), scroll = new ElementStub('scroll');
  scroll.scrollTop = 0; scroll.scrollLeft = 0;
  dom.querySelector = () => caret;
  content.querySelectorAll = () => geometry.runsAvailable ? [run] : [];
  content.querySelector = () => geometry.runsAvailable ? run : null;
  const pending = new Map();
  const view = { state: EditorState.create({ doc: 'plain **bold**', selection: { anchor: 1 }, extensions: [markdownSyntax()] }),
    hasFocus: true, composing: false, dom, contentDOM: content, scrollDOM: scroll,
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
    await runTest({ geometry, animations, view, pending, flush, update, reflow, run });
  } finally {
    detachMarkdownMotion(view);
    if (previousElement === undefined) delete global.HTMLElement; else global.HTMLElement = previousElement;
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
