import { countColumn, Facet, StateField, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { renderMarkdown } from './markdownRendering';
import { bindMarkdownTableResources } from './markdownTableResources';
import { isResolvedMarkdownLink, markdownLinkURL } from './markdownLinks';
import { decodeMarkdownEntity, projectCodeBlock, projectInlineText, projectTable, projectedSourcePosition, type BlockProjection, type CodeProjection, type TableProjection, type TextProjection, type MarkdownNode } from './markdownProjection';
import { reader, resolveLocal } from '../readerContext';

export type MarkdownLivePreviewConfig = { notePath: string; openImage(path: string): Promise<void>; onError?(error: unknown): void };
export const markdownLivePreviewConfig = Facet.define<MarkdownLivePreviewConfig, MarkdownLivePreviewConfig | undefined>({ combine: values => values.at(-1) });

// Compensate source prefix widths in layout while preserving every document position.
function listPrefixes(state: EditorState, node: MarkdownNode) {
  const prefixes: { line: number; columns: number }[] = [];
  for (let item: MarkdownNode | null = node; item; item = item.parent) if (item.name === 'ListItem') {
    const marker = item.getChild('ListMark'); if (!marker) continue;
    const line = state.doc.lineAt(marker.from);
    let end = marker.to; while (end < line.to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
    prefixes.unshift({ line: line.number, columns: countColumn(state.sliceDoc(line.from, end), state.tabSize) - countColumn(state.sliceDoc(line.from, marker.from), state.tabSize) });
  }
  return prefixes;
}
type ListGuide = { column: number; active: boolean; offsetSteps: number; offsetColumns: number };
const sameGuides = (left: ListGuide[], right: ListGuide[]) => left.length === right.length && left.every((guide, index) => guide.column === right[index].column && guide.active === right[index].active && guide.offsetSteps === right[index].offsetSteps && guide.offsetColumns === right[index].offsetColumns);
function listGuides(state: EditorState, node: MarkdownNode, activeItems: Set<number>): ListGuide[] {
  const items: MarkdownNode[] = [], guides: ListGuide[] = [];
  for (let parent: MarkdownNode | null = node; parent; parent = parent.parent) if (parent.name === 'ListItem') items.unshift(parent);
  let previousColumn = 0;
  for (const item of items) {
    const marker = item.getChild('ListMark');
    if (!marker) continue;
    const line = state.doc.lineAt(marker.from);
    const column = countColumn(state.sliceDoc(line.from, marker.from).replace(/>[\t ]?/g, ''), state.tabSize);
    if (column > previousColumn) {
      const parents = item.parent ? listPrefixes(state, item.parent) : [];
      guides.push({ column: (previousColumn + column) / 2, active: activeItems.has(item.from),
        offsetSteps: Math.max(0, parents.length - .5), offsetColumns: parents.reduce((sum, parent) => sum + parent.columns, 0) - (parents.at(-1)?.columns || 0) / 2 });
    }
    previousColumn = column;
  }
  return guides;
}
function guideAttributes(guides: ListGuide[]) {
  const background = guides.map(guide => {
    const left = `var(--md-quote-depth, 0) * var(--md-quote-step) + ${guide.column - guide.offsetColumns} * var(--md-list-space-width, .5ch) + ${guide.offsetSteps} * var(--md-list-gutter, 2em)`;
    const color = `var(--md-list-guide-${guide.active ? 'active' : 'color'})`;
    return `linear-gradient(to right, transparent calc(${left} - .5px), ${color} calc(${left} - .5px) calc(${left} + .5px), transparent calc(${left} + .5px))`;
  }).join(', ');
  return { 'data-list-guides': guides.map(guide => guide.column).join(','),
    'data-list-guide-active': guides.filter(guide => guide.active).map(guide => guide.column).join(','),
    style: `--md-list-guides: ${background}; --md-list-guide-sizes: ${guides.map(() => 'auto').join(', ')}` };
}

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

function decodeImageDestination(source: string) {
  let value = decodeMarkdownEntity(source).trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  const punctuation = (character: string) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 47 || code >= 58 && code <= 64 || code >= 91 && code <= 96 || code >= 123 && code <= 126;
  };
  return value.replace(/\\(.)/gs, (escape, character: string) => punctuation(character) ? character : escape);
}

function textOffsetAtPoint(element: HTMLElement, event: MouseEvent) {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !element.contains(caret.startContainer)) return null;
  const range = document.createRange(); range.selectNodeContents(element);
  range.setEnd(caret.startContainer, caret.startOffset);
  return range.toString().length;
}

