param([switch]$Apply, [string]$Receipt, [string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'artifact-recycle.ps1')
. (Join-Path $PSScriptRoot 'accepted-artifact.ps1')
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$proof = Read-AcceptedArtifact $Receipt $NodeExecutable
$source = Join-Path $proof.artifacts.directory $proof.installer
$destinationRoot = 'D:\exe'
if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) { throw 'D:\exe unavailable; old files retained.' }
if ((Get-Item -LiteralPath $destinationRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked destination.' }
$destination = Join-Path $destinationRoot $proof.installer
if ((Test-Path -LiteralPath $destination) -and ((Get-ArtifactHash $destination) -ne $proof.installerSha256 -or
    (Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Different or linked destination; refusing overwrite.' }
$old = @(Get-ChildItem -LiteralPath $destinationRoot -File | Where-Object {
    $_.Name -match '^(?:ZuorenNotes|\u5de6\u4eba\u7b14\u8bb0)-Setup-(\d+\.\d+\.\d+)\.exe$' -and [version]$Matches[1] -lt [version]$proof.version
})
if (-not $Apply) { [pscustomobject]@{ Receipt = $Receipt; Source = $source; Destination = $destination; Old = @($old | ForEach-Object FullName) } | ConvertTo-Json -Depth 5; exit 0 }
$logs = Join-Path $root ('logs\releases\' + $proof.version)
[IO.Directory]::CreateDirectory($logs) | Out-Null
$record = [ordered]@{ Version = $proof.version; Receipt = $Receipt; ReceiptSha256 = Get-ArtifactHash $Receipt; Source = $source; Destination = $destination; Sha256 = $proof.installerSha256; Status = 'started'; OldFiles = @(); Pending = @() }
$log = Join-Path $logs ('d-exe-sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
function Save-Sync { [IO.File]::WriteAllText($log, ($record | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false))) }
Save-Sync
try {
    if (-not (Test-Path -LiteralPath $destination)) {
        $temporary = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
        Copy-Item -LiteralPath $source -Destination $temporary
        if ((Get-ArtifactHash $temporary) -ne $proof.installerSha256) { throw 'Copy hash mismatch; old files retained.' }
        Move-Item -LiteralPath $temporary -Destination $destination
    }
    if ((Get-ArtifactHash $destination) -ne $proof.installerSha256) { throw 'Destination hash mismatch.' }
    $record.Status = 'copied-and-verified'; Save-Sync
    foreach ($item in $old) {
        try {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked old installer.' }
            $running = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath)
            if ($running -contains $item.FullName) { throw 'Old installer is running; original retained.' }
            if ((Get-ArtifactHash $destination) -ne $proof.installerSha256) { throw 'New installer changed.' }
            $digest = Get-ArtifactHash $item.FullName
            $retirement = Join-Path $root ('work\installer-retirement\' + [Guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($retirement) | Out-Null
            $copy = Join-Path $retirement $item.Name
            Copy-Item -LiteralPath $item.FullName -Destination $copy
            if ((Get-ArtifactHash $copy) -ne $digest) { throw 'Fixed-volume retirement copy mismatch.' }
            $result = Invoke-VerifiedRecycle $copy $retirement
            if ((Get-ArtifactHash $result.RecyclePath) -ne $digest -or (Get-ArtifactHash $item.FullName) -ne $digest) { throw 'Original or recoverable copy changed; D: original retained.' }
            # Both copies were checked. Remove only the exact D: duplicate.
            if ([IO.Path]::GetDirectoryName($item.FullName) -ne $destinationRoot) { throw 'Unsafe D: target.' }
            Remove-Item -LiteralPath $item.FullName
            $record.OldFiles += [pscustomobject]@{ Original = $item.FullName; RecyclePath = $result.RecyclePath; Sha256 = $digest; Status = 'retired-with-verified-recycle-copy' }
            [IO.Directory]::Delete($retirement, $false)
        } catch { $record.Pending += [pscustomobject]@{ Path = $item.FullName; Reason = $_.Exception.Message } }
        Save-Sync
    }
    $record.Status = if ($record.Pending.Count) { 'copied-with-pending-retirement' } else { 'completed' }; Save-Sync
    $record | ConvertTo-Json -Depth 8
    if ($record.Pending.Count) { exit 2 }
} catch { $record.Status = 'pending'; $record.Pending += [pscustomobject]@{ Path = $destination; Reason = $_.Exception.Message }; Save-Sync; throw }
