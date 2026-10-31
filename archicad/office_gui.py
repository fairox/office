"""Office Configurator: the Build in Archicad window (Tkinter/ttk).

Run through OfficeBuild.py (the bundle Tapir's script palette starts), or directly next to
build_office.py for development:  python3 office_gui.py [--port N]
"""
import base64
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:  # the command-line part still works without Tkinter
    tk = None

try:
    B  # noqa: B018 - bundled: the library part above defined B
except NameError:
    import build_office as B

POLL_MS = 2000
SEVERITY = {"ok": "#1f7a45", "info": "#1f2328", "warn": "#9a5b00", "error": "#b3261e"}


class OfficeWindow:
    def __init__(self, root, port=None):
        self.root = root
        self.port_hint = port
        self.instances = []
        self.ac = None
        self.info = None
        self.identity = (None, None, None)
        self.build = None
        self.build_path = None
        self.opened_by_hand = False
        self.loaded_mtime = 0
        self.zone = None
        self.prev = None
        self.runs = []
        self.busy = False
        self.events = queue.Queue()
        root.title("Office Configurator · Build in Archicad")
        root.minsize(720, 640)
        self._layout()
        root.after(100, self.refresh_instances)
        root.after(300, self.poll_downloads)
        root.after(100, self._drain)

    # ---------------------------------------------------------------- layout
    def _layout(self):
        r = self.root
        pad = {"padx": 10, "pady": 4}
        head = ttk.Frame(r)
        head.pack(fill="x", padx=10, pady=(10, 2))
        ttk.Label(head, text="Office Configurator", font=("TkDefaultFont", 13, "bold")).pack(anchor="w")
        ttk.Label(head, text="Builds a design downloaded from the web app as walls, doors, windows, zones and morphs, "
                             "on OFFICE layers, each with an Element ID, and checks every element afterwards.",
                  wraplength=680, foreground="#555").pack(anchor="w")

        proj = ttk.LabelFrame(r, text="Project")
        proj.pack(fill="x", **pad)
        self.instance_var = tk.StringVar()
        self.instance_box = ttk.Combobox(proj, textvariable=self.instance_var, state="readonly", width=70)
        self.instance_box.grid(row=0, column=0, sticky="we", padx=6, pady=4)
        self.instance_box.bind("<<ComboboxSelected>>", lambda e: self.select_instance())
        ttk.Button(proj, text="Refresh", command=self.refresh_instances).grid(row=0, column=1, padx=6)
        self.gate_var = tk.StringVar(value="Looking for Archicad…")
        ttk.Label(proj, textvariable=self.gate_var, foreground="#555", wraplength=640).grid(row=1, column=0, columnspan=2, sticky="w", padx=6, pady=(0, 4))
        proj.columnconfigure(0, weight=1)

        bf = ttk.LabelFrame(r, text="Build file")
        bf.pack(fill="x", **pad)
        self.file_var = tk.StringVar(value="No build file yet. Download one from the web app; it is picked up from Downloads.")
        ttk.Label(bf, textvariable=self.file_var, wraplength=680).pack(anchor="w", padx=6, pady=(4, 0))
        self.design_var = tk.StringVar()
        ttk.Label(bf, textvariable=self.design_var, foreground="#555", wraplength=680).pack(anchor="w", padx=6, pady=(0, 4))
        self.table = ttk.Treeview(bf, columns=("type", "count", "layers"), show="headings", height=7)
        for c, w, t in (("type", 180, "Element type"), ("count", 60, "Count"), ("layers", 400, "Archicad layer(s)")):
            self.table.heading(c, text=t, anchor="w")
            self.table.column(c, width=w, anchor="e" if c == "count" else "w", stretch=c == "layers")
        self.table.pack(fill="x", padx=6, pady=(0, 6))

        pl = ttk.LabelFrame(r, text="Placement")
        pl.pack(fill="x", **pad)
        self.story_var = tk.StringVar()
        self.ox, self.oy, self.oz, self.rot = (tk.StringVar(value="0") for _ in range(4))
        self.walls_var = tk.BooleanVar(value=True)
        ttk.Label(pl, text="Story").grid(row=0, column=0, sticky="w", padx=6)
        self.story_box = ttk.Combobox(pl, textvariable=self.story_var, state="readonly", width=22)
        self.story_box.grid(row=0, column=1, sticky="w", padx=4, pady=4)
        for i, (lbl, var) in enumerate((("Origin X (m)", self.ox), ("Y", self.oy), ("Z", self.oz), ("Rotation (°)", self.rot))):
            ttk.Label(pl, text=lbl).grid(row=1, column=2 * i, sticky="w", padx=6)
            ttk.Entry(pl, textvariable=var, width=9).grid(row=1, column=2 * i + 1, sticky="w", padx=4, pady=4)
        ttk.Checkbutton(pl, text="Build site walls", variable=self.walls_var).grid(row=0, column=2, columnspan=2, sticky="w", padx=6)
        ttk.Button(pl, text="From selected Zone", command=self.from_zone).grid(row=0, column=4, columnspan=3, sticky="e", padx=6)

        md = ttk.LabelFrame(r, text="Mode")
        md.pack(fill="x", **pad)
        self.mode_var = tk.StringVar(value="append")
        self.replace_rb = ttk.Radiobutton(md, text="Replace previous build", value="replace", variable=self.mode_var, command=self.update_buttons)
        self.replace_rb.grid(row=0, column=0, sticky="w", padx=6, pady=2)
        ttk.Radiobutton(md, text="Append (keep what is there)", value="append", variable=self.mode_var, command=self.update_buttons).grid(row=1, column=0, sticky="w", padx=6, pady=2)
        self.remove_rb = ttk.Radiobutton(md, text="Remove run … only", value="remove", variable=self.mode_var, command=self.update_buttons)
        self.remove_rb.grid(row=2, column=0, sticky="w", padx=6, pady=2)
        self.run_var = tk.StringVar()
        self.run_box = ttk.Combobox(md, textvariable=self.run_var, state="readonly", width=44)
        self.run_box.grid(row=2, column=1, sticky="w", padx=6)

        logf = ttk.Frame(r)
        logf.pack(fill="both", expand=True, padx=10, pady=4)
        self.log = tk.Text(logf, height=7, wrap="word", font=("TkFixedFont", 9), state="disabled", relief="flat", background="#f6f6f4")
        sb = ttk.Scrollbar(logf, command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        self.log.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        foot = ttk.Frame(r)
        foot.pack(fill="x", padx=10, pady=(2, 10))
        self.status = tk.Label(foot, text="", anchor="w", fg=SEVERITY["info"])
        self.status.pack(fill="x")
        row = ttk.Frame(foot)
        row.pack(fill="x", pady=(6, 0))
        self.top_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="Keep on top", variable=self.top_var, command=lambda: self.root.attributes("-topmost", self.top_var.get())).pack(side="left")
        ttk.Button(row, text="Open web app", command=self.open_web_app).pack(side="left", padx=6)
        ttk.Button(row, text="Open build file…", command=self.open_file).pack(side="left")
        self.build_btn = ttk.Button(row, text="Build in Archicad", command=self.do_build)
        self.build_btn.pack(side="right")
        self.test_btn = ttk.Button(row, text="Test placement", command=self.do_test)
        self.test_btn.pack(side="right", padx=6)

    # ---------------------------------------------------------------- messages
    def say(self, text, level="info"):
        self.status.configure(text=text, fg=SEVERITY.get(level, SEVERITY["info"]))
        self.write(text)

    def write(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _drain(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "progress":
                    self.status.configure(text=payload, fg=SEVERITY["info"])
                    self.write(payload)
                elif kind == "done":
                    payload()
        except queue.Empty:
            pass
        self.root.after(100, self._drain)

    def run_in_background(self, label, work, done):
        if self.busy:
            return
        self.busy = True
        self.update_buttons()
        self.say(label)

        def runner():
            try:
                result, error = work(), None
            except B.OfficeError as e:
                result, error = None, str(e)
            except Exception as e:  # report, never crash the window
                result, error = None, f"Unexpected error: {e!r}"

            def finish():
                self.busy = False
                done(result, error)
                self.refresh_project()
            self.events.put(("done", finish))

        threading.Thread(target=runner, daemon=True).start()

    # ---------------------------------------------------------------- Archicad
    def refresh_instances(self):
        self.instances = B.discover()
        labels = [B.instance_label(i) for i in self.instances]
        self.instance_box["values"] = labels
        if not self.instances:
            self.instance_var.set("")
            self.ac = self.info = None
            self.gate_var.set("No Archicad found on ports 19723-19744. Start Archicad with Tapir, then Refresh.")
        else:
            current = self.info["port"] if self.info else self.port_hint
            pick = next((i for i in self.instances if i["port"] == current), None)
            if pick is None and len(self.instances) == 1:
                pick = self.instances[0]
            if pick is None:
                self.instance_var.set("")
                self.ac = self.info = None
                self.gate_var.set(f"{len(self.instances)} Archicads are open. Pick the project to build in; nothing is guessed.")
            else:
                self.instance_var.set(B.instance_label(pick))
                self.select_instance()
                return
        self.update_buttons()

    def select_instance(self):
        label = self.instance_var.get()
        self.info = next((i for i in self.instances if B.instance_label(i) == label), None)
        self.ac = B.Archicad(self.info["port"]) if self.info else None
        self.refresh_project()

    def refresh_project(self):
        if not self.ac:
            self.update_buttons()
            return
        try:
            self.identity = B.project_identity(self.ac)
            st = self.ac.tapir("GetStories")
            stories = [f"{s['index']} · {s['name']}" for s in st.get("stories", [])]
            self.story_box["values"] = stories
            if not self.story_var.get() and stories:
                self.story_var.set(next((s for s in stories if s.startswith(f"{st.get('actStory', 0)} ")), stories[0]))
        except B.OfficeError as e:
            self.gate_var.set(str(e))
            self.update_buttons()
            return
        gate, why = B.writing_gate(self.info.get("tapir"), self.info.get("archicad"))
        self.gate = gate
        token, path, name = self.identity
        self.prev = B.latest_run(token, path) if token else None
        self.runs = [j for j in B.all_journals() if token and j.get("project", {}).get("token") == token and j.get("project", {}).get("path") == path
                     and j.get("kind") == "build" and j.get("status") in ("built", "built-with-problems", "failed")]
        values = [f"{j['run']} · {j['status']} · {j.get('name')}" for j in reversed(self.runs)]
        self.run_box["values"] = values
        if self.run_var.get() not in values:
            self.run_var.set(values[0] if values else "")
        self.gate_var.set(f"{why}  Project identity: {'set' if token else 'created on the first build'}.")
        if self.prev:
            self.replace_rb.configure(text=f"Replace previous build ({self.prev['run']}, {self.prev.get('name')}, {self.prev['status']})", state="normal")
            if self.mode_var.get() not in ("remove",):
                self.mode_var.set("replace")
        else:
            self.replace_rb.configure(text="Replace previous build (none in this project yet)", state="disabled")
            if self.mode_var.get() == "replace":
                self.mode_var.set("append")
        self.remove_rb.configure(state="normal" if self.runs else "disabled")
        self.update_buttons()

    def update_buttons(self):
        gate = getattr(self, "gate", "status-only") if self.ac else "status-only"
        have = self.build is not None
        removing = self.mode_var.get() == "remove"
        self.build_btn.configure(text="Remove run" if removing else "Build in Archicad",
                                 state="normal" if not self.busy and self.ac and (removing and self.runs or (not removing and have and gate == "build")) else "disabled")
        self.test_btn.configure(state="normal" if not self.busy and self.ac and have and gate in ("build", "test-only") else "disabled")

    # ---------------------------------------------------------------- build file
    def load_file(self, path, by_hand):
        try:
            build, notes = B.read_build_file(path)
        except (B.OfficeError, OSError) as e:
            self.say(str(e), "error")
            return
        self.build, self.build_path, self.opened_by_hand = build, path, by_hand
        self.loaded_mtime = os.path.getmtime(path)
        m = build["model"]
        s = m["site"]
        self.file_var.set(f"{os.path.basename(path)}  ({'opened by hand' if by_hand else 'newest in Downloads'})")
        checks = m["checks"]
        cl = f"{len(checks)} open check(s): " + " · ".join(c["msg"] for c in checks[:3]) if checks else "No open checks in the design."
        self.design_var.set(f"{build['name']} · site {s['width']:.2f} × {s['depth']:.2f} m, {s['height']:.2f} m high · {cl}")
        for i in self.table.get_children():
            self.table.delete(i)
        rows = B.summarize(build)
        self.table.configure(height=max(4, min(10, len(rows))))
        for row in rows:
            self.table.insert("", "end", values=row)
        p = build["placement"]
        if not self.zone:
            self.ox.set(f"{p['origin'][0]:g}")
            self.oy.set(f"{p['origin'][1]:g}")
            self.oz.set(f"{p['origin'][2]:g}")
            self.rot.set(f"{p['rotationDeg']:g}")
            for v in self.story_box["values"]:
                if v.startswith(f"{p['story']} "):
                    self.story_var.set(v)
        self.walls_var.set(bool(build["walls"]) and not self.zone)
        for n in notes:
            self.write(n)
        self.say(f"Loaded {os.path.basename(path)}: {sum(r[1] for r in B.summarize(build))} elements.", "warn" if checks else "ok")
        self.update_buttons()

    def poll_downloads(self):
        if not self.opened_by_hand:
            newest = B.find_newest_build_file(os.environ.get("OFFICE_DOWNLOADS"))
            if newest and (newest != self.build_path or os.path.getmtime(newest) > self.loaded_mtime):
                self.load_file(newest, by_hand=False)
        self.root.after(POLL_MS, self.poll_downloads)

    def open_file(self):
        path = filedialog.askopenfilename(title="Open build file", filetypes=[("Office build file", "*.office-build.json"), ("JSON", "*.json")])
        if path:
            self.load_file(path, by_hand=True)

    # ---------------------------------------------------------------- placement
    def placement(self):
        try:
            story = int(self.story_var.get().split(" ")[0]) if self.story_var.get() else 0
            return {"origin": [float(self.ox.get()), float(self.oy.get()), float(self.oz.get())], "rotationDeg": float(self.rot.get()), "story": story}
        except ValueError:
            raise B.OfficeError("Placement: origin and rotation must be numbers.")

    def from_zone(self):
        if not self.ac:
            self.say("Pick an Archicad first.", "warn")
            return
        try:
            z = B.zone_site(self.ac)
        except B.OfficeError as e:
            self.say(str(e), "warn")
            return
        self.zone = z
        self.ox.set(f"{z['origin'][0]:g}")
        self.oy.set(f"{z['origin'][1]:g}")
        self.oz.set("0")
        self.rot.set(f"{z['rotationDeg']:g}")
        for v in self.story_box["values"]:
            if v.startswith(f"{z['story']} "):
                self.story_var.set(v)
        self.walls_var.set(False)
        self.say(f"Zone \"{z['name']}\": {z['width']:.2f} × {z['depth']:.2f} m, rotated {z['rotationDeg']:g}°. Site walls off (the Zone's walls exist). "
                 "Open web app to design for it.", "ok")

    def open_web_app(self):
        url = find_web_app()
        if not url:
            self.say("The web app could not be started: serve.py was not found next to this script and has not been run before. "
                     "Start it once with the Start Office Configurator launcher.", "error")
            return
        if self.zone:
            z = dict(self.zone)
            url += "#zone=" + base64.urlsafe_b64encode(json.dumps(z).encode("utf-8")).decode("ascii").rstrip("=")
        webbrowser.open(url)
        self.say(f"Opened {url.split('#')[0]}" + (" with the selected Zone as a fixed site." if self.zone else "."), "ok")

    # ---------------------------------------------------------------- actions
    def do_test(self):
        build = self.build
        try:
            placement = self.placement()
        except B.OfficeError as e:
            self.say(str(e), "error")
            return
        ac, info = self.ac, self.info

        def work():
            return B.test_placement(ac, info, build, placement, progress=lambda m: self.events.put(("progress", m)))

        def done(j, error):
            if error:
                self.say(f"Test placement failed: {error}", "error")
                return
            self.write(B.report_text(j))
            if j.get("testPassed"):
                self.say(f"Test placement passed: {j['summary']['ok']}/{j['summary']['total']} samples verified and deleted. Building is unlocked for Tapir {info.get('tapir')}.", "ok")
            else:
                self.say("Test placement FAILED; see the report above. Nothing else was built.", "error")

        self.run_in_background("Test placement…", work, done)

    def do_build(self):
        if self.mode_var.get() == "remove":
            return self.do_remove()
        build = self.build
        try:
            placement = self.placement()
        except B.OfficeError as e:
            self.say(str(e), "error")
            return
        mode = self.mode_var.get()
        n = sum(r[1] for r in B.summarize(build))
        what = f"Replace run {self.prev['run']}" if mode == "replace" and self.prev else "Append"
        if not messagebox.askokcancel("Build in Archicad", f"Build \"{build['name']}\" ({n} elements) in\n{B.instance_label(self.info)}?\n\n"
                                      f"Mode: {what}\nStory {placement['story']}, origin {placement['origin']}, rotation {placement['rotationDeg']}°\n"
                                      f"Site walls: {'yes' if self.walls_var.get() else 'no'}", parent=self.root):
            self.say("Nothing built.")
            return
        ac, info, walls = self.ac, self.info, self.walls_var.get()

        def work():
            return B.Builder(ac, info, progress=lambda m: self.events.put(("progress", m))).build(build, mode=mode, placement=placement, build_walls=walls)

        def done(j, error):
            if error:
                self.say(f"Build stopped: {error}  The journal keeps what was created; use Remove run to clean up.", "error")
                return
            self.write(B.report_text(j))
            if j["status"] == "built":
                self.say(f"Built run {j['run']}: {j['summary']['ok']}/{j['summary']['total']} elements verified." +
                         (f" Replaced {j['replaced']['run']} (deleted {j['replaced']['deleted']}, kept {len(j['replaced']['kept'])})." if j.get("replaced") else ""), "ok")
            else:
                self.say(f"Built run {j['run']} with problems: {j['summary']['total'] - j['summary']['ok']} element(s) did not verify. See the report.", "warn")

        self.run_in_background("Building…", work, done)

    def do_remove(self):
        sel = self.run_var.get().split(" · ")[0]
        if not sel:
            return
        if not messagebox.askokcancel("Remove run", f"Remove run {sel}?\nOnly elements still exactly as built are deleted; edited ones are kept.", parent=self.root):
            return
        ac, (token, path, _) = self.ac, self.identity

        def work():
            return B.remove_run(ac, sel, token, path)

        def done(rep, error):
            if error:
                self.say(error, "error")
                return
            for k in rep["kept"]:
                self.write(f"kept {k['key']}: {k['why']}")
            self.say(f"Removed run {rep['run']}: deleted {rep['deleted']}, kept {len(rep['kept'])}, already gone {rep['gone']}.", "warn" if rep["kept"] else "ok")
            self.run_var.set("")

        self.run_in_background(f"Removing run {sel}…", work, done)


def find_web_app():
    """URL of the running web app, starting serve.py if needed."""
    info_path = os.path.join(B.home_dir(), "app.json")

    def running():
        try:
            with open(info_path, encoding="utf-8") as f:
                info = json.load(f)
            urllib.request.urlopen(info["url"], timeout=1).close()
            return info
        except (OSError, ValueError, KeyError):
            return None

    info = running()
    if info:
        return info["url"]
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, "..", "serve.py"), os.path.join(here, "serve.py")]
    try:
        with open(info_path, encoding="utf-8") as f:
            candidates.append(os.path.join(json.load(f)["root"], "serve.py"))
    except (OSError, ValueError, KeyError):
        pass
    serve = next((c for c in candidates if os.path.isfile(c)), None)
    if not serve:
        return None
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    py = sys.executable
    if py.lower().endswith("pythonw.exe"):
        py = py[:-5] + ".exe" if os.path.exists(py[:-5] + ".exe") else py
    subprocess.Popen([py, serve], cwd=os.path.dirname(serve), creationflags=flags,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    for _ in range(50):
        time.sleep(0.1)
        info = running()
        if info:
            return info["url"]
    return None


def gui_main(argv=None):
    args = B.parse_args(argv)
    if any((args.list, args.build, args.test, args.status, args.builds, args.remove)):
        return B.main(argv)
    if tk is None:
        print("This Python has no Tkinter, so the window cannot open. Use the python.org installer "
              "(it includes Tkinter), or the command line: --list, --test FILE, --build FILE.", file=sys.stderr)
        return 2
    root = tk.Tk()
    try:
        ttk.Style(root).theme_use("vista" if sys.platform == "win32" else "clam")
    except tk.TclError:
        pass
    OfficeWindow(root, port=args.port)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(gui_main())
