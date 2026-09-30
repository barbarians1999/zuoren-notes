import React, { useEffect, useRef } from 'react';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { indentUnit } from '@codemirror/language';
import { markdownSyntax } from './markdownLanguage';
import { livePreview } from './markdownLivePreview';
import { markdownClipboard } from './markdownClipboard';
import { exitEmptyBlockquote, formatSourceSelection } from './markdownCommands';

export function MarkdownSourceEditor({ notePath, value, onChange, onView, onSelectionChange }: { notePath: string; value: string; onChange: (value: string) => void; onView: (view: EditorView | null) => void; onSelectionChange: (selection: { from: number; to: number; left: number; top: number; width: number; height: number } | null) => void }) {
  const root = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const callback = useRef(onView); callback.current = onView;
  const selectionCallback = useRef(onSelectionChange); selectionCallback.current = onSelectionChange;
  const lastEmitted = useRef(value);
  const extensionsRef = useRef<Extension[]>([]);
  const externalUpdate = useRef(false);
  useEffect(() => {
    if (!root.current) return;
    const extensions: Extension[] = [
        markdownClipboard, basicSetup, markdownSyntax(), livePreview, indentUnit.of('\t'), EditorState.tabSize.of(4),
        Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyBlockquote }])),
        keymap.of([indentWithTab, { key: 'Mod-b', run: view => formatSourceSelection(view, 'bold') }, { key: 'Mod-i', run: view => formatSourceSelection(view, 'italic') }, { key: 'Mod-Shift-x', run: view => formatSourceSelection(view, 'strike') }]),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged && !externalUpdate.current) {
            lastEmitted.current = update.state.doc.toString();
            change.current(lastEmitted.current);
          }
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
    const view = new EditorView({ parent: root.current, state: EditorState.create({ doc: value, extensions }) });
    viewRef.current = view; callback.current(view);
    return () => { callback.current(null); viewRef.current = null; view.destroy(); };
  }, []);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastEmitted.current || value === view.state.doc.toString()) return;
    // External reloads are explicit snapshots, not local typing echoes.
    externalUpdate.current = true;
    try {
      const anchor = Math.min(view.state.selection.main.head, value.length);
      view.setState(EditorState.create({ doc: value, selection: { anchor }, extensions: extensionsRef.current }));
      lastEmitted.current = value;
    } finally { externalUpdate.current = false; }
  }, [value]);
  return <div className="markdown-source-editor" data-note-path={notePath} ref={root} aria-label="Markdown 源码编辑器"/>;
}