function wrapBlock(view: EditorView, element: HTMLElement, projection: BlockProjection, guides: ListGuide[]) {
  const { context } = projection;
  if (!context.quoteDepth && !context.indentColumns && !context.markers.length) return element;
  const wrapper = document.createElement('div'); wrapper.className = 'cm-md-block-wrapper';
  if (guides.length) {
    wrapper.classList.add('cm-md-list-guides');
    for (const [key, value] of Object.entries(guideAttributes(guides))) wrapper.setAttribute(key, value);
  }
  wrapper.dataset.quoteDepth = String(context.quoteDepth);
  wrapper.style.setProperty('--md-quote-depth', String(context.quoteDepth));
  const prefixes = listPrefixes(view.state, syntaxTree(view.state).resolveInner(projection.content.anchor, 1));
  wrapper.style.setProperty('--md-list-indent', `calc(${context.indentColumns - prefixes.reduce((sum, prefix) => sum + prefix.columns, 0)} * var(--md-list-space-width, .5ch) + ${prefixes.length} * var(--md-list-gutter, 2em))`);
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
  constructor(readonly label: string, readonly columns = 0) { super(); }
  eq(other: MarkerWidget) { return other.label === this.label && other.columns === this.columns; }
  toDOM() {
    const el = document.createElement('span'); el.className = 'cm-md-list-marker'; el.textContent = this.label;
    if (this.columns) el.dataset.sourceColumns = String(this.columns);
    return el;
  }
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

// CodeMirror may let a new, equal Widget instance take over an existing DOM
// node without calling toDOM again. Cleanup must follow that node, not an instance.
const tableResourceCleanup = new WeakMap<HTMLElement, () => void>();
class TableWidget extends WidgetType {
  constructor(readonly projection: TableProjection, readonly guides: ListGuide[], readonly config?: MarkdownLivePreviewConfig) { super(); }
  get source() { return this.projection.content.text; }
  get from() { return this.projection.from; }
  get cells() { return this.projection.cells.map(cell => cell.anchor); }
  eq(other: TableWidget) { return other.config === this.config && sameBlock(other.projection, this.projection) && sameGuides(other.guides, this.guides) && other.projection.references === this.projection.references
    && other.projection.cells.length === this.projection.cells.length && other.projection.cells.every((cell, index) => sameText(cell, this.projection.cells[index])); }
  toDOM(view: EditorView) {
    const el = document.createElement('div'); el.className = 'cm-md-table';
    el.innerHTML = renderMarkdown(this.source + this.projection.references);
    const config = this.config;
    const cleanup = config && bindMarkdownTableResources(el, {
      notePath: config.notePath, assetUrl: path => reader().assetUrl(path),
      openLink: href => reader().openMarkdownLink({ sourcePath: config.notePath, href }),
      isCurrent: () => view.state.facet(markdownLivePreviewConfig) === config,
      requestMeasure: () => view.requestMeasure(), onError: config.onError,
    });
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
    const dom = wrapBlock(view, el, this.projection, this.guides);
    if (cleanup) tableResourceCleanup.set(dom, cleanup);
    return dom;
  }
  destroy(dom: HTMLElement) { tableResourceCleanup.get(dom)?.(); tableResourceCleanup.delete(dom); }
  ignoreEvent() { return true; }
}

class CodeBlockWidget extends WidgetType {
  constructor(readonly projection: CodeProjection, readonly guides: ListGuide[]) { super(); }
  get code() { return this.projection.content.text; }
  get from() { return this.projection.content.anchor; }
  get language() { return this.projection.language; }
  eq(other: CodeBlockWidget) { return other.language === this.language && sameBlock(other.projection, this.projection) && sameGuides(other.guides, this.guides); }
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
    return wrapBlock(view, box, this.projection, this.guides);
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

class InlineCodeWidget extends WidgetType {
  private cleanup = new WeakMap<HTMLElement, () => void>();
  constructor(readonly projection: TextProjection) { super(); }
  eq(other: InlineCodeWidget) { return sameText(this.projection, other.projection); }
  toDOM(view: EditorView) {
    const code = document.createElement('code'); code.className = 'cm-md-inline-code-content';
    const text = document.createElement('span'); text.className = 'cm-md-inline-code-text'; text.textContent = this.projection.text || '\u200b'; code.append(text);
    const ownerDocument = code.ownerDocument;
    let stopDrag = () => {};
    this.cleanup.set(code, () => stopDrag());
    code.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); stopDrag();
      const anchor = projectedSourcePosition(this.projection, textOffsetAtPoint(code, event) ?? 0);
      view.dispatch({ selection: { anchor }, scrollIntoView: true }); view.focus();
      const move = (pointer: MouseEvent) => {
        if (!(pointer.buttons & 1)) { stopDrag(); return; }
        const head = view.posAtCoords({ x: pointer.clientX, y: pointer.clientY });
        if (head !== null) view.dispatch({ selection: { anchor, head }, userEvent: 'select.pointer' });
      };
      const finish = () => stopDrag();
      stopDrag = () => {
        ownerDocument.removeEventListener('mousemove', move, true);
        ownerDocument.removeEventListener('mouseup', finish, true);
        ownerDocument.defaultView?.removeEventListener('blur', finish, true);
        view.dom.removeEventListener('blur', finish, true);
        stopDrag = () => {};
      };
      ownerDocument.addEventListener('mousemove', move, true);
      ownerDocument.addEventListener('mouseup', finish, true);
      ownerDocument.defaultView?.addEventListener('blur', finish, true);
      view.dom.addEventListener('blur', finish, true);
    });
    return code;
  }
  destroy(dom: HTMLElement) { this.cleanup.get(dom)?.(); this.cleanup.delete(dom); }
  ignoreEvent() { return true; }
}

