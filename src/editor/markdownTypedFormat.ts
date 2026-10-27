import { isolateHistory } from '@codemirror/commands';
import { EditorState, Transaction, type ChangeSet, type EditorSelection, type TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorView, ViewPlugin, type DOMEventHandlers, type ViewUpdate } from '@codemirror/view';
import { crossesCodeBlock, formatSelection, type MarkdownInlineFormat } from './markdownCommands';
import { formatContinuation } from './markdownFormatHistory';

type PendingFormat = {
  key: string;
  base: EditorState;
  changes: ChangeSet;
  afterDoc: EditorState['doc'];
  afterSelection: EditorSelection;
  identity: string;
  time: number;
};

type TypedFormatHandlers = DOMEventHandlers<unknown> & {
  update(update: { docChanged: boolean; selectionSet: boolean; transactions?: readonly { reconfigured?: boolean }[] }): void;
  clear(): void;
};

type EnsureTree = typeof ensureSyntaxTree;

export function markdownTypedFormat(getIdentity: () => string, onError?: (message: string) => void) {
  return ViewPlugin.fromClass(class {
    handlers = markdownTypedFormatHandlers(getIdentity, onError);
    update(update: ViewUpdate) { this.handlers.update(update); }
    destroy() { this.handlers.clear(); }
  }, {
    eventHandlers: {
      keydown(event, view) { return this.handlers.keydown?.(event, view) ?? false; },
      mousedown(event, view) { return this.handlers.mousedown?.(event, view); },
      blur(event, view) { return this.handlers.blur?.(event, view); },
      compositionstart(event, view) { return this.handlers.compositionstart?.(event, view); },
      paste(event, view) { return this.handlers.paste?.(event, view); },
    },
  });
}

export function markdownTypedFormatHandlers(getIdentity: () => string, onError?: (message: string) => void, ensureTree: EnsureTree = ensureSyntaxTree): TypedFormatHandlers {
  let pending: PendingFormat | null = null;
  const clear = () => { pending = null; };

  const handlers: DOMEventHandlers<unknown> = {
    keydown(event, view) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return false;
      const format = typedFormat(event.key);
      if (!format) { clear(); return false; }
      const state = view.state;
      if (event.isComposing || view.composing || state.readOnly || event.ctrlKey || event.metaKey || event.altKey || state.selection.ranges.length !== 1) {
        clear(); return false;
      }
      const selection = state.selection.main;
      if (selection.empty) {
        clear();
        if (event.key === '`') return insertLiteral(event, view, event.key);
        return false;
      }

      const tree = completeSelectionTree(state, selection.to, ensureTree);
      if (!tree) {
        clear(); event.preventDefault(); onError?.('文档仍在解析，请稍后重试'); return true;
      }
      if (crossesCodeBlock(tree, selection.from, selection.to)) {
        clear(); event.preventDefault(); onError?.('选区跨越代码块，请分别选择文字后设置格式'); return true;
      }
      const code = codeContext(selection.from, selection.to, tree);
      if (event.key === '`') {
        clear();
        if (code === 'block') return insertLiteral(event, view, event.key);
      return dispatchFormat(event, view, formatSelection(state, 'code'));
      }
      const identity = getIdentity(), continuation = pending;
      if (continuation && continuation.key === event.key && continuation.identity === identity &&
        state.doc === continuation.afterDoc && state.selection.eq(continuation.afterSelection)) {
        const desired = formatSelection(continuation.base, format);
        if (!desired) { clear(); return false; }
        const desiredTransaction = continuation.base.update(desired);
        const correction = continuation.changes.invert(continuation.base.doc).compose(desiredTransaction.changes);
        const transaction = state.update({ changes: correction, selection: desiredTransaction.newSelection, annotations: [
          Transaction.userEvent.of('input.type.selection-format'),
          Transaction.time.of(continuation.time), isolateHistory.of('after'), formatContinuation.of(true),
        ] });
        clear(); event.preventDefault(); view.dispatch(transaction); return true;
      }
      clear();
      if (code) return false;
      const base = state, time = Date.now();
      const spec = firstFormatSpec(state, event.key);
      if (!spec) return false;
      const transaction = state.update({ ...spec, annotations: [
        Transaction.userEvent.of('input.type.selection-format'),
        Transaction.time.of(time), isolateHistory.of('before'),
      ] });
      event.preventDefault(); view.dispatch(transaction);
      pending = { key: event.key, base, changes: transaction.changes, afterDoc: transaction.state.doc,
        afterSelection: transaction.state.selection, identity, time };
      return true;
    },
    mousedown: clear,
    blur: clear,
    compositionstart: clear,
    paste: clear,
  };
  return Object.assign(handlers, {
    clear,
    update(update: { docChanged: boolean; selectionSet: boolean; transactions?: readonly { reconfigured?: boolean }[] }) {
      if (update.docChanged || update.selectionSet || update.transactions?.some(transaction => transaction.reconfigured)) clear();
    },
  });
}

function typedFormat(key: string): MarkdownInlineFormat | null {
  return key === '*' ? 'bold' : key === '~' ? 'strike' : key === '`' ? 'code' : null;
}

function firstFormatSpec(state: EditorState, key: string): TransactionSpec | null {
  const { from, to, anchor, head } = state.selection.main;
  if (key === '~') {
    const selected = state.sliceDoc(from, to);
    return { changes: { from, to, insert: `~${selected}~` }, selection: {
      anchor: (anchor === from ? from : to) + 1, head: (head === to ? to : from) + 1,
    } };
  }
  return formatSelection(state, 'italic');
}

function dispatchFormat(event: KeyboardEvent, view: EditorView, spec: TransactionSpec | null) {
  if (!spec) return false;
  const transaction = view.state.update({
    ...spec,
    annotations: [Transaction.userEvent.of('input.type.selection-format'), isolateHistory.of('full')],
  });
  event.preventDefault(); view.dispatch(transaction); return true;
}

function completeSelectionTree(state: EditorState, to: number, ensureTree: EnsureTree) {
  const through = Math.min(state.doc.length, paragraphEnd(state, to));
  const alreadyAvailable = syntaxTreeAvailable(state, through);
  let tree;
  try { tree = ensureTree(state, through, 100); } catch { return null; }
  if (!tree || !syntaxTreeAvailable(state, through)) return null;
  return alreadyAvailable ? syntaxTree(state) : tree;
}

function paragraphEnd(state: EditorState, to: number) {
  let line = state.doc.lineAt(to);
  for (let number = line.number + 1; number <= state.doc.lines; number++) {
    line = state.doc.line(number);
    if (!line.text.trim()) return line.to;
  }
  return state.doc.length;
}

function codeContext(from: number, to: number, tree: ReturnType<typeof syntaxTree>): 'inline' | 'block' | null {
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, 1); node; node = node.parent) {
    if (node.name === 'InlineCode' && to <= node.to) return 'inline';
    if (['FencedCode', 'CodeBlock'].includes(node.name) && to <= node.to) return 'block';
  }
  return null;
}

function insertLiteral(event: KeyboardEvent, view: EditorView, text: string) {
  event.preventDefault();
  const transaction = view.state.update({ changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: text },
    selection: { anchor: view.state.selection.main.from + text.length }, userEvent: 'input.type' });
  view.dispatch(transaction); return true;
}
