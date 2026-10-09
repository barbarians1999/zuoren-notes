const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let polygons, grouped, paint;
before(async () => ({ pdfImagePolygons: polygons, groupedPdfImages: grouped, paintPdfAppearance: paint } = await import('../src/readers/pdfAppearance.ts')));
test('image geometry preserves rotation, normalizes winding and rejects invalid/empty images', () => {
  assert.deepEqual(polygons([.1,.2,.1,.5,.6,.2])[0].map(n => Math.round(n * 100)), [10,20,60,20,60,50,10,50]);
  assert.equal(polygons([0,0,0,0,1,1,NaN,0,0,1,1,0,0,0]).length, 0);
  const p = polygons([.2,.1,.1,.2,.4,.3])[0];
  assert.equal(p.length, 8); assert.ok(Math.abs(p[4] - .3) < 1e-8);
});
test('optimized image groups follow save/restore and form transforms, retain separate tiles', () => {
  const ops = { save:1, restore:2, transform:3, paintFormXObjectBegin:4, paintFormXObjectEnd:5, beginGroup:6, endGroup:7, paintImageXObjectRepeat:8, paintInlineImageXObjectGroup:9 };
  const result = grouped({fnArray:[1,3,8,2,4,9,5], argsArray:[null,[1,0,0,1,10,20],['img',20,30,[0,0,40,0]],null,[[2,0,0,2,0,0]],['img',[{transform:[10,0,0,10,5,5]}]],null]}, { transform:[1,0,0,1,0,0], width:100, height:100 }, ops);
  assert.deepEqual(result, [.1,.2,.1,.5,.3,.2,.5,.2,.5,.5,.7,.2,.1,.1,.1,.3,.3,.1]);
});
test('appearance draws image union only once, restores context and never mutates source', () => {
  const draws = [], context = { save(){}, restore(){this.restored=true}, setTransform(){}, clearRect(){}, drawImage(source){draws.push([source,this.filter])}, beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, clip(){} };
  const canvas = {width:100,height:100,getContext:()=>context}, source = {};
  paint(canvas, { source, images:[0,0,0,1,1,0,0,0,0,1,1,0] }, true);
  assert.deepEqual(draws, [[source,'invert(1) hue-rotate(180deg) brightness(0.85)'],[source,'brightness(0.65)']]);
  assert.equal(context.restored,true);
  draws.length=0; paint(canvas,{source,images:[]},false); assert.deepEqual(draws,[[source,'none']]);
});
