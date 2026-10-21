@echo off
rem Starts the Blackline demo: the API (with the demo company) and the web app, each in its own window.
rem Then open http://localhost:5173 in your browser. Close the two windows to stop.
cd /d "%~dp0"
start "Blackline API" cmd /k "npm.cmd run demo -w @blackline/server"
start "Blackline web" cmd /k "npm.cmd run dev -w @blackline/web"
echo.
echo Both windows are starting. In about 15 seconds open http://localhost:5173
timeout /t 8 >nul
start "" http://localhost:5173
