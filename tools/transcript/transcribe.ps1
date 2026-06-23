# Portable MSSP transcript v2 batch — reads audio from parent folder.
# Default: large-v3-turbo Pass 1 → ./gen/
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$pythonCandidates = @(
    (Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe")
    (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")
    "python"
)

$python = $pythonCandidates | Where-Object {
    if ($_ -eq "python") { return $true }
    Test-Path -LiteralPath $_
} | Select-Object -First 1

$genDir = Join-Path $PSScriptRoot "gen"
& $python (Join-Path $PSScriptRoot "transcribe.py") `
    --model large-v3-turbo `
    --output $genDir `
    --diarize `
    --speaker-mode adaptive `
    --reuse-cache `
    @args
exit $LASTEXITCODE
