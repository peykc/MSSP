@echo off
setlocal
call "%~dp0_transcribe_env.bat"

echo MSSP Transcript Engine v2 - large-v3-turbo speed pass ^(fallback^)
echo   Model:      large-v3-turbo
echo   Output:     gen-turbo\
echo   Speakers:   adaptive ^(min 2, max 8^)
echo   Typical use: faster fallback / preview pass with the same v2 runner behavior as large-v3.
echo.
echo Extra args are passed through, e.g. --limit 10 --force-asr --speaker-mode chaotic
echo.

"%PY%" "%~dp0transcribe.py" ^
  --model large-v3-turbo ^
  --language en ^
  --batch-size 1 ^
  --output "%~dp0gen-turbo" ^
  --diarize ^
  --speaker-mode adaptive ^
  --reuse-cache ^
  --no-reuse-align-model ^
  --no-reuse-diarize-model ^
  --isolate-per-file ^
  %*

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo Transcription failed ^(exit code %EXITCODE%^).
)
echo.
pause
exit /b %EXITCODE%
