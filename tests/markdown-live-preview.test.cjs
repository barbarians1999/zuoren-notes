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
test('motion source ranges follow visible inline text gaps without covering hidden Markdown tokens', async () => {
 const text = 'Start **bold phrase** middle *italic phrase* and [linked phrase](https://example.test)';
 const { result } = await plan(text, { anchor: text.indexOf('bold phrase') + 1 });
 const runs = result.filter(item => item.spec.attributes?.['data-md-motion-key']);
 assert.ok(runs.some(item => item.source === 'Start '));
 assert.ok(runs.some(item => item.source === 'bold phrase'));
 assert.ok(runs.some(item => item.source.includes('italic phrase')));
 assert.ok(runs.some(item => item.source.includes('linked phrase')));
 assert.equal(runs.some(item => item.source.includes('**') || item.source.includes('*') || item.source.includes('](')), false);
});
test('motion runs omit leading list-continuation indentation so indent edits can map text identity', async () => {
 const text = '- parent\n  continuation', { state, result } = await plan(text, { anchor: text.indexOf('continuation') + 1 });
 const line = state.doc.lineAt(text.indexOf('continuation'));
 const runs = result.filter(item => item.spec.attributes?.['data-md-motion-key'] && item.from >= line.from && item.to <= line.to);
 assert.deepEqual(runs.map(item => item.source), ['continuation']);
 assert.equal(state.doc.toString(), text, 'the visible motion range does not remove source indentation');
});
test('active list prefix is not split by motion decorations', async () => {
 const text = '- 这个';
 const { result } = await plan(text, { anchor: 1 });
 const prefix = result.find(item => item.spec.class?.includes('cm-md-list-prefix'));
 const runs = result.filter(item => item.spec.attributes?.['data-md-motion-key']);
 assert.ok(prefix);
 assert.equal(runs.some(run => run.from < prefix.to && run.to > prefix.from), false, 'the editable marker and its space share one visual gutter');
});
test('heading body motion identity exists before first entry and survives repeated delimiter disclosure', async () => {
 for (const prefix of [1, 2, 3, 4, 5, 6].flatMap(level => [' ', '   '].map(gap => '#'.repeat(level) + gap))) {
  const text = `${prefix}标题😀正文\n\n普通正文`, bodyFrom = prefix.length, bodyTo = text.indexOf('\n');
  const key = `${bodyFrom}:${bodyTo}`;
  for (const anchor of [text.length, bodyFrom + 1, text.length, bodyTo]) {
   const { result } = await plan(text, { anchor });
   const runs = result.filter(item => item.spec.attributes?.['data-md-motion-key'] === key);
   assert.equal(runs.length, 1, `${JSON.stringify(prefix)} at ${anchor} keeps the same heading body`);
   assert.equal(runs[0].source, '标题😀正文');
   const labels = result.filter(item => item.spec.attributes?.['data-md-heading-level']);
   assert.equal(labels.length, 1, 'the heading has one level label, independent of its inline marks');
   assert.equal(labels[0].spec.attributes['data-md-heading-level'], String(prefix.trim().length));
  }
 }
});

test('an active single dash after a paragraph stays ordinary text while a list is being started', async () => {
 for (const suffix of ['-', '- ', '-\t']) {
  const text = '正文😀\n第二行\n' + suffix;
  const active = await plan(text, { anchor: text.length });
  assert.equal(active.state.doc.toString(), text);
  assert.equal(active.result.some(item => item.spec.class?.split(/\s+/).includes('cm-md-heading')), false, suffix);
  assert.equal(active.result.some(item => item.spec.attributes?.['data-md-heading-level']), false, suffix);
  const inactive = await plan(text, { anchor: 0 });
  assert.equal(inactive.result.some(item => item.spec.class?.split(/\s+/).includes('cm-md-heading')), true, 'completed Setext remains visible as a heading');
 }
 for (const suffix of ['--', '---', '=']) {
  const text = '正文\n' + suffix;
  const result = (await plan(text, { anchor: text.length })).result;
  assert.equal(result.some(item => item.spec.class?.split(/\s+/).includes('cm-md-heading')), true, suffix);
 }
});

