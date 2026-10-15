import { StateField, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { renderMarkdown } from './markdownRendering';
import { isResolvedMarkdownLink } from './markdownLinks';
import { decodeMarkdownEntity, projectCodeBlock, projectTable, projectedSourcePosition, type BlockProjection, type CodeProjection, type TableProjection, type TextProjection } from './markdownProjection';

function sameText(left: TextProjection, right: TextProjection) {
  return left.text === right.text && left.anchor === right.anchor && left.segments.length === right.segments.length && left.segments.every((part, index) => {
    const other = right.segments[index];
    return part.displayFrom === other.displayFrom && part.displayTo === other.displayTo && part.sourceFrom === other.sourceFrom && part.sourceTo === other.sourceTo;
  });
}
function sameBlock(left: BlockProjection, right: BlockProjection) {
  return left.from === right.from && left.to === right.to && sameText(left.content, right.content)
    && left.context.quoteDepth === right.context.quoteDepth && left.context.indentColumns === right.context.indentColumns
    && left.context.markers.length === right.context.markers.length && left.context.markers.every((marker, index) => {
      const other = right.context.markers[index]; return marker.column === other.column && marker.label === other.label && marker.source === other.source;
    });
}

function textOffsetAtPoint(element: HTMLElement, event: MouseEvent) {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !element.contains(caret.startContainer)) return null;
  const range = document.createRange(); range.selectNodeContents(element);
  range.setEnd(caret.startContainer, caret.startOffset);
  return range.toString().length;
}

function wrapBlock(view: EditorView, element: HTMLElement, projection: BlockProjection) {
  const { context } = projection;
  if (!context.quoteDepth && !context.indentColumns && !context.markers.length) return element;
  const wrapper = document.createElement('div'); wrapper.className = 'cm-md-block-wrapper';
  wrapper.dataset.quoteDepth = String(context.quoteDepth);
  wrapper.style.setProperty('--md-quote-depth', String(context.quoteDepth));
  wrapper.style.setProperty('--md-list-indent', `${context.indentColumns}ch`);
  for (const marker of context.markers) {
    const label = document.createElement('span'); label.className = 'cm-md-container-marker'; label.textContent = marker.label;
    label.style.left = `calc(var(--md-quote-depth) * var(--md-quote-step) + ${marker.column}ch)`;
    label.addEventListener('mousedown', event => event.preventDefault());
    label.addEventListener('click', () => { view.dispatch({ selection: { anchor: marker.source }, scrollIntoView: true }); view.focus(); });
    wrapper.append(label);
  }
  wrapper.append(element);
  return wrapper;
}

class LiteralWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: LiteralWidget) { return other.text === this.text; }
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-literal'; span.textContent = this.text; return span; }
  ignoreEvent() { return false; }
}

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
  constructor(readonly projection: TableProjection) { super(); }
  get source() { return this.projection.content.text; }
  get from() { return this.projection.from; }
  get cells() { return this.projection.cells.map(cell => cell.anchor); }
  eq(other: TableWidget) { return sameBlock(other.projection, this.projection) && other.projection.references === this.projection.references
    && other.projection.cells.length === this.projection.cells.length && other.projection.cells.every((cell, index) => sameText(cell, this.projection.cells[index])); }
  toDOM(view: EditorView) {
    const el = document.createElement('div'); el.className = 'cm-md-table';
    el.innerHTML = renderMarkdown(this.source + this.projection.references);
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
      const projected = this.projection.cells[index];
      const offset = cell instanceof HTMLElement ? textOffsetAtPoint(cell, event) : null;
      activate(projected ? offset !== null && cell?.textContent === projected.text ? projectedSourcePosition(projected, offset) : projected.anchor : this.from);
    });
    el.addEventListener('mouseup', () => setTimeout(() => { press = null; dragged = false; }, 0));
    el.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); activate(this.from); } });
    return wrapBlock(view, el, this.projection);
  }
  ignoreEvent() { return true; }
}

