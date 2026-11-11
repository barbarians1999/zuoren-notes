#!/usr/bin/env python3
"""Rebuild only the managed Windows worker with explicitly supplied local tools.
No tool download, installation, signing, execution-policy change or GUI launch.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--dotnet', required=True, type=Path)
parser.add_argument('--compiler', required=True, type=Path)
parser.add_argument('--references', required=True, type=Path, help='net48 reference assembly directory')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
source = root / 'electron/native/FileMoveWorker.cs'
binary = root / 'electron/native/FileMoveWorker.exe'
refs = [args.references / name for name in ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll']]
for item in [args.dotnet, args.compiler, source, *refs]:
    if not item.is_file():
        raise SystemExit('Missing explicit build input: ' + str(item))
command = [str(args.dotnet), str(args.compiler), '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/deterministic', '/debug-', '/nostdlib+', '/langversion:5', '/pathmap:' + str(root) + '=.', '/out:' + str(binary)]
command += ['/reference:' + str(item) for item in refs] + [str(source)]
subprocess.run(command, cwd=root, check=True)
sha = lambda item: hashlib.sha256(item.read_bytes()).hexdigest()
manifest = {
    'protocol': 2,
    'release_ready': False,
    'source_sha256': sha(source),
    'binary_sha256': sha(binary),
    'compiler_dll_sha256': sha(args.compiler),
    'reference_assembly_sha256': {item.name: sha(item) for item in refs},
    'compiler': 'Microsoft Roslyn 4.11.0; net48 references 1.0.3; C#5; deterministic AnyCPU; x64 runtime probe required',
    'runtime': '.NET Framework 4.8, Windows x64 local NTFS only',
    'qualification': 'Windows native transaction/receipt crash acceptance not run; process-crash model only, not power-loss durability; product remains disabled',
    'layout_expected': {'pointerSize':8,'unicodeSize':16,'attributesSize':48,'ioStatusSize':16,'fileInfoSize':52,'renameRootOffset':8,'renameLengthOffset':16,'renameNameOffset':20,'dispositionSize':1},
    'exit_codes': {'supported':0,'moved':0,'unsupported':3,'failed':4,'uncertain':5,'receipt':0,'unresolved':6}
}
(root / 'electron/native/FileMoveWorker.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'source_sha256':manifest['source_sha256'],'binary_sha256':manifest['binary_sha256'],'release_ready':False}))
