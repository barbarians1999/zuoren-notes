param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $root $manifest.build.directories.output))
$workspace = Split-Path $releaseRoot -Parent
$release = Join-Path $releaseRoot $manifest.version
$logs = Join-Path $workspace ('logs\releases\' + $manifest.version)
$proofPath = Join-Path $release 'VALIDATION.json'
if (-not (Test-Path -LiteralPath $proofPath)) { $proofPath = Join-Path $logs 'VALIDATION.json' }
$proof = Get-Content -LiteralPath $proofPath -Raw -Encoding UTF8 | ConvertFrom-Json
$payload = $proof.installerPayload
if ($proof.version -ne $manifest.version -or $proof.build -ne 'passed' -or
    $proof.sourceUi.failed -ne 0 -or $proof.sourceUi.tests -le 0 -or
    $proof.packagedUi.failed -ne 0 -or $proof.packagedUi.tests -le 0 -or
    $payload.missing -ne 0 -or $payload.mismatched -ne 0 -or $payload.checked -le 0 -or
    -not $payload.embeddedAppAsarMatchesTestedProgram -or
    -not $payload.executableAndInstallerIconsMatchConfiguredSource) { throw 'Release verification is incomplete.' }
$installerName = $manifest.build.win.artifactName.Replace('${version}', $manifest.version).Replace('${ext}', 'exe')
if ($installerName -ne [IO.Path]::GetFileName($installerName) -or $proof.installer -ne $installerName) { throw 'Unexpected installer name.' }
$source = Join-Path $release $installerName
function Hash([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($File)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
if ((Hash $source) -ne $proof.installerSha256 -or (Get-Item -LiteralPath $source).Length -ne $proof.installerBytes -or
    (Hash (Join-Path $release 'win-unpacked\resources\app.asar')) -ne $proof.appAsarSha256 -or
    (Hash (Join-Path $release 'win-unpacked\ZuorenNotes.exe')) -ne $proof.executableSha256) { throw 'Verified package changed.' }
$destinationRoot = 'D:\exe'
if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) { throw 'D:\exe is unavailable; old files retained.' }
if ((Get-Item -LiteralPath $destinationRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Destination is a linked directory.' }
$destination = Join-Path $destinationRoot $installerName
if (Test-Path -LiteralPath $destination) {
    if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked destination.' }
    if ((Hash $destination) -ne $proof.installerSha256) { throw 'Different file already exists; refusing overwrite.' }
}
$old = @(Get-ChildItem -LiteralPath $destinationRoot -File | Where-Object {
    $_.Name -match '^(?:ZuorenNotes|\u5de6\u4eba\u7b14\u8bb0)-Setup-(\d+\.\d+\.\d+)\.exe$' -and
    [version]$Matches[1] -lt [version]$manifest.version
})
foreach ($item in $old) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked old installer.' }
}
if (-not $Apply) {
    [pscustomobject]@{ Source = $source; Destination = $destination; OldInstallers = @($old | ForEach-Object FullName) } | ConvertTo-Json
    exit 0
}
[IO.Directory]::CreateDirectory($logs) | Out-Null
$encoding = New-Object Text.UTF8Encoding($false)
$receipt = [ordered]@{ Version = $manifest.version; Source = $source; Destination = $destination; Sha256 = $proof.installerSha256;
    StartedUtc = [DateTime]::UtcNow.ToString('o'); Status = 'started'; OldFiles = @(); Skipped = @() }
$receiptPath = Join-Path $logs ('d-exe-sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
function Log { [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 6), $encoding) }
Log
try {
    if (-not (Test-Path -LiteralPath $destination)) {
        $temporary = Join-Path $destinationRoot ($installerName + '.' + [Guid]::NewGuid().ToString('N') + '.partial')
        Copy-Item -LiteralPath $source -Destination $temporary
        if ((Hash $temporary) -ne $proof.installerSha256) { throw 'Copy checksum mismatch; old installers retained.' }
        Move-Item -LiteralPath $temporary -Destination $destination
    }
    if ((Hash $destination) -ne $proof.installerSha256) { throw 'Destination checksum mismatch.' }
    $receipt.Status = 'latest-copied-and-verified'; Log
    if (-not $old.Count) {
        $receipt.Status = 'completed'; $receipt.CompletedUtc = [DateTime]::UtcNow.ToString('o'); Log
        $receipt | ConvertTo-Json -Depth 6
        return
    }
    $running = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath)
    # Removable D: may not support recycling. Recycle a verified C: copy first,
    # then remove only the identical D: duplicate. Never delete the only copy.
    $retirementRoot = Join-Path $workspace 'work\installer-retirement'
    $drive = [IO.Path]::GetPathRoot($retirementRoot).TrimEnd('\')
    $volume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $drive + "'")
    if ($volume.DriveType -ne 3 -or $volume.DeviceID -notmatch '\{[0-9a-f-]+\}') { throw 'Retirement volume must be fixed.' }
    $settings = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $Matches[0])
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $bin = Join-Path ($drive + '\$Recycle.Bin') $sid
    $before = @(Get-ChildItem -LiteralPath $bin -Force -File -Filter '$I*')
    $used = [long]((Get-ChildItem -LiteralPath $bin -Force -Recurse -File | Measure-Object Length -Sum).Sum)
    $needed = [long](($old | Measure-Object Length -Sum).Sum)
    if ($settings.NukeOnDelete -ne 0 -or $settings.MaxCapacity -le 0 -or
        $used + $needed + 256MB -ge [long]$settings.MaxCapacity * 1MB -or $volume.FreeSpace -lt $needed + 256MB) {
        throw 'Insufficient safe recycling capacity; old D: files retained.'
    }
    Add-Type -AssemblyName Microsoft.VisualBasic
    foreach ($item in $old) {
        if ($running -contains $item.FullName) { $receipt.Skipped += $item.FullName; Log; continue }
        if ((Hash $destination) -ne $proof.installerSha256) { throw 'Latest installer changed during retirement.' }
        $digest = Hash $item.FullName
        $staging = Join-Path $retirementRoot ([Guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($staging) | Out-Null
        $copy = Join-Path $staging $item.Name
        Copy-Item -LiteralPath $item.FullName -Destination $copy
        if ((Hash $copy) -ne $digest) { throw 'Retirement copy differs.' }
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($copy,
            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
            [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
        $info = Get-ChildItem -LiteralPath $bin -Force -File -Filter '$I*' | Where-Object {
            $bytes = [IO.File]::ReadAllBytes($_.FullName)
            $v = [BitConverter]::ToInt64($bytes, 0)
            $original = if ($v -eq 2) { [Text.Encoding]::Unicode.GetString($bytes, 28, [BitConverter]::ToInt32($bytes, 24) * 2).TrimEnd([char]0) }
                elseif ($v -eq 1) { [Text.Encoding]::Unicode.GetString($bytes, 24, $bytes.Length - 24).TrimEnd([char]0) }
            $original -eq $copy
        } | Select-Object -First 1
        if (-not $info) { throw 'Recycle identity missing; D: original retained.' }
        $recycled = Join-Path $bin ($info.Name -replace '^\$I', '$R')
        if ((Hash $recycled) -ne $digest) { throw 'Recycle payload mismatch; D: original retained.' }
        $record = [ordered]@{ OriginalPath = $item.FullName; Sha256 = $digest; Bytes = $item.Length;
            RecyclePayload = $recycled; RecycleOriginalPath = $copy; Status = 'recoverable-copy-verified' }
        $receipt.OldFiles += $record; Log
        if ((Hash $item.FullName) -ne $digest) { throw 'Old installer changed; D: original retained.' }
        # The exact old file has a verified recoverable copy, so retire its duplicate.
        Remove-Item -LiteralPath $item.FullName
        if (Test-Path -LiteralPath $item.FullName) { throw 'Old duplicate remains.' }
        $record.Status = 'retired-with-verified-recycle-copy'; Log
        [IO.Directory]::Delete($staging, $false)
    }
    foreach ($entry in $before) { if (-not (Test-Path -LiteralPath $entry.FullName)) { throw 'Previous recycle entry disappeared.' } }
    if ((Hash $destination) -ne $proof.installerSha256) { throw 'Latest installer changed.' }
    $receipt.Status = 'completed'; $receipt.CompletedUtc = [DateTime]::UtcNow.ToString('o'); Log
    $receipt | ConvertTo-Json -Depth 6
} catch {
    $receipt.Status = 'stopped-inspect-log'; $receipt.Error = $_.ToString(); Log
    throw
}
