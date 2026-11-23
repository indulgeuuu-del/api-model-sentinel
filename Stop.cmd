@echo off
cd /d "%~dp0"
node "%~dp0bin\sentinel.cjs" stop
if errorlevel 1 pause
