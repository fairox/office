#!/usr/bin/env python3
"""Archicad-side checks against the mock Archicad (tools/mock_archicad.py). Standard library only.

    python3 tools/archicad_check.py

Builds every preset's build file (exported by tools/export_buildfiles.js through Node) and runs the
safety flow: writing gate, Test placement, first Replace -> Append, second Replace deletes exactly
the previous run, user-edited elements kept, Remove run, two Archicads -> refusal, rotated builds,
leftovers of a crashed run, locked layers, other projects, Element IDs on Tapir < 1.7.3 and >= 1.7.3,
the morph axis probe (rows / columns / neither), beams on the story above, and the Zone hand-over.
Nothing here talks to a real Archicad.
"""
import copy
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(ROOT, "archicad"), os.path.join(ROOT, "tools")]
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

HOME = tempfile.mkdtemp(prefix="office-check-")
os.environ["OFFICE_CONFIGURATOR_HOME"] = HOME
import build_office as B  # noqa: E402
import mock_archicad as MA  # noqa: E402

failures, passes = [], 0


def ok(cond, msg):
    global passes
    if cond:
        passes += 1
    else:
        failures.append(msg)
        print(f"  FAIL {msg}")


def raises(fn, text):
    try:
        fn()
    except B.OfficeError as e:
        return text.lower() in str(e).lower()
    return False


def fresh_home():
    shutil.rmtree(os.path.join(HOME, "journal"), ignore_errors=True)
    for f in ("tested.json",):
        try:
            os.remove(os.path.join(HOME, f))
        except OSError:
            pass
    B.home_dir()


class Mock:
    """Context manager: one or more mock Archicads, stopped afterwards."""

    def __init__(self, *mocks):
        self.mocks = mocks

    def __enter__(self):
        for m in self.mocks:
            m.start()
        return self.mocks[0] if len(self.mocks) == 1 else self.mocks

    def __exit__(self, *a):
        for m in self.mocks:
            m.stop()


def tested(ac, info, build):
    j = B.test_placement(ac, info, build)
    ok(j.get("testPassed"), f"Test placement passes ({B.report_text(j)})")
    return j


def no_violations(m, what):
    ok(not m.schema_violations, f"{what}: requests match the Tapir 1.7.0 schemas: {m.schema_violations[:2]}")


# ---------------------------------------------------------------- build files
out = os.path.join(HOME, "buildfiles")
subprocess.check_call(["node", os.path.join(ROOT, "tools", "export_buildfiles.js"), out], stdout=subprocess.DEVNULL)
files = {os.path.basename(p).replace(".office-build.json", ""): p for p in glob.glob(os.path.join(out, "*.office-build.json"))}
builds = {k: B.read_build_file(p)[0] for k, p in files.items()}
print(f"Build files: {len(builds)}")

print("Validation")
for k, b in builds.items():
    ok(sum(c for _, c, _ in B.summarize(b)) > 0, f"{k}: summary has rows")
raw = json.load(open(files["team-room-8-desks"]))
bad_cases = {
    "wrong format": dict(raw, format="something"),
    "wrong version": dict(raw, version=2),
    "foreign layer": copy.deepcopy(raw),
    "box outside site": copy.deepcopy(raw),
    "NaN-ish number": copy.deepcopy(raw),
    "unknown kind": copy.deepcopy(raw),
    "bad key": copy.deepcopy(raw),
    "door in a missing wall": copy.deepcopy(raw),
    "too many boxes": copy.deepcopy(raw),
}
bad_cases["foreign layer"]["model"]["boxes"][0]["layer"] = "Structural - Bearing"
bad_cases["box outside site"]["model"]["boxes"][0]["min"][0] = 30
bad_cases["NaN-ish number"]["model"]["boxes"][0]["size"][0] = "1"
bad_cases["unknown kind"]["model"]["boxes"][0]["kind"] = "sofa"
bad_cases["bad key"]["model"]["boxes"][0]["key"] = "desk 1; DROP"
bad_cases["door in a missing wall"]["model"]["openings"][0]["wall"] = "WALL-X"
bad_cases["too many boxes"]["model"]["boxes"] = bad_cases["too many boxes"]["model"]["boxes"] * 100
for name, data in bad_cases.items():
    clean, errs, _ = B.validate_build(data)
    ok(bool(errs), f"validation refuses: {name}")
