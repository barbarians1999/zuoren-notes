param([string]$TemporaryRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\artifact-recycle.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\accepted-artifact.ps1')
function Expect-Rejection([scriptblock]$Action) { $failed = $false; try { & $Action } catch { $failed = $true }; if (-not $failed) { throw 'Expected safety rejection.' } }
$fixture = Join-Path $TemporaryRoot 'fixture'
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$file = Join-Path $fixture 'sample.txt'; [IO.File]::WriteAllText($file, 'abc')
if ((Get-ArtifactHash $file) -ne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { throw 'Bundled PowerShell hash mismatch.' }
$snapshot = @(Get-ArtifactSnapshot $fixture)
if ($snapshot.Count -ne 1 -or $snapshot[0].Relative -ne 'sample.txt' -or $snapshot[0].Bytes -ne 3) { throw 'Snapshot mismatch.' }
Expect-Rejection { Invoke-VerifiedRecycle $TemporaryRoot $fixture }
Expect-Rejection { Read-AcceptedArtifact '' '' }
[IO.Directory]::CreateDirectory((Join-Path $fixture '.reader')) | Out-Null
Expect-Rejection { Get-ArtifactSnapshot $fixture }
Initialize-NativeRecycle # Compile the real COM interface; never delete anything.
if (-not (Test-Path -LiteralPath $file)) { throw 'Safety test changed original.' }
'PowerShell policy, hash and native interface checks passed; no recycle operation executed.'