class ImageWidget extends WidgetType {
  private mounted = new WeakMap<HTMLElement, () => void>();
  constructor(readonly source: string, readonly alt: string, readonly position: number, readonly config: MarkdownLivePreviewConfig) { super(); }
  eq(other: ImageWidget) { return other.source === this.source && other.alt === this.alt && other.position === this.position && other.config === this.config; }
  toDOM(view: EditorView) {
    const image = document.createElement('img'); image.className = 'cm-md-image'; image.alt = this.alt; image.tabIndex = 0;
    let alive = true;
    this.mounted.set(image, () => { alive = false; });
    const measure = () => { if (alive && image.isConnected) view.requestMeasure(); };
    image.addEventListener('load', measure);
    image.addEventListener('error', () => fail(new Error('Markdown image could not be loaded')));
    const fail = (error: unknown) => {
      if (!alive || !image.isConnected) return;
      image.alt = `${this.alt || '图片'}（无法加载，点击编辑源码）`; image.classList.add('cm-md-image-error');
      try { this.config.onError?.(error); } catch { /* the visible error state remains available */ }
      measure();
    };
    const remote = /^(?:https?:\/\/[^\s]+|data:image\/[^\s]+|blob:[^\s]+|reader-asset:\/\/local\/[^\s]+)$/i.test(this.source);
    let path: string;
    path = remote ? this.source : resolveLocal(this.config.notePath, this.source);
    const load = Promise.resolve().then(() => remote ? this.source : reader().assetUrl(path));
    void load.then(url => {
      if (alive && image.isConnected && view.state.facet(markdownLivePreviewConfig) === this.config) image.src = url;
    }).catch(fail);
    const open = () => { void Promise.resolve().then(() => this.config.openImage(path)).catch(fail); };
    image.addEventListener('click', event => {
      if ((event as MouseEvent).ctrlKey) { event.preventDefault(); open(); return; }
      view.dispatch({ selection: { anchor: this.position }, scrollIntoView: true }); view.focus();
    });
    image.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); if (event.ctrlKey) open(); else { view.dispatch({ selection: { anchor: this.position }, scrollIntoView: true }); view.focus(); }
    });
    return image;
  }
  destroy(dom: HTMLElement) { this.mounted.get(dom)?.(); this.mounted.delete(dom); }
  ignoreEvent() { return true; }
}

