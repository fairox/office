#!/usr/bin/env python3
"""A mock Archicad + Tapir on 127.0.0.1 for testing the Archicad side without Archicad.

    python3 tools/mock_archicad.py [--port 19723] [--tapir 1.7.0] [--project NAME]

It answers the official JSON API (API.IsAlive, GetProductInfo, IsAddOnCommandAvailable,
ExecuteAddOnCommand, GetAllClassificationSystems, GetPropertyIds, SetPropertyValuesOfElements)
and the Tapir commands the builder uses. Every Tapir request is checked against the vendored
schemas of its Tapir version (tools/tapir/<version>.json); violations are kept in `schema_violations`.

Behaves like the real Archicad where that was measured (Archicad 29 / Tapir 1.7.0):
- morph xAxis/yAxis/zAxis act as ROWS of the placement matrix (axes="rows"), so a rotation sent
  as columns comes out turned the opposite way;
- morph basePoint.z is absolute; wall zCoordinate is relative to the story when floorIndex is given;
- a beam without floorIndex goes to the story its z falls on, so one hung from the ceiling lands
  on the story above;
- SetDetailsOfElements ignores details.id before Tapir 1.7.3 (as in the 1.7.0 source);
- GetDetailsOfElements answers a missing element with an {error} item (the 1.7.0 source does this
  although the schema does not list it); Get3DBoundingBoxes likewise;
- new elements get an automatic Element ID ("MO-001"), not an empty one;
- deleting a wall deletes the doors and windows in it; elements on locked layers are not deleted.
"""
import argparse
import http.server
import json
import math
import os
import sys
import threading
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jsonschema_lite  # noqa: E402

SCHEMA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tapir")


def schema_file(tapir):
    """The vendored definitions of the newest version not newer than `tapir`."""
    v = tuple(int(x) for x in tapir.split("."))
    have = sorted(tuple(int(x) for x in f[:-5].split(".")) for f in os.listdir(SCHEMA_DIR) if f[0].isdigit() and f.endswith(".json"))
    pick = [h for h in have if h <= v] or have[:1]
    return os.path.join(SCHEMA_DIR, ".".join(map(str, pick[-1])) + ".json")
ELEMENT_ID_PROPERTY = "9f6c9b1e-1d2c-4c39-8d1a-0e1d2c3b4a51"
ZONE_HEIGHT = 2.6


def gid():
    return str(uuid.uuid4()).upper()


def err(code, message):
    return {"error": {"code": code, "message": message}}


def ok_result():
    return {"success": True}


def fail_result(message, code=-1):
    return {"success": False, "error": {"code": code, "message": message}}


def bbox_of(points3):
    xs, ys, zs = zip(*points3)
    return {"xMin": min(xs), "yMin": min(ys), "zMin": min(zs), "xMax": max(xs), "yMax": max(ys), "zMax": max(zs)}


