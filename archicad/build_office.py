#!/usr/bin/env python3
"""Office Configurator: build a downloaded build file in Archicad through the Tapir add-on.

Library + command line. Standard library only, Python 3.8+.

    python3 build_office.py --list                         running Archicads with Tapir
    python3 build_office.py --build FILE [--port N]        build (replaces the previous build in that project)
    python3 build_office.py --build FILE --append          keep the previous build
    python3 build_office.py --test FILE [--port N]         Test placement: one sample per kind, verify, delete
    python3 build_office.py --status [--port N]            project identity, Tapir, writing gate, last runs
    python3 build_office.py --builds                       every run in the journal
    python3 build_office.py --remove RUN_ID [--port N]     remove one run (only elements still exactly as built)

Talks only to 127.0.0.1 ports 19723-19744. Never deletes by type or layer query: only GUIDs from
its own journal, and only those still exactly as built.
"""
import argparse
import datetime
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")  # Windows consoles choke on "—", "×", "→"
    except (AttributeError, ValueError):
        pass

APP = "Office Configurator"
HOST = "127.0.0.1"
PORTS = range(19723, 19745)
BUILD_FORMAT = "office-configurator-build"
BUILD_VERSION = 1
BATCH = 200
LAYER_PREFIX = "OFFICE - "
LAYERS = ("OFFICE - Walls", "OFFICE - Rooms", "OFFICE - Workstations", "OFFICE - Meeting", "OFFICE - Storage", "OFFICE - Furniture")
BOX_KINDS = ("desk", "chair", "table", "booth", "storage", "furniture")
ZONE_CATEGORIES = {  # category -> (code, colour)
    "open office": ("OF-OPEN", "#d9e6f2"), "meeting": ("OF-MEET", "#f2e3c9"),
    "focus": ("OF-FOCUS", "#dcefd9"), "support": ("OF-SUP", "#e6e6e6"),
}
IDENTITY_SYSTEM = APP
IDENTITY_PREFIX = "office-configurator-project:"
TOL_XY, TOL_Z, TOL_SAME = 0.005, 0.012, 0.002   # verification tolerances (m) and "still as built"
KNOWN_TAPIR = ("1.7",)          # command definitions this file was written against (docs + source of 1.7.0)
TESTED_TAPIR = ()               # versions verified by us against a real Archicad: none yet
ID_VIA_DETAILS = (1, 7, 3)      # SetDetailsOfElements takes details.id from Tapir 1.7.3


class OfficeError(Exception):
    """A refusal or failure to show to the user as is."""


# ---------------------------------------------------------------- paths and journal

def home_dir():
    base = os.environ.get("OFFICE_CONFIGURATOR_HOME")
    if not base:
        docs = os.path.join(os.path.expanduser("~"), "Documents")
        base = os.path.join(docs if os.path.isdir(docs) else os.path.expanduser("~"), APP)
    os.makedirs(os.path.join(base, "journal"), exist_ok=True)
    return base


def journal_path(run_id):
    if not re.match(r"^[0-9A-Za-z-]{1,40}$", run_id or ""):
        raise OfficeError(f"Not a run ID: {run_id!r}")
    return os.path.join(home_dir(), "journal", f"{run_id}.json")


