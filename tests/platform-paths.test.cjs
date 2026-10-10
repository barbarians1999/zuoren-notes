const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFilePath, filePathKey, isAbsoluteFilePath } = require('../src/pathIdentity.cjs');
const { MutationBarrier, sameOrDescendantPath, remapDescendantPath } = require('../src/fileOperations.cjs');
const { sanitizeScrollMemory } = require('../src/sessionState.cjs');
const { validateSession } = require('../electron/session.cjs');
const id = '019c6e27-e55b-43d1-87d8-4e01f1f75043';
test('POSIX identity retains case and slash while Windows identity remains case folded', () => {
  assert.equal(normalizeFilePath('/Users/me/notes/../Notes/a.md'), '/Users/me/Notes/a.md');
  assert.notEqual(filePathKey('/Users/me/A.md'), filePathKey('/Users/me/a.md'));
  assert.equal(filePathKey('D:/Notes/A.md'), filePathKey('d:\\notes\\a.md'));
  assert.equal(normalizeFilePath('\\\\server\\share\\notes\\..\\a.md'), '\\\\server\\share\\a.md');
  assert.equal(isAbsoluteFilePath('relative.md'), false);
  assert.equal(isAbsoluteFilePath('/tmp/a\0.md'), false);
});
test('POSIX renames and mutation barriers do not change another case-distinct document', () => {
  assert.equal(sameOrDescendantPath('/Users/me/Notes/a.md', '/Users/me/notes'), false);
  assert.equal(sameOrDescendantPath('/Users/me/notes-old/a.md', '/Users/me/notes'), false);
  assert.equal(sameOrDescendantPath('/Users/me/notes/a.md', '/Users/me/notes/'), true);
  assert.equal(remapDescendantPath('/Users/me/notes/a.md', '/Users/me/notes', '/Users/me/archive'), '/Users/me/archive/a.md');
  assert.equal(remapDescendantPath('/tmp/a.md', '/', '/archive'), '/archive/tmp/a.md');
  const barrier = new MutationBarrier(); barrier.block('/Users/me/notes');
  assert.equal(barrier.has('/Users/me/notes/a.md'), true);
  assert.equal(barrier.has('/Users/me/Notes/a.md'), false);
  barrier.release('/Users/me/notes'); assert.equal(barrier.has('/Users/me/notes/a.md'), false);
});
test('POSIX V1/V2/V3 sessions retain scroll and source paths without storing note text', () => {
  const notePath = '/Users/me/notes/a.md';
  const v1 = {version:1,root:'/Users/me/notes',currentDirectory:'/Users/me/notes',layout:'note',sidebar:true,splitAt:50,noteTabs:[notePath],primaryNote:{path:notePath,mode:'edit',recoveryId:id},secondaryNote:null,activePdf:null,activeEpub:null};
  assert.equal(validateSession(v1), v1);
  const scroll = {pane:'primary',path:notePath,mode:'edit',scrollTop:150,ratio:0.3};
  const v2 = {...v1,version:2,scrollMemory:[scroll]};
  assert.equal(validateSession(v2),v2); assert.deepEqual(sanitizeScrollMemory([scroll]),[scroll]);
  const v3 = {...v2,version:3,activeNoteGroup:'primary',noteDocuments:[{path:notePath,recoveryId:id,retainedRecoveries:[]}],noteGroups:{primary:{activeId:id,tabs:[{id,path:notePath,mode:'edit',preview:false,selection:{anchor:0,head:0},scroll:{edit:150,preview:0}}]},secondary:{activeId:null,tabs:[]}}};
  assert.equal(validateSession(v3),v3);
  assert.equal(validateSession({...v3,content:'must not enter settings'}),null);
  assert.equal(JSON.stringify(v3).includes('content'),false);
});
