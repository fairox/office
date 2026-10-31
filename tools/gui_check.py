#!/usr/bin/env python3
"""Drive the Build in Archicad window (the bundled archicad/OfficeBuild.py) against the mock Archicad.

Needs a Python with Tkinter and an X display; run it under Xvfb:
    xvfb-run -a -s "-screen 0 1280x1000x24" <python-with-tk> tools/gui_check.py
Screenshots (ImageMagick `import -window root`) go to dist/screens/gui-*.png.

Flow: a build file appears in Downloads and is picked up; Test placement; Build; Build again (Replace);
From selected Zone; Open web app with that Zone; a newer download replaces the loaded file; a file
opened by hand stays loaded; Remove run; two Archicads open means no project is picked for you.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "dist", "screens")
os.makedirs(SHOTS, exist_ok=True)
sys.path.insert(0, os.path.join(ROOT, "tools"))
HOME = tempfile.mkdtemp(prefix="office-gui-")
DOWNLOADS = os.path.join(HOME, "Downloads")
os.makedirs(DOWNLOADS)
os.environ["OFFICE_CONFIGURATOR_HOME"] = os.path.join(HOME, "Office Configurator")
os.environ["OFFICE_DOWNLOADS"] = DOWNLOADS

import mock_archicad as MA  # noqa: E402

spec = importlib.util.spec_from_file_location("OfficeBuild", os.path.join(ROOT, "archicad", "OfficeBuild.py"))
OB = importlib.util.module_from_spec(spec)
sys.modules["OfficeBuild"] = OB
spec.loader.exec_module(OB)
B = OB.B

failures, passes = [], 0


def ok(cond, msg):
    global passes
    if cond:
        passes += 1
    else:
        failures.append(msg)
        print(f"  FAIL {msg}")


opened = []
OB.messagebox.askokcancel = lambda *a, **k: True
OB.webbrowser.open = lambda url: opened.append(url)

files = os.path.join(HOME, "files")
subprocess.check_call(["node", os.path.join(ROOT, "tools", "export_buildfiles.js"), files], stdout=subprocess.DEVNULL)


def download(name, mtime=None):
    dst = os.path.join(DOWNLOADS, name + ".office-build.json")
    shutil.copy(os.path.join(files, name + ".office-build.json"), dst)
    if mtime:
        os.utime(dst, (mtime, mtime))
    return dst


mock = MA.MockArchicad(19723).start()
download("team-room-8-desks", time.time() - 60)

root = OB.tk.Tk()
OB.ttk.Style(root).theme_use("clam")
root.geometry("820x940+0+0")
win = OB.OfficeWindow(root)


def pump(seconds=0.3):
    end = time.time() + seconds
    while time.time() < end:
        root.update()
        time.sleep(0.02)


def wait_idle(timeout=60):
    end = time.time() + timeout
    pump(0.2)
    while (win.busy) and time.time() < end:
        pump(0.1)
    pump(0.3)


def shot(name):
    pump(0.4)
    path = os.path.join(SHOTS, f"gui-{name}.png")
    subprocess.run(["import", "-window", "root", "-crop", "820x940+0+0", path], check=False)
    return path


try:
    pump(1.5)
    ok(win.build is not None and win.build["name"] == "Team room, 8 desks", "build file picked up from Downloads")
    ok(win.instance_var.get().startswith("Office Test · Archicad 29 · Tapir 1.7.0"), f"the only Archicad is picked: {win.instance_var.get()}")
    ok(str(win.build_btn["state"]) == "disabled", "Build disabled until Test placement passes")
    ok(str(win.test_btn["state"]) == "normal", "Test placement available")
    ok(len(win.table.get_children()) >= 6, "element table filled")
    shot("1-loaded")

    win.do_test()
    wait_idle()
    ok("Test placement passed" in win.status.cget("text"), f"Test placement passes: {win.status.cget('text')}")
    ok(not mock.elements, "Test placement leaves nothing behind")
    ok(str(win.build_btn["state"]) == "normal", "Build enabled after Test placement")
    shot("2-tested")

    win.do_build()
    wait_idle()
    ok(win.status.cget("text").startswith("Built run"), f"first build: {win.status.cget('text')}")
    first = B.all_journals()[-1]["run"]
    n_first = len(mock.of_run(first))
    ok(n_first > 50, f"first build in the model ({n_first})")
    ok(win.mode_var.get() == "replace" and "Replace previous build" in win.replace_rb.cget("text"), "Replace offered once a build exists")
    shot("3-built")

    win.do_build()
    wait_idle()
    second = B.all_journals()[-1]["run"]
    ok("Replaced" in win.status.cget("text") and not mock.of_run(first) and len(mock.of_run(second)) == n_first, f"Replace: {win.status.cget('text')}")
    shot("4-replaced")

    import math
    a = math.radians(15)
    poly = [(20 + math.cos(a) * x - math.sin(a) * y, 4 + math.sin(a) * x + math.cos(a) * y) for x, y in ((0, 0), (9, 0), (9, 6.6), (0, 6.6))]
    mock.selection = [mock.add_zone(poly, "Studio North", floor=1)]
    win.from_zone()
    pump()
    ok(abs(float(win.rot.get()) - 15) < 1e-6 and win.ox.get() == "20" and win.story_var.get().startswith("1 ") and not win.walls_var.get(),
       f"From selected Zone fills the placement: {win.ox.get()},{win.oy.get()} {win.rot.get()}° story {win.story_var.get()} walls {win.walls_var.get()}")
    shot("5-zone")

    win.open_web_app()
    pump(0.5)
    ok(opened and "#zone=" in opened[-1], f"Open web app passes the Zone: {opened[-1:]} ")
    if opened:
        import base64
        z = json.loads(base64.urlsafe_b64decode(opened[-1].split("#zone=")[1] + "==").decode())
        ok(z["name"] == "Studio North" and abs(z["width"] - 9) < 1e-6, "zone hand-over carries name and size")

    later = download("executive-suite-6-desk-bench")
    pump(2.6)
    ok(win.build["name"] == "Executive suite, 6-desk bench", "a newer download is picked up while the window is open")
    win.load_file(os.path.join(files, "studio-4-desks.office-build.json"), by_hand=True)
    os.utime(later, None)
    pump(2.6)
    ok(win.build["name"] == "Studio, 4 desks", "a file opened by hand stays loaded")

    win.mode_var.set("remove")
    win.update_buttons()
    win.run_box.current(0)
    ok(win.build_btn.cget("text") == "Remove run", "mode Remove run relabels the button")
    shot("6-remove")
    win.do_build()
    wait_idle()
    ok(not mock.of_run(second), f"Remove run removes the run: {win.status.cget('text')}")

    other = MA.MockArchicad(19724, project="Second project").start()
    win.info = None
    win.refresh_instances()
    pump()
    ok(win.instance_var.get() == "" and "nothing is guessed" in win.gate_var.get(), "two Archicads: nothing picked for you")
    ok(str(win.build_btn["state"]) == "disabled", "no Archicad picked: Build disabled")
    shot("7-two-archicads")
    other.stop()
    ok(not mock.schema_violations, f"window requests match Tapir schemas: {mock.schema_violations[:2]}")
finally:
    try:
        root.destroy()
    except Exception:
        pass
    mock.stop()
    try:  # stop the web app server "Open web app" started
        with open(os.path.join(os.environ["OFFICE_CONFIGURATOR_HOME"], "app.json")) as f:
            os.kill(json.load(f)["pid"], 15)
    except (OSError, ValueError, KeyError):
        pass
    shutil.rmtree(HOME, ignore_errors=True)

print(f"\n{passes} passed, {len(failures)} failed. Screenshots in dist/screens/gui-*.png")
sys.exit(1 if failures else 0)