big = os.path.join(HOME, "big.office-build.json")
with open(big, "w") as f:
    f.write(" " * (B.MAX_FILE + 1))
ok(raises(lambda: B.read_build_file(big), "larger than 5 MB"), "validation refuses files over 5 MB")

print("Discovery")
fresh_home()
ok(raises(lambda: B.choose_instance([]), "No running Archicad"), "no Archicad: refusal")
with Mock(MA.MockArchicad(19723), MA.MockArchicad(19724, project="Other")) as (m1, m2):
    found = B.discover()
    ok(len(found) == 2, f"two Archicads found ({len(found)})")
    ok(raises(lambda: B.choose_instance(found), "refusing to guess"), "two Archicads: refuses to guess")
    ok(B.choose_instance(found, 19724)["project"]["projectName"] == "Other", "explicit port picks that Archicad")
    ok("Office Test · Archicad 29 · Tapir 1.7.0 · port 19723" in [B.instance_label(i) for i in found], "picker label")

print("Writing gate")
fresh_home()
ok(B.writing_gate("1.9.0")[0] == "status-only", "unknown Tapir: status only")
ok(B.writing_gate(None)[0] == "status-only", "no Tapir: status only")
with Mock(MA.MockArchicad(19723, tapir="1.9.0")) as m:
    ac, info = B.connect()
    ok(raises(lambda: B.test_placement(ac, info, builds["team-room-8-desks"]), "status only"), "unknown Tapir: even Test placement refused")
    ok(not m.elements, "unknown Tapir: nothing written")
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    ok(raises(lambda: B.Builder(ac, info).build(builds["team-room-8-desks"]), "Test placement first"), "untested Tapir: build refused")
    ok(not m.elements, "untested Tapir: nothing written")
    j = tested(ac, info, builds["team-room-rotated-30"])
    kinds = {r.get("kind") or r["type"] for r in j["elements"]}
    ok({"Wall", "Door", "Window", "Zone", "desk", "chair", "table", "booth"} <= kinds, f"Test placement samples every kind: {sorted(kinds)}")
    ok(not m.elements, f"Test placement leaves nothing behind ({len(m.elements)} left)")
    ok(B.writing_gate("1.7.0")[0] == "build", "passed Test placement unlocks building")
    no_violations(m, "test placement")

print("Build, Replace, Remove")
fresh_home()
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    tested(ac, info, builds["team-room-8-desks"])
    user = m.add_user_element("Morph", 1, (50, 50, 0, 51, 51, 1))
    j1 = B.Builder(ac, info).build(builds["team-room-8-desks"])
    ok(j1["status"] == "built", f"first build verifies: {B.report_text(j1)}")
    ok(any("building as Append" in n for n in j1["notes"]), "first Replace falls back to Append")
    ids = [m.elements[g]["id"] for g in m.of_run(j1["run"])]
    ok(len(ids) == len(j1["elements"]) and len(set(ids)) == len(ids), "every element has a unique OF-<run>-<key> Element ID")
    ok(all(i.startswith(f"OF-{j1['run']}-") for i in ids), "Element IDs carry the run")
    layer_names = {a["index"]: a["name"] for a in m.attributes["Layer"]}
    ok({layer_names[e["layerIndex"]] for g, e in m.elements.items() if g != user} <= set(B.LAYERS), "every element on an OFFICE layer")
    ok(any(a["name"] == "OFFICE Oak #d9c7a5" for a in m.attributes["Surface"]), "surfaces named OFFICE <material> #rrggbb")
    ok(len(m.classification_systems) == 1 and m.classification_systems[0]["source"].startswith(B.IDENTITY_PREFIX), "identity token in an app-owned classification system")
    ok(m.project.get("projectName") == "Office Test", "project info fields untouched")
    batches = len(j1["batches"])
    ok(batches >= 5, f"journal records each batch ({batches})")

    n1 = len(m.of_run(j1["run"]))
    j2 = B.Builder(ac, info).build(builds["team-room-8-desks"])
    ok(j2["status"] == "built" and j2["replaces"] == j1["run"], "second Replace replaces the first run")
    ok(not m.of_run(j1["run"]) and len(m.of_run(j2["run"])) == n1, f"second Replace deletes exactly the previous run ({len(m.of_run(j1['run']))} left)")
    ok(user in m.elements, "an element that is not ours is never touched")
    ok(B.load_journal(j1["run"])["status"] == "replaced", "replaced run marked in the journal")

    # user edits: moved by 50 mm, moved to another layer, on a locked layer
    run2 = m.of_run(j2["run"])
    by_key = {m.elements[g]["id"].split(f"OF-{j2['run']}-")[1]: g for g in run2}
    m.move(by_key["DESK-01-TOP"], dx=0.05)
    m.elements[by_key["CHAIR-01-SEAT"]]["layerIndex"] = 1
    m.lock_layer("OFFICE - Meeting")
    j3 = B.Builder(ac, info).build(builds["team-room-8-desks"])
    rep = j3["replaced"]
    kept = {k["key"] for k in rep["kept"]}
    ok({"DESK-01-TOP", "CHAIR-01-SEAT"} <= kept, f"user-edited elements are kept: {sorted(kept)[:5]}")
    ok(by_key["DESK-01-TOP"] in m.elements and by_key["CHAIR-01-SEAT"] in m.elements, "kept elements still in the model")
    meeting = [k for k in rep["kept"] if "locked" in k["why"]]
    ok(meeting, "elements on a locked layer are kept and reported")
    ok(B.load_journal(j2["run"])["status"] == "replaced-partly", "partly replaced run marked")
    m.locked_layers.clear()

    rem = B.remove_run(ac, j3["run"], j3["project"]["token"], j3["project"]["path"])
    ok(rem["deleted"] == len(j3["elements"]) and not rem["kept"], f"remove-run deletes the run ({rem['deleted']}/{len(j3['elements'])})")
    ok(not m.of_run(j3["run"]), "nothing of the removed run left")
    ok(raises(lambda: B.remove_run(ac, j1["run"], "other-token", j1["project"]["path"]), "another project"), "remove refuses another project's run")
    no_violations(m, "build/replace/remove")

