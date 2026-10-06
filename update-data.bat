@echo off
rem Rebuild the portal data from the Excel workbook and check it against the workbook's totals.
cd /d "%~dp0"
python scripts\build_data.py %*
if errorlevel 1 goto :fail
node scripts\verify.js
if errorlevel 1 goto :fail
echo.
echo Data updated. Refresh the portal in your browser.
pause
exit /b 0
:fail
echo.
echo Update failed - see the messages above.
pause
exit /b 1