test('moving into and out of a tentative dash updates heading presentation without changing text', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 const text = '正文😀\n第二行\n- ';
 let state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [markdownSyntax(), livePreview] });
 const hasHeading = () => {
  let found = false;
  state.field(livePreview).between(0, text.length, (_from, _to, value) => { if (value.spec.class?.split(/\s+/).includes('cm-md-heading')) found = true; });
  return found;
 };
 assert.equal(hasHeading(), false);
 state = state.update({ selection: { anchor: 0 } }).state;
 assert.equal(hasHeading(), true);
 state = state.update({ selection: { anchor: text.length } }).state;
 assert.equal(hasHeading(), false);
 assert.equal(state.doc.toString(), text);
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
 assert.equal(active.result.filter(x => x.spec.class?.split(/\s+/).includes('cm-md-ordered-marker')).length, 1, 'the active ordered item displays its source marker once');
 assert.equal(active.result.some(x => x.spec.widget?.constructor.name === 'MarkerWidget'), false, 'the active source marker has no competing widget');
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
 assert.equal(first.result.some(x => x.spec.class?.split(/\s+/).includes('cm-md-strong')), true);
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

test('inactive task widgets absorb the source gap and active prefixes retain it', async () => {
 for (const source of ['- [ ] task', '- [ ]    task', '12. [ ]\ttask', '- [ ] \t  task']) {
  const { result } = await plan('cursor\n\n' + source);
  const checkbox = result.find(item => item.spec.widget?.constructor.name === 'TaskWidget');
  assert.ok(checkbox, source);
  assert.equal(checkbox.source, source.slice(0, source.indexOf('task')), 'the widget replaces the full source marker and gap without editing the document');
 }
 for (const [source, expectedColumns] of [['- [ ] task', 1], ['- [ ]    task', 4], ['12. [ ]\ttask', 1], ['- [ ] \t  task', 5]]) {
  const active = await plan('cursor\n\n' + source, { anchor: 'cursor\n\n'.length + 2 });
  const prefix = active.result.find(item => item.spec.class?.split(/\s+/).includes('cm-md-list-prefix'));
  assert.ok(prefix, 'the active task syntax uses the shared visual prefix: ' + source);
  assert.match(prefix.spec.attributes.style, new RegExp(`--md-prefix-space-columns: ${expectedColumns}(?:;|$)`), source);
  assert.equal(active.result.some(item => item.spec.widget?.constructor.name === 'TaskWidget'), false, source);
 }
});

test('ATX heading marker remains editable when the caret is just after its unfinished prefix', async () => {
 const text = '# ', caret = text.length;
 const { result } = await plan(text, { anchor: caret });
 assert.equal(result.some(item => item.from === 0 && item.to >= caret && item.spec.class === undefined && item.spec.widget === undefined), false);
});

test('empty ATX heading stays visible after Enter moves the caret to the next line', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 let state = EditorState.create({ doc: '# ', selection: { anchor: 2 }, extensions: [markdownSyntax(), livePreview] });
 state = state.update({ changes: { from: 2, insert: '\n' }, selection: { anchor: 3 } }).state;
 const hidden = []; state.field(livePreview).between(0, state.doc.length, (from, to, value) => { if (value.spec.class === undefined && value.spec.widget === undefined) hidden.push({ from, to }); });
 assert.equal(state.doc.toString(), '# \n');
 assert.equal(hidden.some(range => range.from === 0 && range.to >= 1), false, 'an empty heading delimiter is never hidden without heading text');
});

test('ordered marker source remains editable when the caret sits directly after the period', async () => {
 const text = '9.', caret = text.length;
 const { result } = await plan(text, { anchor: caret });
 assert.equal(result.filter(item => item.spec.class?.split(/\s+/).includes('cm-md-list-prefix')).length, 1, 'the period-end caret stays inside the editable prefix');
 assert.equal(result.filter(item => item.spec.widget?.constructor.name === 'MarkerWidget').length, 0, 'the end caret must not be replaced with a preview widget');
});

test('active ordered-list text keeps its source marker in one presentation', async () => {
 for (const text of ['1. ', '1. wo', '1. 我', '12) 中文']) {
  const { result } = await plan(text, { anchor: text.length });
  const prefixes = result.filter(item => item.spec.class?.split(/\s+/).includes('cm-md-ordered-marker'));
  const widgets = result.filter(item => item.spec.widget?.constructor.name === 'MarkerWidget');
  assert.equal(prefixes.length, 1, text);
  assert.equal(prefixes[0].source, text.slice(0, text.indexOf(' ') >= 0 ? text.indexOf(' ') : text.length), 'the colored marker excludes the input separator');
  assert.equal(widgets.length, 0, text);
 }
});