with Mock(MA.MockArchicad(19723, project="Second", path="/projects/second.pln")) as m:
    ac, info = B.connect()
    j = B.Builder(ac, info).build(builds["studio-4-desks"])
    ok(j["replaces"] is None, "Replace never reaches into another project's runs")

print("Problems block Replace")
fresh_home()
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    tested(ac, info, builds["team-room-8-desks"])
    j1 = B.Builder(ac, info).build(builds["team-room-8-desks"])
    m.reject_property_set = True          # Element IDs cannot be written on this Tapir: verification must notice
    j2 = B.Builder(ac, info).build(builds["team-room-8-desks"])
    ok(j2["status"] == "built-with-problems", "unset Element IDs are found by verification")
    ok(any("Element ID" in p for r in j2["elements"] for p in r.get("problems", [])), "the problem names the Element ID")
    ok(m.of_run(j1["run"]) and any("kept" in n for n in j2["notes"]), "a build with problems does not replace the previous one")
    m.reject_property_set = False
    j3 = B.Builder(ac, info).build(builds["team-room-8-desks"])
    ok(j3["status"] == "built" and j3["replaces"] == j2["run"], "a built-with-problems run is replaced by the next good build")
    ok(not [g for g in m.elements if g in {r.get('guid') for r in j2['elements']}], "faulty run cleaned up by Replace")

print("Element IDs by Tapir version")
fresh_home()
with Mock(MA.MockArchicad(19723, tapir="1.7.3")) as m:
    ac, info = B.connect()
    tested(ac, info, builds["studio-4-desks"])
    j = B.Builder(ac, info).build(builds["studio-4-desks"])
    ok(j["status"] == "built", "Tapir 1.7.3: IDs through SetDetailsOfElements")
    ok("API.SetPropertyValuesOfElements" not in m.calls, "Tapir 1.7.3 does not need the property path")
fresh_home()
with Mock(MA.MockArchicad(19723, tapir="1.7.0")) as m:
    ac, info = B.connect()
    tested(ac, info, builds["studio-4-desks"])
    ok("API.SetPropertyValuesOfElements" in m.calls, "Tapir 1.7.0: IDs through the Element ID property")

print("Rotated builds and the morph axis probe")
for axes, expect in (("rows", "rows"), ("columns", "columns")):
    fresh_home()
    with Mock(MA.MockArchicad(19723, axes=axes)) as m:
        ac, info = B.connect()
        tested(ac, info, builds["team-room-rotated-30"])
        j = B.Builder(ac, info).build(builds["team-room-rotated-30"])
        ok(j["status"] == "built", f"30° build verifies when Archicad reads axes as {axes}: {B.report_text(j)[:300]}")
        ok(j.get("probe", {}).get("convention") == expect and j["probe"]["status"] == "deleted", f"probe finds {expect} and is deleted")
        ok(not [g for g, e in m.elements.items() if not e["id"].startswith("OF-")], "no probe left behind")
