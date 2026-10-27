require('./typescript-loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
async function plan(text, selection={anchor:0}) {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
 const state=EditorState.create({doc:text,selection,extensions:[markdownSyntax()]});
 const result=[];buildMarkdownLivePreview(state).between(0,state.doc.length,(from,to,value)=>result.push({from,to,source:state.sliceDoc(from,to),spec:value.spec}));
 return {state,result};
}
test('fenced code and escaped delimiters never become live formatting',async()=>{
 for(const text of ['cursor\n\n~~~md\n# heading\n- [ ] task\n~~strike~~\n~~~','cursor\n\n\\~~literal~~','cursor\n\n`~~code~~`']){
 const {result}=await plan(text);assert.equal(result.some(x=>x.spec.class?.includes('strikethrough')||x.spec.widget?.constructor.name==='TaskWidget'),false);
 }
});
test('all lines of a multi-line selection retain source delimiters',async()=>{
 const text='first\n**middle**\nlast';const {result}=await plan(text,{anchor:0,head:text.length});
 assert.equal(result.some(x=>!x.spec.class),false);
});
test('GFM tasks, strike, emphasis and highlights use parsed nodes',async()=>{
 const {result}=await plan('cursor\n\n~~strike~~ **bold** *italic* ==highlight==\n\n- [ ] task');
 for(const cls of ['strikethrough','strong','emphasis','highlight'])assert.ok(result.some(x=>x.spec.class==='cm-md-'+cls),cls);
 assert.ok(result.some(x=>x.spec.widget?.constructor.name==='TaskWidget'));
});
test('table becomes one block widget only while selection is outside it',async()=>{
 const text='cursor\n\n| A | B |\n| :--- | ---: |\n| x | y |';
 const inactive=await plan(text);assert.equal(inactive.result.filter(x=>x.spec.widget?.constructor.name==='TableWidget').length,1);
 const active=await plan(text,{anchor:text.indexOf('x')});assert.equal(active.result.some(x=>x.spec.widget?.constructor.name==='TableWidget'),false);
 assert.equal(inactive.state.doc.toString(),text);
});
test('table-like text without separator and tables in code remain source',async()=>{
 for(const text of ['cursor\n\n| A | B |\n| x | y |','cursor\n\n~~~\n| A | B |\n| --- | --- |\n| x | y |\n~~~']){
 const {result}=await plan(text);assert.equal(result.some(x=>x.spec.widget?.constructor.name==='TableWidget'),false);
 }
});

test('each table widget collects only its own cells, including in a nested list', async () => {
 for (const prefix of ['', '   ']) {
  const first = '| A | B |\n' + prefix + '| --- | --- |\n' + prefix + '| x | y |';
  const second = '| C | D |\n| --- | --- |\n| z | w |';
  const text = 'cursor\n\n' + (prefix ? '1. ' : '') + first + '\n\n# Between\n\n' + second;
  const { result } = await plan(text);
  const tables = result.filter(item => item.spec.widget?.constructor.name === 'TableWidget');
  assert.equal(tables.length, 2);
  for (const table of tables) {
   assert.equal(table.spec.widget.cells.length, 4);
   assert.ok(table.spec.widget.cells.every(position => position >= table.from && position < table.to));
  }
 }
});

test('blockquotes render with quote styling while their markers stay editable',async()=>{
 const text='cursor\n\n> 引用第一行\n> 引用第二行';
 const inactive=await plan(text);
 assert.equal(inactive.result.filter(x=>x.spec.class==='cm-md-quote').length,2);
 assert.equal(inactive.result.filter(x=>x.source==='>'&&!x.spec.class).length,2);
 const active=await plan(text,{anchor:text.indexOf('引用第一行')});
 assert.equal(active.result.filter(x=>x.spec.class==='cm-md-quote').length,2);
 assert.equal(active.result.some(x=>x.source==='>'&&!x.spec.class),true);
});

test('ordered list items can contain multi-line blockquotes in live preview', async () => {
 const text = 'cursor\n\n3. > first quoted line\n   > second quoted line';
 const inactive = await plan(text);
 const marker = inactive.result.find(x => x.spec.widget?.constructor.name === 'MarkerWidget');
 assert.ok(marker, 'the ordered list marker is replaced with a visible widget');
 assert.equal(marker.spec.widget.label, '3.');
 assert.equal(inactive.result.filter(x => x.spec.class === 'cm-md-quote').length, 2, 'blockquote styling spans both wrapped source lines');
 assert.deepEqual(inactive.result.filter(x => x.source === '>' && !x.spec.class).map(x => x.source), ['>', '>'], 'quote syntax is hidden while the item is inactive');

 const active = await plan(text, { anchor: text.indexOf('first quoted line') });
 assert.equal(active.result.some(x => x.spec.widget?.constructor.name === 'MarkerWidget'), true, 'the list marker stays in live preview while editing item text');
 assert.equal(active.result.filter(x => x.spec.class === 'cm-md-quote').length, 2, 'live preview styling remains while the caret is inside the item');
 assert.equal(active.result.some(x => x.source === '>' && !x.spec.class), true, 'the quote marker is editable while the item is active');
});

test('horizontal rules render as a live-preview block and stay editable when active', async () => {
 const text = 'cursor\n\n---\n\nend';
 const inactive = await plan(text);
 const rule = inactive.result.find(x => x.spec.widget?.constructor.name === 'HorizontalRuleWidget');
 assert.ok(rule, 'an inactive thematic break becomes a horizontal rule widget');
 assert.equal(rule.source, '---');
 const active = await plan(text, { anchor: text.indexOf('---') + 1 });
 assert.equal(active.result.some(x => x.spec.widget?.constructor.name === 'HorizontalRuleWidget'), false, 'the source delimiter remains editable when the caret is on it');
 assert.equal(active.state.sliceDoc(text.indexOf('---'), text.indexOf('---') + 3), '---');
});

test('inactive fenced code renders a literal block and active code keeps editable source', async () => {
 for (const fence of ['```', '~~~']) {
  const text = 'cursor\n\n' + fence + 'text\n# literal\n- [ ] task\n<script>alert(1)</script>\n' + fence;
  const inactive = await plan(text);
  const widget = inactive.result.find(x => x.spec.widget?.constructor.name === 'CodeBlockWidget')?.spec.widget;
  assert.ok(widget); assert.equal(widget.language, 'text');
  assert.equal(widget.code, '# literal\n- [ ] task\n<script>alert(1)</script>');
  const active = await plan(text, { anchor: text.indexOf('# literal') });
  assert.equal(active.result.some(x => x.spec.widget?.constructor.name === 'CodeBlockWidget'), false);
  assert.ok(active.result.some(x => x.spec.class?.includes('cm-md-code-line')));
  const selected = await plan(text, { anchor: 0, head: text.length });
  assert.equal(selected.result.some(x => x.spec.widget?.constructor.name === 'CodeBlockWidget'), false);
  assert.equal(inactive.state.doc.toString(), text);
 }
});

test('moving the caret within the same active line reuses decorations; crossing lines updates source visibility', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 let state = EditorState.create({ doc: '**first**\n\n**second**', selection: { anchor: 2 }, extensions: [markdownSyntax(), livePreview] });
 const before = state.field(livePreview);
 state = state.update({ selection: { anchor: 5 } }).state;
 assert.equal(state.field(livePreview), before);
 state = state.update({ selection: { anchor: state.doc.length - 2 } }).state;
 assert.notEqual(state.field(livePreview), before);
});

