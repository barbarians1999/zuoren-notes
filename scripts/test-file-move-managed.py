#!/usr/bin/env python3
"""Regenerate TEMP-backed source-derived managed transaction regressions.

Production Move/Run/receipt and cleanup code is retained. Only native platform
primitives, paths and JSON runtime are replaced with a managed TEMP fixture.
Receipt write/flush faults are injected into the original stream code. This script never loads the production worker or calls WinAPI.
Supply existing local tools explicitly; no downloads or installation occur.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def extract_method(source, marker):
    """Match braces while skipping ordinary/verbatim strings and comments."""
    if source.count(marker) != 1:
        raise ValueError('Expected one current production method: ' + marker)
    start = source.index(marker)
    at = source.index('{', start)
    depth, index = 1, at + 1
    state = 'code'
    while index < len(source):
        char = source[index]
        following = source[index + 1:index + 2]
        if state == 'line':
            if char == '\n':
                state = 'code'
        elif state == 'block':
            if char == '*' and following == '/':
                state = 'code'
                index += 1
        elif state == 'string':
            if char == '\\':
                index += 1
            elif char == '"':
                state = 'code'
        elif state == 'verbatim':
            if char == '"' and following == '"':
                index += 1
            elif char == '"':
                state = 'code'
        elif state == 'char':
            if char == '\\':
                index += 1
            elif char == "'":
                state = 'code'
        elif char == '/' and following == '/':
            state = 'line'
            index += 1
        elif char == '/' and following == '*':
            state = 'block'
            index += 1
        elif char == '"':
            if source[index:index + 3] == '"""' or (source[index - 1:index] == '$' or source[index - 2:index] in ('$@', '@$')):
                raise ValueError('Raw/interpolated C# strings require extraction review')
            state = 'verbatim' if source[index - 1:index] == '@' else 'string'
        elif char == "'":
            state = 'char'
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
        index += 1
    raise ValueError('Unterminated current production method: ' + marker)


def after_cleanup(method):
    marker = 'finally { scope.Dispose(); }'
    if method.count(marker) != 1:
        raise ValueError('Cleanup structure changed; review the extraction')
    return method[method.index(marker) + len(marker):method.rfind('}')].strip()


