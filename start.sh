#!/bin/sh
# Start the Office Configurator (Linux). Needs Python 3.8 or newer.
cd "$(dirname "$0")" || exit 1
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    exec "$py" serve.py --open "$@"
  fi
done
echo "Python 3.8 or newer was not found."
echo "Install it with your package manager, for example:  sudo apt install python3"
exit 1
