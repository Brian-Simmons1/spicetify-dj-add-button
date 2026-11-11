# Copies djAddButton.js into Spicetify's Extensions folder, enables it, and applies.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    Write-Error 'spicetify not found on PATH'
}

$extDir = Join-Path (spicetify path userdata) 'Extensions'
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'djAddButton.js') -Destination $extDir -Force
Write-Host "Copied djAddButton.js -> $extDir"

spicetify config extensions djAddButton.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
spicetify apply
exit $LASTEXITCODE