def generate(source):
    # Keep the full production Move/Run/ReceiptProtocol/ReceiptLease code.
    # Replace only the Windows primitives and directory model with a managed
    # TEMP-backed platform fixture; native qualification is not run here.
    methods = {
        'Native': extract_method(source, 'internal static class Native {'),
        'SealedDirectories': extract_method(source, 'internal sealed class SealedDirectories : IDisposable {'),
        'Probe': extract_method(source, '    internal static object Probe()'),
        'Layout': extract_method(source, '    internal static string Layout()'),
        'Move': extract_method(source, '    internal static object Move('),
        'Run': extract_method(source, '    private static int Run(string[] args)'),
        'ReceiptProtocol': extract_method(source, 'internal static class ReceiptProtocol {'),
        'ReceiptLease': extract_method(source, 'internal sealed class ReceiptLease : IDisposable {'),
        'Dispose': extract_method(source, '    public void Dispose() {\n        for (int index = Handles.Count - 1;'),
        'CleanupFailure': extract_method(source, '    internal void CleanupFailure()'),
        'Bytes': extract_method(source, '    internal byte[] Bytes('),
        'Hash': extract_method(source, '    internal string Hash('),
        'Write': extract_method(source, '    internal void Write('),
    }
    template_path = Path(__file__).resolve().parent.parent / 'tests/fixtures/file-move-managed.csharp'
    template = template_path.read_text(encoding='utf-8')
    template = template.replace('internal sealed class OwnedHandle { internal IntPtr Value; internal bool Delete; internal string Name; }\n', '')
    scope_methods = '\n'.join(methods[name] for name in ['Bytes', 'Hash', 'Write', 'CleanupFailure', 'Dispose'])
    scope_methods = scope_methods.replace('stream.Write(data, 0, data.Length);', 'stream.Write(data, 0, data.Length); if (Native.Mode == \"stage-write-fail\") throw new IOException(\"PRIVATE METADATA STAGE FAILURE\");')
    template = template.replace('// INSERT_SCOPE_METHODS', scope_methods)
    production = source.replace(methods['Native'], '').replace(methods['SealedDirectories'], '')
    production = production.replace(methods['Probe'], '    internal static object Probe() { Native.ProbeCalls++; ProbePassed = Native.ProbeSupported; return new { status = ProbePassed ? "supported" : "unsupported", protocol = 2 }; }')
    production = production.replace(methods['Layout'], '    internal static string Layout() { return "{}"; }')
    production = production.replace('private static int Run(', 'internal static int Run(', 1)
    # Faults are injected into the actual receipt stream code. No alternate
    # status/commit policy is reimplemented by these injections.
    persist = extract_method(production, '    internal void Persist(object result)')
    faulted = persist.replace('stream.Write(bytes, 0, bytes.Length); stream.SetLength(bytes.Length); stream.Flush(true);', 'if (Native.FailReceiptWrite) { stream.Write(bytes, 0, bytes.Length / 2); throw new IOException("fixture receipt write"); } stream.Write(bytes, 0, bytes.Length); stream.SetLength(bytes.Length); if (Native.FailReceiptFlush) throw new IOException("fixture receipt flush"); stream.Flush(true);')
    if faulted == persist:
        raise ValueError('Receipt stream write changed; review fault injection')
    production = production.replace(persist, faulted)
    invalidation = extract_method(production, '    internal void InvalidateAfterWriteFailure()')
    faulted = invalidation.replace('stream.WriteByte(0);', 'if (Native.FailInvalidate) throw new IOException("fixture invalidation fault"); stream.WriteByte(0);')
    production = production.replace(invalidation, faulted)
    claim = extract_method(production, '    private void Claim()')
    faulted = claim.replace('stream.Write(claim, 0, claim.Length); stream.Flush(true);', 'if (Native.FailClaimWrite) { stream.WriteByte(1); throw new IOException("fixture claim write"); } stream.Write(claim, 0, claim.Length); if (Native.FailClaimFlush) throw new IOException("fixture claim flush"); stream.Flush(true);')
    production = production.replace(claim, faulted)
    production = production.replace('using Microsoft.Win32.SafeHandles;', 'using Microsoft.Win32.SafeHandles;\nusing Path = FixturePath;')
    harness = production + '\n' + template
    if '[DllImport' in harness or '[LibraryImport' in harness:
        raise ValueError('Generated managed harness must contain no native imports')
    methods['ManagedPlatformFixture'] = template
    return harness, methods