test('ordered list number stays separate from each editable gap', async () => {
 for (const text of ['1.  正文', '12.\t正文', '123)    正文']) {
  const { result } = await plan(text, { anchor: text.length });
  const marker = result.find(item => item.spec.class === 'cm-md-ordered-marker');
  const gap = text.slice(marker?.to, text.search(/正文/));
  assert.ok(marker, text);
  assert.match(marker.source, /^\d+[.)]$/);
  assert.match(gap, /^[\t ]+$/);
  assert.equal(result.some(item => item.from < text.indexOf('正文') && item.to > marker.to && item.spec.class?.includes('cm-md-ordered-marker')), false);
  assert.equal(result.some(item => item.spec.widget?.constructor.name === 'MarkerWidget'), false);
 }
});

for (const prefix of ['- ', '12. ']) test(`list prefix ${JSON.stringify(prefix)} has one marker at its separator-end caret`, async () => {
 const text = prefix + '\nbody', caret = prefix.length;
 const { result } = await plan(text, { anchor: caret });
 const sourceMarkers = result.filter(item => item.spec.class?.split(/\s+/).includes('cm-md-ordered-marker')).length;
 const widgetMarkers = result.filter(item => item.spec.widget?.constructor.name === 'MarkerWidget').length;
 assert.equal(sourceMarkers, prefix.startsWith('12') ? 1 : 0, JSON.stringify(prefix));
 assert.equal(widgetMarkers, prefix.startsWith('12') ? 0 : 1, JSON.stringify(prefix));
});

test('moving from a list body to the prefix end refreshes the single rendered marker', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 const text = '- \nbody';
 let state = EditorState.create({ doc: text, selection: { anchor: text.indexOf('body') + 1 }, extensions: [markdownSyntax(), livePreview] });
 const body = state.field(livePreview);
 state = state.update({ selection: { anchor: 2 } }).state;
 assert.notEqual(state.field(livePreview), body, 'the prefix boundary is a distinct live-preview state even on the same source line');
 const ranges = []; state.field(livePreview).between(0, text.length, (from, to, value) => ranges.push({ from, to, value }));
 assert.equal(ranges.some(item => item.value.spec.class === 'cm-md-list-prefix'), false);
 assert.equal(ranges.filter(item => item.value.spec.widget?.constructor.name === 'MarkerWidget').length, 1);
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

test('list indentation tabs keep their source and code blocks keep their literal indentation', async () => {
 for (const text of [
  'cursor\n\n- parent\n\t  continuation',
  'cursor\n\n1. parent\n\t  continuation',
  'cursor\n\n- [ ] task\n\t  continuation',
  'cursor\n\n- parent\n  - child\n\t  continuation',
  'cursor\n\n> - parent\n> \t  continuation',
 ]) {
  const { state, result } = await plan(text);
  assert.equal(state.doc.toString(), text);
  assert.ok(result.some(item => item.spec.class === 'cm-md-indent-tab' && item.source === '\t'), text);
 }
 for (const text of ['cursor\n\n\tcode', 'cursor\n\n```text\n\tcode\n```']) {
  const { state, result } = await plan(text);
  assert.equal(state.doc.toString(), text);
  assert.equal(result.some(item => item.spec.class === 'cm-md-indent-tab'), false, text);
 }
});

test('whitespace-only list continuation keeps the same layout before and after typing', async () => {
 for (const source of ['- item\n ', '- item\n\t', '- item\n\t  ', '1. item\n\t', '- outer\n  - inner\n\t\t', '> - item\n> \t']) {
  const blank = await plan(source, { anchor: source.length });
  const typed = await plan(source + '文', { anchor: source.length + 1 });
  const layout = ({ state, result }) => {
   const line = state.doc.lineAt(state.doc.length);
   return result.find(item => item.from === line.from && item.spec.class === 'cm-md-list-layout')?.spec.attributes?.style;
  };
  assert.equal(blank.state.doc.toString(), source);
  assert.ok(layout(typed), 'typed continuation must have list layout: ' + JSON.stringify(source));
  assert.equal(layout(blank), layout(typed), 'empty and typed continuation use the same layout: ' + JSON.stringify(source));
 }
});

test('horizontal-rule selection updates agree with fresh preview at either source boundary', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview, buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
 for (const marker of ['---', '***', '___', '- - -']) {
  const source = marker + '\ntext';
  let state = EditorState.create({ doc: source, selection: { anchor: marker.length }, extensions: [markdownSyntax(), livePreview] });
  const rules = decorations => {
   const result = [];
   decorations.between(0, state.doc.length, (from, to, value) => {
    if (value.spec.widget?.constructor.name === 'HorizontalRuleWidget') result.push({ from, to });
   });
   return result;
  };
  for (const anchor of [1, marker.length, 0, marker.length, marker.length - 1]) {
   state = state.update({ selection: { anchor } }).state;
   assert.deepEqual(rules(state.field(livePreview)), rules(buildMarkdownLivePreview(state)),
    `selection-only cache matches a fresh render at ${anchor}: ${marker}`);
   assert.equal(rules(state.field(livePreview)).length, anchor < marker.length ? 0 : 1);
   assert.equal(state.doc.toString(), source, 'revealing source never edits the document');
  }
 }
});

