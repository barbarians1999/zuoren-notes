param([switch]$Apply, [string]$Receipt, [string]$NodeExecutable, [string[]]$SkipPaths = @())
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'artifact-recycle.ps1')
. (Join-Path $PSScriptRoot 'accepted-artifact.ps1')
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$proof = Read-AcceptedArtifact $Receipt $NodeExecutable
$releaseRoot = Join-Path $root 'releases'
$latestDirectory = [IO.Path]::GetFullPath($proof.artifacts.directory)
$candidates = @(); $pending = @()
function Add-Artifact([IO.DirectoryInfo]$Item, [string]$Group, [string]$Parent) {
    if (-not (Test-ArtifactWithin $Item.FullName $Parent) -or $Item.FullName -eq $latestDirectory) { throw 'Unsafe cleanup target.' }
    if ($SkipPaths -contains $Item.FullName) { $script:pending += @{ Path = $Item.FullName; Reason = 'Explicitly deferred' }; return }
    $script:candidates += [pscustomobject]@{ Path = $Item.FullName; Group = $Group; Name = $Item.Name; Parent = $Parent }
}
foreach ($item in Get-ChildItem -LiteralPath $releaseRoot -Directory) {
    if ($item.Name -match '^\d+\.\d+\.\d+$' -and [version]$item.Name -lt [version]$proof.version) { Add-Artifact $item 'releases' $releaseRoot }
}
foreach ($spec in @(@('exports', '^(\d+\.\d+\.\d+)-\d{4}-\d{2}-\d{2}$'), @('outputs', '^(?:ui-|markdown-audit-|markdown-repair-)(\d+\.\d+\.\d+)$'))) {
    $parent = Join-Path $root $spec[0]
    if (Test-Path -LiteralPath $parent) { foreach ($item in Get-ChildItem -LiteralPath $parent -Directory) {
        if ($item.Name -match $spec[1] -and [version]$Matches[1] -lt [version]$proof.version) { Add-Artifact $item $spec[0] $parent }
    } }
}
$work = Join-Path $root 'work'
if (Test-Path -LiteralPath $work) { foreach ($item in Get-ChildItem -LiteralPath $work -Directory) {
    if ($item.Name -notmatch '^(installer-\d+|package-source)$') { continue }
    $manifest = Join-Path $item.FullName 'package.json'
    if (Test-Path -LiteralPath $manifest) {
        $generated = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($generated.name -eq 'zuoren-notes-reader' -and [version]$generated.version -le [version]$proof.version) { Add-Artifact $item 'installer-staging' $work }
    }
} }
$plan = [ordered]@{ AcceptedVersion = $proof.version; Receipt = $Receipt; ReceiptSha256 = Get-ArtifactHash $Receipt; Targets = $candidates; Pending = $pending }
if (-not $Apply) { $plan | ConvertTo-Json -Depth 6; exit 0 }
$logs = Join-Path $root ('logs\cleanup\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $proof.version)
[IO.Directory]::CreateDirectory($logs) | Out-Null
$encoding = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $logs 'manifest.json'), ($plan | ConvertTo-Json -Depth 7), $encoding)
$results = @()
foreach ($target in $candidates) {
    try {
        # Snapshot verifies no links/protected subtrees before any removal.
        $snapshot = @(Get-ArtifactSnapshot $target.Path)
        if ($snapshot | Where-Object { $_.Relative -match '\.(pdf|epub)$' }) { throw 'Original reading material found; deferred.' }
        $archiveNames = @('VALIDATION.json', 'BUILD.json', 'SHA256SUMS.txt', 'PUBLISHED.json', 'EXPORT-VERIFICATION.json', 'installer-integrity.json', 'builder-debug.yml', 'CHANGELOG.md', 'summary.json', 'manifest.json', 'recycled.jsonl', 'report.html', 'observations.json')
        foreach ($entry in $snapshot) {
            $file = Join-Path $target.Path $entry.Relative
            if ([IO.Path]::GetFileName($file) -notin $archiveNames -and [IO.Path]::GetExtension($file) -ne '.log') { continue }
            $archive = Join-Path (Join-Path (Join-Path $root 'logs') $target.Group) ($target.Name + '\' + $entry.Relative)
            [IO.Directory]::CreateDirectory((Split-Path $archive -Parent)) | Out-Null
            if (Test-Path -LiteralPath $archive) {
                if ((Get-ArtifactHash $archive) -ne $entry.Sha256) { throw 'Historical log archive conflict; original retained.' }
            } else { Copy-Item -LiteralPath $file -Destination $archive }
            if ((Get-ArtifactHash $archive) -ne $entry.Sha256) { throw 'Historical log archive hash mismatch.' }
        }
        # Validate the accepted package again immediately before recycling.
        $null = Read-AcceptedArtifact $Receipt $NodeExecutable
        $results += Invoke-VerifiedRecycle $target.Path $target.Parent
    } catch { $pending += [pscustomobject]@{ Path = $target.Path; Reason = $_.Exception.Message } }
    [IO.File]::WriteAllText((Join-Path $logs 'results.json'), (@{ Results = $results; Pending = $pending } | ConvertTo-Json -Depth 8), $encoding)
}
$summary = [ordered]@{ AcceptedVersion = $proof.version; Receipt = $Receipt; Status = if ($pending.Count) { 'pending' } else { 'completed' }; Recycled = $results; Pending = $pending; LogDirectory = $logs; SettingsChanged = $false }
[IO.File]::WriteAllText((Join-Path $logs 'summary.json'), ($summary | ConvertTo-Json -Depth 8), $encoding)
$summary | ConvertTo-Json -Depth 8
if ($pending.Count) { exit 2 }