fresh_home()
with Mock(MA.MockArchicad(19723, axes="broken")) as m:
    ac, info = B.connect()
    ok(raises(lambda: B.test_placement(ac, info, builds["team-room-rotated-30"]), "neither axis convention"), "probe matching neither convention: refusal")
    ok(not [e for e in m.elements.values() if e["type"] == "Morph"], "no morph built after the refusal")
fresh_home()
with Mock(MA.MockArchicad(19723, axes="rows")) as m:
    # Replay of the first real build: rotated morphs sent as columns to an Archicad that reads rows.
    ac, info = B.connect()
    tested(ac, info, builds["team-room-8-desks"])
    bld = B.Builder(ac, info)
    orig = B.Builder.probe_axes
    B.Builder.probe_axes = lambda self, pl, j: "columns"
    try:
        j = bld.build(builds["team-room-rotated-30"], mode="append")
    finally:
        B.Builder.probe_axes = orig
    bad = [r for r in j["elements"] if r["type"] == "Morph" and r.get("problems")]
    ok(j["status"] == "built-with-problems" and len(bad) > 0, f"replay: mirrored morphs are caught by verification ({len(bad)} flagged)")
fresh_home()
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    tested(ac, info, builds["exec-suite-rotated-90"])
    j = B.Builder(ac, info).build(builds["exec-suite-rotated-90"])
    ok(j["status"] == "built" and "probe" not in j, "90° build: plain extents, no probe needed")
    prisms = [r for r in j["elements"] if r["key"].startswith("TABLE-01-TOP")]
    ok(prisms and prisms[0]["status"] == "ok", "round table top (prism body) verifies")

print("Stories")
fresh_home()
with Mock(MA.MockArchicad(19723, stories=((0, 0.0, "Ground"), (1, 2.8, "First")))) as m:
    ac, info = B.connect()
    b = copy.deepcopy(builds["studio-4-desks"])
    b["model"]["beams"] = [{"key": "THR-1", "layer": "OFFICE - Walls", "beg": [1.0, 1.0], "end": [2.0, 1.0], "width": 0.2, "height": 0.3, "top": 2.8}]
    tested(ac, info, b)
    j = B.Builder(ac, info).build(b)
    beam = next(r for r in j["elements"] if r["key"] == "THR-1")
    ok(m.elements[beam["guid"]]["floorIndex"] == 1, "a beam hung from the ceiling lands on the story above (as in Archicad)")
    ok(beam["status"] == "ok", "the beam's story is not checked, its geometry is")
    j = B.Builder(ac, info).build(b, placement={"story": 1}, mode="append")
    desk = next(r for r in j["elements"] if r["key"] == "DESK-01-TOP")
    ok(abs(m.elements[desk["guid"]]["bbox"]["zMax"] - (2.8 + 0.74)) < 1e-6 and j["status"] == "built", "story 1: morph z is level + height")
    wall = next(r for r in j["elements"] if r["type"] == "Wall")
    ok(abs(m.elements[wall["guid"]]["bbox"]["zMin"] - 2.8) < 1e-6, "story 1: wall z relative to the story")
    ok(raises(lambda: B.Builder(ac, info).build(b, placement={"story": 7}), "does not exist"), "a story that does not exist is refused")

print("Crashed run")
fresh_home()
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    tested(ac, info, builds["open-plan-two-6-desk-benches"])
    B.BATCH = 20
    m.calls.clear()
    m.fail = ("CreateMorphs", 2)          # the connection drops on the 3rd morph batch
    try:
        B.Builder(ac, info).build(builds["open-plan-two-6-desk-benches"], mode="append")
        crashed = False
    except B.OfficeError:
        crashed = True
    m.fail = None
    ok(crashed, "a dropped connection stops the build with an error")
    runs = [j for j in B.all_journals() if j.get("kind") == "build"]
    j = runs[-1]
    ok(j["status"] == "failed", "the crashed run is journalled as failed")
    created = [r["guid"] for r in j["elements"] if r.get("guid")]
    ok(len(created) > 40 and all(g in m.elements for g in created), f"journal holds the GUIDs created before the crash ({len(created)})")
    rem = B.remove_run(ac, j["run"], j["project"]["token"], j["project"]["path"])
    ok(rem["deleted"] == len(created) and not rem["kept"], f"leftovers of the crashed run removed ({rem['deleted']}/{len(created)}, kept {rem['kept'][:2]})")
    ok(not [g for g in created if g in m.elements], "nothing of the crashed run remains")
    B.BATCH = 200

