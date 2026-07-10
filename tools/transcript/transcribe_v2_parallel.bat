@echo off
setlocal
call "%~dp0_transcribe_env.bat"

echo MSSP Transcript Engine v2 - large-v3 PARALLEL pass ^(multi-GPU, rented box^)
echo   Model:      large-v3
echo   Batch size: 8   ^(ASR parallelism inside each transcription^)
echo   Output:     gen-large-v3\
echo   Speakers:   adaptive ^(min 2, max 8^)
echo   Workers:    one per GPU ^(auto-detected^), 8 episodes/process, models reused
echo.
echo Extra args are passed through, e.g. --gpus 0,1,2,3 --files-per-worker 4 --limit 10
echo.

"%PY%" "%~dp0transcribe_parallel.py" ^
  --model large-v3 ^
  --language en ^
  --batch-size 8 ^
  --output "%~dp0gen-large-v3" ^
  --diarize ^
  --speaker-mode adaptive ^
  --reuse-cache ^
  --reuse-align-model ^
  --reuse-diarize-model ^
  %*

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo Parallel transcription reported failures ^(exit code %EXITCODE%^).
)
echo.
pause
exit /b %EXITCODE%
