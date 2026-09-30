// One corpus checks both editor decorations and the reading renderer.
module.exports = [
  { name: 'heading', source: '## Heading', live: '.cm-md-heading-2', read: 'h2', text: 'Heading' },
  { name: 'emphasis', source: '**bold** and *italic* and ~~strike~~', live: '.cm-md-strikethrough', read: 'del', text: 'strike' },
  { name: 'highlight-nesting', source: '==**bold** and a=b==', live: '.cm-md-highlight', read: 'mark', text: 'bold and a=b' },
  { name: 'highlight-code-boundary', source: '==a `==` b==', live: '.cm-md-highlight', read: 'mark', text: 'a == b' },
  { name: 'task', source: '- [x] task\n- [ ] pending', live: '.cm-md-task-checkbox', read: 'input[type=checkbox]', count: 2 },
  { name: 'ordered-quote', source: '3. > quoted\n   > continued', live: '.cm-md-quote', read: 'ol blockquote', text: 'quoted' },
  { name: 'bullet', source: '- one\n- two', live: '.cm-md-list-marker', read: 'ul li', count: 2 },
  { name: 'rule', source: '---', live: '.cm-md-horizontal-rule', read: 'hr', count: 1 },
  { name: 'table', source: '| A | B |\n| :--- | ---: |\n| **x** | y |', live: '.cm-md-table table', read: 'table', text: 'A' },
  { name: 'code', source: '~~~md\n# literal\n- [ ] literal\n~~~', live: '.cm-md-code-preview code', read: 'pre code', text: '# literal' },
];
