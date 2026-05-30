@echo off
setlocal
cd /d "%~dp0"
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BUNDLED_NODE%" (
  set "NODE_EXE=%BUNDLED_NODE%"
) else (
  set "NODE_EXE=node"
)
start "MSSP Anthology Server" "%NODE_EXE%" "mssp_app\server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5177"
