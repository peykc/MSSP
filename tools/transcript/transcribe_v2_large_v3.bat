@echo off
setlocal
call "%~dp0_transcribe_env.bat"

echo MSSP Transcript Engine v2 - large-v3 quality pass ^(Pass 2^)
echo   Model:      large-v3
echo   Output:     gen-large-v3\
echo   Speakers:   adaptive ^(min 2, max 8^)
echo   Typical use: rerun flagged episodes after Pass 1 ^(add --force-asr^).
echo.
echo Extra args are passed through, e.g. --only "episode.mp3" --force-asr --speaker-mode chaotic
echo.

"%PY%" "%~dp0transcribe.py" ^
  --model large-v3 ^
  --output "%~dp0gen-large-v3" ^
  --diarize ^
  --speaker-mode adaptive ^
  --reuse-cache ^
  %*

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo Transcription failed ^(exit code %EXITCODE%^).
)
echo.
pause
exit /b %EXITCODE%