def invoke(command, log, timeout):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        def text(value):
            return value.decode('utf-8', errors='replace') if isinstance(value, bytes) else value or ''
        log.write_text(text(error.stdout) + text(error.stderr) + '\nManaged subprocess exceeded its bounded timeout.\n', encoding='utf-8')
        raise RuntimeError('Managed subprocess timed out; no native worker was started') from error
    log.write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode != 0:
        raise RuntimeError('Managed subprocess failed; see ' + str(log))
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dotnet', required=True, type=Path, help='Existing dotnet executable')
    parser.add_argument('--compiler', required=True, type=Path, help='Existing Roslyn csc.dll')
    parser.add_argument('--references', required=True, type=Path, help='Existing net48 reference assembly directory')
    parser.add_argument('--source', type=Path, help='Production C# file; defaults to this checkout')
    parser.add_argument('--output', type=Path, help='Text-only artifacts directory; defaults to logs/file-move/managed-SHA')
    parser.add_argument('--runtime-version', default='8.0.0', help='Existing Microsoft.NETCore.App runtime minimum, default 8.0.0')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    source = (args.source or repo / 'electron/native/FileMoveWorker.cs').resolve()
    dotnet, compiler = args.dotnet.resolve(), args.compiler.resolve()
    references = [(args.references / name).resolve() for name in ['mscorlib.dll', 'System.dll', 'System.Core.dll']]
    reference = references[0]
    for item in [source, dotnet, compiler, *references]:
        if not item.is_file():
            raise ValueError('Missing explicit local input: ' + str(item))
    if not re.fullmatch(r'\d+\.\d+\.\d+', args.runtime_version):
        raise ValueError('Runtime version must be major.minor.patch')
    original = source.read_bytes()
    source_sha = digest(original)
    output = (args.output or repo / 'logs/file-move' / ('managed-' + source_sha[:12])).resolve()
    output.mkdir(parents=True, exist_ok=True)
    receipt_path = output / 'managed-regression-receipt.json'
    receipt = {
        'schema': 1, 'status': 'failed', 'source': str(source), 'source_sha256': source_sha,
        'generator_sha256': digest(Path(__file__).read_bytes()), 'platform': sys.platform,
        'tool_inputs': {'dotnet': str(dotnet), 'compiler': str(compiler), 'reference': str(reference)},
        'compiler_sha256': digest(compiler.read_bytes()), 'reference_sha256': digest(reference.read_bytes()),
        'runtime_minimum': args.runtime_version, 'windows_api_invoked': False,
        'production_worker_executed': False, 'windows_native_probe_pass': False, 'release_ready': False,
        'qualification': 'Full production managed transaction/receipt policy with TEMP-backed platform mocks; not Windows or GUI acceptance',
    }
    print(json.dumps({'event': 'managed-source', 'source_sha256': source_sha, 'windows_api_invoked': False}), flush=True)
    try:
        harness, methods = generate(original.decode('utf-8'))
        # No production PInvoke declarations survive generation. The reviewed
        # fixture maps all managed File/Directory operations to its own TEMP root.
        if '[DllImport' in harness or '[LibraryImport' in harness:
            raise ValueError('Native imports remain in the managed harness')
        generated = output / 'ManagedFaultRegression.generated.cs'
        generated.write_text(harness, encoding='utf-8')
        receipt['generated_sha256'] = digest(generated.read_bytes())
        receipt['extracted_method_sha256'] = {name: digest(body.encode('utf-8')) for name, body in methods.items()}
        receipt['extraction_changes'] = ['Run visibility private to internal', 'native primitives/directories/JSON runtime replaced by managed TEMP model', 'Probe/layout bypassed in managed harness only', 'receipt stream write/flush/invalidation faults injected in actual methods']
        with tempfile.TemporaryDirectory(prefix='zuoren-managed-regression-') as temporary:
            work = Path(temporary)
            binary = work / 'ManagedFaultRegression.exe'
            command = [str(dotnet), str(compiler), '/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/main:ManagedReview', '/platform:x64', '/langversion:5', '/optimize+', '/deterministic+', '/out:' + str(binary), *['/reference:' + str(item) for item in references], str(generated)]
            invoke(command, output / 'managed-regression-compile.log', 60)
            (work / 'ManagedFaultRegression.runtimeconfig.json').write_text(json.dumps({'runtimeOptions': {'tfm': 'net8.0', 'framework': {'name': 'Microsoft.NETCore.App', 'version': args.runtime_version}, 'rollForward': 'LatestMajor'}}), encoding='utf-8')
            result = invoke([str(dotnet), str(binary)], output / 'managed-regression-run.log', 30)
        cases = re.findall(r'^PASS \d+ (.+)$', result, re.MULTILINE)
        if len(cases) != 61 or 'managed source-derived transaction regressions passed: 61; no Windows APIs invoked' not in result:
            raise RuntimeError('Expected all 61 managed assertions; inspect the generated source/run log')
        if source.read_bytes() != original:
            raise RuntimeError('Production source changed during managed verification; receipt refused')
        receipt.update({'status': 'passed', 'managed_cases': len(cases), 'cases': cases, 'temporary_binary_removed': True, 'runtime_report': next((line for line in result.splitlines() if line.startswith('managed-runtime: ')), None)})
    except Exception as error:
        receipt['error'] = str(error)
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        raise
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'passed', 'source_sha256': source_sha, 'managed_cases': len(cases), 'windows_api_invoked': False, 'receipt': str(receipt_path)}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Managed file-move regression failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