test('horizontal rule animates both disclosure directions without replaying inside its source', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview, buildMarkdownLivePreview } = await import('../src/editor/markdownLivePreview.ts');
 const source = 'before\n\n---\n\nafter', from = source.indexOf('---');
 let state = EditorState.create({ doc: source, selection: { anchor: from + 1 }, extensions: [markdownSyntax(), livePreview] });
 const animatedRule = decorations => {
  let found = false;
  decorations.between(0, source.length, (_from, _to, value) => {
   if (value.spec.widget?.constructor.name === 'HorizontalRuleWidget' && value.spec.widget.animateEntry) found = true;
  });
  return found;
 };
 state = state.update({ selection: { anchor: 0 } }).state;
 assert.equal(animatedRule(state.field(livePreview)), true, 'leaving source reveals the rendered rule with one bounded entrance');
 assert.equal(animatedRule(buildMarkdownLivePreview(state)), false, 'a fresh initial render does not replay the entrance');
 state = state.update({ selection: { anchor: source.length } }).state;
 assert.equal(animatedRule(state.field(livePreview)), false, 'ordinary cursor movement does not animate other rules');
 state = state.update({ selection: { anchor: from + 2 } }).state;
 assert.equal(animatedRule(state.field(livePreview)), false, 'the editable source stays unobscured when focus enters it');
 const sourceMotion = [];
 state.field(livePreview).between(from, from + 3, (a, b, value) => {
  if (value.spec.class?.includes('cm-md-horizontal-rule-source-enter')) sourceMotion.push({from:a,to:b});
 });
 assert.deepEqual(sourceMotion, [{from,to:from+3}], 'entering the rule source animates only its editable delimiter');
 const beforeMove=state.field(livePreview);
 state = state.update({ selection: { anchor: from + 1 } }).state;
 assert.equal(state.field(livePreview),beforeMove,'moving within the same rule reuses its DOM without replaying');
 assert.equal(state.doc.toString(), source, 'focus transitions never change Markdown');
});

test('blank list paragraphs and lazy task continuations predict the parsed text edge', async () => {
 // Reproduction: the empty line previously had no list offset until its first
 // character was typed. A blank line requires the list's real content indent;
 // only an adjacent paragraph/task permits lazy continuation indentation.
 for (const source of [
  '- item\n\n\t', '1. item\n\n\t', '10. item\n\n\t',
  '- item\n\n\n  ', '- [ ] item\n ', '- [x] item\n\n\t',
  '- parent\n  - child\n\n  ', '- parent\n  - child\n\n\t',
  '- item\n  ```\n  code\n  ```\n\t', '- item\n  ~~~\n  code\n  ~~~\n\n\t',
 ]) {
  const blank = await plan(source, { anchor: source.length });
  const typed = await plan(source + '文', { anchor: source.length + 1 });
  const layout = ({ state, result }) => result.find(item => item.from === state.doc.lineAt(state.doc.length).from
   && item.spec.class === 'cm-md-list-layout')?.spec.attributes?.style;
  assert.ok(layout(typed), 'the Markdown parser confirms a list paragraph: ' + JSON.stringify(source));
  assert.equal(layout(blank), layout(typed), 'the caret already uses the parsed text edge: ' + JSON.stringify(source));
  assert.equal(blank.state.doc.toString(), source, 'the presentation does not rewrite indentation');
 }
});

