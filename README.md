# Office Configurator

Browser configurator for office rooms, with a dimensioned plan, a 3D view and
honest checks. Archicad building is planned as a later phase. Users should read
[START-HERE.txt](START-HERE.txt); this file is for development.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | S tier: rectangular room, fixed site, openings editor, desks along walls + meeting table + booths, 3D + plan + checks, URL/localStorage state | **done** |
| 2 | Build file, `OfficeBuild.py` window, mock Archicad, Replace/Remove | not started |
| 3 | M tier: polygons, columns, core, room spine, aisles, pinned rooms | not started |
| 4 | L tier: multiple cores, instancing, batch building | not started |
| 5 | Library objects, multiple floors, IFC classification | not started |

The spec sections we have are in [docs/SPEC.md](docs/SPEC.md). Sections 1–9 are missing.
Reference drawings and what was taken from them: [docs/REFERENCES.md](docs/REFERENCES.md).

## Layout

```
serve.py                 static server for web/ (Python 3.8+, no dependencies)
web/generator.js         pure layout generator (no DOM); runs in the browser and in Node
web/presets.js           starting rooms + programmes
web/app.js               panels, state, persistence (URL hash + localStorage)
web/plan.js              SVG plan with dimension chains and clearance overlay
web/view3d.js            three.js view (vendored r170 in web/vendor/)
tools/check.js           geometry checker: presets x tiers x strategies + stress + regressions
tools/browser_check.js   Playwright: drives the UI, screenshots every preset/view
tools/package.py         dist/office-configurator-<date>-<commit>.zip from HEAD
```

## Checks

```bash
node tools/check.js
```

```bash
node tools/browser_check.js
```

```bash
python3 tools/package.py
```

`check.js` re-derives door swings, thresholds, window bands and opening positions
from the raw input instead of reusing the generator's helpers. Add a regression
case at the bottom of it for every bug you fix.

## Conventions

- Millimetres throughout. Origin is the interior SW corner; x east, y north.
- Walls run counter-clockwise S → E → N → W. In a wall frame, `s` is along the wall
  from its start corner (S: SW, E: SE, N: NE, W: NW) and `n` is into the room.
- An opening's `offset` is measured from its `ref` corner to its near edge.
- The generator never mutates its input. Every clamp, clip, shortfall or removal adds a
  check message with the measured amount.

## Defaults chosen (change if your standard differs)

These are in `STANDARDS` in `web/generator.js`. Clearances follow the Dimensions.com
"Private Office Clearances" sheet where it gives a figure; see [docs/REFERENCES.md](docs/REFERENCES.md).

| | |
|---|---|
| Desk | 1600 × 800 mm, 740 mm high, 1100 mm chair zone behind (sheet: desk back clearance 1070–1520) |
| Bench | free-standing, back to back, up to 3 desks a side, 1100 mm chair zone on each side |
| Phone booth | 1100 × 1100 mm, 2200 mm high, 900 mm clear in front |
| Meeting table | rectangular: 700 mm per seat a side, 1000 mm deep (800 for ≤ 2 seats); round: 1070 / 1220 / 1520 mm for 4 / 6 / 8 seats; 760 mm table zone (sheet: 560–760) |
| Door clearance | swing (leaf width, inward doors) + threshold 1500 mm deep, 300 mm beyond each jamb |
| Window band | nothing taller than the sill within 1000 mm of the window |
| Route | 900 mm clear passage from a door to every chair zone, booth front and the table zone |

Desk arrangement: **Along the walls**, **Back-to-back benches**, or **Walls, then benches**.
Benches run at right angles to the main window wall and gather towards it (Compact: along the
room, in the middle); a look-ahead picks positions that leave room for the remaining desks.

Strategies: **Daylight first** (booths, desks, table), **Meeting first** (table, booths, desks)
and **Compact** (desks, booths, table). Each tries its own order first, then other orders,
and keeps another order only if it places strictly more on that strategy's priorities.
