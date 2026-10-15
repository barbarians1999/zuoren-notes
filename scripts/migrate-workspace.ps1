param([Parameter(Mandatory=$true)][string]$OldRoot, [switch]$Apply)
$ErrorActionPreference = 'Stop'
$newRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$oldRootPath = (Resolve-Path -LiteralPath $OldRoot).Path.TrimEnd('\')
if ($oldRootPath -eq $newRoot -or $oldRootPath.StartsWith($newRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $newRoot.StartsWith($oldRootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Migration roots must be distinct, non-nested directories.' }
$manifest = Get-Content -LiteralPath (Join-Path $newRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.name -ne 'zuoren-notes-reader' -or (Test-Path -LiteralPath (Join-Path $oldRootPath 'package.json'))) { throw 'Unexpected active/legacy workspace identity.' }
function Long-Path([string]$File) { if ($File.StartsWith('\\?\')) { return $File }; return '\\?\' + [IO.Path]::GetFullPath($File) }
function Hash([string]$File) {
    $sha = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead((Long-Path $File))
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function Within([string]$Child, [string]$Parent) { return [IO.Path]::GetFullPath($Child).StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }
function Inventory([string]$Target) {
    $entry = Get-Item -LiteralPath $Target -Force
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked target: ' + $Target) }
    $files = [Collections.Generic.List[object]]::new(); $directories = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    if ($entry.PSIsContainer) { $pending.Push($Target) } else { $files.Add([pscustomobject]@{ Relative = ''; Bytes = $entry.Length; Sha256 = (Hash $Target) }) }
    while ($pending.Count) {
        $directory = $pending.Pop(); $directories.Add($directory.Substring($Target.Length).TrimStart('\'))
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (-not (Within $item.FullName $Target) -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Unsafe entry: ' + $item.FullName) }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            else { $files.Add([pscustomobject]@{ Relative = $item.FullName.Substring($Target.Length).TrimStart('\'); Bytes = $item.Length; Sha256 = (Hash $item.FullName) }) }
        }
    }
    return [pscustomobject]@{ Directory = $entry.PSIsContainer; Files = $files.ToArray(); Directories = $directories.ToArray(); Bytes = [long](($files.ToArray() | Measure-Object Bytes -Sum).Sum) }
}
$targets = [Collections.Generic.List[object]]::new()
function Add-Target([string]$From, [string]$To, [string]$Kind) {
    $source = [IO.Path]::GetFullPath((Join-Path $oldRootPath $From)); $destination = [IO.Path]::GetFullPath((Join-Path $newRoot $To))
    if (-not (Within $source $oldRootPath) -or -not (Within $destination $newRoot) -or (Within $destination (Join-Path $newRoot '.git')) -or $destination -eq (Join-Path $newRoot '.git')) { throw 'Migration target escaped its explicit root.' }
    if ($From -match 'sheke|shelf' -or $To -match 'sheke|shelf') { throw 'Book-shelf project is excluded.' }
    if (-not (Test-Path -LiteralPath $source)) { return }
    $targets.Add([pscustomobject]@{ Source = $source; Destination = $destination; Kind = $Kind; Inventory = (Inventory $source); Status = 'planned' })
}
Add-Target 'releases' 'releases' 'installers'
foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $oldRootPath 'logs') -Force) {
    if ($entry.Name -notmatch 'sheke|shelf') { Add-Target ('logs\' + $entry.Name) ('logs\' + $entry.Name) 'logs' }
}
foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $oldRootPath 'outputs') -Directory) {
    if ($entry.Name -match '^ui-\d+\.\d+\.\d+$') { Add-Target ('outputs\' + $entry.Name) ('outputs\' + $entry.Name) 'current-ui' }
}
foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $oldRootPath 'exports') -File) {
    if ($entry.Extension -eq '.md' -and $entry.Name -notmatch 'sheke|shelf') { Add-Target ('exports\' + $entry.Name) ('exports\' + $entry.Name) 'handoff' }
}
Add-Target 'work' 'work' 'support-files'
foreach ($name in @('rescue-20260923-fe94b4a1', 'save-fix-023')) { Add-Target $name ('work\legacy-workspace\' + $name) 'preserved-recovery-and-repair' }
Add-Target '.git' 'work\legacy-workspace\original-workspace\.git' 'preserved-legacy-git'
foreach ($name in @('AGENTS.md', 'apply-icon-patch.cjs', 'executable-icon.png', 'icon-0.2.1.patch', 'icon-0.2.2.patch', 'icon-render-ready.patch', 'installer-icon.png', 'original-icon.png', 'render-icon-runner.cjs', 'verify-release-icons.ps1')) {
    Add-Target $name ('work\legacy-workspace\original-workspace\' + $name) 'historical-support-file'
}
foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $oldRootPath 'tmp') -Directory) {
    if ($entry.Name -match '^pdf-') { Add-Target ('tmp\' + $entry.Name) ('work\legacy-workspace\tmp\' + $entry.Name) 'preserved-pdf-test-profile' }
}
$bytes = [long](($targets.ToArray() | ForEach-Object { $_.Inventory.Bytes } | Measure-Object -Sum).Sum)
$copyBytes = [long]0
foreach ($target in $targets) {
    foreach ($file in $target.Inventory.Files) {
        $destination = if ($target.Inventory.Directory) { Join-Path $target.Destination $file.Relative } else { $target.Destination }
        if ([IO.File]::Exists((Long-Path $destination)) -and ([IO.File]::GetAttributes((Long-Path $destination)) -band [IO.FileAttributes]::ReparsePoint -or (Hash $destination) -ne $file.Sha256)) { throw ('Existing destination differs; no overwrite: ' + $destination) }
        if (-not [IO.File]::Exists((Long-Path $destination))) { $copyBytes += $file.Bytes }
    }
}
if (-not $Apply) { [pscustomobject]@{ Bytes = $bytes; Targets = @($targets.ToArray() | Select-Object Source,Destination,Kind,@{n='Files';e={$_.Inventory.Files.Count}},@{n='Bytes';e={$_.Inventory.Bytes}}) } | ConvertTo-Json -Depth 5; exit 0 }
$drive = [IO.Path]::GetPathRoot($oldRootPath).TrimEnd('\')
$volume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $drive + "'")
if ($drive -ne [IO.Path]::GetPathRoot($newRoot).TrimEnd('\') -or $volume.DriveType -ne 3 -or $volume.DeviceID -notmatch '\{[0-9a-f-]+\}') { throw 'This migration requires one fixed volume.' }
$settings = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $Matches[0])
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$bin = Join-Path ($drive + '\$Recycle.Bin') $sid
$before = @(Get-ChildItem -LiteralPath $bin -Force -File -Filter '$I*' | ForEach-Object FullName)
$used = [long]((Get-ChildItem -LiteralPath $bin -Force -Recurse -File | Measure-Object Length -Sum).Sum)
if ($volume.FreeSpace -lt $copyBytes + 1GB -or $settings.NukeOnDelete -ne 0 -or [long]$settings.MaxCapacity * 1MB -le $used + $bytes + 1GB) { throw 'Insufficient copy/recycle capacity; no settings changed.' }
$running = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath)
foreach ($target in $targets) { if ($running | Where-Object { $_ -eq $target.Source -or (Within $_ $target.Source) }) { throw ('Running files are protected: ' + $target.Source) } }
$auditRoot = Join-Path $newRoot ('logs\migration\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
[IO.Directory]::CreateDirectory($auditRoot) | Out-Null
$encoding = [Text.UTF8Encoding]::new($false)
$audit = [ordered]@{ OldRoot = $oldRootPath; NewRoot = $newRoot; Bytes = $bytes; StartedUtc = [DateTime]::UtcNow.ToString('o'); Status = 'copying'; Targets = $targets.ToArray(); RecycleEntries = @() }
function Log { [IO.File]::WriteAllText((Join-Path $auditRoot 'migration.json'), ($audit | ConvertTo-Json -Depth 9), $encoding) }
function Validate-Copy($Target, [string]$Root) {
    foreach ($file in $Target.Inventory.Files) {
        $path = if ($Target.Inventory.Directory) { Join-Path $Root $file.Relative } else { $Root }
        if (-not [IO.File]::Exists((Long-Path $path)) -or (Hash $path) -ne $file.Sha256) { throw ('Content verification failed: ' + $path) }
    }
}
function Original-Path([string]$File) {
    $data = [IO.File]::ReadAllBytes($File); $version = [BitConverter]::ToInt64($data, 0)
    if ($version -eq 2) { return [Text.Encoding]::Unicode.GetString($data, 28, [BitConverter]::ToInt32($data, 24) * 2).TrimEnd([char]0) }
    if ($version -eq 1) { return [Text.Encoding]::Unicode.GetString($data, 24, $data.Length - 24).TrimEnd([char]0) }
}
Log
try {
    foreach ($target in $targets) {
        if ($target.Inventory.Directory) { foreach ($directory in $target.Inventory.Directories) { [IO.Directory]::CreateDirectory((Long-Path (Join-Path $target.Destination $directory))) | Out-Null } }
        foreach ($file in $target.Inventory.Files) {
            $source = if ($target.Inventory.Directory) { Join-Path $target.Source $file.Relative } else { $target.Source }
            $destination = if ($target.Inventory.Directory) { Join-Path $target.Destination $file.Relative } else { $target.Destination }
            [IO.Directory]::CreateDirectory((Long-Path (Split-Path $destination -Parent))) | Out-Null
            if (-not [IO.File]::Exists((Long-Path $destination))) { [IO.File]::Copy((Long-Path $source), (Long-Path $destination), $false) }
        }
        Validate-Copy $target $target.Destination; $target.Status = 'copied-and-hash-verified'; Log
        Write-Output ('Verified copy: ' + $target.Source)
    }
    $audit.Status = 'copies-verified-recycling'; Log
    foreach ($target in $targets) {
        $current = Inventory $target.Source
        if ($current.Files.Count -ne $target.Inventory.Files.Count -or $current.Directories.Count -ne $target.Inventory.Directories.Count -or $current.Bytes -ne $target.Inventory.Bytes) { throw ('Source changed during migration: ' + $target.Source) }
        Validate-Copy $target $target.Source; Validate-Copy $target $target.Destination
        & (Join-Path $newRoot 'node_modules\electron\dist\electron.exe') (Join-Path $PSScriptRoot 'recycle-migration.cjs') (Join-Path $auditRoot 'migration.json') $target.Source | Out-Host
        if ($LASTEXITCODE -ne 0) { throw ('Native recycling failed; inspect receipt: ' + $target.Source) }
        $info = Get-ChildItem -LiteralPath $bin -Force -File -Filter '$I*' | Where-Object { $before -notcontains $_.FullName -and (Original-Path $_.FullName) -eq $target.Source } | Select-Object -First 1
        if (-not $info -or (Test-Path -LiteralPath $target.Source)) { throw ('Recycle identity not verified: ' + $target.Source) }
        $payload = Join-Path $bin ($info.Name -replace '^\$I', '$R'); Validate-Copy $target $payload
        $target.Status = 'migrated-original-recycled-and-verified'; $audit.RecycleEntries += [pscustomobject]@{ Original = $target.Source; Payload = $payload; Destination = $target.Destination }; Log
        Write-Output ('Recycled and verified: ' + $target.Source)
    }
    foreach ($entry in $before) { if (-not (Test-Path -LiteralPath $entry)) { throw 'A previous recycle entry disappeared.' } }
    $audit.Status = 'complete'; $audit.CompletedUtc = [DateTime]::UtcNow.ToString('o'); Log
    [pscustomobject]@{ Status = $audit.Status; Targets = $targets.Count; Bytes = $bytes; LogDirectory = $auditRoot; BookShelfUntouched = $true } | ConvertTo-Json
} catch { $audit.Status = 'stopped-inspect-audit'; $audit.Error = $_.ToString(); Log; throw }