def save_journal(j):
    path = journal_path(j["run"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(j, f, indent=1)
    os.replace(tmp, path)


def load_journal(run_id):
    path = journal_path(run_id)
    if not os.path.exists(path):
        raise OfficeError(f"No run {run_id} in the journal ({os.path.dirname(path)}).")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def all_journals():
    d = os.path.join(home_dir(), "journal")
    out = []
    for name in sorted(os.listdir(d)):
        if name.endswith(".json"):
            try:
                with open(os.path.join(d, name), encoding="utf-8") as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return out


def load_tested():
    try:
        with open(os.path.join(home_dir(), "tested.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def record_tested(tapir, archicad, run_id):
    tested = load_tested()
    tested[tapir] = {"archicad": archicad, "run": run_id, "at": now_iso()}
    with open(os.path.join(home_dir(), "tested.json"), "w", encoding="utf-8") as f:
        json.dump(tested, f, indent=1)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_run_id():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%y%m%d-%H%M%S")
    run = stamp
    n = 1
    while os.path.exists(journal_path(run)):
        n += 1
        run = f"{stamp}-{n}"
    return run


# ---------------------------------------------------------------- Archicad connection

class Archicad:
    """One running Archicad, reached through its JSON API on 127.0.0.1:port."""

    def __init__(self, port, timeout=120.0):
        port = int(port)
        if port not in PORTS:
            raise OfficeError(f"Port {port} is outside 19723-19744.")
        self.port = port
        self.timeout = timeout
        self.url = f"http://{HOST}:{port}"

    def call(self, command, parameters=None, timeout=None):
        body = {"command": command}
        if parameters is not None:
            body["parameters"] = parameters
        req = urllib.request.Request(self.url, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise OfficeError(f"Archicad on port {self.port} did not answer {command}: {e}")
        if not data.get("succeeded"):
            err = data.get("error") or {}
            raise OfficeError(f"{command} failed: {err.get('message', data)}")
        return data.get("result") or {}

    def tapir(self, name, parameters=None):
        params = {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": name}}
        if parameters is not None:
            params["addOnCommandParameters"] = parameters
        res = self.call("API.ExecuteAddOnCommand", params).get("addOnCommandResponse", {})
        if isinstance(res, dict) and "error" in res and len(res) == 1:
            raise OfficeError(f"Tapir {name} failed: {res['error'].get('message', res['error'])}")
        return res


def probe_port(port, timeout=0.6):
    """Facts about the Archicad on `port`, or None."""
    ac = Archicad(port, timeout=timeout)
    try:
        if not ac.call("API.IsAlive", timeout=timeout).get("isAlive"):
            return None
    except OfficeError:
        return None
    ac.timeout = 10
    info = {"port": port, "archicad": None, "tapir": None, "project": None}
    try:
        p = ac.call("API.GetProductInfo")
        info["archicad"] = f"{p.get('version')}.{p.get('buildNumber')}"
        info["archicadVersion"] = p.get("version")
    except OfficeError:
        pass
    try:
        ok = ac.call("API.IsAddOnCommandAvailable", {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": "GetAddOnVersion"}})
        if ok.get("available"):
            info["tapir"] = ac.tapir("GetAddOnVersion").get("version")
            info["project"] = ac.tapir("GetProjectInfo")
    except OfficeError:
        pass
    return info


def discover():
    return [i for i in (probe_port(p) for p in PORTS) if i]


def instance_label(i):
    proj = i.get("project") or {}
    name = "Untitled" if proj.get("isUntitled") else (proj.get("projectName") or "?")
    ver = f"Archicad {i.get('archicadVersion')}" if i.get("archicadVersion") else "Archicad"
    tapir = f"Tapir {i['tapir']}" if i.get("tapir") else "no Tapir"
    return f"{name} · {ver} · {tapir} · port {i['port']}"


def choose_instance(instances, port=None):
    """The instance to talk to. Never guesses between several."""
    if port is not None:
        for i in instances:
            if i["port"] == int(port):
                return i
        raise OfficeError(f"No Archicad answers on port {port}.")
    usable = [i for i in instances if i.get("tapir")]
    if not instances:
        raise OfficeError("No running Archicad found on ports 19723-19744.")
    if not usable:
        raise OfficeError("Archicad is running but the Tapir add-on does not answer. Install or enable Tapir.")
    if len(usable) > 1:
        raise OfficeError("Several Archicads are open; refusing to guess. Pick one with --port:\n  " + "\n  ".join(instance_label(i) for i in usable))
    return usable[0]


def version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).split(".")[:3])
    except ValueError:
        return (0, 0, 0)


def writing_gate(tapir, archicad=None):
    """('build' | 'test-only' | 'status-only', reason)."""
    if not tapir:
        return "status-only", "Tapir does not answer."
    if ".".join(str(tapir).split(".")[:2]) not in KNOWN_TAPIR:
        return "status-only", f"Tapir {tapir} is not a version this tool was written for (1.7.x); status only."
    if tapir in TESTED_TAPIR:
        return "build", f"Tapir {tapir} is tested."
    t = load_tested().get(tapir)
    if t:
        return "build", f"Tapir {tapir}: Test placement passed on {t['at'][:10]} (run {t['run']})."
    return "test-only", f"Tapir {tapir} has not been tested on this computer yet: run Test placement first."


# ---------------------------------------------------------------- build file validation

KEY = re.compile(r"^[A-Z0-9-]{1,40}$")
MATERIAL = re.compile(r"^[A-Za-z][A-Za-z ]{0,30}$")
COLOR = re.compile(r"^#[0-9a-f]{6}$")
MAX_FILE = 5 * 1024 * 1024


def _num(v, lo, hi, what, errs):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < lo or v > hi:
        errs.append(f"{what}: {v!r} is not a number in {lo}..{hi}")
        return lo
    return float(v)


def _str(v, pattern, what, errs, maxlen=120):
    if not isinstance(v, str) or len(v) > maxlen or (pattern and not pattern.match(v)):
        errs.append(f"{what}: {v!r} is not allowed")
        return ""
    return v


def _pt(v, n, lo, hi, what, errs):
    if not isinstance(v, list) or len(v) != n:
        errs.append(f"{what}: needs {n} numbers")
        return [0.0] * n
    return [_num(x, lo, hi, f"{what}[{i}]", errs) for i, x in enumerate(v)]


def _list(v, what, maxn, errs):
    if not isinstance(v, list):
        errs.append(f"{what}: not a list")
        return []
    if len(v) > maxn:
        errs.append(f"{what}: {len(v)} entries, at most {maxn}")
        return []
    return v


def validate_build(data):
    """Strict whitelist copy of a build file. Returns (clean, errors, notes); refuse when errors."""
    errs, notes = [], []
    if not isinstance(data, dict):
        return None, ["The file is not a JSON object."], notes
    if data.get("format") != BUILD_FORMAT:
        return None, [f"Not an Office Configurator build file (format {data.get('format')!r})."], notes
    if data.get("version") != BUILD_VERSION:
        return None, [f"Build file version {data.get('version')!r}; this tool reads version {BUILD_VERSION}."], notes
    extra = set(data) - {"format", "version", "created", "name", "mode", "walls", "placement", "model"}
    if extra:
        notes.append(f"Ignored unknown fields: {', '.join(sorted(extra))}")
    out = {"format": BUILD_FORMAT, "version": BUILD_VERSION,
           "created": _str(data.get("created", ""), None, "created", errs, 40),
           "name": _str(data.get("name", ""), None, "name", errs, 120) or "Office",
           "mode": data.get("mode") if data.get("mode") in ("replace", "append") else None,
           "walls": data.get("walls")}
    if out["mode"] is None:
        errs.append(f"mode: {data.get('mode')!r} is not replace/append")
    if not isinstance(out["walls"], bool):
        errs.append("walls: not true/false")
    pl = data.get("placement") if isinstance(data.get("placement"), dict) else {}
    story = pl.get("story", 0)
    if isinstance(story, bool) or not isinstance(story, int) or not -20 <= story <= 200:
        errs.append(f"placement.story: {story!r} is not a story index")
        story = 0
    out["placement"] = {"origin": _pt(pl.get("origin", [0, 0, 0]), 3, -100000, 100000, "placement.origin", errs),
                        "rotationDeg": _num(pl.get("rotationDeg", 0), -360, 360, "placement.rotationDeg", errs), "story": story}
    m = data.get("model") if isinstance(data.get("model"), dict) else None
    if m is None:
        return None, errs + ["model: missing"], notes
    if m.get("units") != "m":
        errs.append("model.units: must be m")
    s = m.get("site") if isinstance(m.get("site"), dict) else {}
    site = {"width": _num(s.get("width"), 2.4, 60, "site.width", errs), "depth": _num(s.get("depth"), 2.4, 60, "site.depth", errs),
            "height": _num(s.get("height"), 2.2, 10, "site.height", errs), "wallThickness": _num(s.get("wallThickness"), 0.05, 1, "site.wallThickness", errs)}
    keys = set()

    def key(v, what):
        k = _str(v, KEY, what, errs, 40)
        if k in keys:
            errs.append(f"{what}: duplicate key {k}")
        keys.add(k)
        return k

    def layer(v, what):
        if v not in LAYERS:
            errs.append(f"{what}: layer {v!r} is not one of the OFFICE layers")
        return v

    lim = 200.0
    walls = []
    for i, w in enumerate(_list(m.get("walls", []), "walls", 64, errs)):
        w = w if isinstance(w, dict) else {}
        walls.append({"key": key(w.get("key"), f"walls[{i}].key"), "layer": layer(w.get("layer"), f"walls[{i}]"),
                      "beg": _pt(w.get("beg"), 2, -lim, lim, f"walls[{i}].beg", errs), "end": _pt(w.get("end"), 2, -lim, lim, f"walls[{i}].end", errs),
                      "thickness": _num(w.get("thickness"), 0.05, 1, f"walls[{i}].thickness", errs), "height": _num(w.get("height"), 0.1, 10, f"walls[{i}].height", errs)})
    wall_len = {w["key"]: math.dist(w["beg"], w["end"]) for w in walls}
    openings = []
    for i, o in enumerate(_list(m.get("openings", []), "openings", 64, errs)):
        o = o if isinstance(o, dict) else {}
        kind = o.get("kind") if o.get("kind") in ("door", "window") else None
        if kind is None:
            errs.append(f"openings[{i}].kind: {o.get('kind')!r}")
        host = o.get("wall")
        if host not in wall_len:
            errs.append(f"openings[{i}].wall: no wall {host!r}")
        rec = {"key": key(o.get("key"), f"openings[{i}].key"), "kind": kind, "wall": host, "layer": layer(o.get("layer"), f"openings[{i}]"),
               "centerOffset": _num(o.get("centerOffset"), 0, wall_len.get(host, lim), f"openings[{i}].centerOffset", errs),
               "width": _num(o.get("width"), 0.3, 6, f"openings[{i}].width", errs), "height": _num(o.get("height"), 0.1, 10, f"openings[{i}].height", errs),
               "sill": _num(o.get("sill", 0), 0, 10, f"openings[{i}].sill", errs),
               "swing": o.get("swing") if o.get("swing") in ("in", "out") else "in", "hinge": o.get("hinge") if o.get("hinge") in ("start", "end") else "start"}
        openings.append(rec)
    beams = []
    for i, b in enumerate(_list(m.get("beams", []), "beams", 64, errs)):
        b = b if isinstance(b, dict) else {}
        beams.append({"key": key(b.get("key"), f"beams[{i}].key"), "layer": layer(b.get("layer"), f"beams[{i}]"),
                      "beg": _pt(b.get("beg"), 2, -lim, lim, f"beams[{i}].beg", errs), "end": _pt(b.get("end"), 2, -lim, lim, f"beams[{i}].end", errs),
                      "width": _num(b.get("width"), 0.05, 2, f"beams[{i}].width", errs), "height": _num(b.get("height"), 0.05, 3, f"beams[{i}].height", errs),
                      "top": _num(b.get("top"), 0.1, 10, f"beams[{i}].top", errs)})
    zones = []
    for i, z in enumerate(_list(m.get("zones", []), "zones", 32, errs)):
        z = z if isinstance(z, dict) else {}
        cat = z.get("category")
        if cat not in ZONE_CATEGORIES:
            errs.append(f"zones[{i}].category: {cat!r}")
        poly = _list(z.get("polygon"), f"zones[{i}].polygon", 64, errs)
        if len(poly) < 3:
            errs.append(f"zones[{i}].polygon: fewer than 3 points")
        zones.append({"key": key(z.get("key"), f"zones[{i}].key"), "layer": layer(z.get("layer"), f"zones[{i}]"),
                      "name": _str(z.get("name", ""), None, f"zones[{i}].name", errs, 60), "number": _str(z.get("number", ""), None, f"zones[{i}].number", errs, 10),
                      "category": cat, "height": _num(z.get("height", site["height"]), 0.1, 10, f"zones[{i}].height", errs),
                      "polygon": [_pt(p, 2, -lim, lim, f"zones[{i}].polygon[{j}]", errs) for j, p in enumerate(poly)]})
    boxes = []
    for i, b in enumerate(_list(m.get("boxes", []), "boxes", 5000, errs)):
        b = b if isinstance(b, dict) else {}
        kind = b.get("kind")
        if kind not in BOX_KINDS:
            errs.append(f"boxes[{i}].kind: {kind!r}")
        rot = _num(b.get("rot", 0), 0, 360, f"boxes[{i}].rot", errs)   # facing of the element the box belongs to
        rec = {"key": key(b.get("key"), f"boxes[{i}].key"), "element": _str(b.get("element"), KEY, f"boxes[{i}].element", errs, 40),
               "kind": kind, "part": _str(b.get("part", ""), re.compile(r"^[a-z]{1,20}$"), f"boxes[{i}].part", errs, 20),
               "rot": rot, "layer": layer(b.get("layer"), f"boxes[{i}]"),
               "material": _str(b.get("material"), MATERIAL, f"boxes[{i}].material", errs, 31), "color": _str(b.get("color"), COLOR, f"boxes[{i}].color", errs, 7),
               "min": _pt(b.get("min"), 3, -1, 61, f"boxes[{i}].min", errs), "size": _pt(b.get("size"), 3, 0.001, 12, f"boxes[{i}].size", errs)}
        if b.get("shape") == "prism":
            rec.update({"shape": "prism", "centre": _pt(b.get("centre"), 2, -1, 61, f"boxes[{i}].centre", errs),
                        "radius": _num(b.get("radius"), 0.05, 3, f"boxes[{i}].radius", errs),
                        "sides": int(_num(b.get("sides"), 8, 64, f"boxes[{i}].sides", errs)), "z": _pt(b.get("z"), 2, 0, 10, f"boxes[{i}].z", errs)})
        elif "shape" in b:
            errs.append(f"boxes[{i}].shape: {b.get('shape')!r}")
        boxes.append(rec)
    for b in boxes:
        x0, y0, _ = b["min"]
        if x0 < -0.001 or y0 < -0.001 or x0 + b["size"][0] > site["width"] + 0.001 or y0 + b["size"][1] > site["depth"] + 0.001:
            errs.append(f"{b['key']}: outside the {site['width']} x {site['depth']} m site")
    checks = []
    for c in _list(m.get("checks", []), "checks", 200, notes):
        if isinstance(c, dict) and c.get("level") in ("warn", "error"):
            checks.append({"level": c["level"], "code": str(c.get("code", ""))[:60], "msg": str(c.get("msg", ""))[:400]})
    total = len(walls) + len(openings) + len(beams) + len(zones) + len(boxes)
    if total == 0:
        errs.append("The build file has no elements.")
    out["model"] = {"units": "m", "site": site, "walls": walls, "openings": openings, "beams": beams, "zones": zones, "boxes": boxes, "checks": checks}
    return out, errs, notes


def read_build_file(path):
    if os.path.getsize(path) > MAX_FILE:
        raise OfficeError(f"{os.path.basename(path)} is larger than 5 MB; not a build file.")
    with open(path, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except ValueError as e:
            raise OfficeError(f"{os.path.basename(path)} is not valid JSON: {e}")
    clean, errs, notes = validate_build(data)
    if errs:
        raise OfficeError(f"{os.path.basename(path)} was refused:\n  " + "\n  ".join(errs[:20]) + (f"\n  ... {len(errs) - 20} more" if len(errs) > 20 else ""))
    return clean, notes


def summarize(build):
    """Rows of (element type, count, layers) for the window's table."""
    m = build["model"]
    rows = []

    def add(label, items):
        if items:
            rows.append((label, len(items), ", ".join(sorted({i["layer"] for i in items}))))

    if build["walls"]:
        add("Wall", m["walls"])
        add("Door", [o for o in m["openings"] if o["kind"] == "door"])
        add("Window", [o for o in m["openings"] if o["kind"] == "window"])
        add("Beam (threshold)", m["beams"])
    add("Zone", m["zones"])
    for kind in BOX_KINDS:
        add(f"Morph · {kind}", [b for b in m["boxes"] if b["kind"] == kind])
    return rows


# ---------------------------------------------------------------- placement geometry

class Placement:
    def __init__(self, origin, rotation_deg, story, level):
        self.ox, self.oy, self.oz = (float(v) for v in origin)
        self.rot = float(rotation_deg)
        self.story = int(story)
        self.level = float(level)
        a = math.radians(self.rot)
        self.c, self.s = math.cos(a), math.sin(a)
        self.square = abs(self.rot / 90.0 - round(self.rot / 90.0)) < 1e-9
        if self.square:  # exact cos/sin for 0/90/180/270
            k = int(round(self.rot / 90.0)) % 4
            self.c, self.s = ((1, 0), (0, 1), (-1, 0), (0, -1))[k]

    def xy(self, x, y):
        return (self.ox + self.c * x - self.s * y, self.oy + self.s * x + self.c * y)

    def z(self, z):
        return self.level + self.oz + z

    def bbox_of(self, pts2, z0, z1):
        w = [self.xy(x, y) for x, y in pts2]
        return [min(p[0] for p in w), min(p[1] for p in w), self.z(z0), max(p[0] for p in w), max(p[1] for p in w), self.z(z1)]


def rect_pts(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def wall_pts(beg, end, thickness):
    dx, dy = end[0] - beg[0], end[1] - beg[1]
    n = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / n * thickness / 2, dx / n * thickness / 2
    return [(beg[0] + nx, beg[1] + ny), (end[0] + nx, end[1] + ny), (end[0] - nx, end[1] - ny), (beg[0] - nx, beg[1] - ny)]


def prism_body(b, pl, base):
    """A closed n-sided prism, vertices relative to `base` (no axes, so rotation-proof)."""
    n, r = b["sides"], b["radius"]
    cx, cy = pl.xy(*b["centre"])
    verts = []
    for zz in b["z"]:
        for k in range(n):
            a = 2 * math.pi * k / n + math.radians(pl.rot)
            verts.append({"x": cx + r * math.cos(a) - base[0], "y": cy + r * math.sin(a) - base[1], "z": pl.z(zz) - base[2]})
    bottom = {"vertexIds": list(range(n - 1, -1, -1))}
    top = {"vertexIds": list(range(n, 2 * n))}
    sides = [{"vertexIds": [k, (k + 1) % n, n + (k + 1) % n, n + k]} for k in range(n)]
    return {"vertices": verts, "polygons": [bottom, top] + sides}


def prism_bbox(b, pl):
    n, r = b["sides"], b["radius"]
    cx, cy = pl.xy(*b["centre"])
    pts = [(cx + r * math.cos(2 * math.pi * k / n + math.radians(pl.rot)), cy + r * math.sin(2 * math.pi * k / n + math.radians(pl.rot))) for k in range(n)]
    return [min(p[0] for p in pts), min(p[1] for p in pts), pl.z(b["z"][0]), max(p[0] for p in pts), max(p[1] for p in pts), pl.z(b["z"][1])]


def morph_request(b, pl, convention):
    """CreateMorphs entry for a box, and its expected world bounding box."""
    x0, y0, z0 = b["min"]
    sx, sy, sz = b["size"]
    if b.get("shape") == "prism":
        base = (pl.xy(*b["centre"])[0], pl.xy(*b["centre"])[1], pl.z(b["z"][0]))
        req = {"basePoint": {"x": base[0], "y": base[1], "z": base[2]}, "body": prism_body(b, pl, base), "floorIndex": pl.story}
        return req, prism_bbox(b, pl)
    exp = pl.bbox_of(rect_pts(x0, y0, x0 + sx, y0 + sy), z0, z0 + sz)
    if pl.square:
        # Square to the project axes: plain extent, identity axes.
        req = {"basePoint": {"x": exp[0], "y": exp[1], "z": exp[2]}, "size": {"x": exp[3] - exp[0], "y": exp[4] - exp[1], "z": sz}, "floorIndex": pl.story}
        return req, exp
    bx, by = pl.xy(x0, y0)
    c, s = pl.c, pl.s
    if convention == "rows":   # Archicad reads the axes as rows of the placement matrix: send the transpose
        xa, ya = {"x": c, "y": -s, "z": 0}, {"x": s, "y": c, "z": 0}
    else:
        xa, ya = {"x": c, "y": s, "z": 0}, {"x": -s, "y": c, "z": 0}
    req = {"basePoint": {"x": bx, "y": by, "z": pl.z(z0)}, "size": {"x": sx, "y": sy, "z": sz},
           "xAxis": xa, "yAxis": ya, "zAxis": {"x": 0, "y": 0, "z": 1}, "floorIndex": pl.story}
    return req, exp


# ---------------------------------------------------------------- reading results

def guid_of(item):
    if isinstance(item, dict) and isinstance(item.get("elementId"), dict):
        return item["elementId"].get("guid")
    return None


def error_of(item):
    if isinstance(item, dict) and isinstance(item.get("error"), dict):
        return item["error"].get("message", "error")
    return None


def elements(guids):
    return [{"elementId": {"guid": g}} for g in guids]


def read_back(ac, guids):
    """{guid: {type, id, floorIndex, layerIndex, bbox} or {missing: reason}}."""
    out = {}
    for i in range(0, len(guids), BATCH):
        chunk = guids[i:i + BATCH]
        boxes = ac.tapir("Get3DBoundingBoxes", {"elements": elements(chunk)}).get("boundingBoxes3D", [])
        details = ac.tapir("GetDetailsOfElements", {"elements": elements(chunk), "fields": ["type", "id", "floorIndex", "layerIndex"]}).get("detailsOfElements", [])
        for g, bb, d in zip(chunk, boxes, details):
            if error_of(bb) or error_of(d):
                out[g] = {"missing": error_of(bb) or error_of(d)}
                continue
            b = bb.get("boundingBox3D", {})
            out[g] = {"type": d.get("type"), "id": d.get("id"), "floorIndex": d.get("floorIndex"), "layerIndex": d.get("layerIndex"),
                      "bbox": [b.get("xMin"), b.get("yMin"), b.get("zMin"), b.get("xMax"), b.get("yMax"), b.get("zMax")]}
    return out


def bbox_diff(a, b, xy=True, z=True):
    d = 0.0
    if xy:
        d = max(d, *(abs(a[i] - b[i]) for i in (0, 1, 3, 4)))
    if z:
        d = max(d, abs(a[2] - b[2]), abs(a[5] - b[5]))
    return d


# ---------------------------------------------------------------- project identity and attributes

def project_identity(ac, create=False):
    """(token, path, name). The token lives in the source field of an app-owned classification system."""
    info = ac.tapir("GetProjectInfo")
    path = info.get("projectPath") or info.get("projectLocation")
    name = info.get("projectName") or ("Untitled" if info.get("isUntitled") else "?")
    token = None
    for cs in ac.call("API.GetAllClassificationSystems").get("classificationSystems", []):
        src = cs.get("source") or ""
        if cs.get("name") == IDENTITY_SYSTEM and src.startswith(IDENTITY_PREFIX):
            token = src[len(IDENTITY_PREFIX):]
            break
    if token is None and create:
        token = uuid.uuid4().hex
        res = ac.tapir("CreateClassificationSystems", {"classificationSystemsWithItems": [{
            "classificationSystem": {"name": IDENTITY_SYSTEM, "description": "Created by the Office Configurator to recognise this project. Safe to keep.",
                                     "source": IDENTITY_PREFIX + token, "version": "1", "date": datetime.date.today().isoformat()},
            "classificationItems": []}]})
        r = (res.get("executionResults") or [{}])[0]
        if not r.get("success"):
            raise OfficeError(f"Could not create the {IDENTITY_SYSTEM} classification system: {r.get('error', {}).get('message', r)}")
    return token, path, name


def attribute_index(ac, kind):
    res = ac.tapir("GetAttributesByType", {"attributeType": kind})
    if "attributes" not in res:
        raise OfficeError(f"GetAttributesByType {kind} failed: {res}")
    return {a["name"]: a for a in res["attributes"]}


def ensure_attributes(ac, kind, wanted, make, command, array_key):
    """Look attributes up by name; create the missing ones. Returns {name: header}."""
    have = attribute_index(ac, kind)
    missing = [n for n in wanted if n not in have]
    created = []
    if missing:
        res = ac.tapir(command, {array_key: [make(n) for n in missing], "overwriteExisting": False})
        for n, r in zip(missing, res.get("attributeIds", [])):
            if error_of(r):
                raise OfficeError(f"Could not create {kind} {n!r}: {error_of(r)}")
            created.append(n)
        have = attribute_index(ac, kind)
    for n in wanted:
        if n not in have:
            raise OfficeError(f"{kind} {n!r} is still missing after creating it.")
    return {n: have[n] for n in wanted}, created


def rgb(hexcolor):
    return {"red": int(hexcolor[1:3], 16) / 255, "green": int(hexcolor[3:5], 16) / 255, "blue": int(hexcolor[5:7], 16) / 255}


def surface_name(material, color):
    return f"OFFICE {material} {color}"


# ---------------------------------------------------------------- the build

class Builder:
    """Builds (or test-places) a validated build file in one Archicad, journalling every batch."""

    def __init__(self, ac, info, progress=None):
        self.ac = ac
        self.info = info
        self.tapir = info.get("tapir")
        self.progress = progress or (lambda msg: None)
        self.convention = None
        self.layer_idx = {}
        self.surfaces = {}
        self.categories = {}
        self.element_id_prop = None

    # -- helpers
    def say(self, msg):
        self.progress(msg)

    def story_level(self, story):
        st = self.ac.tapir("GetStories")
        for s in st.get("stories", []):
            if s.get("index") == story:
                return float(s.get("level", 0.0))
        raise OfficeError(f"Story {story} does not exist in this project (stories {st.get('firstStory')}..{st.get('lastStory')}).")

    def probe_axes(self, pl, j):
        """Place a 30° probe morph, read its box back, and decide how Archicad reads xAxis/yAxis."""
        c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
        bx, by, bz = pl.ox, pl.oy, pl.z(0)
        size = (1.0, 0.2, 0.1)
        req = {"basePoint": {"x": bx, "y": by, "z": bz}, "size": {"x": size[0], "y": size[1], "z": size[2]},
               "xAxis": {"x": c, "y": s, "z": 0}, "yAxis": {"x": -s, "y": c, "z": 0}, "zAxis": {"x": 0, "y": 0, "z": 1}, "floorIndex": pl.story}
        res = self.ac.tapir("CreateMorphs", {"morphsData": [req]}).get("elements", [])
        g = guid_of(res[0]) if res else None
        if not g:
            raise OfficeError(f"The axis probe morph could not be created: {error_of(res[0]) if res else 'no answer'}")
        j["probe"] = {"guid": g, "status": "placed"}
        save_journal(j)
        got = read_back(self.ac, [g])[g]
        self.ac.tapir("DeleteElements", {"elements": elements([g])})
        j["probe"]["status"] = "deleted"

        def expect(sign):
            cc, ss = c, sign * s
            pts = [(bx + cc * x - ss * y, by + ss * x + cc * y) for x, y in rect_pts(0, 0, size[0], size[1])]
            return [min(p[0] for p in pts), min(p[1] for p in pts), bz, max(p[0] for p in pts), max(p[1] for p in pts), bz + size[2]]

        bb = got.get("bbox")
        if not bb or None in bb:
            raise OfficeError("The axis probe morph has no bounding box; refusing to build rotated boxes.")
        if bbox_diff(bb, expect(+1)) <= TOL_XY:
            conv = "columns"
        elif bbox_diff(bb, expect(-1)) <= TOL_XY:
            conv = "rows"
        else:
            raise OfficeError("The 30° probe morph matches neither axis convention; refusing to build rotated boxes.")
        j["probe"]["convention"] = conv
        save_journal(j)
        self.say(f"Axis probe: Archicad reads morph axes as {conv}.")
        return conv

    def ensure_all_attributes(self, build, j):
        m = build["model"]
        layers, made = ensure_attributes(self.ac, "Layer", list(LAYERS), lambda n: {"name": n}, "CreateLayers", "layerDataArray")
        self.layer_idx = {n: int(h["index"]) for n, h in layers.items()}
        j["attributes"]["layers"] = made
        names = sorted({(b["material"], b["color"]) for b in m["boxes"]})
        if names:
            surfaces, made = ensure_attributes(self.ac, "Surface", [surface_name(*n) for n in names],
                                               lambda n: {"name": n, "materialType": "General", "surfaceColor": rgb(n[-7:])}, "CreateSurfaces", "surfaceDataArray")
            self.surfaces = {n: h["attributeId"] for n, h in surfaces.items()}
            j["attributes"]["surfaces"] = made
        cats = sorted({z["category"] for z in m["zones"]})
        if cats:
            catnames = [f"OFFICE {c}" for c in cats]
            got, made = ensure_attributes(self.ac, "ZoneCategory", catnames,
                                          lambda n: {"name": n, "categoryCode": ZONE_CATEGORIES[n[7:]][0], "color": rgb(ZONE_CATEGORIES[n[7:]][1])},
                                          "CreateZoneCategories", "zoneCategoryDataArray")
            self.categories = {n[7:]: h["attributeId"] for n, h in got.items()}
            j["attributes"]["zoneCategories"] = made
        save_journal(j)

    def set_identity(self, recs, run):
        """Layer for every element, and its Element ID OF-<run>-<key>."""
        by_details = version_tuple(self.tapir) >= ID_VIA_DETAILS
        for i in range(0, len(recs), BATCH):
            chunk = [r for r in recs[i:i + BATCH] if r.get("guid")]
            if not chunk:
                continue
            items = []
            for r in chunk:
                d = {"layerIndex": self.layer_idx[r["layer"]]}
                if by_details:
                    d["id"] = r["id"]
                items.append({"elementId": {"guid": r["guid"]}, "details": d})
            res = self.ac.tapir("SetDetailsOfElements", {"elementsWithDetails": items}).get("executionResults", [])
            for r, x in zip(chunk, res):
                if not x.get("success"):
                    r.setdefault("problems", []).append(f"layer/ID not set: {x.get('error', {}).get('message', x)}")
            if not by_details:
                # Tapir before 1.7.3 ignores details.id; write the built-in Element ID property instead.
                if self.element_id_prop is None:
                    p = self.ac.call("API.GetPropertyIds", {"properties": [{"type": "BuiltIn", "nonLocalizedName": "General_ElementID"}]})
                    self.element_id_prop = p["properties"][0]["propertyId"]
                vals = [{"elementId": {"guid": r["guid"]}, "propertyId": self.element_id_prop, "propertyValue": {"value": r["id"]}} for r in chunk]
                res = self.ac.call("API.SetPropertyValuesOfElements", {"elementPropertyValues": vals}).get("executionResults", [])
                for r, x in zip(chunk, res):
                    if not x.get("success"):
                        r.setdefault("problems", []).append(f"Element ID not set: {x.get('error', {}).get('message', x)}")

    def create(self, command, array_key, reqs, recs, j):
        """Create in batches; journal after each batch."""
        for i in range(0, len(reqs), BATCH):
            res = self.ac.tapir(command, {array_key: reqs[i:i + BATCH]}).get("elements", [])
            for k, rec in enumerate(recs[i:i + BATCH]):
                item = res[k] if k < len(res) else None
                rec["guid"] = guid_of(item)
                if not rec["guid"]:
                    rec["status"] = "failed"
                    rec.setdefault("problems", []).append(f"not created: {error_of(item) or 'no answer'}")
                else:
                    rec["status"] = "created"
            j["batches"].append({"command": command, "count": len(reqs[i:i + BATCH]), "at": now_iso()})
            save_journal(j)
            self.say(f"{command}: {sum(1 for r in recs[:i + BATCH] if r.get('guid'))}/{len(recs)}")

    def build(self, build, *, mode=None, placement=None, build_walls=True, test=False, select=None, j_extra=None):
        """Build a validated build file. Returns the journal (status built / built-with-problems)."""
        ac, info = self.ac, self.info
        gate, why = writing_gate(self.tapir, info.get("archicad"))
        if gate == "status-only" or (gate == "test-only" and not test):
            raise OfficeError(why)
        token, path, pname = project_identity(ac, create=True)
        pl_in = dict(build["placement"])
        if placement:
            pl_in.update({k: v for k, v in placement.items() if v is not None})
        level = self.story_level(int(pl_in["story"]))
        pl = Placement(pl_in["origin"], pl_in["rotationDeg"], pl_in["story"], level)
        mode = "test" if test else (mode or build["mode"])
        prev = None
        notes = []
        if mode == "replace":
            prev = latest_run(token, path)
            if prev is None:
                mode = "append"
                notes.append("No previous build in this project: building as Append.")
        run = new_run_id()
        j = {"run": run, "kind": "test" if test else "build", "status": "building", "created": now_iso(), "name": build["name"],
             "project": {"token": token, "path": path, "name": pname},
             "archicad": {"port": ac.port, "version": info.get("archicad"), "tapir": self.tapir},
             "placement": {"origin": [pl.ox, pl.oy, pl.oz], "rotationDeg": pl.rot, "story": pl.story, "level": level},
             "mode": mode, "replaces": prev["run"] if prev else None, "attributes": {}, "batches": [], "elements": [], "notes": notes}
        if j_extra:
            j.update(j_extra)
        save_journal(j)
        self.say(f"Run {run} started ({mode}).")
        try:
            self.ensure_all_attributes(build, j)
            m = build["model"]
            pick = select or (lambda kind, item: True)
            idf = lambda key: f"OF-{run}-{key}"
            # walls
            walls = [w for w in m["walls"] if build["walls"] and build_walls and pick("wall", w)]
            wrecs, wreqs = [], []
            for w in walls:
                (bx, by), (ex, ey) = pl.xy(*w["beg"]), pl.xy(*w["end"])
                wreqs.append({"begCoordinate": {"x": bx, "y": by}, "endCoordinate": {"x": ex, "y": ey}, "floorIndex": pl.story,
                              "zCoordinate": pl.oz, "height": w["height"], "thickness": w["thickness"], "referenceLineLocation": "Center"})
                wrecs.append({"key": w["key"], "id": idf(w["key"]), "type": "Wall", "layer": w["layer"], "story": pl.story,
                              "expected": pl.bbox_of(wall_pts(w["beg"], w["end"], w["thickness"]), 0, w["height"]), "check": "xyz"})
            j["elements"].extend(wrecs)
            self.create("CreateWalls", "wallsData", wreqs, wrecs, j)
            wall_guid = {r["key"]: r.get("guid") for r in wrecs}
            wall_def = {w["key"]: w for w in walls}
            # doors and windows, in the segment that holds them
            for kind, command, key in (("door", "CreateDoors", "doorsData"), ("window", "CreateWindows", "windowsData")):
                ops = [o for o in m["openings"] if o["kind"] == kind and o["wall"] in wall_def and pick(kind, o)]
                reqs, recs = [], []
                for o in ops:
                    if not wall_guid.get(o["wall"]):
                        j["notes"].append(f"{o['key']} skipped: its wall was not created.")
                        continue
                    w = wall_def[o["wall"]]
                    L = math.dist(w["beg"], w["end"])
                    t = o["centerOffset"] / L
                    cx, cy = pl.xy(w["beg"][0] + (w["end"][0] - w["beg"][0]) * t, w["beg"][1] + (w["end"][1] - w["beg"][1]) * t)
                    # swing/hinge mapping (interior is left of the wall direction) is not yet verified on a real Archicad
                    reqs.append({"ownerWallId": {"guid": wall_guid[o["wall"]]}, "centerOffset": o["centerOffset"], "sillHeight": o["sill"],
                                 "width": o["width"], "height": o["height"], "oSide": o["swing"] == "in", "reflected": o["hinge"] == "end"})
                    ang = math.atan2(w["end"][1] - w["beg"][1], w["end"][0] - w["beg"][0]) + math.radians(pl.rot)
                    recs.append({"key": o["key"], "id": idf(o["key"]), "type": kind.capitalize(), "layer": o["layer"], "story": pl.story, "wallKey": o["wall"],
                                 "expected": {"centre": [cx, cy], "dir": [math.cos(ang), math.sin(ang)]}, "check": "along"})
                j["elements"].extend(recs)
                self.create(command, key, reqs, recs, j)
            if not (build["walls"] and build_walls) and m["openings"]:
                j["notes"].append(f"{len(m['openings'])} door(s)/window(s) not built: site walls are not built in this run.")
            # thresholds: beam hung from the ceiling by its top centre
            beams = [b for b in m["beams"] if build["walls"] and build_walls and pick("beam", b)]
            breqs, brecs = [], []
            for b in beams:
                (bx, by), (ex, ey) = pl.xy(*b["beg"]), pl.xy(*b["end"])
                breqs.append({"begCoordinate": {"x": bx, "y": by}, "endCoordinate": {"x": ex, "y": ey}, "zCoordinate": pl.z(b["top"]),
                              "width": b["width"], "height": b["height"], "anchorPoint": "TopCenter", "isWidthAndHeightLinked": False})
                brecs.append({"key": b["key"], "id": idf(b["key"]), "type": "Beam", "layer": b["layer"], "story": None,
                              "expected": pl.bbox_of(wall_pts(b["beg"], b["end"], b["width"]), b["top"] - b["height"], b["top"]), "check": "xyz"})
            j["elements"].extend(brecs)
            self.create("CreateBeams", "beamsData", breqs, brecs, j)
            # zones
            zones = [z for z in m["zones"] if pick("zone", z)]
            zreqs, zrecs = [], []
            for z in zones:
                poly = [pl.xy(*p) for p in z["polygon"]]
                cx, cy = sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)
                zreqs.append({"name": z["name"], "numberStr": z["number"], "floorIndex": pl.story, "categoryAttributeId": self.categories[z["category"]],
                              "stampPosition": {"x": cx, "y": cy}, "geometry": {"polygonCoordinates": [{"x": x, "y": y} for x, y in poly]}})
                zrecs.append({"key": z["key"], "id": idf(z["key"]), "type": "Zone", "layer": z["layer"], "story": pl.story,
                              "expected": pl.bbox_of(z["polygon"], 0, 0), "check": "xy"})
            j["elements"].extend(zrecs)
            self.create("CreateZones", "zonesData", zreqs, zrecs, j)
            # morphs
            boxes = [b for b in m["boxes"] if pick("box", b)]
            if boxes and not pl.square and any(b.get("shape") != "prism" for b in boxes):
                self.convention = self.probe_axes(pl, j)
            mreqs, mrecs = [], []
            for b in boxes:
                req, exp = morph_request(b, pl, self.convention)
                req["surfaceId"] = self.surfaces[surface_name(b["material"], b["color"])]
                mreqs.append(req)
                mrecs.append({"key": b["key"], "id": idf(b["key"]), "type": "Morph", "layer": b["layer"], "story": pl.story,
                              "kind": b["kind"], "expected": exp, "check": "xyz"})
            j["elements"].extend(mrecs)
            self.create("CreateMorphs", "morphsData", mreqs, mrecs, j)
            self.say("Setting layers and Element IDs…")
            self.set_identity(j["elements"], run)
            save_journal(j)
            self.say("Verifying…")
            self.verify(j)
        except OfficeError as e:
            j["status"] = "failed"
            j["notes"].append(str(e))
            save_journal(j)
            raise
        except Exception as e:  # keep the journal recoverable whatever happened
            j["status"] = "failed"
            j["notes"].append(f"Unexpected error: {e!r}")
            save_journal(j)
            raise
        if mode == "replace" and prev:
            if j["status"] == "built":
                self.say(f"Replacing run {prev['run']}…")
                rep = remove_run(ac, prev["run"], token, path, reason="replaced", by=run)
                j["replaced"] = rep
                j["notes"].append(f"Replaced run {prev['run']}: deleted {rep['deleted']}, kept {len(rep['kept'])}, already gone {rep['gone']}.")
            else:
                j["notes"].append(f"Run {prev['run']} kept: the new build has problems, so nothing was replaced.")
            save_journal(j)
        return j

    def verify(self, j):
        """Read every element back: type, Element ID, story, layer, bounding box."""
        recs = [r for r in j["elements"] if r.get("guid")]
        got = read_back(self.ac, [r["guid"] for r in recs])
        for r in recs:
            g = got.get(r["guid"], {"missing": "no answer"})
            probs = r.setdefault("problems", [])
            if "missing" in g:
                probs.append(f"not found: {g['missing']}")
                r["status"] = "problem"
                continue
            r["asBuilt"] = {"bbox": g["bbox"], "layerIndex": g["layerIndex"], "floorIndex": g["floorIndex"], "type": g["type"]}
            if g["type"] != r["type"]:
                probs.append(f"type {g['type']}, expected {r['type']}")
            if g["id"] != r["id"]:
                probs.append(f"Element ID {g['id']!r}, expected {r['id']!r}")
            if self.layer_idx and g["layerIndex"] != self.layer_idx.get(r["layer"]):
                probs.append(f"layer index {g['layerIndex']}, expected {self.layer_idx.get(r['layer'])} ({r['layer']})")
            if r["story"] is not None and g["floorIndex"] != r["story"]:
                probs.append(f"story {g['floorIndex']}, expected {r['story']}")
            bb, exp = g["bbox"], r["expected"]
            if r["check"] == "along":
                cx, cy = (bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2
                d = abs((cx - exp["centre"][0]) * exp["dir"][0] + (cy - exp["centre"][1]) * exp["dir"][1])
                if d > TOL_XY:
                    probs.append(f"centre {d * 1000:.0f} mm along the wall from where it should be")
            else:
                dxy = bbox_diff(bb, exp, xy=True, z=False)
                if dxy > TOL_XY:
                    probs.append(f"off by {dxy * 1000:.0f} mm in plan")
                if r["check"] == "xyz":
                    dz = bbox_diff(bb, exp, xy=False, z=True)
                    if dz > TOL_Z:
                        probs.append(f"off by {dz * 1000:.0f} mm in height")
            r["status"] = "problem" if probs else "ok"
        failed = [r for r in j["elements"] if r.get("status") in ("failed", "problem")]
        j["status"] = "built-with-problems" if failed else "built"
        j["verified"] = now_iso()
        j["summary"] = {"ok": sum(1 for r in j["elements"] if r.get("status") == "ok"), "total": len(j["elements"])}
        save_journal(j)
        return failed


def latest_run(token, path):
    """The newest build run of this project that still stands (built or built with problems)."""
    runs = [j for j in all_journals() if j.get("kind") == "build" and j.get("status") in ("built", "built-with-problems")
            and j.get("project", {}).get("token") == token and j.get("project", {}).get("path") == path]
    return sorted(runs, key=lambda j: j["run"])[-1] if runs else None


def remove_run(ac, run_id, token, path, reason="removed", by=None):
    """Delete a run's elements that are still exactly as built. Edited ones are kept and reported."""
    j = load_journal(run_id)
    if j.get("project", {}).get("token") != token or j.get("project", {}).get("path") != path:
        raise OfficeError(f"Run {run_id} belongs to another project ({j.get('project', {}).get('name')}); nothing removed.")
    recs = [r for r in j.get("elements", []) if r.get("guid") and r.get("status") != "deleted"]
    got = read_back(ac, [r["guid"] for r in recs])
    delete, kept, gone = [], [], 0
    kept_walls = set()
    for r in recs:
        g = got.get(r["guid"], {})
        if "missing" in g:
            gone += 1
            r["status"] = "deleted"
            continue
        ref = r.get("asBuilt")
        why = []
        if ref:
            if g["type"] != ref["type"]:
                why.append(f"type is now {g['type']}")
            if g["layerIndex"] != ref["layerIndex"]:
                why.append("moved to another layer")
            if r["check"] != "along" and bbox_diff(g["bbox"], ref["bbox"], z=r["check"] == "xyz") > TOL_SAME:
                why.append("moved or reshaped")
        else:   # never verified (a faulty run): compare with what was asked for, at verification tolerance
            if g["type"] != r["type"]:
                why.append(f"type is now {g['type']}")
            if r["check"] != "along":
                if bbox_diff(g["bbox"], r["expected"], z=False) > TOL_XY or (r["check"] == "xyz" and bbox_diff(g["bbox"], r["expected"], xy=False) > TOL_Z):
                    why.append("not where it was placed")
        if why:
            kept.append({"key": r["key"], "guid": r["guid"], "why": ", ".join(why)})
            if r["type"] == "Wall":
                kept_walls.add(r["key"])
        else:
            delete.append(r)
    # doors and windows in a kept wall stay with it; openings go before their walls
    order = {"Morph": 0, "Zone": 1, "Beam": 2, "Door": 3, "Window": 3, "Wall": 4}
    final = []
    for r in sorted(delete, key=lambda r: order.get(r["type"], 9)):
        if r["type"] in ("Door", "Window") and r.get("wallKey") in kept_walls:
            kept.append({"key": r["key"], "guid": r["guid"], "why": "its wall was edited and is kept"})
            continue
        final.append(r)
    deleted = 0
    for i in range(0, len(final), BATCH):
        chunk = final[i:i + BATCH]
        res = ac.tapir("DeleteElements", {"elements": elements([r["guid"] for r in chunk])}).get("executionResults", [])
        for r, x in zip(chunk, res):
            if x.get("success"):
                r["status"] = "deleted"
                deleted += 1
            else:
                kept.append({"key": r["key"], "guid": r["guid"], "why": f"Archicad refused: {x.get('error', {}).get('message', x)}"})
        save_journal(j)
    j["status"] = reason if not kept else f"{reason}-partly"
    j.setdefault("history", []).append({"at": now_iso(), "action": reason, "by": by, "deleted": deleted, "kept": kept, "gone": gone})
    save_journal(j)
    return {"run": run_id, "deleted": deleted, "kept": kept, "gone": gone}


def test_placement(ac, info, build, placement=None, progress=None):
    """One sample per kind (rotated ones first), plus one wall with its openings; verify, then delete."""
    m = build["model"]
    chosen = {}
    for b in sorted(m["boxes"], key=lambda b: (b.get("shape") != "prism", b["rot"] % 180 == 0, b["key"])):
        chosen.setdefault(b["kind"], b["element"])
    # one door and one window, each with the wall that holds it; at least one wall
    sample_ops = {}
    for o in m["openings"]:
        sample_ops.setdefault(o["kind"], o["key"])
    walls = {o["wall"] for o in m["openings"] if o["key"] in sample_ops.values()} or ({m["walls"][0]["key"]} if m["walls"] else set())
    seen_kind = set()

    def select(kind, item):
        if kind == "box":
            return chosen.get(item["kind"]) == item["element"]
        if kind == "wall":
            return item["key"] in walls
        if kind in ("door", "window"):
            return sample_ops.get(kind) == item["key"]
        if kind == "beam":
            return "beam" not in seen_kind and not seen_kind.add("beam")
        if kind == "zone":
            return "zone" not in seen_kind and not seen_kind.add("zone")
        return False

    test_build = dict(build, walls=True)
    b = Builder(ac, info, progress)
    j = b.build(test_build, placement=placement, test=True, select=select)
    passed = j["status"] == "built"
    rep = remove_run(ac, j["run"], j["project"]["token"], j["project"]["path"], reason="test-removed")
    j = load_journal(j["run"])
    if rep["kept"]:
        passed = False
        j["notes"].append(f"Could not delete {len(rep['kept'])} test element(s): {rep['kept']}")
    j["testPassed"] = passed
    save_journal(j)
    if passed:
        record_tested(info.get("tapir"), info.get("archicad"), j["run"])
    return j


# ---------------------------------------------------------------- zone hand-over

def zone_site(ac):
    """The single selected Zone as a rectangular site: {name, width, depth, origin, rotationDeg, story}."""
    sel = ac.tapir("GetSelectedElements").get("elements", [])
    guids = [guid_of(e) for e in sel if guid_of(e)]
    if not guids:
        raise OfficeError("Select one Zone in Archicad first.")
    det = ac.tapir("GetDetailsOfElements", {"elements": elements(guids), "fields": ["type", "floorIndex", "details"]}).get("detailsOfElements", [])
    zones = [d for d in det if isinstance(d, dict) and d.get("type") == "Zone"]
    if len(zones) != 1:
        raise OfficeError(f"Select exactly one Zone ({len(zones)} selected).")
    z = zones[0]
    poly = [(p["x"], p["y"]) for p in z["details"]["polygonOutline"]]
    if len(poly) > 4 and math.dist(poly[0], poly[-1]) < 1e-6:
        poly = poly[:-1]
    if len(poly) != 4:
        raise OfficeError(f"The Zone has {len(poly)} corners; tier S needs a rectangular Zone.")
    area = sum(poly[i][0] * poly[(i + 1) % 4][1] - poly[(i + 1) % 4][0] * poly[i][1] for i in range(4)) / 2
    if area < 0:
        poly = poly[::-1]
    for i in range(4):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % 4]
        dot = (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1])
        if abs(dot) > 1e-4 * math.dist(a, b) * math.dist(b, c):
            raise OfficeError("The Zone is not rectangular; tier S needs a rectangular Zone.")
    # origin at the corner whose first edge is closest to the project x axis
    i = min(range(4), key=lambda k: abs(math.atan2(poly[(k + 1) % 4][1] - poly[k][1], poly[(k + 1) % 4][0] - poly[k][0])))
    p0, p1, p3 = poly[i], poly[(i + 1) % 4], poly[i - 1]
    rot = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
    return {"name": z["details"].get("name", ""), "width": round(math.dist(p0, p1), 4), "depth": round(math.dist(p0, p3), 4),
            "origin": [round(p0[0], 4), round(p0[1], 4), 0.0], "rotationDeg": round(rot, 6), "story": int(z.get("floorIndex", 0))}


# ---------------------------------------------------------------- reporting

def report_text(j):
    lines = [f"Run {j['run']} ({j.get('kind')}): {j['status']}"]
    els = j.get("elements", [])
    sm = j.get("summary") or {"ok": sum(1 for r in els if r.get("status") == "ok"), "total": len(els)}
    lines.append(f"  {sm['ok']}/{sm['total']} elements verified" + (f", Tapir {j['archicad']['tapir']}" if j.get("archicad") else ""))
    if j.get("probe", {}).get("convention"):
        lines.append(f"  morph axes read as {j['probe']['convention']}")
    for r in els:
        if r.get("problems"):
            lines.append(f"  {r['key']}: {'; '.join(r['problems'])}")
    for n in j.get("notes", []):
        lines.append(f"  {n}")
    return "\n".join(lines)


def find_newest_build_file(folder=None):
    folder = folder or os.path.join(os.path.expanduser("~"), "Downloads")
    try:
        files = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".office-build.json")]
    except OSError:
        return None
    return max(files, key=os.path.getmtime) if files else None


def connect(port=None):
    info = choose_instance(discover(), port)
    return Archicad(info["port"]), info


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Build Office Configurator build files in Archicad (Tapir).")
    ap.add_argument("--port", type=int)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--build", metavar="FILE")
    ap.add_argument("--test", metavar="FILE")
    ap.add_argument("--append", action="store_true")
    ap.add_argument("--no-walls", action="store_true")
    ap.add_argument("--story", type=int)
    ap.add_argument("--origin", help="x,y,z in metres")
    ap.add_argument("--rotation", type=float)
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--builds", action="store_true")
    ap.add_argument("--remove", metavar="RUN_ID")
    ap.add_argument("--yes", action="store_true", help="do not ask before building")
    # Tapir's script palette also passes --host and --token: accepted and ignored (the token is never printed).
    args, _unknown = ap.parse_known_args(argv)
    return args


def placement_args(args):
    pl = {}
    if args.origin:
        pl["origin"] = [float(v) for v in args.origin.split(",")]
    if args.rotation is not None:
        pl["rotationDeg"] = args.rotation
    if args.story is not None:
        pl["story"] = args.story
    return pl


def main(argv=None):
    args = parse_args(argv)
    try:
        if args.builds:
            for j in all_journals():
                p = j.get("project", {})
                print(f"{j['run']}  {j.get('kind', ''):5}  {j.get('status', ''):22}  {p.get('name')}  {j.get('name')}")
            return 0
        if args.list:
            found = discover()
            for i in found:
                print(instance_label(i))
            if not found:
                print("No running Archicad found on ports 19723-19744.")
            return 0
        ac, info = connect(args.port)
        if args.status:
            token, path, name = project_identity(ac)
            gate, why = writing_gate(info.get("tapir"), info.get("archicad"))
            print(instance_label(info))
            print(f"Project: {name} ({path or 'not saved'}); identity {'set' if token else 'not set yet (created on first build)'}")
            print(f"Writing: {gate}. {why}")
            prev = latest_run(token, path) if token else None
            print(f"Previous build: {prev['run'] + ' (' + prev['status'] + ')' if prev else 'none'}")
            return 0
        if args.remove:
            token, path, _ = project_identity(ac)
            rep = remove_run(ac, args.remove, token, path)
            print(f"Removed run {rep['run']}: deleted {rep['deleted']}, kept {len(rep['kept'])}, already gone {rep['gone']}.")
            for k in rep["kept"]:
                print(f"  kept {k['key']}: {k['why']}")
            return 0 if not rep["kept"] else 2
        if args.test:
            build, notes = read_build_file(args.test)
            j = test_placement(ac, info, build, placement_args(args), progress=print)
            print(report_text(j))
            print("Test placement PASSED." if j.get("testPassed") else "Test placement FAILED.")
            return 0 if j.get("testPassed") else 1
        if args.build:
            build, notes = read_build_file(args.build)
            for n in notes:
                print(n)
            if not args.yes:
                ans = input(f"Build {build['name']!r} in {instance_label(info)}? [y/N] ")
                if ans.strip().lower() not in ("y", "yes"):
                    print("Nothing built.")
                    return 1
            j = Builder(ac, info, progress=print).build(build, mode="append" if args.append else None,
                                                        placement=placement_args(args), build_walls=not args.no_walls)
            print(report_text(j))
            return 0 if j["status"] == "built" else 1
        print("Nothing to do; see --help.")
        return 1
    except OfficeError as e:
        print(str(e), file=sys.stderr)
        return 2


B = sys.modules[__name__]   # the window refers to the library as B.<name>, bundled or not

if __name__ == "__main__":
    sys.exit(main())
