@echo off
setlocal
call "%~dp0_transcribe_env.bat"

echo MSSP Transcript Engine v2 - large-v3-turbo ^(isolated output^)
echo   Model:      large-v3-turbo
echo   Output:     gen-turbo\
echo   Speakers:   adaptive ^(min 2, max 8^)
echo   Use this when you want turbo JSON separate from gen\ ^(default Pass 1^).
echo.
echo Extra args are passed through, e.g. --only "episode.mp3" --force-asr
echo.

"%PY%" "%~dp0transcribe.py" ^
  --model large-v3-turbo ^
  --output "%~dp0gen-turbo" ^
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