export function buildMarkdownLivePreview(state: EditorState, parseBudget = 120, motionLines?: Set<number>): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = [];
  const blocks: ReturnType<Decoration['range']>[] = [];
  const quoteDepths = new Map<number, number>();
  const guideLines = new Map<number, ListGuide[]>(), codeLines = new Set<number>();
  const headingTokens: { from: number; to: number }[] = [];
  const listLines = new Map<number, { steps: number; columns: number; markers: number }>();
  // Initial hydration may parse briefly. Typing has a smaller budget and
  // selection-only updates never force a synchronous full-document parse.
  // Language-worker tree updates finish the remaining decorations safely.
  const tree = (parseBudget > 0 && ensureSyntaxTree(state, state.doc.length, parseBudget)) || syntaxTree(state);
  motionLines ??= state.selection.ranges.length === 1 && state.selection.main.empty
    ? new Set([state.doc.lineAt(state.selection.main.head).from]) : new Set();
  const activeItems = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let node: MarkdownNode | null = tree.resolveInner(state.doc.lineAt(range.head).to, -1); node; node = node.parent) {
      if (node.name === 'ListItem') { activeItems.add(node.from); break; }
    }
  }
  const activeLine = (from: number, to: number) => state.selection.ranges.some(range => {
    const start = state.doc.lineAt(range.from).from, end = state.doc.lineAt(range.to).to;
    return from <= end && to >= start;
  });
  const active = (from: number, to: number) => state.selection.ranges.some(range => range.empty
    ? range.head >= from && range.head < to : range.from <= to && range.to >= from);
  const activeAtPrefixEnd = (from: number, to: number) => state.selection.ranges.some(range => range.empty
    ? range.head >= from && range.head <= to : range.from <= to && range.to >= from);
  const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (to > from) {
      const range = Decoration.replace({ widget, block }).range(from, to);
      ranges.push(range);
      if (block) blocks.push(range);
    }
  };
  const mark = (from: number, to: number, cls: string, attributes?: Record<string, string>) => {
    if (to > from) ranges.push(Decoration.mark({ class: cls, attributes }).range(from, to));
  };
  tree.iterate({ enter(ref) {
    const node = ref.node, { from, to, name } = node;
    if (name === 'FencedCode' || name === 'CodeBlock') {
      if (name === 'FencedCode' && !activeLine(from, to)) {
        const projection = projectCodeBlock(state, node);
        hide(projection.from, projection.to, new CodeBlockWidget(projection, listGuides(state, node, activeItems)), true);
      } else {
        mark(from, to, 'cm-md-code-block');
        const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number;
        for (let number = first; number <= last; number++) {
          codeLines.add(number);
          ranges.push(Decoration.line({ class: 'cm-md-code-line' + (number === first ? ' cm-md-code-first' : '') + (number === last ? ' cm-md-code-last' : '') }).range(state.doc.line(number).from));
        }
      }
      return false;
    }
    if (['HTMLBlock', 'CommentBlock'].includes(name)) return false;
    if (name === 'Image') {
      const config = state.facet(markdownLivePreviewConfig), url = markdownLinkURL(state, tree, node);
      if (!active(from, to) && config && url && url.trim()) {
        const rawSource = decodeImageDestination(url);
        const safeRemote = /^(?:https?:\/\/[^\s]+|data:image\/[^\s]+|blob:[^\s]+|reader-asset:\/\/local\/[^\s]+)$/i.test(rawSource);
        let source = rawSource;
        if (!safeRemote) try { source = decodeURIComponent(rawSource); } catch { source = ''; }
        const hasUnknownScheme = /^(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:/.test(source) && !safeRemote;
        const opening = node.getChildren('LinkMark').find(mark => state.sliceDoc(mark.from, mark.to) === '![');
        const alt = projectInlineText(state, node, tree).text;
        const position = opening?.to ?? from;
        if (source && !hasUnknownScheme) hide(from, to, new ImageWidget(source, alt, position, config));
      }
      return false;
    }
    if (name === 'Table' && !activeLine(from, to)) {
      const projection = projectTable(state, node, tree);
      hide(projection.from, projection.to, new TableWidget(projection, listGuides(state, node, activeItems), state.facet(markdownLivePreviewConfig)), true);
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
      const headingActive = activeAtPrefixEnd(from, to);
      mark(from, to, `cm-md-heading cm-md-heading-${level}${headingActive ? ' cm-md-format-active' : ''}`);
      // Line decorations have one owner even when inline formatting splits
      // the heading mark. The level label never becomes editable source.
      ranges.push(Decoration.line({ class: 'cm-md-heading-line', attributes: {
        'data-md-heading-level': String(level),
      } }).range(state.doc.lineAt(from).from));
      // Keep the body measurable before the first cross-line entry, not only
      // after the caret has already visited this heading.
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
        motionLines.add(state.doc.line(number).from);
      }
      const header = node.getChild('HeaderMark');
      const hasHeadingText = !!header && /\S/.test(state.sliceDoc(header.to, to));
      if (hasHeadingText) for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'HeaderMark') {
          let end = child.to;
          while (end < to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
          headingTokens.push({ from: child.from, to: end });
          if (headingActive) mark(child.from, end, 'cm-md-format-token');
          else hide(child.from, end);
        }
      }
    }
    const inlineClass: Record<string, string> = { StrongEmphasis: 'strong', Emphasis: 'emphasis', Strikethrough: 'strikethrough', InlineCode: 'inline-code', Highlight: 'highlight' };
    if (inlineClass[name]) {
      const formatActive = active(from, to);
      if (name === 'InlineCode') {
        if (formatActive) {
          mark(from, to, 'cm-md-inline-code cm-md-format-active');
          for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'CodeMark') mark(child.from, child.to, 'cm-md-format-token');
        }
        else hide(from, to, new InlineCodeWidget(projectInlineText(state, node, tree)));
        return false;
      }
      mark(from, to, `cm-md-${inlineClass[name]}${formatActive ? ' cm-md-format-active' : ''}`);
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (!/^(EmphasisMark|StrikethroughMark|CodeMark|HighlightMark)$/.test(child.name)) continue;
        if (formatActive) mark(child.from, child.to, 'cm-md-format-token');
        else hide(child.from, child.to);
      }
    }
    if (name === 'ListItem') {
      const prefixes = listPrefixes(state, node);
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(Math.max(from, to - 1)).number; number++) {
        const earlier = prefixes.filter(prefix => prefix.line < number);
        listLines.set(number, { steps: earlier.length, columns: earlier.reduce((sum, prefix) => sum + prefix.columns, 0), markers: prefixes.filter(prefix => prefix.line === number).length });
      }
      const guides = listGuides(state, node, activeItems);
      if (guides.length) {
        const last = state.doc.lineAt(Math.max(from, to - 1)).number;
        for (let number = state.doc.lineAt(from).number; number <= last; number++) {
          const levels = new Map((guideLines.get(number) || []).map(guide => [guide.column, guide]));
          for (const guide of guides) levels.set(guide.column, guide);
          guideLines.set(number, [...levels.values()].sort((left, right) => left.column - right.column));
        }
      }
      const marker = node.getChild('ListMark'), task = node.getChild('Task')?.getChild('TaskMarker');
      if (marker) {
        const line = state.doc.lineAt(marker.from);
        let end = task?.to ?? marker.to; while (end < line.to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
        mark(end, line.to, 'cm-md-list');
        const prefixActive = marker.to === end
          ? activeAtPrefixEnd(marker.from, end)
          : active(marker.from, end);
        const gapFrom = task?.to ?? marker.to;
        const before = countColumn(state.sliceDoc(line.from, gapFrom), state.tabSize);
        if (prefixActive) {
          const after = countColumn(state.sliceDoc(line.from, end), state.tabSize);
          mark(marker.from, end, 'cm-md-list-prefix cm-md-format-token', { style: `--md-prefix-space-columns: ${after - before}` });
        }
        if (!prefixActive) {
          if (task) {
            // The gap is presentation-only whitespace while the task is inactive.
            // Replace it with the widget's fixed half-em margin so spaces and tabs
            // render consistently without changing the Markdown source.
            hide(marker.from, end, new TaskWidget(task.from + 1, /x/i.test(state.sliceDoc(task.from, task.to))));
          }
          else {
            const label = node.parent?.name === 'OrderedList' ? state.sliceDoc(marker.from, marker.to) : '•';
            hide(marker.from, end, new MarkerWidget(label, label === '•' ? end - marker.from : 0));
          }
        }
      }
    }
    if (name === 'QuoteMark' && !active(from, to)) hide(from, to);
    if (name === 'HardBreak' && !active(from, to)) {
      const source = state.sliceDoc(from, to);
      if (source.endsWith('\\\n')) hide(to - 2, to - 1);
    }
    if (name === 'Autolink') {
      const url = markdownLinkURL(state, tree, node);
      mark(from, to, 'cm-md-link', url ? { 'data-markdown-link': url } : undefined);
      if (!active(from, to)) for (const delimiter of node.getChildren('LinkMark')) hide(delimiter.from, delimiter.to);
    }
    if (name === 'Link' && isResolvedMarkdownLink(state, tree, node)) {
      const url = markdownLinkURL(state, tree, node);
      mark(from, to, 'cm-md-link', url ? { 'data-markdown-link': url } : undefined);
      if (!active(from, to)) {
        const marks = node.getChildren('LinkMark');
        if (marks.length >= 2) { hide(marks[0].from, marks[0].to); hide(marks[1].from, to); }
      }
    }
  } });
  // A whitespace-only active continuation is outside the parser's ListItem
  // until text is typed. Give it the same visual context without changing it.
  const selectedLines = new Set(state.selection.ranges.map(range => state.doc.lineAt(range.head).number));
  for (const number of selectedLines) {
    if (listLines.has(number) || codeLines.has(number) || number <= 1) continue;
    const line = state.doc.line(number);
    if (!/^[\t ]+$/.test(line.text)) continue;
    let previousNumber = number - 1;
    while (previousNumber > 1 && !state.doc.line(previousNumber).text.trim()) previousNumber--;
    const previous = state.doc.line(previousNumber);
    if (!previous.text.trim()) continue;
    const separated = previousNumber < number - 1, indentColumns = countColumn(line.text, state.tabSize);
    let candidate: MarkdownNode | null = tree.resolveInner(previous.to, -1);
    let followsParagraph = false;
    for (; candidate; candidate = candidate.parent) {
      if (candidate.name === 'CodeBlock') break;
      if (candidate.name === 'FencedCode') {
        const fences = candidate.getChildren('CodeMark');
        // Only a parser-confirmed closing fence permits a new list paragraph.
        // An open fence still owns the whitespace line as literal code.
        if (fences.length < 2 || state.doc.lineAt(fences[fences.length - 1].from).number !== previous.number) break;
      }
      if (candidate.name === 'Paragraph' || candidate.name === 'Task') followsParagraph = !separated;
      if (candidate.name !== 'ListItem') continue;
      const marker = candidate.getChild('ListMark'); if (!marker) continue;
      const markerLine = state.doc.lineAt(marker.from);
      let end = marker.to; while (end < markerLine.to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
      const required = countColumn(state.sliceDoc(markerLine.from, end).replace(/>[\t ]?/g, ''), state.tabSize);
      if (!followsParagraph && indentColumns < required) continue;
      // A new paragraph after a blank line needs the container's actual
      // indentation. Four more columns start code, and a missing quote marker
      // cannot continue a blockquote after that blank line.
      if (!followsParagraph && indentColumns >= required + 4) break;
      let quoted = false;
      for (let parent = candidate.parent; parent; parent = parent.parent) if (parent.name === 'Blockquote') quoted = true;
      if (separated && quoted) break;
      const prefixes = listPrefixes(state, candidate).filter(prefix => prefix.line < number);
      listLines.set(number, { steps: prefixes.length, columns: prefixes.reduce((sum, prefix) => sum + prefix.columns, 0), markers: 0 });
      break;
    }
  }
  for (const [number, guides] of guideLines) if (!codeLines.has(number)) {
    const line = state.doc.line(number), attributes = guideAttributes(guides);
    ranges.push(Decoration.line({ class: 'cm-md-list-guides', attributes }).range(line.from));
  }
  for (const [number, layout] of listLines) if (!codeLines.has(number)) {
    const line = state.doc.line(number);
    const prefix = line.text.match(/^[\t >]*/)?.[0] || '';
    const columns = (value: string) => countColumn(value.replace(/>[\t ]?/g, ''), state.tabSize);
    const indent = columns(prefix);
    for (let index = 0; index < prefix.length; index++) if (prefix[index] === '\t') {
      const width = columns(prefix.slice(0, index + 1)) - columns(prefix.slice(0, index));
      if (width > 0) mark(line.from + index, line.from + index + 1, 'cm-md-indent-tab', { style: `--md-tab-columns: ${width}` });
    }
    ranges.push(Decoration.line({ class: 'cm-md-list-layout', attributes: { style:
      `--md-list-offset: calc(${layout.steps} * var(--md-list-gutter, 2em) - ${layout.columns} * var(--md-list-space-width, .5ch)); --md-list-wrap-indent: calc(${indent} * var(--md-list-space-width, .5ch) + ${layout.markers} * var(--md-list-gutter, 2em))`,
    } }).range(line.from));
  }
  for (const [number, depth] of quoteDepths) ranges.push(Decoration.line({ class: 'cm-md-quote', attributes: {
    'data-quote-depth': String(depth), style: `--md-quote-depth: ${depth}`,
  } }).range(state.doc.line(number).from));
  const motionExclusions = [...ranges.filter(range => range.to > range.from && (range.value.point
    || range.value.spec.class?.split(' ').includes('cm-md-list-prefix'))), ...headingTokens]
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let exclusionIndex = 0;
  for (const lineStart of [...motionLines].sort((left, right) => left - right)) {
    const line = state.doc.lineAt(lineStart), excluded: { from: number; to: number }[] = [];
    while (exclusionIndex < motionExclusions.length && motionExclusions[exclusionIndex].to <= line.from) exclusionIndex++;
    for (let index = exclusionIndex; index < motionExclusions.length && motionExclusions[index].from < line.to; index++) {
      if (motionExclusions[index].to > line.from) excluded.push(motionExclusions[index]);
    }
    const leadingIndent = /^[\t ]+/.exec(line.text)?.[0];
    if (leadingIndent) excluded.push({ from: line.from, to: line.from + leadingIndent.length });
    tree.iterate({ from: line.from, to: line.to, enter(ref) {
      const { from, to, name } = ref;
      if (/^(FencedCode|CodeBlock|InlineCode|Image|Table|HorizontalRule|HTMLBlock|CommentBlock)$/.test(name)) {
        excluded.push({ from, to }); return false;
      }
      if (!ref.node.firstChild && to > from && /(?:Mark|Marker)$/.test(name)) excluded.push({ from, to });
    } });
    excluded.sort((left, right) => left.from - right.from || left.to - right.to);
    let cursor = line.from;
    for (const part of excluded) {
      const from = Math.max(line.from, part.from), to = Math.min(line.to, part.to);
      if (to <= cursor) continue;
      if (from > cursor) mark(cursor, from, 'cm-md-motion-run', { 'data-md-motion-key': `${cursor}:${from}` });
      cursor = Math.max(cursor, to);
    }
    if (cursor < line.to) mark(cursor, line.to, 'cm-md-motion-run', { 'data-md-motion-key': `${cursor}:${line.to}` });
  }
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
    if (transaction.reconfigured) return buildMarkdownLivePreview(transaction.state, 0);
    if (!transaction.docChanged && !treeChanged) {
      if (!transaction.selection || activeLineKey(transaction.startState) === activeLineKey(transaction.state)) return value;
    }
    const motionLines = new Set<number>();
    if (transaction.state.selection.ranges.length === 1 && transaction.state.selection.main.empty) {
      motionLines.add(transaction.state.doc.lineAt(transaction.state.selection.main.head).from);
      if (!transaction.docChanged && transaction.startState.selection.ranges.length === 1 && transaction.startState.selection.main.empty) {
        motionLines.add(transaction.startState.doc.lineAt(transaction.startState.selection.main.head).from);
      }
    }
    return buildMarkdownLivePreview(transaction.state, transaction.docChanged ? 20 : 0, motionLines);
  },
  provide: field => EditorView.decorations.from(field),
});

