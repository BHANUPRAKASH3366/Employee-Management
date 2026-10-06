@echo off
rem Starts the live VCT Employee Portal. Keep this window open while you use the portal.
rem The portal refreshes by itself every time the Excel file (see portal.config.json) is saved.
title VCT Employee Portal - live
cd /d "%~dp0"
python scripts\live_server.py %*
if errorlevel 1 (
  echo.
  echo The portal could not start - see the messages above.
  pause
)
