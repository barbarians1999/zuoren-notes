import { StateField, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { renderMarkdown } from './markdownRendering';

class MarkerWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(other: MarkerWidget) { return other.label === this.label; }
  toDOM() { const el = document.createElement('span'); el.className = 'cm-md-list-marker'; el.textContent = this.label; return el; }
}

class TaskWidget extends WidgetType {
  constructor(readonly position: number, readonly checked: boolean) { super(); }
  eq(other: TaskWidget) { return other.position === this.position && other.checked === this.checked; }
  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = this.checked; input.className = 'cm-md-task-checkbox';
    input.setAttribute('aria-label', this.checked ? '取消完成任务' : '标记任务完成');
    input.disabled = view.state.readOnly;
    input.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('click', event => {
      event.preventDefault();
      if (view.state.readOnly) return;
      const value = view.state.sliceDoc(this.position, this.position + 1);
      if (!/[ xX]/.test(value)) return;
      view.dispatch({ changes: { from: this.position, to: this.position + 1, insert: value.toLowerCase() === 'x' ? ' ' : 'x' }, userEvent: 'input.task' });
    });
    return input;
  }
  ignoreEvent() { return true; }
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly cells: number[]) { super(); }
  eq(other: TableWidget) { return other.from === this.from && other.source === this.source; }
  toDOM(view: EditorView) {
    const el = document.createElement('div'); el.className = 'cm-md-table';
    el.innerHTML = renderMarkdown(this.source);
    el.tabIndex = 0; el.setAttribute('aria-label', '表格，点击单元格编辑 Markdown');
    const activate = (position: number) => { view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus(); };
    let press: { x: number; y: number } | null = null;
    let dragged = false;
    el.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); press = { x: event.clientX, y: event.clientY }; dragged = false;
    });
    el.addEventListener('mousemove', event => {
      if (press && (event.buttons & 1) && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) dragged = true;
    });
    el.addEventListener('click', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const wasDragged = dragged; press = null; dragged = false;
      if (wasDragged) return;
      const cell = (event.target as Element).closest('th,td');
      const index = [...el.querySelectorAll('th,td')].indexOf(cell as Element);
      activate(this.cells[index] ?? this.from);
    });
    el.addEventListener('mouseup', () => setTimeout(() => { press = null; dragged = false; }, 0));
    el.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); activate(this.from); } });
    return el;
  }
  ignoreEvent() { return true; }
}

class CodeBlockWidget extends WidgetType {
  constructor(readonly code: string, readonly from: number, readonly language: string) { super(); }
  eq(other: CodeBlockWidget) { return other.code === this.code && other.from === this.from && other.language === this.language; }
  toDOM(view: EditorView) {
    const box = document.createElement('div'); box.className = 'cm-md-code-preview';
    const pre = document.createElement('pre'), code = document.createElement('code');
    code.textContent = this.code || '\u200b'; pre.append(code); box.append(pre);
    box.tabIndex = 0; box.setAttribute('aria-label', '代码块，点击编辑');
    if (this.language) {
      const label = document.createElement('span'); label.className = 'cm-md-code-language';
      label.textContent = this.language; box.prepend(label);
    }
    const activate = (offset = 0) => {
      view.dispatch({ selection: { anchor: this.from + Math.min(this.code.length, Math.max(0, offset)) }, scrollIntoView: true });
      view.focus();
    };
    let press: { x: number; y: number } | null = null;
    let dragged = false;
    box.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); press = { x: event.clientX, y: event.clientY }; dragged = false;
    });
    box.addEventListener('mousemove', event => {
      if (press && (event.buttons & 1) && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) dragged = true;
    });
    box.addEventListener('click', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const wasDragged = dragged; press = null; dragged = false;
      if (wasDragged) return;
      const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
      let offset = 0;
      if (caret && code.contains(caret.startContainer)) {
        const range = document.createRange(); range.selectNodeContents(code);
        range.setEnd(caret.startContainer, caret.startOffset); offset = range.toString().length;
      }
      activate(offset);
    });
    box.addEventListener('mouseup', () => setTimeout(() => { press = null; dragged = false; }, 0));
    box.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); activate(); } });
    return box;
  }
  ignoreEvent() { return true; }
}

class HorizontalRuleWidget extends WidgetType {
  eq(other: HorizontalRuleWidget) { return other.constructor === HorizontalRuleWidget; }
  toDOM() {
    // Keep this an inline replacement. A block replacement changes the
    // CodeMirror line geometry and can make mouse clicks land on the next
    // Markdown line after the rule.
    const rule = document.createElement('span');
    rule.className = 'cm-md-horizontal-rule';
    rule.setAttribute('aria-label', 'Markdown 分隔线');
    return rule;
  }
}

