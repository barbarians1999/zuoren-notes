# Shared recycle-only implementation. ASCII source is safe in Windows PS 5.1.
$ErrorActionPreference = 'Stop'
function Get-ArtifactHash([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($File)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Test-ArtifactWithin([string]$Child, [string]$Parent) {
    return [IO.Path]::GetFullPath($Child).StartsWith([IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Get-ArtifactSnapshot([string]$Target) {
    $base = Get-Item -LiteralPath $Target -Force
    if ($base.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked recycle target.' }
    $items = @($base)
    if ($base.PSIsContainer) {
        $pending = New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($base.FullName)
        $items = @()
        while ($pending.Count) {
            foreach ($item in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked artifact entry.' }
                if ($item.Name -in @('.git', '.reader', 'legacy-workspace')) { throw 'Protected artifact data.' }
                if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $items += $item }
            }
        }
    }
    return @($items | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{ Relative = if ($base.PSIsContainer) { $_.FullName.Substring($base.FullName.Length).TrimStart('\') } else { '' }; Bytes = $_.Length; Sha256 = Get-ArtifactHash $_.FullName }
    })
}
function Get-RecycleIdentity([string]$Target) {
    $drive = [IO.Path]::GetPathRoot($Target).TrimEnd('\')
    $volume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $drive + "'")
    if ($volume.DriveType -ne 3 -or $volume.DeviceID -notmatch '\{[0-9a-f-]+\}') { throw 'Recycle target must be on an identified fixed volume.' }
    $volumeId = $Matches[0]
    $settings = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $volumeId)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    return @{ Volume = $volume; Settings = $settings; Bin = Join-Path ($drive + '\$Recycle.Bin') $sid }
}
function Assert-RecycleCapacity([string]$Target, [long]$Needed) {
    $identity = Get-RecycleIdentity $Target
    $used = [long]0
    if (Test-Path -LiteralPath $identity.Bin) {
        $pending = New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($identity.Bin)
        while ($pending.Count) { foreach ($item in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked recycle-bin entry; capacity unknown.' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $used += $item.Length }
        } }
    }
    if ($identity.Settings.NukeOnDelete -ne 0 -or $identity.Settings.MaxCapacity -le 0 -or
        $used + $Needed + 256MB -ge [long]$identity.Settings.MaxCapacity * 1MB) { throw 'Recycle bin disabled or safe capacity insufficient; original retained; settings unchanged.' }
    return $identity
}
function Find-RecyclePayload([string]$Original, [string]$Bin) {
    foreach ($entry in Get-ChildItem -LiteralPath $Bin -Force -File -Filter '$I*') {
        $bytes = [IO.File]::ReadAllBytes($entry.FullName)
        if ($bytes.Length -lt 28) { continue }
        $format = [BitConverter]::ToInt64($bytes, 0)
        $origin = if ($format -eq 2) { [Text.Encoding]::Unicode.GetString($bytes, 28, [Math]::Min([BitConverter]::ToInt32($bytes, 24) * 2, $bytes.Length - 28)).TrimEnd([char]0) }
            elseif ($format -eq 1) { [Text.Encoding]::Unicode.GetString($bytes, 24, $bytes.Length - 24).TrimEnd([char]0) }
        if ($origin -eq $Original) { return Join-Path $Bin ($entry.Name -replace '^\$I', '$R') }
    }
    return $null
}
function Initialize-NativeRecycle {
    if ('ZuorenArtifactRecycle' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IArtifactFileOperation {
  void Advise(IntPtr sink, out uint cookie); void Unadvise(uint cookie);
  void SetOperationFlags(uint flags); void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
  void SetProgressDialog(IntPtr dialog); void SetProperties(IntPtr properties); void SetOwnerWindow(uint owner);
  void ApplyPropertiesToItem(IntPtr item); void ApplyPropertiesToItems(IntPtr items);
  void RenameItem(IntPtr item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink); void RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
  void MoveItem(IntPtr item, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink); void MoveItems(IntPtr items, IntPtr destination);
  void CopyItem(IntPtr item, IntPtr destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink); void CopyItems(IntPtr items, IntPtr destination);
  void DeleteItem(IntPtr item, IntPtr sink); void DeleteItems(IntPtr items);
  void NewItem(IntPtr destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
  void PerformOperations(); void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}
public static class ZuorenArtifactRecycle {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, out IntPtr item);
  public static void Send(string path) {
    var operation = (IArtifactFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
    IntPtr item = IntPtr.Zero;
    try {
      // RECYCLEONDELETE + ADDUNDORECORD + EARLYFAILURE, SILENT, NOERRORUI,
      // NOCONFIRMATION, ALLOWUNDO. No hard-delete fallback or error dialog.
      operation.SetOperationFlags(0x20180454);
      Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
      operation.DeleteItem(item, IntPtr.Zero); operation.PerformOperations();
      bool aborted; operation.GetAnyOperationsAborted(out aborted);
      if (aborted) throw new InvalidOperationException("Recycle operation aborted; inspect original and receipt.");
    } finally { if (item != IntPtr.Zero) Marshal.Release(item); Marshal.FinalReleaseComObject(operation); }
  }
}
'@
}
function Invoke-VerifiedRecycle([string]$Target, [string]$AllowedParent) {
    $targetPath = [IO.Path]::GetFullPath($Target)
    if (-not (Test-ArtifactWithin $targetPath $AllowedParent)) { throw 'Recycle target is broad or outside its allowed parent.' }
    for ($parent = [IO.Path]::GetDirectoryName($targetPath); $parent; $parent = [IO.Path]::GetDirectoryName($parent)) {
        if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked target ancestor.' }
    }
    $running = @(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath)
    if ($running | Where-Object { $_ -eq $targetPath -or (Test-ArtifactWithin $_ $targetPath) }) { throw 'Artifact is running; original retained.' }
    $before = @(Get-ArtifactSnapshot $targetPath)
    $needed = [long](($before | Measure-Object Bytes -Sum).Sum)
    $identity = Assert-RecycleCapacity $targetPath $needed
    $oldEntries = @(Get-ChildItem -LiteralPath $identity.Bin -Force -File -Filter '$I*' | Select-Object -ExpandProperty FullName)
    Initialize-NativeRecycle
    try {
        [ZuorenArtifactRecycle]::Send($targetPath)
        if (Test-Path -LiteralPath $targetPath) { throw 'Original remains after recycle.' }
        $payload = Find-RecyclePayload $targetPath $identity.Bin
        if (-not $payload) { throw 'Recycle identity missing.' }
        $after = @(Get-ArtifactSnapshot $payload)
        if (($before | ConvertTo-Json -Depth 5 -Compress) -ne ($after | ConvertTo-Json -Depth 5 -Compress)) { throw 'Recycle payload hash mismatch.' }
        foreach ($entry in $oldEntries) { if (-not (Test-Path -LiteralPath $entry)) { throw 'Previous recycle entry disappeared.' } }
        return [pscustomobject]@{ Path = $targetPath; Status = 'recycled-verified'; Bytes = $needed; RecyclePath = $payload; Files = $before.Count }
    } catch {
        if (-not (Test-Path -LiteralPath $targetPath)) {
            $payload = Find-RecyclePayload $targetPath $identity.Bin
            if ($payload -and (Test-Path -LiteralPath $payload)) { Move-Item -LiteralPath $payload -Destination $targetPath }
        }
        throw
    }
}
