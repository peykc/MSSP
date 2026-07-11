@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo MSSP Transcript — one-time setup
echo Folder: %~dp0
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python not found on PATH.
  echo Install Python 3.10-3.12 from https://www.python.org/downloads/
  echo and check "Add python.exe to PATH" during install.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"') do set "PYVER=%%V"
echo Using Python %PYVER%
for /f "delims=" %%M in ('python -c "import sys; print(1 if sys.version_info >= (3, 13) else 0)"') do set "PY313=%%M"
if "%PY313%"=="1" (
  echo ERROR: Python 3.13+ cannot get CUDA PyTorch ^(needed for GPU diarization^).
  echo Install Python 3.12 from https://www.python.org/downloads/ and run setup.bat again.
  echo.
  pause
  exit /b 1
)

set "VENV=%~dp0.venv"
set "PIP=%VENV%\Scripts\pip.exe"
set "PY=%VENV%\Scripts\python.exe"

if not exist "%PY%" (
  echo Creating virtual environment in .venv ...
  python -m venv "%VENV%"
  if errorlevel 1 (
    echo ERROR: Failed to create .venv
    echo.
    pause
    exit /b 1
  )
) else (
  echo Virtual environment already exists: .venv
)

echo.
echo Upgrading pip ...
"%PY%" -m pip install --upgrade pip
if errorlevel 1 goto :fail

echo.
echo [1/5] Installing pinned PyTorch 2.8.0 ^(CUDA 12.8^) ...
"%PIP%" install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto :fail

echo.
echo [2/5] Installing pinned transcription dependencies ...
"%PIP%" install -r "%~dp0requirements.txt"
if errorlevel 1 goto :fail

echo.
echo [3/5] Re-pinning CUDA PyTorch ^(dependencies may swap wheels^) ...
"%PIP%" install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto :fail

echo.
echo [4/5] Verifying dependency consistency ...
"%PY%" -m pip check
if errorlevel 1 goto :fail

echo.
echo [5/5] Verifying CUDA PyTorch ...
"%PY%" -c "import torch; v=torch.__version__; ok=torch.cuda.is_available() and '+cu' in v; print(f'torch {v}, cuda={torch.cuda.is_available()}'); raise SystemExit(0 if ok else 1)"
if errorlevel 1 (
  echo.
  echo ERROR: GPU PyTorch not active. CUDA diarization will fall back to CPU.
  echo Re-run setup after installing Python 3.12, or manually:
  echo   "%PIP%" install --force-reinstall torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
  goto :fail
)

for /f "delims=" %%G in ('"%PY%" -c "import torch; print(f'{torch.cuda.get_device_properties(0).total_memory/(1024**3):.1f}') if torch.cuda.is_available() else print('0')"') do set "VRAM_GB=%%G"
echo GPU VRAM: %VRAM_GB% GB — transcribe_v2_large_v3.bat will use CUDA ASR + diarize, CPU align on ^<8GB cards.

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo.
  echo WARNING: ffmpeg not found on PATH. Transcription needs it.
  echo   winget install Gyan.FFmpeg
) else (
  echo.
  echo ffmpeg: OK
)

if not exist "%~dp0.env" (
  echo.
  echo Tip: create .env here with HF_TOKEN=... for speaker diarization.
  echo   Token: https://huggingface.co/settings/tokens
  echo   License: https://huggingface.co/pyannote/speaker-diarization-community-1
)

echo.
echo Setup complete. Double-click transcribe_v2_large_v3.bat to run.
echo.
pause
exit /b 0

:fail
echo.
echo Setup failed. See errors above.
echo.
pause
exit /b 1