test('inline constructs activate only under the caret, selections expose touched syntax, and task bodies keep checkboxes', async () => {
 const text = '**one** and *two*\n\n- [ ] task';
 const first = await plan(text, { anchor: text.indexOf('one') + 1 });
 assert.equal(first.result.some(x => x.spec.class === 'cm-md-strong'), true);
 assert.equal(first.result.some(x => x.from === text.indexOf('**') && x.to === text.indexOf('**') + 2 && !x.spec.class), false);
 const second = await plan(text, { anchor: text.indexOf('two') + 1 });
 assert.equal(second.result.some(x => x.from === text.indexOf('**') && x.to === text.indexOf('**') + 2 && !x.spec.class), true);
 assert.equal(second.result.some(x => x.from === text.indexOf('*two*') && x.to === text.indexOf('*two*') + 1 && !x.spec.class), false);
 const selected = await plan(text, { anchor: text.indexOf('one'), head: text.indexOf('one') + 3 });
 assert.equal(selected.result.some(x => x.from === text.indexOf('**') && x.to === text.indexOf('**') + 2 && !x.spec.class), false);
 const body = await plan(text, { anchor: text.indexOf('task') + 1 });
 assert.equal(body.result.some(x => x.spec.widget?.constructor.name === 'TaskWidget'), true);
 assert.equal(body.result.some(x => x.source === '- '), false);
});

