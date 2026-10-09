param([switch]$Apply, [string[]]$SkipPaths = @())
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$latest = [version]$package.version
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $package.build.directories.output))
$workspaceRoot = Split-Path $releaseRoot -Parent
$latestDirectory = Join-Path $releaseRoot $package.version
$candidates = New-Object 'System.Collections.Generic.List[object]'
$skipped = New-Object 'System.Collections.Generic.List[object]'

function Is-Within([string]$Child, [string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Read-SafeTree([string]$Target) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $files = New-Object 'System.Collections.Generic.List[object]'
    $pending.Push($Target)
    while ($pending.Count) {
        $directory = $pending.Pop()
        if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked directory: $directory" }
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if ($item.Name -in @('.git', '.reader')) { throw "Protected data directory: $($item.FullName)" }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked entry: $($item.FullName)" }
            if (-not (Is-Within $item.FullName $Target)) { throw 'Artifact tree escaped its target.' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $files.Add($item) }
        }
    }
    return ,$files
}

function Add-Candidate([IO.DirectoryInfo]$Item, [string]$Group, [string]$Parent) {
    if (-not (Is-Within $Item.FullName $Parent)) { throw 'Refusing a broad or outside target.' }
    foreach ($skip in $SkipPaths) {
        if ([IO.Path]::GetFullPath($skip) -eq $Item.FullName) {
            $skipped.Add([pscustomobject]@{ Path = $Item.FullName; Reason = 'Previously blocked recycle operation; explicitly deferred.' }); return
        }
    }
    try {
        $files = Read-SafeTree $Item.FullName
        if ($files | Where-Object { $_.Name -eq '.git' -or $_.Extension -in @('.pdf', '.epub') }) { throw 'Original reading material found.' }
        $size = ($files | Measure-Object -Property Length -Sum).Sum
        $candidates.Add([pscustomobject]@{ Path = $Item.FullName; Group = $Group; Name = $Item.Name; Bytes = [long]$size; Files = $files })
    } catch { $skipped.Add([pscustomobject]@{ Path = $Item.FullName; Reason = $_.Exception.Message }) }
}

