# Copies djAddButton.js into Spicetify's Extensions folder, enables it, and applies.
# Native-command errors are checked via $LASTEXITCODE: spicetify prints progress to stderr,
# which Windows PowerShell 5.1 would otherwise treat as a terminating error.

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    Write-Error 'spicetify not found on PATH'
    exit 1
}

$extDir = Join-Path (spicetify path userdata) 'Extensions'
New-Item -ItemType Directory -Force -Path $extDir -ErrorAction Stop | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'djAddButton.js') -Destination $extDir -Force -ErrorAction Stop
Write-Host "Copied djAddButton.js -> $extDir"

spicetify config extensions djAddButton.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
spicetify apply
exit $LASTEXITCODE
