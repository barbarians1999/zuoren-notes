import { useEffect, useRef } from 'react';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab, historyField } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { defaultHighlightStyle, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdownSyntax } from './markdownLanguage';
import { livePreview } from './markdownLivePreview';
import { markdownClipboard } from './markdownClipboard';
import { markdownTextSelection } from './markdownSelection';
import { continueMarkdown, exitEmptyBlockquote, exitEmptyIndent, formatSourceSelection } from './markdownCommands';
import { undoNoteView, redoNoteView, type NoteDocument, type NoteViewState } from '../workspace/noteDocument';

// Keep the existing editing setup, but store undo data only in the document.
function withoutViewHistory(extension: Extension): Extension {
  return extension === historyField ? [] : Array.isArray(extension) ? extension.map(withoutViewHistory) : extension;
}
const documentViewSetup = withoutViewHistory(basicSetup);
// The default code highlight style underlines headings. Override its heading
// rule at the syntax source (which can wrap our decorations), retaining links,
// strike and code colors instead of attempting descendant-only CSS resets.
const proseHighlighting = syntaxHighlighting(HighlightStyle.define(defaultHighlightStyle.specs.map(spec =>
  spec.textDecoration === 'underline' && spec.fontWeight === 'bold' ? { ...spec, textDecoration: 'none' } : spec
)));

export function MarkdownSourceEditor({ notePath, onView, onSelectionChange, sharedDocument, tab }: { notePath: string; onView: (view: EditorView | null) => void; onSelectionChange: (selection: { from: number; to: number; left: number; top: number; width: number; height: number } | null) => void; sharedDocument: NoteDocument; tab: NoteViewState }) {
  const root = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null);
  const callback = useRef(onView); callback.current = onView;
  const selectionCallback = useRef(onSelectionChange); selectionCallback.current = onSelectionChange;
  const extensionsRef = useRef<Extension[]>([]);
  const shared = useRef({ document: sharedDocument, tab }); shared.current = { document: sharedDocument, tab };
  useEffect(() => {
    if (!root.current) return;
    const extensions: Extension[] = [
        markdownClipboard, documentViewSetup, markdownSyntax(), proseHighlighting, livePreview, markdownTextSelection, indentUnit.of('\t'), EditorState.tabSize.of(4),
        Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyIndent }, { key: 'Enter', run: exitEmptyBlockquote }, { key: 'Enter', run: continueMarkdown }, { key: 'Mod-z', run: undoNoteView }, { key: 'Mod-Shift-z', run: redoNoteView }, { key: 'Mod-y', run: redoNoteView }])),
        keymap.of([indentWithTab]),
        Prec.highest(keymap.of([{ key: 'Mod-b', run: view => formatSourceSelection(view, 'bold') }, { key: 'Mod-i', run: view => formatSourceSelection(view, 'italic') }, { key: 'Mod-Shift-x', run: view => formatSourceSelection(view, 'strike') }])),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.selectionSet || update.focusChanged) {
            const selection = update.state.selection.main;
            if (!update.view.hasFocus || selection.empty) {
              selectionCallback.current(null);
              return;
            }
            const start = update.view.coordsAtPos(selection.from);
            const end = update.view.coordsAtPos(selection.to);
            if (!start || !end) {
              selectionCallback.current(null);
              return;
            }
            selectionCallback.current({
              from: selection.from,
              to: selection.to,
              left: Math.min(start.left, end.left),
              top: Math.min(start.top, end.top),
              width: Math.abs(end.left - start.left),
              height: Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top),
            });
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: 'var(--reading-size, 18px)' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--note-body-font)' },
          '.cm-content': { padding: '38px 44px 120px', minHeight: 'calc(100% - 158px)', lineHeight: '1.75', fontSize: 'var(--reading-size, 18px)' },
          '.cm-gutters': { display: 'none' }, '.cm-line': { padding: '0' },
          '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
          '.cm-cursor': { borderLeftColor: 'var(--accent)' },
        }),
      ];
    extensionsRef.current = extensions;
    const view = new EditorView({ parent: root.current, state: EditorState.create({ doc: shared.current.document.state.doc, selection: shared.current.tab.selection, extensions }), dispatchTransactions: (transactions, view) => {
      shared.current.document.dispatch(view, transactions);
    } });
    viewRef.current = view; callback.current(view);
    return () => { callback.current(null); viewRef.current = null; view.destroy(); };
  }, []);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setState(EditorState.create({ doc: sharedDocument.state.doc, selection: tab.selection, extensions: extensionsRef.current }));
    return sharedDocument.attach(view, tab);
  }, [sharedDocument, tab]);
  return <div className="markdown-source-editor" data-note-path={notePath} ref={root} aria-label="Markdown 源码编辑器"/>;
}