test('task prefix activation changes independently from the item body', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 const text = '- [ ] task';
 let state = EditorState.create({ doc: text, selection: { anchor: text.indexOf('task') + 1 }, extensions: [markdownSyntax(), livePreview] });
 const body = state.field(livePreview);
 assert.ok(hasWidget(body, 'TaskWidget'));
 state = state.update({ selection: { anchor: text.indexOf('task') } }).state;
 assert.ok(hasWidget(state.field(livePreview), 'TaskWidget'), 'the first body position is outside the half-open prefix range');
 state = state.update({ selection: { anchor: 5 } }).state;
 assert.notEqual(state.field(livePreview), body);
 assert.equal(hasWidget(state.field(livePreview), 'TaskWidget'), false);
 function hasWidget(decorations, name) {
  let found = false; decorations.between(0, text.length, (_from, _to, value) => { if (value.spec.widget?.constructor.name === name) found = true; });
  return found;
 }
});

test('hard break marker previews as a line break, and is source when selected', async () => {
 const text = 'a\\\nb';
 const inactive = await plan(text);
 assert.equal(inactive.result.some(x => x.from === text.indexOf('\\') && x.to === text.indexOf('\\') + 1), true);
 const active = await plan(text, { anchor: text.indexOf('\\') });
 assert.equal(active.result.some(x => x.from === text.indexOf('\\') && x.to === text.indexOf('\\') + 1), false);
 assert.equal(active.state.doc.toString(), text);
});

test('same-line cursor moves refresh quote, escape, entity, autolink and hard-break disclosure', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 for (const [text, outside, inside] of [
  ['> quoted', 5, 0], ['text \\*literal', 0, 5], ['text &amp;', 0, 6],
  ['text <https://example.test>', 0, 8], ['a\\\nb', 0, 1],
 ]) {
  let state = EditorState.create({ doc: text, selection: { anchor: outside }, extensions: [markdownSyntax(), livePreview] });
  const before = state.field(livePreview);
  state = state.update({ selection: { anchor: inside } }).state;
  assert.notEqual(state.field(livePreview), before, text);
  const hidden = [];
  state.field(livePreview).between(0, text.length, (from, to, value) => { if (value.spec.class === undefined) hidden.push({ from, to }); });
  assert.equal(hidden.some(range => range.from <= inside && range.to > inside), false, 'the active syntax is accessible');
 }
});