test('blank paragraph layout preserves UTF-16 edits, one-step undo and rehydration', async () => {
 const { EditorState } = await import('@codemirror/state');
 const { history, undo, redo } = await import('@codemirror/commands');
 const { indentUnit } = await import('@codemirror/language');
 const { markdownSyntax } = await import('../src/editor/markdownLanguage.ts');
 const { livePreview } = await import('../src/editor/markdownLivePreview.ts');
 const { keyHabitsTab } = await import('../src/editor/markdownKeyHabits.ts');
 const extensions = [markdownSyntax(), livePreview, history(), indentUnit.of('\t'), EditorState.tabSize.of(4)];
 for (const source of ['- item\n\n', '10. item\n\n', '- [ ] task\n\n']) {
  const view = { state: EditorState.create({ doc: source, selection: { anchor: source.length }, extensions }) };
  view.dispatch = transaction => { view.state = transaction.state || view.state.update(transaction).state; };
  const layout = state => {
   let value;
   state.field(livePreview).between(state.doc.lineAt(state.doc.length).from, state.doc.length, (_from, _to, decoration) => {
    if (decoration.spec.class === 'cm-md-list-layout') value = decoration.spec.attributes.style;
   });
   return value;
  };
  assert.equal(keyHabitsTab(1)(view), true);
  assert.equal(view.state.doc.toString(), source + '\t');
  const blankLayout = layout(view.state);
  assert.ok(blankLayout);
  const position = view.state.doc.length;
  view.dispatch({ changes: { from: position, insert: '文😀' }, selection: { anchor: position + 3 }, userEvent: 'input.type' });
  assert.equal(view.state.doc.toString(), source + '\t文😀');
  assert.equal(view.state.selection.main.head, position + 3, 'selection positions remain UTF-16 offsets');
  assert.equal(layout(view.state), blankLayout);
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), source + '\t', 'one undo removes typing, not the preceding Tab');
  assert.equal(view.state.selection.main.head, position);
  assert.equal(layout(view.state), blankLayout);
  assert.equal(redo(view), true);
  const reopened = EditorState.create({ doc: view.state.doc.toString(), selection: view.state.selection, extensions });
  assert.equal(layout(reopened), blankLayout, 'rehydrating the saved source gives the same list offset');
  assert.equal(reopened.doc.toString(), source + '\t文😀');
 }
});

test('blank continuation inference stops at list ends, quotes and indented code', async () => {
 for (const source of [
  '- item\n\n ', '10. item\n\n   ', '- item\n\n      ', '- item\n\n\t\t',
  '- item\n\nplain paragraph\n\t', '- item\n\n# Heading\n\t',
  '> - item\n\n\t', '> > - item\n\n  ', '```\n- item\n\t',
  '    - code\n\t', '- item\n  ```\n  code\n\t',
  '- item\n  ```\n  code\n  ```\n ', '- item\n  ```\n  code\n  ```\n\t\t',
 ]) {
  const lastLayout = ({ state, result }) => result.filter(item => item.from === state.doc.lineAt(state.doc.length).from
   && item.spec.class === 'cm-md-list-layout');
  assert.deepEqual(lastLayout(await plan(source + '文', { anchor: source.length + 1 })), [],
   'the parser confirms this is not a prose list continuation: ' + JSON.stringify(source));
  assert.deepEqual(lastLayout(await plan(source, { anchor: source.length })), [],
   'an empty line does not invent list membership: ' + JSON.stringify(source));
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

test('active list prefixes retain the full source-space count for visual gap compensation', async () => {
 const source = '-    four spaces', { result } = await plan(source, { anchor: 1 });
 const prefix = result.find(item => item.spec.class?.split(/\s+/).includes('cm-md-list-prefix'));
 assert.ok(prefix, 'the source prefix is editable at the marker');
 assert.match(prefix.spec.attributes.style, /--md-prefix-space-columns: 4/);
 assert.equal(source, '-    four spaces', 'visual compensation does not rewrite Markdown');
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
