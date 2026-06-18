# Portable MSSP transcript batch — reads audio from parent folder, writes to ./gen/
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

& $python (Join-Path $PSScriptRoot "transcribe.py") --diarize @args
exit $LASTEXITCODE
