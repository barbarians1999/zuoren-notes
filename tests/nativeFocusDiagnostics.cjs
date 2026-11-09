const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// These observers run in the test-owned main process and renderer. They never
// focus a window/element, alter a selection, or change the focus wait policy.
function observeNativeFocus({ app, BrowserWindow }, { key, limit }) {
  const events = [], listeners = [];
  const snapshot = () => ({
    at: Date.now(), focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
    windows: BrowserWindow.getAllWindows().map(win => {
      const destroyed = win.isDestroyed();
      return { id: win.id, destroyed, ...(!destroyed ? {
        focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(),
        contentFocused: !win.webContents.isDestroyed() && win.webContents.isFocused(),
      } : {}) };
    }),
  });
  const record = (source, event, id = null) => {
    let state;
    try { state = snapshot(); } catch (error) { state = { at: Date.now(), diagnosticError: error.message }; }
    events.push({ source, event, id, ...state });
    if (events.length > limit) events.shift();
  };
  const listen = (target, event, handler) => {
    target.on(event, handler); listeners.push(() => target.removeListener(event, handler));
  };
  const register = win => {
    const id = win.id;
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'closed'])
      listen(win, event, () => record('window', event, id));
    for (const event of ['focus', 'blur', 'did-finish-load', 'render-process-gone'])
      listen(win.webContents, event, () => record('webContents', event, id));
    record('window', 'observed', id);
  };
  globalThis[key] = {
    read: () => {
      let current;
      try { current = snapshot(); } catch (error) { current = { at: Date.now(), diagnosticError: error.message }; }
      return { current, events: [...events], product: { version: app.getVersion(), packaged: app.isPackaged } };
    },
    dispose: () => { for (const remove of listeners) { try { remove(); } catch {} } delete globalThis[key]; },
  };
  try {
    for (const win of BrowserWindow.getAllWindows()) register(win);
    listen(app, 'browser-window-created', (_event, win) => {
      try { register(win); } catch (error) {
        events.push({ at: Date.now(), event: 'registration-error', diagnosticError: error.message });
        if (events.length > limit) events.shift();
      }
    });
  } catch (error) { globalThis[key].dispose(); throw error; }
}

function observeRendererFocus({ key, limit }) {
  const events = [], listeners = [];
  const describe = element => element instanceof Element ? {
    tag: element.tagName, classes: typeof element.className === 'string' ? element.className : '',
    role: element.getAttribute('role'), inSettings: !!element.closest('.settings-menu'),
    inWindowControls: !!element.closest('.window-controls'),
  } : null;
  const snapshot = () => {
    const panel = document.querySelector('.settings-popover');
    const content = document.querySelector('[data-pane-id="primary"] .cm-content');
    const selection = content?.cmTile?.root?.view?.state.selection.main;
    return {
      at: Date.now(), focused: document.hasFocus(), visibility: document.visibilityState,
      active: describe(document.activeElement),
      settings: { present: !!panel, hidden: panel?.getAttribute('aria-hidden') ?? null, inert: panel?.inert ?? null,
        expanded: document.querySelector('.settings-menu > button')?.getAttribute('aria-expanded') ?? null },
      selection: selection ? { anchor: selection.anchor, head: selection.head } : null,
    };
  };
  const record = event => {
    try {
      events.push({ event: event.type, target: describe(event.target), trusted: event.isTrusted,
        ...(event.type === 'pointerdown' ? { button: event.button, x: event.clientX, y: event.clientY } : {}), ...snapshot() });
    } catch (error) { events.push({ at: Date.now(), diagnosticError: error.message }); }
    if (events.length > limit) events.shift();
  };
  const listen = (target, event, capture = false) => {
    target.addEventListener(event, record, capture);
    listeners.push(() => target.removeEventListener(event, record, capture));
  };
  window[key] = {
    read: () => {
      let current;
      try { current = snapshot(); } catch (error) { current = { at: Date.now(), diagnosticError: error.message }; }
      return { current, events: [...events] };
    },
    dispose: () => { for (const remove of listeners) { try { remove(); } catch {} } delete window[key]; },
  };
  try {
    listen(window, 'focus'); listen(window, 'blur');
    for (const event of ['focusin', 'focusout', 'visibilitychange', 'pointerdown']) listen(document, event, true);
  } catch (error) { window[key].dispose(); throw error; }
  record({ type: 'observed', target: document.activeElement, isTrusted: false });
}