test('images become widgets only with the configured source context and activate at alt text', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { buildMarkdownLivePreview, markdownLivePreviewConfig } = await import('../src/editor/markdownLivePreview.ts');
 const config = { notePath: 'C:/notes/page.md', openImage: async () => {} };
 for (const [text, url] of [
  ['intro\n\n![alt](<space file.png> "title")', 'space file.png'],
  ['intro\n\n![alt](a\\(b\\).png)', 'a(b).png'],
  ['intro\n\n![alt][]\n\n[alt]: pixel.png', 'pixel.png'],
  ['intro\n\n![alt]\n\n[alt]: pixel.png', 'pixel.png'],
 ]) {
  const state = EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: [markdownSyntax(), markdownLivePreviewConfig.of(config)] });
  const ranges = []; buildMarkdownLivePreview(state).between(0, text.length, (from, to, value) => ranges.push({ from, to, value }));
  const image = ranges.find(range => range.value.spec.widget?.constructor.name === 'ImageWidget');
  assert.ok(image); assert.equal(image.value.spec.widget.source, url);
  assert.equal(image.value.spec.widget.alt, 'alt'); assert.equal(image.value.spec.widget.position, text.indexOf('![') + 2);
  const active = EditorState.create({ doc: text, selection: { anchor: text.indexOf('alt') + 1 }, extensions: [markdownSyntax(), markdownLivePreviewConfig.of(config)] });
  const activeRanges = []; buildMarkdownLivePreview(active).between(0, text.length, (from, to, value) => activeRanges.push(value));
  assert.equal(activeRanges.some(value => value.spec.widget?.constructor.name === 'ImageWidget'), false);
  const noConfig = await plan(text);
  assert.equal(noConfig.result.some(value => value.spec.widget?.constructor.name === 'ImageWidget'), false);
 }
 for (const text of ['intro\n\n![alt]', 'intro\n\n![alt](javascript:alert(1))']) {
  const state = EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: [markdownSyntax(), markdownLivePreviewConfig.of(config)] });
  const ranges = []; buildMarkdownLivePreview(state).between(0, text.length, (from, to, value) => ranges.push(value));
  assert.equal(ranges.some(value => value.spec.widget?.constructor.name === 'ImageWidget'), false, text);
 }
});

test('inactive inline code uses reading projection and maps clicks back to its source', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
 const { projectedSourcePosition } = await import('../src/editor/markdownProjection.ts');
 for (const [source, expected] of [['`  x  `', ' x '], ['`a\nb`', 'a b']]) {
  const text = 'intro\n\n' + source, state = EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: [markdownSyntax()] });
  let widget;
  buildMarkdownLivePreview(state).between(0, text.length, (_from, _to, value) => { if (value.spec.widget?.constructor.name === 'InlineCodeWidget') widget = value.spec.widget; });
  assert.ok(widget); assert.equal(widget.projection.text, expected);
  const character = expected.includes('x') ? 'x' : 'b';
  assert.equal(projectedSourcePosition(widget.projection, expected.indexOf(character)), text.indexOf(character));
  assert.equal(widget.ignoreEvent(), true, 'the widget owns primary mousedown so CodeMirror cannot place a competing edge cursor');
 }
});

test('multi-line inline code owns nested container syntax without overlapping decorations', async () => {
 for (const source of ['> `a\n> b`', '- `a\n  b`']) {
  const text = 'intro\n\n' + source, { result } = await plan(text);
  const widget = result.find(item => item.spec.widget?.constructor.name === 'InlineCodeWidget');
  assert.ok(widget, source);
  assert.equal(widget.spec.widget.projection.text, 'a b', source);
  assert.equal(result.some(item => item.from > widget.from && item.from < widget.to && item.spec.widget), false, source);
 }
});

test('unresolved bracket text stays literal while defined reference links and autolinks preview', async () => {
 for (const source of ['[ordinary]', '[missing][id]', '[id][]', '[[note]]', '- [?] task']) {
  const { result } = await plan('cursor\n\n' + source);
  assert.equal(result.some(x => x.spec.class === 'cm-md-link'), false, source);
  assert.equal(result.some(x => x.source === '[' || x.source === ']'), false, 'unresolved brackets remain visible: ' + source);
 }
 for (const source of ['[text](https://example.com)', '[text]()', '[text][ID]\n\n[id]: /local.md', '[ID][]\n\n[id]: /local.md', '[ID]\n\n[id]: /local.md', '<https://example.com>', '<user@example.com>']) {
  const { result } = await plan('cursor\n\n' + source);
  assert.equal(result.some(x => x.spec.class === 'cm-md-link'), true, source);
 }
});

