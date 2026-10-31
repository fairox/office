@echo off
setlocal
cd /d "%~dp0"
rem Opens the Build in Archicad window without a console (pyw / pythonw).
set "PYW="
py -3 -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1 && set "PYW=pyw -3"
if not defined PYW pythonw -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1 && set "PYW=pythonw"
if not defined PYW goto nopython
start "" %PYW% "archicad\OfficeBuild.py" %*
exit /b

:nopython
echo.
echo Python 3.8 or newer with Tkinter was not found.
echo.
echo   1. Download Python from https://www.python.org/downloads/windows/
echo      (it includes Tkinter). In the installer, tick "Add python.exe to PATH".
echo   2. Double-click this file again.
echo.
echo If typing "python" opens the Microsoft Store, Windows is using its placeholder
echo alias, not a real Python. Install Python from python.org as above, or turn the
echo alias off: Settings ^> Apps ^> Advanced app settings ^> App execution aliases.
echo.
pause
exit /b 1
