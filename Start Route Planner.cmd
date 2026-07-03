@echo off
rem Starts the local server (if not already running) and opens the route planner.
powershell -NoProfile -Command "if (-not (Test-NetConnection localhost -Port 8347 -InformationLevel Quiet -WarningAction SilentlyContinue)) { Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0server.ps1' ; Start-Sleep -Seconds 2 }"
start http://localhost:8347/
