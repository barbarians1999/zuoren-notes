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
 assert.equal(active.result.some(x => x.spec.widget?.constructor.name === 'MarkerWidget'), false, 'the Markdown marker reappears while editing its list item');
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
