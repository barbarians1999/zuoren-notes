// Windows-only qualification in newly created TEMP fixtures. No Electron,
// installed userData, release flag change, or production capability bypass.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const assert = require('node:assert/strict');
const { NativeFileMover } = require('../electron/native-file-mover.cjs');
const { FileStore, digest } = require('../electron/storage.cjs');
const { FileMoves } = require('../electron/file-moves.cjs');
const { MoveJournal } = require('../electron/move-journal.cjs');
const identity = stat => [stat.dev, stat.ino].join(':');
function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
const reportOwners = new Map();
async function writeReport(file, report, exclusive = false) {
  const temporary = exclusive ? file : path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  let handle, owned = false, closed = false, published = false;
  try {
    if (!exclusive) {
      const current = await fs.lstat(file, { bigint: true });
      assert.equal(current.isSymbolicLink(), false); assert.equal(current.isFile(), true);
      assert.equal(identity(current), reportOwners.get(file), 'only this qualification report may be updated');
    }
    handle = await fs.open(temporary, 'wx', 0o600); owned = true;
    await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync();
    const nextIdentity = identity(await handle.stat({ bigint: true }));
    await handle.close(); closed = true;
    if (!exclusive) await fs.rename(temporary, file);
    published = true; reportOwners.set(file, nextIdentity);
  } finally {
    if (handle && !closed) await handle.close().catch(() => {});
    if (owned && !published && !exclusive) await fs.unlink(temporary).catch(() => {});
  }
}
async function main() {
  // Must precede manifest reads, TEMP creation and any native invocation.
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 required; no native test was run.');
  const cases = [], finalized = [];
  const report = { schema: 2, protocol: 2, platform: process.platform, arch: process.arch, node: process.version,
    os: os.release(), product_enabled: false, electron_started: false, cases, finalized };
  let base, baseIdentity, native, journal, passed = false, manifestBytes;
  try {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ZuorenNativeMoveQualification-')));
    baseIdentity = identity(await fs.lstat(base, { bigint: true })); report.fixture = base;
    const root = path.join(base, 'notes'), journalDirectory = path.join(base, 'journal'), workerTemp = path.join(base, 'worker-temp');
    await fs.mkdir(root); await fs.mkdir(workerTemp);
    native = new NativeFileMover({ spawn: (executable, args, options) => childProcess.spawn(executable, args,
      { ...options, env: { ...(options.env || process.env), TEMP: workerTemp, TMP: workerTemp } }) });
    const manifest = await native.verify(); manifestBytes = await fs.readFile(native.manifestPath);
    assert.equal(manifest.protocol, 2); assert.equal(manifest.release_ready, false, 'qualification must not enable the candidate');
    assert.equal(digest(await fs.readFile(path.join(__dirname, '../electron/native/FileMoveWorker.cs'))), manifest.source_sha256);
    Object.assign(report, { binary_sha256: manifest.binary_sha256, source_sha256: manifest.source_sha256,
      cli_sha256: digest(await fs.readFile(__filename)), release_ready: false });
    const probe = await native.run(['--probe'], null); report.probe = probe;
    assert.equal(native.active, false); assert.equal(probe.status, 'supported'); assert.equal(probe.protocol, 2);
    for (const name of ['relative-no-reparse-does-not-create-outside', 'held-sentinel-prevents-directory-reparse',
      'held-parent-rejects-peer-delete-and-rename', 'held-sentinel-rejects-peer-delete-including-posix',
      'held-sentinel-rejects-basic-and-posix-replacement', 'held-sentinel-rejects-posix-link-replacement',
      'relative-rename-and-no-replace', 'source-handle-excludes-concurrent-write']) assert.ok(probe.cases?.includes(name), name);
    report.probe = probe;
    const store = new FileStore(); await store.grantRoot(root);
    journal = new MoveJournal(journalDirectory); await journal.load(); assert.equal(journal.problem, null);
    const assertReceiptFixture = input => assert.ok(within(journalDirectory, input.ReceiptPath), 'receipt must remain in this TEMP journal');
    // This adapter is only for synthetic files below this newly created root.
    // NativeFileMover.move()/capability() and release_ready remain unchanged.
    const adapter = {
      capability: async () => ({ supported: true, evidence: probe }),
      move: input => {
        assert.equal(input.Root, root); assert.ok(within(root, input.Source) && within(root, input.Target)); assertReceiptFixture(input);
        return native.run([], input);
      },
      readReceipt: input => { assertReceiptFixture(input); return native.readReceipt(input); },
      get active() { return native.active; },
    };
    const moves = new FileMoves(store, { native: adapter, journal,
      // Closed-file qualification has no product session; GUI/settings remap is
      // a separate acceptance item. Still assert finalize reaches this callback.
      onFinalize: async result => { finalized.push({ operationId: result.operationId, path: result.entry.path }); } });
    store.moveGuard = (file, options) => moves.assertAccess(file, options);
    async function intentFor(operationId) {
      const state = await journal.status(operationId); assert.equal(state.status, 'pending'); assert.ok(state.intent);
      return state.intent;
    }
    async function finalizeMoved(operationId) {
      const intent = await intentFor(operationId);
      assert.equal((await new MoveJournal(journalDirectory).load()).hasPending, true, 'reload must retain pending protection');
      const terminal = await adapter.readReceipt(moves.receiptFields(intent)); assert.equal(native.active, false);
      assert.equal(terminal.status, 'moved'); await moves.verifyOutcome(intent, terminal);
      await assert.rejects(store.checked(intent.plan.target), /未决|保护|闭锁/, 'normal Store access remains guarded until finalize');
      const callbacks = finalized.length;
      assert.equal(await moves.finalize(operationId), true); assert.equal(finalized.length, callbacks + 1);
      assert.equal(journal.hasPending, false); assert.equal(journal.problem, null);
      assert.equal((await new MoveJournal(journalDirectory).load()).hasPending, false, 'FINISHED must survive journal reload');
      return intent;
    }
    for (const extension of ['md', 'pdf', 'epub']) {
      report.current_case = extension + '-move-finalize-undo';
      const directory = path.join(root, extension); await fs.mkdir(directory);
      const source = path.join(root, 'fixture.' + extension), target = path.join(directory, path.basename(source));
      // Reader qualification only: these are synthetic bytes, not rendered books.
      await fs.writeFile(source, Buffer.from(`\ufeff# owned ${extension} fixture 😀\r\n`), { flag: 'wx' });
      let recoveryId, savedReader, savedHistory;
      if (extension === 'md') {
        const note = await store.readNote(source);
        const saved = await store.saveNote({ ...note, content: note.content + 'saved fixture\r\n' }); assert.notEqual(saved.conflict, true);
        const current = await store.readNote(source); recoveryId = crypto.randomUUID();
        await store.writeRecovery({ sourcePath: source, recoveryId, paneHint: 'primary', baseHash: current.hash,
          content: 'unsaved owned fixture', encoding: { bom: true, eol: '\r\n' } });
        savedHistory = await store.history(source); assert.ok(savedHistory.length > 0);
      } else if (extension === 'pdf') {
        const opened = await store.pdf(source); savedReader = { ...opened.meta, page: 2 }; await store.savePdf(source, savedReader);
      } else {
        const opened = await store.epub(source); savedReader = { ...opened.meta, progress: .4 }; await store.saveEpub(source, savedReader);
      }
      const before = await fs.readFile(source), beforeIdentity = identity(await fs.stat(source, { bigint: true }));
      const records = await moves.records(source, target, root, digest(before)); assert.ok(records.length > 0);
      const entry = (await store.listDirectory(root, root)).entries.find(item => item.path === source); assert.ok(entry?.moveVersion);
      const operationId = crypto.randomUUID();
      const result = await moves.move({ operationId, root, path: source, directory, expectedVersion: entry.moveVersion }); assert.equal(result.ok, true);
      await finalizeMoved(operationId);
      assert.deepEqual(await fs.readFile(target), before); assert.equal(identity(await fs.stat(target, { bigint: true })), beforeIdentity);
      await assert.rejects(fs.stat(source), { code: 'ENOENT' });
      for (const record of records) {
        assert.equal(digest(await fs.readFile(record.file)), digest(record.raw), 'original auxiliary record retained');
        const destination = path.join(directory, '.reader', record.relative);
        assert.deepEqual(await fs.readFile(destination), record.next, 'exact planned metadata published');
      }
      // Store reads deliberately occur only after successful finalize.
      if (extension === 'md') {
        assert.equal((await store.readRecovery(target, recoveryId)).content, 'unsaved owned fixture');
        assert.deepEqual(await store.history(target), savedHistory);
        const loaded = await store.readNote(target); assert.equal(loaded.bom, true); assert.equal(loaded.eol, '\r\n');
      } else assert.deepEqual((await store[extension](target)).meta, savedReader);
      const undoId = crypto.randomUUID(), undone = await moves.undo({ operationId: undoId, token: result.undoToken }); assert.equal(undone.ok, true);
      await finalizeMoved(undoId);
      assert.deepEqual(await fs.readFile(source), before); assert.equal(identity(await fs.stat(source, { bigint: true })), beforeIdentity);
      await assert.rejects(fs.stat(target), { code: 'ENOENT' });
      if (extension === 'md') {
        assert.equal((await store.readRecovery(source, recoveryId)).content, 'unsaved owned fixture'); assert.deepEqual(await store.history(source), savedHistory);
      } else assert.deepEqual((await store[extension](source)).meta, savedReader);
      cases.push({ name: extension + '-journal-receipt-finalize-metadata-and-undo', passed: true, body_sha256: digest(before), metadata_records: records.length });
    }
    // Bypass only the broker's early collision check, with a real durable intent
    // and bound receipt, to exercise native no-replace after metadata staging.
    report.current_case = 'direct-native-collision-receipt-and-replay';
    const source = path.join(root, 'collision.md'), directory = path.join(root, 'collision-target'); await fs.mkdir(directory);
    const target = path.join(directory, path.basename(source)); await fs.writeFile(source, 'owned original', { flag: 'wx' });
    const note = await store.readNote(source), recoveryId = crypto.randomUUID();
    await store.writeRecovery({ sourcePath: source, recoveryId, paneHint: 'primary', baseHash: note.hash,
      content: 'owned collision recovery', encoding: { bom: false, eol: '\n' } });
    const before = await fs.readFile(source), snapshot = await moves.snapshot(source), records = await moves.records(source, target, root, snapshot.hash);
    assert.ok(records.length > 0); const foreign = Buffer.from('foreign collision fixture'); await fs.writeFile(target, foreign, { flag: 'wx' });
    const operationId = crypto.randomUUID(), plan = { operationId, root, source, target, rootIdentity: store.rootIdentities.get(root),
      expectedIdentity: snapshot.identity, expectedHash: snapshot.hash,
      records: records.map(record => ({ source: record.file, relative: record.relative.replaceAll('\\', '/'), rawHash: digest(record.raw), nextHash: digest(record.next) })) };
    await journal.prepare(plan); const intent = await intentFor(operationId), fields = moves.receiptFields(intent);
    const request = { Root: root, RootIdentity: plan.rootIdentity, Source: source, Target: target, ExpectedIdentity: snapshot.identity,
      ExpectedHash: snapshot.hash, Records: records.map(record => ({ Source: record.file, Relative: record.relative.replaceAll('/', '\\'), RawHash: digest(record.raw), NextBase64: record.next.toString('base64') })), ...fields };
    const refused = await adapter.move(request); assert.equal(native.active, false); assert.equal(refused.status, 'failed');
    const persisted = await adapter.readReceipt(fields); assert.deepEqual(persisted, refused); await moves.verifyOutcome(intent, persisted);
    assert.deepEqual(await fs.readFile(source), before); assert.deepEqual(await fs.readFile(target), foreign);
    for (const record of records) {
      assert.deepEqual(await fs.readFile(record.file), record.raw);
      await assert.rejects(fs.stat(path.join(directory, '.reader', record.relative)), { code: 'ENOENT' });
    }
    await journal.complete(operationId, { kind: 'failed', result: persisted }); assert.equal(journal.hasPending, false);
    assert.equal(await store.readRecovery(target, recoveryId), null, 'foreign collision body cannot see the source recovery');
    cases.push({ name: 'direct-native-bound-intent-collision-publishes-no-metadata', passed: true, metadata_records: records.length });
    const receiptBytes = await fs.readFile(fields.ReceiptPath);
    const late = await adapter.move(request); assert.equal(late.status, 'uncertain'); assert.equal(native.active, false);
    assert.deepEqual(await fs.readFile(fields.ReceiptPath), receiptBytes); assert.deepEqual(await fs.readFile(source), before); assert.deepEqual(await fs.readFile(target), foreign);
    cases.push({ name: 'late-worker-rejects-nonempty-terminal-without-overwrite', passed: true });
    const wrongBinding = (fields.RequestBinding[0] === '0' ? '1' : '0') + fields.RequestBinding.slice(1);
    const unresolved = await native.run(['--read-receipt'], { ...fields, RequestBinding: wrongBinding });
    assert.equal(unresolved.status, 'unresolved'); assert.equal(native.active, false); assert.deepEqual(await fs.readFile(fields.ReceiptPath), receiptBytes);
    cases.push({ name: 'wrong-binding-receipt-query-remains-read-only-unresolved', passed: true });
    assert.equal(journal.hasPending, false); assert.equal(journal.problem, null);
    assert.deepEqual(await fs.readdir(workerTemp), [], 'successful probes must clean their private fixtures');
    async function noMarkers(folder) {
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        assert.equal(item.isSymbolicLink(), false, 'unexpected link retained in qualification fixture');
        assert.equal(item.name.startsWith('.__zuoren_move_'), false, 'unconfirmed owned marker/temp retained');
        if (item.isDirectory()) await noMarkers(path.join(folder, item.name));
      }
    }
    await noMarkers(base); assert.deepEqual(await fs.readFile(native.manifestPath), manifestBytes, 'qualification must not change release_ready/manifest');
    passed = true; report.status = 'passed'; delete report.current_case; report.remaining = [
      'Windows controlled main/worker crash, held-lease and concurrent metadata/root/POSIX race matrix',
      'Actual settings/session remap, GUI/IME/accessibility and packaging acceptance',
    ];
  } catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
  finally {
    report.worker_exit_confirmed = native ? !native.active : true; report.fixture_retained = Boolean(base);
    const logs = path.join(__dirname, '..', 'logs', 'file-move'), output = path.join(logs, 'windows-native-' + Date.now() + '-' + crypto.randomUUID() + '.json');
    try { await fs.mkdir(logs, { recursive: true }); await writeReport(output, { ...report, status: passed ? 'checks-passed-pending-final-report' : report.status, completion_pending: true }, true); }
    catch (error) { process.exitCode = 1; console.error(JSON.stringify({ status: 'report-failed', error: error.message, fixture: base, worker_exit_confirmed: report.worker_exit_confirmed })); return; }
    // Never delete on a failed/unknown native operation or an unconfirmed exit.
    if (base && passed && native && !native.active && journal && !journal.hasPending && !journal.problem) {
      try {
        const current = await fs.lstat(base, { bigint: true }); assert.equal(identity(current), baseIdentity); assert.equal(current.isSymbolicLink(), false);
        assert.equal(await fs.realpath(base), base); await fs.rm(base, { recursive: true, force: false });
        report.fixture_removed = true; report.fixture_retained = false;
      } catch (error) { process.exitCode = 1; report.status = 'cleanup-failed'; report.cleanup_error = error.message; }
    }
    try { await writeReport(output, report); } catch (error) { process.exitCode = 1; report.status = 'report-update-failed'; report.report_update_error = error.message; console.error('Final report update failed; initial diagnostic retained: ' + error.message); }
    console.log(JSON.stringify({ status: report.status, report: output, fixture: report.fixture_retained ? base : undefined,
      fixture_removed: Boolean(report.fixture_removed), worker_exit_confirmed: report.worker_exit_confirmed, product_enabled: false }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