export function buildMarkdownLivePreview(state: EditorState, parseBudget = 120): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  // Initial hydration may parse briefly. Typing has a smaller budget and
  // selection-only updates never force a synchronous full-document parse.
  // Language-worker tree updates finish the remaining decorations safely.
  const tree = (parseBudget > 0 && ensureSyntaxTree(state, state.doc.length, parseBudget)) || syntaxTree(state);
  const active = (from: number, to: number) => state.selection.ranges.some(range => {
    const start = state.doc.lineAt(range.from).from, end = state.doc.lineAt(range.to).to;
    return from <= end && to >= start;
  });
  const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (to > from) ranges.push(Decoration.replace({ widget, block }).range(from, to));
  };
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) ranges.push(Decoration.mark({ class: cls }).range(from, to));
  };
  tree.iterate({ enter(ref) {
    const node = ref.node, { from, to, name } = node;
    if (name === 'FencedCode' || name === 'CodeBlock') {
      if (name === 'FencedCode' && !active(from, to)) {
        const body = node.getChild('CodeText'), info = node.getChild('CodeInfo');
        // Only decorate the view: document bytes, clipboard and undo stay Markdown.
        hide(from, to, new CodeBlockWidget(body ? state.sliceDoc(body.from, body.to) : '', body?.from ?? state.doc.lineAt(from).to,
          info ? state.sliceDoc(info.from, info.to) : ''), true);
      } else {
        mark(from, to, 'cm-md-code-block');
        const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number;
        for (let number = first; number <= last; number++) {
          ranges.push(Decoration.line({ class: 'cm-md-code-line' + (number === first ? ' cm-md-code-first' : '') + (number === last ? ' cm-md-code-last' : '') }).range(state.doc.line(number).from));
        }
      }
      return false;
    }
    if (['HTMLBlock', 'CommentBlock', 'Image'].includes(name)) return false;
    if (name === 'Table' && !active(from, to)) {
      const cells: number[] = [];
      const cursor = node.cursor();
      // SyntaxNode.cursor() retains its ancestors: next() can leave this table
      // and walk the rest of the document. Bound the scan to this table so cell
      // click targets stay local and multiple tables do not cause quadratic work.
      do { if (cursor.name === 'TableCell') cells.push(cursor.from); } while (cursor.next() && cursor.from < to);
      hide(from, to, new TableWidget(state.sliceDoc(from, to), from, cells), true);
      return false;
    }
    if (name === 'HorizontalRule' && !active(from, to)) {
      hide(from, to, new HorizontalRuleWidget());
      return false;
    }
    if (name === 'Blockquote') {
      const first = state.doc.lineAt(from).number;
      const last = state.doc.lineAt(Math.max(from, to - 1)).number;
      for (let number = first; number <= last; number++) {
        ranges.push(Decoration.line({ class: 'cm-md-quote' }).range(state.doc.line(number).from));
      }
    }
    if (/^(ATX|Setext)Heading/.test(name)) {
      const level = Number(name.slice(-1));
      mark(from, to, 'cm-md-heading cm-md-heading-' + level);
      if (!active(from, to)) for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'HeaderMark') {
          let end = child.to;
          while (end < to && state.sliceDoc(end, end + 1) === ' ') end++;
          hide(child.from, end);
        }
      }
    }
    const inlineClass: Record<string, string> = { StrongEmphasis: 'strong', Emphasis: 'emphasis', Strikethrough: 'strikethrough', InlineCode: 'inline-code', Highlight: 'highlight' };
    if (inlineClass[name]) {
      mark(from, to, 'cm-md-' + inlineClass[name]);
      if (!active(from, to)) for (let child = node.firstChild; child; child = child.nextSibling) {
        if (/^(EmphasisMark|StrikethroughMark|CodeMark|HighlightMark)$/.test(child.name)) hide(child.from, child.to);
      }
      if (name === 'InlineCode') return false;
    }
    if (name === 'ListItem') {
      const marker = node.getChild('ListMark'), task = node.getChild('Task')?.getChild('TaskMarker');
      if (marker) {
        const line = state.doc.lineAt(marker.from);
        for (let cursor = line.from; cursor < marker.from;) {
          const tab = state.sliceDoc(cursor, cursor + 1) === '\t';
          let end = cursor + 1;
          while (end < marker.from && (state.sliceDoc(end, end + 1) === '\t') === tab) end++;
          mark(cursor, end, tab ? 'cm-md-indent-tab' : 'cm-md-indent-space');
          cursor = end;
        }
        mark(marker.to, line.to, 'cm-md-list');
        if (!active(line.from, line.to)) {
          if (task) hide(marker.from, task.to, new TaskWidget(task.from + 1, /x/i.test(state.sliceDoc(task.from, task.to))));
          else {
            let end = marker.to; while (end < line.to && state.sliceDoc(end, end + 1) === ' ') end++;
            hide(marker.from, end, new MarkerWidget(node.parent?.name === 'OrderedList' ? state.sliceDoc(marker.from, marker.to) : '•'));
          }
        }
      }
    }
    if (name === 'QuoteMark' && !active(from, to)) hide(from, to);
    if (name === 'Link') {
      mark(from, to, 'cm-md-link');
      if (!active(from, to)) {
        const marks = node.getChildren('LinkMark');
        if (marks.length >= 2) { hide(marks[0].from, marks[0].to); hide(marks[1].from, to); }
      }
    }
  } });
  return Decoration.set(ranges, true);
}

export const livePreview = StateField.define<DecorationSet>({
  create: buildMarkdownLivePreview,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    if (!transaction.docChanged && !treeChanged) {
      if (!transaction.selection || activeLineKey(transaction.startState) === activeLineKey(transaction.state)) return value;
    }
    return buildMarkdownLivePreview(transaction.state, transaction.docChanged ? 20 : 0);
  },
  provide: field => EditorView.decorations.from(field),
});

function activeLineKey(state: EditorState) {
  return state.selection.ranges.map(range => `${state.doc.lineAt(range.from).number}:${state.doc.lineAt(range.to).number}`).join(',');
}
