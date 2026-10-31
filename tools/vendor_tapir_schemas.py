#!/usr/bin/env python3
"""Copy the Tapir command definitions this project uses out of a Tapir checkout.

    python3 tools/vendor_tapir_schemas.py <tapir-checkout> <tag>

Writes tools/tapir/<tag>.json: the used commands' input/output schemas plus every common
definition they reference (transitively). The mock Archicad validates requests and
responses against it. Tapir is MIT licensed (tools/tapir/LICENSE-tapir.txt).
"""
import json
import os
import subprocess
import sys

USED = [
    "GetAddOnVersion", "GetProjectInfo", "GetStories", "GetSelectedElements",
    "CreateWalls", "CreateDoors", "CreateWindows", "CreateBeams", "CreateZones", "CreateMorphs",
    "CreateLayers", "CreateSurfaces", "CreateZoneCategories", "CreateClassificationSystems",
    "GetAttributesByType", "GetDetailsOfElements", "SetDetailsOfElements", "Get3DBoundingBoxes", "DeleteElements",
]


def load(repo, tag, path):
    text = subprocess.check_output(["git", "-C", repo, "show", f"{tag}:{path}"]).decode("utf-8")
    return json.loads(text[text.index("=") + 1:].strip().rstrip(";"))


def refs(node, out):
    if isinstance(node, dict):
        if "$ref" in node:
            out.add(node["$ref"].split("/")[-1])
        for v in node.values():
            refs(v, out)
    elif isinstance(node, list):
        for v in node:
            refs(v, out)
    return out


def main():
    repo, tag = sys.argv[1], sys.argv[2]
    commands = {c["name"]: c for g in load(repo, tag, "docs/archicad-addon/command_definitions.js") for c in g["commands"]}
    common = load(repo, tag, "docs/archicad-addon/common_schema_definitions.js")
    used = {n: {k: commands[n][k] for k in ("version", "inputScheme", "outputScheme")} for n in USED}
    need, done = refs(used, set()), set()
    while need - done:
        name = sorted(need - done)[0]
        done.add(name)
        refs(common[name], need)
    out = {"tapirVersion": tag, "commands": used, "definitions": {k: common[k] for k in sorted(done)}}
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tapir", f"{tag}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"Wrote {path}: {len(used)} commands, {len(done)} definitions")


if __name__ == "__main__":
    main()
