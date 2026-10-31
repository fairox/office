#!/usr/bin/env python3
"""Serve the Office Configurator from ./web on localhost.

    python3 serve.py            serve on the first free port from 8765
    python3 serve.py --open     ... and open the browser
    python3 serve.py --port 9000

Needs Python 3.8+ and nothing else.
"""
import argparse
import functools
import http.server
import json
import os
import socket
import sys
import threading
import webbrowser

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(errors="replace")  # Windows consoles choke on "—", "×", "→"
    except (AttributeError, ValueError):
        pass

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
                      ".svg": "image/svg+xml", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("OFFICE_SERVE_QUIET"):
            return
        super().log_message(fmt, *args)


def record_location(url):
    """Tell the Build in Archicad window where the app lives (Documents/Office Configurator/app.json)."""
    base = os.environ.get("OFFICE_CONFIGURATOR_HOME")
    if not base:
        docs = os.path.join(os.path.expanduser("~"), "Documents")
        base = os.path.join(docs if os.path.isdir(docs) else os.path.expanduser("~"), "Office Configurator")
    try:
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, "app.json"), "w", encoding="utf-8") as f:
            json.dump({"root": os.path.dirname(os.path.abspath(__file__)), "url": url, "pid": os.getpid()}, f)
    except OSError:
        pass


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port between {start} and {start + 49}.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true", help="open the configurator in the default browser")
    args = ap.parse_args()

    if sys.version_info < (3, 8):
        raise SystemExit("Python 3.8 or newer is needed.")
    port = free_port(args.port)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=ROOT))
    url = f"http://127.0.0.1:{port}/"
    record_location(url)
    print(f"Office Configurator running at {url}")
    print("Leave this window open while you work. Press Ctrl+C to stop.", flush=True)
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
