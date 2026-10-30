#!/usr/bin/env python3
"""Write dist/office-configurator-<date>-<commit>.zip from the files committed at HEAD.

    python3 tools/package.py

Launchers get their line endings (.bat CRLF) and exec bits fixed in the zip,
whatever the checkout looks like. Uncommitted changes are not packaged.
"""
import datetime
import os
import subprocess
import sys
import zipfile

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREFIX = "office-configurator/"
EXECUTABLE_SUFFIXES = (".sh", ".command")
EXECUTABLE_FILES = {"serve.py", "tools/package.py"}
# Tapir add-on bundle shipped with the Archicad side (phase 2). Refuse to package a stale one.
TAPIR_DIR = "archicad/tapir/"
TAPIR_STAMP = "archicad/tapir/BUNDLE_SOURCE"


def git(*args, binary=False):
    out = subprocess.check_output(["git", *args], cwd=ROOT)
    return out if binary else out.decode("utf-8")


def check_tapir(files):
    bundle = [f for f in files if f.startswith(TAPIR_DIR)]
    if not bundle:
        return "no Tapir bundle in this phase"
    if TAPIR_STAMP not in files:
        raise SystemExit(f"Refusing to package: {TAPIR_DIR} has no {os.path.basename(TAPIR_STAMP)} stamp.")
    # The stamp names the commit of the scripts the bundle was built from; they must not have changed since.
    stamp = git("show", f"HEAD:{TAPIR_STAMP}").strip()
    changed = git("diff", "--name-only", stamp, "HEAD", "--", "archicad/").split()
    changed = [f for f in changed if not f.startswith(TAPIR_DIR)]
    if changed:
        raise SystemExit("Refusing to package: the Tapir bundle is stale. Changed since it was built:\n  " + "\n  ".join(changed))
    return f"Tapir bundle current (built from {stamp[:8]})"


def main():
    if git("status", "--porcelain", "--untracked-files=no").strip():
        print("Note: you have uncommitted changes; they are NOT in the package (it is built from HEAD).")
    commit = git("rev-parse", "--short=8", "HEAD").strip()
    ts = int(git("log", "-1", "--format=%ct").strip())
    when = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
    entries = []
    for line in git("ls-tree", "-r", "HEAD").splitlines():
        meta, path = line.split("\t", 1)
        mode = meta.split()[0]
        entries.append((path, mode))
    files = [p for p, _ in entries]
    tapir = check_tapir(files)

    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", f"office-configurator-{when:%Y%m%d}-{commit}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path, mode in entries:
            data = git("show", f"HEAD:{path}", binary=True)
            if path.endswith(".bat"):
                data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            executable = mode == "100755" or path.endswith(EXECUTABLE_SUFFIXES) or path in EXECUTABLE_FILES
            info = zipfile.ZipInfo(PREFIX + path, date_time=when.timetuple()[:6])
            info.create_system = 3  # unix, so the permission bits below are honoured
            info.external_attr = ((0o100755 if executable else 0o100644) & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    size = os.path.getsize(out)
    print(f"Wrote {os.path.relpath(out, ROOT)} ({len(entries)} files, {size / 1024:.0f} KB). {tapir}.")


if __name__ == "__main__":
    main()
