@echo off
setlocal
cd /d "%~dp0"

set "PY="
if exist "..\.venv\Scripts\python.exe" set "PY=..\.venv\Scripts\python.exe"
if not defined PY if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY set "PY=python"

if "%PY%"=="python" (
  echo No .venv found — using system Python.
  echo Run setup.bat in this folder first ^(creates .venv and installs dependencies^).
  echo.
)

"%PY%" "%~dp0transcribe.py" --diarize %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo Transcription failed ^(exit code %EXITCODE%^).
)
echo.
pause
exit /b %EXITCODE%