async function boundedRead(operation, timeout = 1500) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Diagnostic read timed out')), timeout); })]);
  } catch (error) { return { diagnosticError: error.message }; }
  finally { clearTimeout(timer); }
}

async function createNativeFocusDiagnostics(app, page, label) {
  const key = '__zuorenFocusTrace_' + randomUUID().replaceAll('-', '');
  const startedAt = Date.now(), phases = [];
  let phase = 'observe', saved = false, windowIds = null;
  const setup = await Promise.all([
    boundedRead(() => app.evaluate(observeNativeFocus, { key, limit: 120 })),
    boundedRead(() => page.evaluate(observeRendererFocus, { key, limit: 120 })),
  ]);
  const identity = {};
  for (const name of ['input-focus-smoke.cjs', 'nativeFocusDiagnostics.cjs', 'electronHarness.cjs']) {
    try { identity[name] = createHash('sha256').update(await fs.readFile(path.join(__dirname, name))).digest('hex'); }
    catch (error) { identity[name] = { diagnosticError: error.message }; }
  }
  return {
    stage(name) { phase = name; phases.push({ at: Date.now(), name }); },
    identify(ids) { windowIds = { ...ids }; },
    async save(outcome, error) {
      if (saved) return;
      saved = true;
      try {
        // Snapshot before the caller destroys the auxiliary window or refocuses
        // the main window. Never infer failure state from app.close diagnostics.
        const [native, renderer] = await Promise.all([
          boundedRead(() => app.evaluate((_electron, name) => globalThis[name]?.read() ?? { diagnosticError: 'Native observer unavailable' }, key)),
          boundedRead(() => page.evaluate(name => window[name]?.read() ?? { diagnosticError: 'Renderer observer unavailable' }, key)),
        ]);
        const directory = process.env.ZUOREN_UI_DIAGNOSTICS || path.join(__dirname, '..', 'logs', 'verification', 'ui-runs', `${startedAt}-${process.pid}`);
        const prefix = `input-focus-${label.replace(/[^a-z0-9-]/gi, '-')}-${startedAt}-${process.pid}`;
        const report = { schemaVersion: 1, label, outcome, phase, startedAt, capturedAt: Date.now(),
          beforeCleanup: true, windowIds, phases, testIdentity: identity, node: process.version,
          setupErrors: setup.filter(value => value?.diagnosticError), native, renderer,
          ...(error ? { error: { name: error.name, message: error.message, stack: error.stack } } : {}) };
        try {
          await fs.mkdir(directory, { recursive: true });
          const destination = path.join(directory, prefix + '.json');
          await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
          console.error(`[input-focus] ${label}/${phase} ${outcome}: ${destination}`);
          if (outcome === 'failed') {
            try { await page.screenshot({ path: path.join(directory, prefix + '.png'), timeout: 1500 }); }
            catch (failure) { console.error('[input-focus] failure screenshot unavailable: ' + failure.message); }
          }
        } catch (failure) {
          console.error('[input-focus] could not persist diagnostic: ' + failure.message);
          console.error('[input-focus] diagnostic fallback: ' + JSON.stringify(report));
        }
      } catch (failure) { console.error('[input-focus] diagnostic unavailable: ' + failure.message); }
    },
    async dispose() {
      await Promise.all([
        boundedRead(() => app.evaluate((_electron, name) => globalThis[name]?.dispose(), key)),
        boundedRead(() => page.evaluate(name => window[name]?.dispose(), key)),
      ]);
    },
  };
}

module.exports = { createNativeFocusDiagnostics, observeNativeFocus, observeRendererFocus, boundedRead };
