param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$release = Join-Path ([IO.Path]::GetFullPath((Join-Path $projectRoot $manifest.build.directories.output))) $manifest.version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $release 'icon-verification' }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$paths = [ordered]@{
    source = (Join-Path $projectRoot $manifest.build.win.icon)
    executable = (Join-Path $release 'win-unpacked/ZuorenNotes.exe')
    installer = (Join-Path $release ($manifest.build.win.artifactName.Replace('${version}', $manifest.version).Replace('${ext}', 'exe')))
}
$signatures = @{}
foreach ($label in $paths.Keys) {
    $icon = [Drawing.Icon]::ExtractAssociatedIcon($paths[$label])
    if ($null -eq $icon) { throw ('No icon: ' + $label) }
    $bitmap = $icon.ToBitmap()
    try {
        if ($bitmap.Width -ne 32 -or $bitmap.Height -ne 32) { throw ('Unexpected icon size: ' + $label) }
        $bitmap.Save((Join-Path $OutputDirectory ($label + '-icon.png')), [Drawing.Imaging.ImageFormat]::Png)
        $pixels = New-Object 'System.Collections.Generic.List[int]'
        for ($y = 0; $y -lt $bitmap.Height; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x++) { $pixels.Add($bitmap.GetPixel($x, $y).ToArgb()) }
        }
        $signatures[$label] = ($pixels -join ',')
    } finally { $bitmap.Dispose(); $icon.Dispose() }
}
if ($signatures.executable -ne $signatures.source) { throw 'Executable icon differs from the configured source ICO.' }
if ($signatures.installer -ne $signatures.source) { throw 'Installer icon differs from the configured source ICO.' }
$report = [ordered]@{ version = $manifest.version; source = $manifest.build.win.icon; executableMatchesSource = $true; installerMatchesSource = $true; paths = $paths }
$encoding = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'summary.json'), ($report | ConvertTo-Json -Depth 5), $encoding)
$report | ConvertTo-Json -Depth 5
Write-Output 'ICON_RESOURCES_MATCH'
