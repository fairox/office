#!/bin/sh
# Start the Office Configurator (macOS). Double-click in Finder. Needs Python 3.8 or newer.
cd "$(dirname "$0")" || exit 1
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    exec "$py" serve.py --open "$@"
  fi
done
echo "Python 3.8 or newer was not found."
echo ""
echo "Install it from https://www.python.org/downloads/macos/ and double-click this file again."
echo "(If macOS offers to install the Command Line Developer Tools instead, that works too.)"
echo ""
printf "Press Return to close this window. "
read -r _
exit 1