class MockArchicad:
    def __init__(self, port=19723, tapir="1.7.0", project="Office Test", path="/projects/office-test.pln",
                 stories=((0, 0.0, "Ground Floor"), (1, 3.0, "1st Floor"), (2, 6.0, "2nd Floor")), axes="rows", archicad=(29, 3100)):
        self.port = port
        self.tapir_version = tapir
        self.project = {"isUntitled": path is None, "isTeamwork": False}
        if path:
            self.project.update({"projectName": project, "projectPath": path, "projectLocation": path})
        self.stories = [{"index": i, "floorId": i + 1, "dispOnSections": True, "level": lv, "name": n} for i, lv, n in stories]
        self.axes = axes
        self.archicad = archicad
        self.elements = {}
        self.order = []
        self.counters = {}
        self.attributes = {"Layer": [], "Surface": [], "ZoneCategory": [], "BuildingMaterial": []}
        self.add_attribute("Layer", "Archicad Layer")
        self.add_attribute("Surface", "Paint - White")
        self.add_attribute("ZoneCategory", "Area")
        self.locked_layers = set()
        self.classification_systems = []
        self.selection = []
        self.calls = []
        self.schema_violations = []
        self.fail = None          # (command, after_n_calls): drop the connection on that call
        self.reject_property_set = False
        with open(schema_file(tapir), encoding="utf-8") as f:
            s = json.load(f)
        self.schemas, self.defs = s["commands"], s["definitions"]
        self.server = None

    # ---------------------------------------------------------------- server
    def start(self):
        mock = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n).decode("utf-8"))
                try:
                    out = mock.handle(body)
                except ConnectionAbortedError:
                    self.close_connection = True
                    return
                data = json.dumps(out).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None

    # ---------------------------------------------------------------- helpers for tests
    def add_attribute(self, kind, name, **extra):
        lst = self.attributes[kind]
        a = {"attributeId": {"guid": gid()}, "index": max([x["index"] for x in lst] + [0]) + 1, "name": name, "modificationTime": 1761868800}
        a.update(extra)
        lst.append(a)
        return a

    def layer_index(self, name):
        return next(a["index"] for a in self.attributes["Layer"] if a["name"] == name)

    def lock_layer(self, name):
        self.locked_layers.add(self.layer_index(name))

    def move(self, guid, dx=0.0, dy=0.0, dz=0.0):
        e = self.elements[guid]
        b = e["bbox"]
        for k, d in (("x", dx), ("y", dy), ("z", dz)):
            b[k + "Min"] += d
            b[k + "Max"] += d

    def add_user_element(self, etype="Morph", layer=1, bbox=(0, 0, 0, 1, 1, 1), floor=0):
        g = gid()
        self.elements[g] = {"type": etype, "id": self.auto_id(etype), "floorIndex": floor, "layerIndex": layer,
                            "bbox": dict(zip(("xMin", "yMin", "zMin", "xMax", "yMax", "zMax"), bbox)), "details": {}}
        self.order.append(g)
        return g

    def add_zone(self, polygon, name="Room", floor=0):
        g = self.add_user_element("Zone", 1, (0, 0, 0, 1, 1, 1), floor)
        e = self.elements[g]
        e["bbox"] = bbox_of([(x, y, self.level(floor)) for x, y in polygon] + [(polygon[0][0], polygon[0][1], self.level(floor) + ZONE_HEIGHT)])
        e["details"] = {"name": name, "numberStr": "1", "categoryAttributeId": self.attributes["ZoneCategory"][0]["attributeId"],
                        "stampPosition": {"x": polygon[0][0], "y": polygon[0][1]}, "isManual": True,
                        "polygonOutline": [{"x": x, "y": y} for x, y in polygon], "zCoordinate": self.level(floor)}
        return g

    def of_run(self, run):
        return [g for g, e in self.elements.items() if e["id"].startswith(f"OF-{run}-")]

    # ---------------------------------------------------------------- dispatch
    def handle(self, body):
        cmd = body.get("command")
        params = body.get("parameters") or {}
        self.calls.append(cmd if cmd != "API.ExecuteAddOnCommand" else params.get("addOnCommandId", {}).get("commandName"))
        if self.fail and self.calls.count(self.fail[0]) > self.fail[1] and self.calls[-1] == self.fail[0]:
            raise ConnectionAbortedError()
        if cmd == "API.IsAlive":
            return {"succeeded": True, "result": {"isAlive": True}}
        if cmd == "API.GetProductInfo":
            return {"succeeded": True, "result": {"version": self.archicad[0], "buildNumber": self.archicad[1], "languageCode": "INT"}}
        if cmd == "API.IsAddOnCommandAvailable":
            cid = params.get("addOnCommandId", {})
            ok = cid.get("commandNamespace") == "TapirCommand" and hasattr(self, "t_" + cid.get("commandName", ""))
            return {"succeeded": True, "result": {"available": ok}}
        if cmd == "API.GetAllClassificationSystems":
            return {"succeeded": True, "result": {"classificationSystems": self.classification_systems}}
        if cmd == "API.GetPropertyIds":
            out = []
            for p in params.get("properties", []):
                if p.get("type") == "BuiltIn" and p.get("nonLocalizedName") == "General_ElementID":
                    out.append({"propertyId": {"guid": ELEMENT_ID_PROPERTY}})
                else:
                    out.append(err(-1, "Unknown property"))
            return {"succeeded": True, "result": {"properties": out}}
        if cmd == "API.SetPropertyValuesOfElements":
            res = []
            for v in params.get("elementPropertyValues", []):
                g = v.get("elementId", {}).get("guid")
                if self.reject_property_set:
                    res.append(fail_result("The property is not editable."))
                elif g not in self.elements:
                    res.append(fail_result("Element not found."))
                elif v.get("propertyId", {}).get("guid") != ELEMENT_ID_PROPERTY:
                    res.append(fail_result("Unknown property."))
                else:
                    self.elements[g]["id"] = str(v.get("propertyValue", {}).get("value", ""))
                    res.append(ok_result())
            return {"succeeded": True, "result": {"executionResults": res}}
        if cmd == "API.ExecuteAddOnCommand":
            cid = params.get("addOnCommandId", {})
            name = cid.get("commandName", "")
            fn = getattr(self, "t_" + name, None)
            if cid.get("commandNamespace") != "TapirCommand" or fn is None:
                return {"succeeded": False, "error": {"code": 4001, "message": f"Unknown add-on command {name}"}}
            p = params.get("addOnCommandParameters")
            sch = self.schemas.get(name)
            if sch and sch["inputScheme"] is not None:
                problems = jsonschema_lite.validate(p, sch["inputScheme"], self.defs)
                if problems:
                    self.schema_violations.append((name, "input", problems[:5]))
                    return {"succeeded": True, "result": {"addOnCommandResponse": err(-1, "Invalid parameters: " + "; ".join(problems[:3]))}}
            out = fn(p or {})
            if sch and name != "GetDetailsOfElements":
                problems = jsonschema_lite.validate(out, sch["outputScheme"], self.defs)
                if problems:
                    self.schema_violations.append((name, "output", problems[:5]))
            return {"succeeded": True, "result": {"addOnCommandResponse": out}}
        return {"succeeded": False, "error": {"code": 4000, "message": f"Unknown command {cmd}"}}

    # ---------------------------------------------------------------- geometry
    def level(self, floor):
        for s in self.stories:
            if s["index"] == floor:
                return s["level"]
        raise KeyError(floor)

    def floor_of_z(self, z):
        best = self.stories[0]["index"]
        for s in self.stories:
            if s["level"] <= z + 1e-9:
                best = s["index"]
        return best

    def auto_id(self, etype):
        prefix = {"Wall": "W", "Door": "D", "Window": "WI", "Beam": "B", "Zone": "Z", "Morph": "MO"}.get(etype, "E")
        self.counters[prefix] = self.counters.get(prefix, 0) + 1
        return f"{prefix}-{self.counters[prefix]:03d}"

    def new(self, etype, floor, bbox, **details):
        g = gid()
        self.elements[g] = {"type": etype, "id": self.auto_id(etype), "floorIndex": floor, "layerIndex": 1, "bbox": bbox, "details": details}
        self.order.append(g)
        return {"elementId": {"guid": g}}

    def morph_matrix(self, d):
        if "xAxis" not in d:
            return ((1, 0, 0), (0, 1, 0), (0, 0, 1))
        ax = [(d[k]["x"], d[k]["y"], d[k]["z"]) for k in ("xAxis", "yAxis", "zAxis")]
        if self.axes == "rows":
            return tuple(ax)                                   # world = M . local with M's rows = the axes
        if self.axes == "columns":
            return tuple(tuple(ax[c][r] for c in range(3)) for r in range(3))
        return ((1.2, 0, 0), (0, 0.8, 0), (0, 0, 1))           # "broken": neither convention

    # ---------------------------------------------------------------- Tapir commands
    def t_GetAddOnVersion(self, p):
        return {"version": self.tapir_version}

    def t_GetProjectInfo(self, p):
        return dict(self.project)

    def t_GetStories(self, p):
        return {"firstStory": self.stories[0]["index"], "lastStory": self.stories[-1]["index"], "actStory": 0,
                "skipNullFloor": False, "stories": self.stories}

    def t_GetSelectedElements(self, p):
        return {"elements": [{"elementId": {"guid": g}} for g in self.selection if g in self.elements]}

    def t_GetAttributesByType(self, p):
        return {"attributes": self.attributes.get(p["attributeType"], [])}

    def _create_attrs(self, kind, arr, p):
        out = []
        for d in p[arr]:
            if any(a["name"] == d["name"] for a in self.attributes[kind]) and not p.get("overwriteExisting"):
                out.append(err(-2130313112, f"{kind} '{d['name']}' already exists"))
                continue
            a = self.add_attribute(kind, d["name"])
            out.append({"attributeId": a["attributeId"]})
        return {"attributeIds": out}

    def t_CreateLayers(self, p):
        return self._create_attrs("Layer", "layerDataArray", p)

    def t_CreateSurfaces(self, p):
        return self._create_attrs("Surface", "surfaceDataArray", p)

    def t_CreateZoneCategories(self, p):
        return self._create_attrs("ZoneCategory", "zoneCategoryDataArray", p)

    def t_CreateClassificationSystems(self, p):
        res = []
        for x in p["classificationSystemsWithItems"]:
            cs = dict(x["classificationSystem"])
            cs["classificationSystemId"] = {"guid": gid()}
            self.classification_systems.append(cs)
            res.append(ok_result())
        return {"executionResults": res}

    def t_CreateWalls(self, p):
        out = []
        for d in p["wallsData"]:
            floor = d.get("floorIndex", self.floor_of_z(d.get("zCoordinate", 0)))
            z0 = self.level(floor) + d.get("zCoordinate", 0) if "floorIndex" in d else d.get("zCoordinate", 0)
            if d.get("referenceLineLocation", "Center") != "Center":
                out.append(err(-1, "mock: only Center reference lines are modelled"))
                continue
            b, e, t = d["begCoordinate"], d["endCoordinate"], d["thickness"]
            L = math.hypot(e["x"] - b["x"], e["y"] - b["y"])
            nx, ny = -(e["y"] - b["y"]) / L * t / 2, (e["x"] - b["x"]) / L * t / 2
            pts = [(b["x"] + sx * nx, b["y"] + sx * ny, z) for sx in (1, -1) for z in (z0, z0 + d["height"])] + \
                  [(e["x"] + sx * nx, e["y"] + sx * ny, z) for sx in (1, -1) for z in (z0, z0 + d["height"])]
            out.append(self.new("Wall", floor, bbox_of(pts), beg=b, end=e, thickness=t, z0=z0, height=d["height"]))
        return {"elements": out}

    def _openings(self, p, arr, etype):
        out = []
        for d in p[arr]:
            w = self.elements.get(d["ownerWallId"]["guid"])
            if not w or w["type"] != "Wall":
                out.append(err(-2130313126, "The owner wall does not exist."))
                continue
            wd = w["details"]
            b, e = wd["beg"], wd["end"]
            L = math.hypot(e["x"] - b["x"], e["y"] - b["y"])
            ux, uy = (e["x"] - b["x"]) / L, (e["y"] - b["y"]) / L
            width, height = d.get("width", 0.9), d.get("height", 2.1)
            if d["centerOffset"] - width / 2 < -1e-9 or d["centerOffset"] + width / 2 > L + 1e-9:
                out.append(err(-2130313126, "The opening does not fit in the wall."))
                continue
            cx, cy = b["x"] + ux * d["centerOffset"], b["y"] + uy * d["centerOffset"]
            t = wd["thickness"]
            z0 = wd["z0"] + d.get("sillHeight", 0)
            pts = [(cx + sa * ux * width / 2 + sb * -uy * t / 2, cy + sa * uy * width / 2 + sb * ux * t / 2, z)
                   for sa in (1, -1) for sb in (1, -1) for z in (z0, z0 + height)]
            r = self.new(etype, w["floorIndex"], bbox_of(pts), owner=d["ownerWallId"]["guid"])
            out.append(r)
        return {"elements": out}

    def t_CreateDoors(self, p):
        return self._openings(p, "doorsData", "Door")

    def t_CreateWindows(self, p):
        return self._openings(p, "windowsData", "Window")

    def t_CreateBeams(self, p):
        out = []
        for d in p["beamsData"]:
            z = d["zCoordinate"]
            floor = d["floorIndex"] if "floorIndex" in d else self.floor_of_z(z)
            b, e, w, h = d["begCoordinate"], d["endCoordinate"], d.get("width", 0.2), d.get("height", 0.2)
            L = math.hypot(e["x"] - b["x"], e["y"] - b["y"])
            nx, ny = -(e["y"] - b["y"]) / L * w / 2, (e["x"] - b["x"]) / L * w / 2
            zt = z if d.get("anchorPoint", "Center").startswith("Top") else z + h / 2
            pts = [(q["x"] + sx * nx, q["y"] + sx * ny, zz) for q in (b, e) for sx in (1, -1) for zz in (zt - h, zt)]
            out.append(self.new("Beam", floor, bbox_of(pts)))
        return {"elements": out}

    def t_CreateZones(self, p):
        out = []
        for d in p["zonesData"]:
            floor = int(d.get("floorIndex", 0))
            g = d["geometry"]
            if "polygonCoordinates" not in g:
                out.append(err(-1, "mock: automatic zones are not modelled"))
                continue
            lv = self.level(floor)
            pts = [(c["x"], c["y"], lv) for c in g["polygonCoordinates"]] + [(g["polygonCoordinates"][0]["x"], g["polygonCoordinates"][0]["y"], lv + ZONE_HEIGHT)]
            out.append(self.new("Zone", floor, bbox_of(pts), name=d["name"], numberStr=d["numberStr"],
                                categoryAttributeId=d.get("categoryAttributeId", self.attributes["ZoneCategory"][0]["attributeId"]),
                                stampPosition=d.get("stampPosition", {"x": 0, "y": 0}), isManual=True,
                                polygonOutline=g["polygonCoordinates"], zCoordinate=lv))
        return {"elements": out}

    def t_CreateMorphs(self, p):
        out = []
        surfaces = {a["attributeId"]["guid"] for a in self.attributes["Surface"]}
        for d in p["morphsData"]:
            if ("size" in d) == ("body" in d):
                out.append(err(-1, "Give exactly one of size and body."))
                continue
            if "surfaceId" in d and d["surfaceId"]["guid"] not in surfaces:
                out.append(err(-1, "The surface does not exist."))
                continue
            M = self.morph_matrix(d)
            bp = d["basePoint"]
            if "size" in d:
                s = d["size"]
                local = [(x, y, z) for x in (0, s["x"]) for y in (0, s["y"]) for z in (0, s["z"])]
            else:
                local = [(v["x"], v["y"], v["z"]) for v in d["body"]["vertices"]]
            pts = [(bp["x"] + sum(M[0][i] * v[i] for i in range(3)), bp["y"] + sum(M[1][i] * v[i] for i in range(3)),
                    bp["z"] + sum(M[2][i] * v[i] for i in range(3))) for v in local]
            floor = d.get("floorIndex", self.floor_of_z(bp["z"]))
            out.append(self.new("Morph", floor, bbox_of(pts)))
        return {"elements": out}

    def t_GetDetailsOfElements(self, p):
        fields = p.get("fields")
        out = []
        for item in p["elements"]:
            e = self.elements.get(item["elementId"]["guid"])
            if not e:
                out.append(err(-2130313112, "Failed to get the details of element"))
                continue
            d = {"type": e["type"], "id": e["id"], "floorIndex": e["floorIndex"], "layerIndex": e["layerIndex"], "drawIndex": 1, "details": e["details"]}
            out.append({k: v for k, v in d.items() if not fields or k in fields})
        return {"detailsOfElements": out}

    def t_SetDetailsOfElements(self, p):
        res = []
        layers = {a["index"] for a in self.attributes["Layer"]}
        for item in p["elementsWithDetails"]:
            e = self.elements.get(item["elementId"]["guid"])
            if not e:
                res.append(fail_result("Element not found."))
                continue
            d = item["details"]
            if "layerIndex" in d:
                if d["layerIndex"] not in layers:
                    res.append(fail_result("Layer does not exist."))
                    continue
                e["layerIndex"] = d["layerIndex"]
            if "floorIndex" in d:
                e["floorIndex"] = int(d["floorIndex"])
            if "id" in d and tuple(int(x) for x in self.tapir_version.split(".")) >= (1, 7, 3):
                e["id"] = d["id"]     # before 1.7.3 the add-on never reads details.id
            res.append(ok_result())
        return {"executionResults": res}

    def t_Get3DBoundingBoxes(self, p):
        out = []
        for item in p["elements"]:
            e = self.elements.get(item["elementId"]["guid"])
            out.append({"boundingBox3D": dict(e["bbox"])} if e else err(-2130313112, "Element not found"))
        return {"boundingBoxes3D": out}

    def t_DeleteElements(self, p):
        res = []
        for item in p["elements"]:
            g = item["elementId"]["guid"]
            e = self.elements.get(g)
            if not e:
                res.append(fail_result("Element not found.", -2130313112))
                continue
            if e["layerIndex"] in self.locked_layers:
                res.append(fail_result("The element is on a locked layer.", -2130313103))
                continue
            del self.elements[g]
            if e["type"] == "Wall":
                for h in [h for h, x in self.elements.items() if x["details"].get("owner") == g]:
                    del self.elements[h]
            res.append(ok_result())
        return {"executionResults": res}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=19723)
    ap.add_argument("--tapir", default="1.7.0")
    ap.add_argument("--project", default="Office Test")
    ap.add_argument("--axes", default="rows", choices=("rows", "columns", "broken"))
    a = ap.parse_args()
    m = MockArchicad(a.port, a.tapir, a.project, axes=a.axes).start()
    print(f"Mock Archicad (Tapir {a.tapir}, axes as {a.axes}) on http://127.0.0.1:{a.port}/  Ctrl+C to stop.", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        m.stop()


if __name__ == "__main__":
    main()
