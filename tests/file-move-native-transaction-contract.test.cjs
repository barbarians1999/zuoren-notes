// Text contracts supplement the TEMP-backed managed suite; they never run the
// native binary, launch a GUI, or replace a Windows qualification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../electron/native/FileMoveWorker.cs'), 'utf8');
function between(start, end) { const at = source.indexOf(start); assert.ok(at >= 0, start); const stop = source.indexOf(end, at + start.length); assert.ok(stop > at, end); return source.slice(at, stop); }
const move = between('    internal static object Move(', '    private static void RequireMissing(');
const run = between('    private static int Run(', '    private static int Main(');
const lease = between('internal sealed class ReceiptLease', 'internal static class FileMoveWorker');
test('native metadata transaction checks every collision and stages records before body, then publishes', () => {
  const inspect = move.indexOf('foreach (var record in lockedRecords)');
  const staging = move.indexOf('foreach (var record in prepared)');
  const body = move.indexOf('Native.Rename(file.Value, targetParent.Value');
  const committed = move.indexOf('moved = true;', body);
  const publish = move.indexOf('Native.Rename(record.Temporary.Value');
  assert.ok(inspect >= 0 && inspect < staging && staging < body && body < committed && committed < publish);
  assert.equal(move.slice(0, body).includes('Native.Rename(record.Temporary.Value'), false);
  assert.ok(move.indexOf('recordNames.Add(relative)') < inspect, 'duplicate targets are refused before staging');
});
test('exceptional metadata publication cannot delete a possibly published record or rollback body', () => {
  const safe = move.indexOf('record.Temporary.Delete = false;');
  const publish = move.indexOf('Native.Rename(record.Temporary.Value');
  assert.ok(safe >= 0 && safe < publish);
  assert.equal(/(?:DeleteOwned|unlink|File\.Delete|File\.Move)\(/.test(move), false);
  assert.match(move, /moved \|\| commitAttempted && !commitDenied \? "uncertain" : "failed"/);
  assert.equal(move.includes('error.Message'), false, 'raw metadata parser errors must not enter a receipt');
});
test('a fresh exclusive receipt is claimed before Probe or user-root work and is single-use', () => {
  assert.match(lease, /writable \? 0x00100083u : Native\.Read, 0, false/);
  assert.match(lease, /info\.Identity != input\.ReceiptIdentity/);
  assert.match(lease, /info\.SizeHigh != 0 \|\| info\.SizeLow != 0/);
  assert.match(lease, /if \(writable\) lease\.Claim\(\)/);
  assert.match(lease, /MoveStarted = true; return true/);
  assert.match(move, /lease == null \|\| !lease\.Authorizes\(input\)/);
  const acquire = run.indexOf('ReceiptLease.Acquire(input, true)');
  const probe = run.indexOf('Probe();', acquire);
  const body = run.indexOf('Move(input, lease)', probe);
  assert.ok(acquire >= 0 && acquire < probe && probe < body);
});
test('protocol2 receipt query does not run qualification or user-root mutation', () => {
  const query = run.slice(run.indexOf('if (readReceipt)'), run.indexOf('} else if (probeOnly)'));
  assert.match(query, /ReceiptLease.Acquire\(input, false\)/);
  assert.match(query, /status = "receipt", receipt = lease.Read\(\)/);
  assert.equal(/Probe\(|Move\(|Protect\(|Persist\(/.test(query), false);
  assert.match(source, /case "unresolved": return 6/);
  assert.match(run, /\\"event\\":\\"ready\\",\\"protocol\\":2/);
});
test('receipt invalidation stays nonempty and held until stdout/exit choice and remaining handle cleanup', () => {
  assert.match(lease, /stream.WriteByte\(0\); stream.Flush\(true\); stream.SetLength\(1\)/);
  assert.equal(lease.includes('stream.SetLength(0)'), false);
  const output = run.indexOf('Console.WriteLine(json.Serialize(result))');
  const release = run.indexOf('lease.Dispose()', output);
  assert.ok(output >= 0 && release > output);
  assert.ok(lease.indexOf('scope.Dispose(); CleanupWarning') < lease.indexOf('Native.CloseHandle(file.Value)'));
});
test('remote or unknown drives are refused before opening or sealing a user-root directory', () => {
  const drive = move.indexOf('Native.GetDriveTypeW(scope.Root.Substring(0, 3)) != 3');
  const root = move.indexOf('scope.Directory(scope.Root, false)');
  assert.ok(drive >= 0 && drive < root);
  assert.match(source, /extern uint GetDriveTypeW\(string root\)/);
});
