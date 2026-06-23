@echo off
setlocal
call "%~dp0_transcribe_env.bat"

echo MSSP Transcript Engine v2 - default Pass 1 batch
echo   Model:      large-v3-turbo
echo   Output:     gen\
echo   Speakers:   adaptive ^(min 2, max 8^)
echo   Pipeline:   float16 ASR, full-audio diarization, speechTurns v2
echo   Cache:      .cache\transcripts\ ^(reuse on^)
echo.
echo Extra args are passed through, e.g. --only "episode.mp3" --limit 5
echo.

"%PY%" "%~dp0transcribe.py" ^
  --model large-v3-turbo ^
  --output "%~dp0gen" ^
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