foreach ($item in Get-ChildItem -LiteralPath $releaseRoot -Directory) {
    if ($item.Name -match '^\d+\.\d+\.\d+$' -and [version]$item.Name -lt $latest) { Add-Candidate $item 'releases' $releaseRoot }
}
$exportRoot = Join-Path $workspaceRoot 'exports'
if (Test-Path -LiteralPath $exportRoot) {
    foreach ($item in Get-ChildItem -LiteralPath $exportRoot -Directory) {
        if ($item.Name -match '^(\d+\.\d+\.\d+)-\d{4}-\d{2}-\d{2}$' -and [version]$Matches[1] -lt $latest) { Add-Candidate $item 'source-exports' $exportRoot }
    }
}
$outputRoot = Join-Path $workspaceRoot 'outputs'
if (Test-Path -LiteralPath $outputRoot) {
    foreach ($item in Get-ChildItem -LiteralPath $outputRoot -Directory) {
        if ($item.Name -match '^ui-(\d+\.\d+\.\d+)$' -and [version]$Matches[1] -lt $latest) { Add-Candidate $item 'ui' $outputRoot }
    }
}
$staging = Join-Path $projectRoot 'work\package-source'
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'work') -Directory) {
    if ($item.Name -notmatch '^installer-\d+$') { continue }
    $manifest = Join-Path $item.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { continue }
    $generated = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($generated.name -eq $package.name -and [version]$generated.version -le $latest) {
        Add-Candidate $item 'installer-staging' (Join-Path $projectRoot 'work')
    }
}
if (Test-Path -LiteralPath (Join-Path $staging 'package.json')) {
    $staged = Get-Content -LiteralPath (Join-Path $staging 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([version]$staged.version -lt $latest -and (Test-Path -LiteralPath (Join-Path $staging 'dist')) -and (Test-Path -LiteralPath (Join-Path $staging 'electron'))) {
        Add-Candidate (Get-Item -LiteralPath $staging) 'build-staging' (Join-Path $projectRoot 'work')
    }
}
$plan = [pscustomobject]@{ LatestVersion = $package.version; Targets = @($candidates.ToArray() | Select-Object Path,Group,Bytes); Skipped = $skipped.ToArray(); TotalBytes = [long](($candidates.ToArray() | Measure-Object Bytes -Sum).Sum) }
if (-not $Apply) { $plan | ConvertTo-Json -Depth 6; exit 0 }

# Never retire the preceding release until both UI verification and payload checks passed.
$validation = Get-Content -LiteralPath (Join-Path $latestDirectory 'VALIDATION.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$integrity = Get-Content -LiteralPath (Join-Path $outputRoot ('ui-' + $package.version + '\integrity\installer-integrity.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
if ($validation.version -ne $package.version -or $validation.sourceUi.failed -ne 0 -or $validation.packagedUi.failed -ne 0 -or
    $validation.build -ne 'passed' -or $integrity.version -ne $package.version -or -not $integrity.installerEmbeddedAppAsarMatchesTestedProgram -or
    $integrity.packagedFilesComparedToCurrentBuild.missing -ne 0 -or $integrity.packagedFilesComparedToCurrentBuild.mismatched -ne 0) { throw 'Latest release is not verified.' }
if ((Get-FileHash -LiteralPath $integrity.installer -Algorithm SHA256).Hash -ne $integrity.installerSha256) { throw 'Latest installer checksum changed.' }

# Respect the user's recycle-only requirement even if Explorer settings change.
foreach ($drive in @($candidates.ToArray() | ForEach-Object { [IO.Path]::GetPathRoot($_.Path).TrimEnd('\') } | Select-Object -Unique)) {
    $volume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $drive + "'")
    if (-not ($volume.DeviceID -match '\{[0-9a-f-]+\}')) { throw 'Cannot identify recycle-bin volume.' }
    $settings = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $Matches[0])
    if ($settings.NukeOnDelete -ne 0 -or $plan.TotalBytes -ge ([long]$settings.MaxCapacity * 1MB)) { throw 'Recycle bin is disabled or its quota is insufficient.' }
}

$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object -ExpandProperty ExecutablePath)
$logRoot = Join-Path $workspaceRoot 'logs'
$runDirectory = Join-Path $logRoot ('cleanup\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $package.version)
[IO.Directory]::CreateDirectory($runDirectory) | Out-Null
$encoding = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $runDirectory 'manifest.json'), ($plan | ConvertTo-Json -Depth 6), $encoding)
Add-Type -AssemblyName Microsoft.VisualBasic
$shell = New-Object -ComObject Shell.Application
$results = New-Object 'System.Collections.Generic.List[object]'
$logNames = @('VALIDATION.json', 'SHA256SUMS.txt', 'EXPORT-VERIFICATION.json', 'installer-integrity.json', 'builder-debug.yml', 'CHANGELOG.md', 'summary.json', 'manifest.json', 'recycled.jsonl')
foreach ($target in $candidates) {
    if ($running | Where-Object { (Is-Within $_ $target.Path) -or $_ -eq $target.Path }) {
        $results.Add([pscustomobject]@{ Path = $target.Path; Status = 'skipped-running'; Bytes = $target.Bytes }); continue
    }
    try {
        $currentFiles = Read-SafeTree $target.Path
        foreach ($file in $currentFiles) {
            if ($file.Name -in $logNames -or $file.Extension -eq '.log') {
                $relative = $file.FullName.Substring($target.Path.Length).TrimStart('\')
                $destination = Join-Path (Join-Path (Join-Path $logRoot $target.Group) $target.Name) $relative
                [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
                if (Test-Path -LiteralPath $destination) {
                    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "Archive conflict: $destination" }
                } else { Copy-Item -LiteralPath $file.FullName -Destination $destination }
                if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw 'Log archive verification failed.' }
            }
        }
        if ($target.Path -eq $latestDirectory -or -not (Is-Within $target.Path $workspaceRoot) -and -not (Is-Within $target.Path (Join-Path $projectRoot 'work'))) { throw 'Unsafe recycle target.' }
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target.Path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
        if (Test-Path -LiteralPath $target.Path) { throw 'Target still exists after recycling.' }
        $matched = $null
        foreach ($entry in $shell.Namespace(10).Items()) {
            $origin = [string]$entry.ExtendedProperty('System.Recycle.DeletedFrom')
            if ($origin -and (Join-Path $origin $entry.Name) -eq $target.Path) { $matched = $entry.Path; break }
        }
        if (-not $matched) { throw 'Target removed but recycle-bin identity could not be verified.' }
        $results.Add([pscustomobject]@{ Path = $target.Path; Status = 'recycled-verified'; Bytes = $target.Bytes; RecyclePath = $matched })
    } catch {
        $results.Add([pscustomobject]@{ Path = $target.Path; Status = 'failed'; Error = $_.Exception.Message })
        [IO.File]::WriteAllText((Join-Path $runDirectory 'results.json'), ($results.ToArray() | ConvertTo-Json -Depth 6), $encoding)
        throw
    }
    [IO.File]::WriteAllText((Join-Path $runDirectory 'results.json'), ($results.ToArray() | ConvertTo-Json -Depth 6), $encoding)
}
$summary = [pscustomobject]@{ LatestVersion = $package.version; Recycled = @($results.ToArray() | Where-Object Status -eq 'recycled-verified').Count;
    RecycledBytes = [long](($results.ToArray() | Where-Object Status -eq 'recycled-verified' | Measure-Object Bytes -Sum).Sum);
    Skipped = @($skipped.ToArray()) + @($results.ToArray() | Where-Object Status -eq 'skipped-running'); LogDirectory = $runDirectory; Recoverable = $true }
[IO.File]::WriteAllText((Join-Path $runDirectory 'summary.json'), ($summary | ConvertTo-Json -Depth 6), $encoding)
$summary | ConvertTo-Json -Depth 6
