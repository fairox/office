@echo off
setlocal
cd /d "%~dp0"
title Office Configurator
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY goto nopython
%PY% serve.py --open
if errorlevel 1 pause
exit /b

:nopython
echo.
echo Python 3.8 or newer was not found.
echo.
echo   1. Download Python from https://www.python.org/downloads/windows/
echo   2. In the installer, tick "Add python.exe to PATH".
echo   3. Double-click this file again.
echo.
echo If typing "python" opens the Microsoft Store, Windows is using its placeholder
echo alias, not a real Python. Install Python from python.org as above, or turn the
echo alias off: Settings ^> Apps ^> Advanced app settings ^> App execution aliases.
echo.
pause
exit /b 1
