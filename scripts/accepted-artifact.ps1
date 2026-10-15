function Read-AcceptedArtifact([string]$Receipt, [string]$NodeExecutable) {
    if (-not $Receipt -or -not [IO.Path]::IsPathRooted($Receipt)) { throw 'An explicit absolute acceptance receipt is required.' }
    if (-not $NodeExecutable -or -not [IO.Path]::IsPathRooted($NodeExecutable) -or -not (Test-Path -LiteralPath $NodeExecutable)) { throw 'Pass the loaded bundled Node executable explicitly.' }
    $projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
    $verified = & $NodeExecutable (Join-Path $projectRoot 'scripts\delivery-receipt.cjs') $Receipt
    if ($LASTEXITCODE -ne 0) { throw 'Acceptance receipt or package verification failed.' }
    $proof = Get-Content -LiteralPath $Receipt -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = Join-Path (Join-Path $projectRoot 'releases') $proof.version
    if ([IO.Path]::GetFullPath($proof.artifacts.directory) -ne $expected -or [IO.Path]::GetFullPath($Receipt) -ne (Join-Path $expected 'VALIDATION.json')) { throw 'Acceptance target is outside the exact versioned project directory.' }
    return $proof
}
