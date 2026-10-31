#!/usr/bin/env python3
"""Write dist/office-configurator-<date>-<commit>.zip from the files committed at HEAD.

    python3 tools/package.py

Launchers get their line endings (.bat CRLF) and exec bits fixed in the zip, whatever the
checkout looks like. A stale archicad/OfficeBuild.py bundle is refused. Uncommitted changes
are not packaged.
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
EXECUTABLE_FILES = {"serve.py", "tools/package.py", "archicad/OfficeBuild.py", "archicad/build_office.py"}
# The single-file script for Tapir's palette must match the sources it is generated from.
BUNDLE = "archicad/OfficeBuild.py"
BUNDLE_SOURCES = ("archicad/build_office.py", "archicad/office_gui.py")


def git(*args, binary=False):
    out = subprocess.check_output(["git", *args], cwd=ROOT)
    return out if binary else out.decode("utf-8")


def check_bundle(files):
    if BUNDLE not in files:
        raise SystemExit(f"Refusing to package: {BUNDLE} is not committed.")
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    from bundle_tapir_script import bundle
    lib, gui = (git("show", f"HEAD:{p}") for p in BUNDLE_SOURCES)
    if bundle(lib, gui) != git("show", f"HEAD:{BUNDLE}"):
        raise SystemExit(f"Refusing to package: {BUNDLE} is stale. Run python3 tools/bundle_tapir_script.py and commit.")
    return f"{BUNDLE} matches its sources"


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
    tapir = check_bundle(files)

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