print("Every preset")
fresh_home()
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    tested(ac, info, builds["team-room-8-desks"])
    for k, b in sorted(builds.items()):
        j = B.Builder(ac, info).build(b, mode="append")
        ok(j["status"] == "built", f"{k}: {B.report_text(j)[:400]}")
    no_violations(m, "every preset")

print("Tier M floor")
fresh_home()
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    fl = builds["floor-36-x-18-m-central-core"]
    tested(ac, info, fl)
    j = B.Builder(ac, info).build(fl, build_walls=False, mode="append")
    ok(j["status"] == "built", f"floor without site walls verifies: {B.report_text(j)[:300]}")
    keys = {r["key"] for r in j["elements"]}
    ok(any(k.startswith("ROOM-") and "-P" in k for k in keys), "room partitions built without site walls")
    ok(any(k.endswith("-THR") for k in keys), "room thresholds (beams) built")
    ok(not any(k.startswith("WALL-E") for k in keys), "outline walls left out when site walls are off")
    ok(not any(k.startswith("COL-") or k == "CORE" for k in keys), "columns and core left out when site walls are off")
    ok(sum(1 for r in j["elements"] if r["type"] == "Zone") >= 10, "room and neighbourhood zones built")

print("Zone hand-over")
with Mock(MA.MockArchicad(19723)) as m:
    ac, info = B.connect()
    ok(raises(lambda: B.zone_site(ac), "Select one Zone"), "no selection: asks for a Zone")
    a = math.radians(30)
    W, D, ox, oy = 7.8, 6.6, 10.0, 5.0
    pts = [(0, 0), (W, 0), (W, D), (0, D)]
    poly = [(ox + math.cos(a) * x - math.sin(a) * y, oy + math.sin(a) * x + math.cos(a) * y) for x, y in pts]
    m.selection = [m.add_zone(poly, "Team room", floor=1)]
    z = B.zone_site(ac)
    ok(abs(z["width"] - W) < 1e-6 and abs(z["depth"] - D) < 1e-6 and abs(z["rotationDeg"] - 30) < 1e-6 and z["story"] == 1, f"rectangular zone read: {z}")
    ok(abs(z["origin"][0] - ox) < 1e-6 and abs(z["origin"][1] - oy) < 1e-6 and z["name"] == "Team room", "zone origin and name")
    m.selection = [m.add_zone([(0, 0), (5, 0), (5, 3), (2, 5), (0, 3)], "L-shape")]
    ok(raises(lambda: B.zone_site(ac), "rectangular"), "non-rectangular zone refused (tier S)")

print("Downloads")
d = os.path.join(HOME, "Downloads")
os.makedirs(d)
for i, name in enumerate(("a.office-build.json", "b.office-build.json", "notes.json")):
    p = os.path.join(d, name)
    open(p, "w").write("{}")
    os.utime(p, (1000 + i, 1000 + i))
ok(os.path.basename(B.find_newest_build_file(d) or "") == "b.office-build.json", "newest build file in Downloads is picked")

print("CLI")
ok(B.parse_args(["--host", "127.0.0.1", "--token", "SECRET", "--port", "19723"]).port == 19723, "palette's --host/--token accepted")
with Mock(MA.MockArchicad(19723)):
    r = subprocess.run([sys.executable, os.path.join(ROOT, "archicad", "build_office.py"), "--status", "--token", "SECRET"], capture_output=True, text=True, env=os.environ)
    ok(r.returncode == 0 and "Office Test" in r.stdout and "SECRET" not in r.stdout + r.stderr, f"--status works and never prints the token: {r.stdout} {r.stderr}")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "archicad", "build_office.py"), "--builds"], capture_output=True, text=True, env=os.environ)
    ok(r.returncode == 0 and "build" in r.stdout, "--builds lists the journal")

shutil.rmtree(HOME, ignore_errors=True)
print(f"\n{passes} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
