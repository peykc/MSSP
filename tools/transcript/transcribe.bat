@echo off
setlocal
cd /d "%~dp0"

set "PY="
if exist "..\.venv\Scripts\python.exe" set "PY=..\.venv\Scripts\python.exe"
if not defined PY if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY set "PY=python"

"%PY%" "%~dp0transcribe.py" --diarize %*
exit /b %ERRORLEVEL%
