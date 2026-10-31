#!/bin/sh
# Opens the Build in Archicad window (macOS). Needs Python 3.8+ with Tkinter (the python.org installer has it).
cd "$(dirname "$0")" || exit 1
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    exec "$py" archicad/OfficeBuild.py "$@"
  fi
done
echo "Python 3.8 or newer with Tkinter was not found."
echo ""
echo "Install it from https://www.python.org/downloads/macos/ and double-click this file again."
echo ""
printf "Press Return to close this window. "
read -r _
exit 1
