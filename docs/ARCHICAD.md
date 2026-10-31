# The Archicad side

`archicad/build_office.py` (library + CLI) and `archicad/office_gui.py` (window) are bundled into
`archicad/OfficeBuild.py` by `tools/bundle_tapir_script.py`. Never edit the bundle by hand;
`tools/package.py` refuses to package a stale one.

## What has been verified, and against what

**Nothing here has run against a real Archicad yet.** Everything below was checked against
`tools/mock_archicad.py`, which follows the Tapir 1.7.0 / 1.7.3 command definitions (vendored in
`tools/tapir/`, validated on every request) and the behaviour measured on Archicad 29 / Tapir 1.7.0
(spec section 8). The first real check is the user's **Test placement**.

| Area | Mock | Real Archicad |
|---|---|---|
| Build file validation (whitelist, ranges, layers, keys, size) | `tools/archicad_check.py` | n/a (no Archicad involved) |
| Discovery, picker, refusal with two Archicads | yes | not yet |
| Writing gate (unknown Tapir: status only; untested: Test placement first) | yes | not yet |
| Walls, doors, windows, zones, morphs, beams on the right story / height | yes | not yet |
| Morph axis probe: rows, columns, neither (refuse) | yes | rows measured by the user on 1.7.0 |
| Replay of the first real failure (rotated morphs sent as columns) is caught by verification | yes | n/a |
| Layers, surfaces `OFFICE <material> #rrggbb`, zone categories | yes | not yet |
| Element IDs `OF-<run>-<key>` | yes, both paths | not yet |
| Journal per batch, crash leaves recoverable GUIDs, remove leftovers | yes | not yet |
| Replace: first falls back to Append, second deletes exactly the previous run, edited elements kept, locked layers kept, problems block Replace | yes | not yet |
| Remove run, other project refused | yes | not yet |
| Window: Downloads pick-up, Test placement, Build, Replace, From selected Zone, Open web app, Remove run (Xvfb) | `tools/gui_check.py` | not yet |

## Findings from Tapir's own source and definitions

- **Element ID.** `SetDetailsOfElements` reads `details.id` only from **Tapir 1.7.3** (the 1.7.0 source
  never reads it and the 1.7.0 schema has no `id`). So the builder sets IDs with `details.id` on
  1.7.3+, and on older Tapir through Archicad's own `API.SetPropertyValuesOfElements` on the built-in
  `General_ElementID` property. Verification reads every ID back, so a wrong path shows up as a problem.
- **Morph axes.** Tapir's definitions describe `xAxis/yAxis/zAxis` as the placement matrix's
  *columns*; the measured behaviour is *rows*. The builder never relies on either: square placements
  send plain extents, other angles run the 30° probe first.
- **Missing elements.** `GetDetailsOfElements` answers a deleted element with an `{error}` item (source),
  although its schema does not allow one. `Get3DBoundingBoxes` does the same (schema allows it).
- **Round table tops** are built as a 24-sided prism through `CreateMorphs.body`, with vertices
  relative to the base point and no axes, so they do not depend on the axis convention.

## Not yet verified on a real Archicad (look at these first)

- **Door swing and hinge side.** Sent as `oSide` (swing into the room) and `reflected` (hinge at the
  wall's end corner). The mapping is a reasoned guess; Test placement cannot see it. Check the first door.
- **Element ID through the property API on Tapir < 1.7.3** (`API.GetPropertyIds` + `SetPropertyValuesOfElements`).
- **`API.GetAllClassificationSystems`** for the project identity token (Archicad's own API, not Tapir).
- **Door/window bounding boxes**: only their centre along the wall is checked (5 mm), because frames make
  the rest of the box depend on the library part.
- **Zone height**: zones are checked in plan only.

## Files and commands

```
Documents/Office Configurator/journal/<run>.json   every run, saved after each batch
Documents/Office Configurator/tested.json          Tapir versions with a passed Test placement
Documents/Office Configurator/app.json             where serve.py runs (for "Open web app")
```

```bash
python3 archicad/build_office.py --list
```

```bash
python3 archicad/build_office.py --test team-room.office-build.json --port 19723
```

```bash
python3 archicad/build_office.py --build team-room.office-build.json --port 19723
```

```bash
python3 archicad/build_office.py --remove 261031-061500 --port 19723
```
