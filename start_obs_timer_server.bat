@echo off
setlocal
set "NODE_EXE=C:\Users\kiki_\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "OBS_TIMER_HOST=127.0.0.1"
cd /d "%~dp0"
echo OBS Timer Server
echo.
echo Display URL:
echo   http://127.0.0.1:17171/display
echo.
echo Controller URL:
echo   http://127.0.0.1:17171/control
echo.
echo Keep this window open while using the timer.
echo.
"%NODE_EXE%" "%~dp0obs_timer_server.js"
echo.
pause