class CodeBlockWidget extends WidgetType {
  constructor(readonly projection: CodeProjection) { super(); }
  get code() { return this.projection.content.text; }
  get from() { return this.projection.content.anchor; }
  get language() { return this.projection.language; }
  eq(other: CodeBlockWidget) { return other.language === this.language && sameBlock(other.projection, this.projection); }
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
      view.dispatch({ selection: { anchor: projectedSourcePosition(this.projection.content, offset) }, scrollIntoView: true });
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
      activate(textOffsetAtPoint(code, event) ?? 0);
    });
    box.addEventListener('mouseup', () => setTimeout(() => { press = null; dragged = false; }, 0));
    box.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); activate(); } });
    return wrapBlock(view, box, this.projection);
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
  const blocks: ReturnType<Decoration['range']>[] = [];
  const quoteDepths = new Map<number, number>();
  // Initial hydration may parse briefly. Typing has a smaller budget and
  // selection-only updates never force a synchronous full-document parse.
  // Language-worker tree updates finish the remaining decorations safely.
  const tree = (parseBudget > 0 && ensureSyntaxTree(state, state.doc.length, parseBudget)) || syntaxTree(state);
  const active = (from: number, to: number) => state.selection.ranges.some(range => {
    const start = state.doc.lineAt(range.from).from, end = state.doc.lineAt(range.to).to;
    return from <= end && to >= start;
  });
  const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (to > from) {
      const range = Decoration.replace({ widget, block }).range(from, to);
      ranges.push(range);
      if (block) blocks.push(range);
    }
  };
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) ranges.push(Decoration.mark({ class: cls }).range(from, to));
  };
  tree.iterate({ enter(ref) {
    const node = ref.node, { from, to, name } = node;
    if (name === 'FencedCode' || name === 'CodeBlock') {
      if (name === 'FencedCode' && !active(from, to)) {
        const projection = projectCodeBlock(state, node);
        hide(projection.from, projection.to, new CodeBlockWidget(projection), true);
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
      const projection = projectTable(state, node, tree);
      hide(projection.from, projection.to, new TableWidget(projection), true);
      return false;
    }
    if (name === 'HorizontalRule' && !active(from, to)) {
      hide(from, to, new HorizontalRuleWidget());
      return false;
    }
    if (name === 'Blockquote') {
      const first = state.doc.lineAt(from).number;
      const last = state.doc.lineAt(Math.max(from, to - 1)).number;
      let depth = 1;
      for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === 'Blockquote') depth++;
      for (let number = first; number <= last; number++) {
        quoteDepths.set(number, Math.max(depth, quoteDepths.get(number) || 0));
      }
    }
    if (name === 'Escape' && !active(from, to)) { hide(from, from + 1); return false; }
    if (name === 'Entity' && !active(from, to)) { hide(from, to, new LiteralWidget(decodeMarkdownEntity(state.sliceDoc(from, to)))); return false; }
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
          if (!/[\t ]/.test(state.sliceDoc(cursor, cursor + 1))) { cursor++; continue; }
          const tab = state.sliceDoc(cursor, cursor + 1) === '\t';
          let end = cursor + 1;
          while (end < marker.from && /[\t ]/.test(state.sliceDoc(end, end + 1)) && (state.sliceDoc(end, end + 1) === '\t') === tab) end++;
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
    if (name === 'Autolink') {
      mark(from, to, 'cm-md-link');
      if (!active(from, to)) for (const delimiter of node.getChildren('LinkMark')) hide(delimiter.from, delimiter.to);
    }
    if (name === 'Link' && isResolvedMarkdownLink(state, tree, node)) {
      mark(from, to, 'cm-md-link');
      if (!active(from, to)) {
        const marks = node.getChildren('LinkMark');
        if (marks.length >= 2) { hide(marks[0].from, marks[0].to); hide(marks[1].from, to); }
      }
    }
  } });
  for (const [number, depth] of quoteDepths) ranges.push(Decoration.line({ class: 'cm-md-quote', attributes: {
    'data-quote-depth': String(depth), style: `--md-quote-depth: ${depth}`,
  } }).range(state.doc.line(number).from));
  // A whole-line replacement owns its container prefix. Do not also paint a
  // hidden list marker or an orphan quote line above the rendered block.
  blocks.sort((left, right) => left.from - right.from);
  const visible = ranges.filter(range => {
    let low = 0, high = blocks.length;
    while (low < high) { const middle = (low + high) >> 1; if (blocks[middle].to <= range.from) low = middle + 1; else high = middle; }
    const block = blocks[low];
    return !block || block === range || (range.from === range.to ? range.from < block.from : range.to <= block.from);
  });
  return Decoration.set(visible, true);
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