test('Tab nested Markdown keeps formatting; ordinary indented text remains code like Obsidian', async () => {
 const nested = 'cursor\n\n- parent\n\t- **bold** *italic* ~~strike~~ ==highlight==\n\t- [ ] task';
 const { result } = await plan(nested);
 for (const cls of ['strong', 'emphasis', 'strikethrough', 'highlight', 'list-guides']) assert.ok(result.some(x => x.spec.class === 'cm-md-' + cls), cls);
 assert.ok(result.some(x => x.spec.widget?.constructor.name === 'TaskWidget'));
 assert.equal(result.some(x => x.spec.class?.includes('code-block')), false);
 for (const indent of ['\t', '    ']) {
  const { result } = await plan('cursor\n\n' + indent + '**literal**');
  assert.ok(result.some(x => x.spec.class === 'cm-md-code-block'));
  assert.equal(result.some(x => x.spec.class === 'cm-md-strong'), false);
 }
});

test('list guides follow levels across continuation lines and paragraphs without changing source', async () => {
 const text = 'cursor\n\n  - first\n    continued\n\n    second paragraph\n    - child\n      child continued\n  - sibling\n\nplain\n  prose';
 const { state, result } = await plan(text, { anchor: text.indexOf('child continued') });
 const guides = result.filter(x => x.spec.class === 'cm-md-list-guides');
 const at = value => guides.find(x => x.from === state.doc.lineAt(text.indexOf(value)).from)?.spec.attributes;
 assert.equal(at('first')['data-list-guides'], '1');
 assert.equal(at('continued')['data-list-guides'], '1');
 assert.equal(at('second paragraph')['data-list-guides'], '1');
 assert.equal(at('child continued')['data-list-guides'], '1,3');
 assert.equal(at('child continued')['data-list-guide-active'], '3');
 assert.equal(at('first')['data-list-guide-active'], '');
 assert.equal(at('sibling')['data-list-guide-active'], '');
 assert.equal(at('prose'), undefined);
 assert.equal(state.doc.toString(), text);
 assert.equal(result.some(x => /^cm-md-indent-/.test(x.spec.class || '')), false);
});

test('Tab width and ordered-marker width choose one guide per level, including quoted lists', async () => {
 for (const [text, columns] of [['cursor\n\n- parent\n\t- child', '2'], ['cursor\n\n10. parent\n    - child', '2'], ['cursor\n\n> - parent\n>   - child', '1']]) {
  const { state, result } = await plan(text);
  const line = state.doc.lineAt(text.indexOf('child')).from;
  const guide = result.find(x => x.from === line && x.spec.class === 'cm-md-list-guides');
  assert.equal(guide.spec.attributes['data-list-guides'], columns);
  assert.equal(guide.spec.attributes['data-list-guide-active'], '');
 }
});

test('bullet display retains source-prefix metadata while layout uses a shared visual gutter', async () => {
 const { result } = await plan('cursor\n\n  - first\n    continued\n\n  +   spaced\n      continued');
 const markers = result.filter(x => x.spec.widget?.constructor.name === 'MarkerWidget');
 assert.deepEqual(markers.map(x => x.spec.widget.columns), [2, 4]);
});

test('ordinary spaces and code have no list guides; moving between items changes only active guide', async () => {
 for (const text of ['cursor\n\n  prose', 'cursor\n\n\tcode', 'cursor\n\n    code', 'cursor\n\n> quote']) {
  assert.equal((await plan(text)).result.some(x => x.spec.class === 'cm-md-list-guides'), false);
 }
 const text = 'cursor\n\n  - first\n  - second';
 for (const selected of ['first', 'second']) {
  const { state, result } = await plan(text, { anchor: text.indexOf(selected) });
  const active = result.filter(x => x.spec.class === 'cm-md-list-guides' && x.spec.attributes['data-list-guide-active']);
  assert.equal(active.length, 1);
  assert.equal(active[0].from, state.doc.lineAt(text.indexOf(selected)).from);
  assert.equal(state.doc.toString(), text);
 }
 const beforeMarker = await plan(text, { anchor: text.indexOf('  - first') });
 const active = beforeMarker.result.find(x => x.spec.class === 'cm-md-list-guides' && x.spec.attributes['data-list-guide-active']);
 assert.equal(active?.spec.attributes['data-list-guide-active'], '1', 'the leading whitespace belongs to the current list row too');
});
