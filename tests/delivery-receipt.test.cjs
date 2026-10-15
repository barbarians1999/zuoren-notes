const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { testPlan, digest } = require('../scripts/verification-plan.cjs');
const { assertReceipt, assertReusableBuild, verifyReceipt, sha256, writeJson } = require('../scripts/delivery-receipt.cjs');
const root = path.resolve(__dirname, '..');
test('markdown is directed, full is broader, and custom plans preserve baseline data-protection tests', async () => {
  const markdown = testPlan(root, 'markdown'), full = testPlan(root, 'full');
  assert.ok(markdown.source.length < full.source.length);
  assert.ok(markdown.source.includes('tests/markdown-presentation-smoke.cjs'));
  assert.ok(!markdown.source.includes('tests/pdf-selection-smoke.cjs'));
  assert.ok(markdown.packaged.includes('tests/platform-package-smoke.cjs'));
  assert.throws(() => testPlan(root, 'directed'), /requires/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-plan-'));
  try {
    const file = path.join(directory, 'plan.json');
    await writeJson(file, { reason: 'specific UI change', source: ['tests/window-startup-smoke.cjs'], packaged: ['tests/window-startup-smoke.cjs'] });
    const directed = testPlan(root, 'directed', file);
    assert.ok(directed.source.includes('tests/document-lifecycle-smoke.cjs'));
    assert.ok(directed.packaged.includes('tests/platform-package-smoke.cjs'));
    await writeJson(file, { reason: 'bad path', source: ['../test.cjs'], packaged: [] });
    assert.throws(() => testPlan(root, 'directed', file), /Unsafe/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('build reuse follows app and runtime identity, not conversation, latest manifest or test-plan labels', () => {
  const source = { commit: 'a', inputs: { sha256: 'app' }, lockFile: { sha256: 'lock' }, nodeVersion: '24', electronVersion: '44' };
  const checkpoint = { schemaVersion: 2, version: '0.3.12', kind: 'official', source };
  assertReusableBuild(checkpoint, { ...source, commit: 'new-test-only-commit' }, '0.3.12', 'official');
  for (const changed of [{ ...source, inputs: { sha256: 'other' } }, { ...source, lockFile: { sha256: 'other' } }, { ...source, electronVersion: '45' }]) assert.throws(() => assertReusableBuild(checkpoint, changed, '0.3.12', 'official'), /inputs changed/);
});
test('only complete exact-identity receipts grant acceptance; byte changes and legacy/dirty evidence are rejected', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-artifact-'));
  try {
    await fs.mkdir(path.join(directory, 'win-unpacked/resources'), { recursive: true });
    const files = ['Setup.exe', 'win-unpacked/resources/app.asar', 'win-unpacked/ZuorenNotes.exe'];
    for (const file of files) await fs.writeFile(path.join(directory, file), file);
    const definition = { schemaVersion: 1, profile: 'directed', reason: 'fixture', unit: ['unit'], source: ['source'], packaged: ['packaged'] };
    const report = { schemaVersion: 2, version: '0.3.12', kind: 'official', build: 'passed', sourceCommit: 'a'.repeat(40), source: { commit: 'a'.repeat(40), dirty: false, inputs: { sha256: 'b'.repeat(64) }, lockFile: { sha256: 'c'.repeat(64) } },
      profile: 'directed', plan: { ...definition, sha256: digest(definition) }, tests: Object.fromEntries(['unit', 'source', 'packaged'].map(stage => [stage, { status: 'passed', count: 1, inputsSha256: 'a', files: definition[stage] }])),
      localAcceptance: { status: 'passed' }, artifacts: { directory }, installer: files[0], installerBytes: 9,
      installerSha256: await sha256(path.join(directory, files[0])), appAsarSha256: await sha256(path.join(directory, files[1])), executableSha256: await sha256(path.join(directory, files[2])),
      installerPayload: { checked: 3, missing: 0, mismatched: 0, embeddedAppAsarMatchesTestedProgram: true, executableAndInstallerIconsMatchConfiguredSource: true } };
    const receipt = path.join(directory, 'VALIDATION.json'); await writeJson(receipt, report);
    await verifyReceipt(receipt);
    assert.throws(() => assertReceipt({ ...report, schemaVersion: undefined }), /schema-2/);
    assert.throws(() => assertReceipt({ ...report, kind: 'local-test' }), /official/);
    assert.throws(() => assertReceipt({ ...report, source: { ...report.source, dirty: true } }), /official/);
    assert.throws(() => assertReceipt({ ...report, plan: { ...report.plan, reason: 'unverified scope' } }), /plan identity/);
    await fs.writeFile(path.join(directory, files[0]), 'changed');
    await assert.rejects(verifyReceipt(receipt), /artifact changed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