function activeLineKey(state: EditorState) {
  const tree = syntaxTree(state);
  return state.selection.ranges.map(range => {
    if (!range.empty) return `selection:${range.from}:${range.to}`;
    // Heading source is also disclosed at its line-end caret. Resolve the
    // left side for that inclusive endpoint, matching activeAtPrefixEnd.
    for (let node: MarkdownNode | null = tree.resolveInner(range.head, -1); node; node = node.parent) {
      if (/^(ATX|Setext)Heading/.test(node.name) && range.head === node.to) return `${node.name}:${node.from}:${node.to}`;
    }
    for (let node: MarkdownNode | null = tree.resolveInner(range.head, 1); node; node = node.parent) {
      if (node.name === 'ListItem') {
        const marker = node.getChild('ListMark'), task = node.getChild('Task')?.getChild('TaskMarker');
        if (marker) {
          const line = state.doc.lineAt(marker.from); let end = task?.to ?? marker.to;
          while (end < line.to && /[\t ]/.test(state.sliceDoc(end, end + 1))) end++;
          if (range.head >= marker.from && (range.head < end || (marker.to === end && range.head === end))) return `list-prefix:${marker.from}:${end}`;
        }
      }
      // Rule replacement uses a half-open source range. Its line-end caret
      // must not share a cache key with a caret editing the rule itself.
      if (node.name === 'HorizontalRule' && range.head >= node.from && range.head < node.to) return `${node.name}:${node.from}:${node.to}`;
      if (/^(InlineCode|StrongEmphasis|Emphasis|Strikethrough|Highlight|Link|Image|ATXHeading|SetextHeading|Autolink|QuoteMark|HardBreak|Escape|Entity)/.test(node.name)) return `${node.name}:${node.from}:${node.to}`;
      if (/^(Paragraph|Document)$/.test(node.name)) break;
    }
    return `${state.doc.lineAt(range.head).number}`;
  }).join(',');
}

export function markdownMotionVisibilityKey(state: EditorState) {
  const key = activeLineKey(state);
  return key.includes(':') ? key : null;
}
