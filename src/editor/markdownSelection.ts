import { Direction, EditorView, RectangleMarker, layer } from '@codemirror/view';

// Keep CodeMirror's cursors, multiple ranges and document selection, but paint
// only selected text. The default code-editor layer fills whole wrapped lines
// and includes the centered content's padding, which is misleading in prose.
export const markdownTextSelection = [
  layer({
    above: false,
    class: 'cm-proseSelectionLayer',
    update: update => update.docChanged || update.selectionSet || update.viewportChanged,
    markers(view) {
      const scroll = view.scrollDOM.getBoundingClientRect();
      const left = (view.textDirection === Direction.LTR ? scroll.left : scroll.right - view.scrollDOM.clientWidth * view.scaleX) - view.scrollDOM.scrollLeft * view.scaleX;
      const top = scroll.top - view.scrollDOM.scrollTop * view.scaleY;
      const markers: RectangleMarker[] = [];
      const doc = view.dom.ownerDocument;
      for (const selection of view.state.selection.ranges) {
        if (selection.empty) continue;
        for (const visible of view.visibleRanges) {
          const from = Math.max(selection.from, visible.from), to = Math.min(selection.to, visible.to);
          if (from >= to) continue;
          const start = view.domAtPos(from), end = view.domAtPos(to);
          const range = doc.createRange();
          range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
          const ancestor = range.commonAncestorContainer;
          const walker = doc.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
          let node: Node | null = ancestor.nodeType === Node.TEXT_NODE ? ancestor : walker.nextNode();
          while (node) {
            if (range.intersectsNode(node) && !node.parentElement?.closest('[contenteditable="false"], .cm-widgetBuffer')) {
              const text = doc.createRange();
              text.selectNodeContents(node);
              if (text.compareBoundaryPoints(Range.START_TO_START, range) < 0) text.setStart(range.startContainer, range.startOffset);
              if (text.compareBoundaryPoints(Range.END_TO_END, range) > 0) text.setEnd(range.endContainer, range.endOffset);
              for (const rect of text.getClientRects()) {
                if (rect.width > 0 && rect.height > 0) markers.push(new RectangleMarker('cm-proseSelectionBackground', rect.left - left, rect.top - top, rect.width, rect.height));
              }
            }
            node = walker.nextNode();
          }
        }
      }
      return markers;
    },
  }),
  EditorView.theme({
    '.cm-selectionLayer': { display: 'none' },
    '.cm-proseSelectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  }),
];
