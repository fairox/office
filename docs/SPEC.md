# Spec (as received)

> Sections 1–9 were not included in the message this was pasted from; it starts
> partway through section 9. Paste the missing sections here when available.

…

- **Test placement:** one sample per kind, preferring rotated ones, plus one wall. Verify and delete.
- **Console encoding:** `stream.reconfigure(errors="replace")` on stdout/stderr. Windows consoles crash on characters like "—", "×" and "→".

---

## 10. Testing (this is what made the kitchen reliable)

1. **`tools/check.js`** runs the generator over every preset × tier × strategy, plus stress cases. It checks:
   - finite geometry; nothing outside the floor plate;
   - no overlaps between desks / rooms / partitions / columns;
   - nothing in a door swing, threshold or core clearance; nothing tall across a window band;
   - programme met or reported;
   - fixed site unchanged across every strategy; pinned rooms exactly where asked (or reported as moved);
   - the "really ended up" readouts match the geometry.

   Add a regression case for every bug you fix.
2. **Browser checks with Playwright** (Chromium is preinstalled; use `--use-gl=swiftshader`): no page errors; screenshot every preset (Split / 3D / Plan); drive the panels like a user (type exact mm, switch reference corners, add/remove openings, fix/release the site, reload and confirm restore).
3. **A mock Archicad** (`http.server` on 19723/19724) implementing:
   - `API.IsAlive`, `GetProductInfo`, `IsAddOnCommandAvailable`, `ExecuteAddOnCommand`;
   - an element store with type / story / layer / ID / surface / bounding box;
   - classification systems, surfaces, selection and zones, `DeleteElements` results.

   Make it **behave like the real Archicad**, including the rows-convention for morph axes, and replay real failures against it before fixing them. Test the safety flow:
   - the first Replace falls back to Append;
   - the second Replace deletes exactly the previous run;
   - a "user-edited" element is kept;
   - remove-run works;
   - two instances means a refusal to guess;
   - rotated builds verify;
   - leftovers from a faulty run can be removed.
4. **The window under Xvfb** (`xvfb-run`, a Python with tkinter, `import -window root` for screenshots): load a downloaded build file, build, replace, From selected Zone, Test placement.
5. **Never claim the real Archicad works** until the user has run Test placement on their machine. Say what was verified against the mock and what wasn't.

---

## 11. Packaging and launchers

- `Start Office Configurator.bat` (Windows, CRLF, tries `py -3` then `python`), `.command` (macOS, exec bit), `start.sh` (Linux). Each finds Python 3.8+, starts `serve.py --open`, and explains how to install Python if it is missing (including the Microsoft Store alias trap).
- `Build in Archicad.bat` / `.command` open `OfficeBuild.py` (`pyw` on Windows so no console stays open).
- `START-HERE.txt`: install, start, build in Archicad, troubleshooting.
- `tools/package.py` writes `dist/office-configurator-<date>-<commit>.zip` from the tracked files: CRLF for `.bat`, exec bits for launchers and scripts, and a refusal if the Tapir bundle is stale.
- `.gitattributes` for line endings. `.gitignore`: `dist/`, journals, logs, `__pycache__`.

---

## 12. Phases and acceptance

| Phase | Scope | Done when |
|---|---|---|
| 1 | S tier: rectangular room, fixed site, openings editor, desks along walls + meeting table + booth, 3D + plan + checks, URL/localStorage state | check.js green across presets; Playwright flow with no errors; plan dimension chains correct |
| 2 | Build file + `OfficeBuild.py` window + mock Archicad: walls, doors, windows, zones, morphs, layers, surfaces, element IDs, journal, verify, Replace/Remove | the mock flow passes every safety case; Xvfb window screenshots; the user's first real Test placement passes |
| 3 | M tier: rectilinear polygons, columns, one core, room spine packer, neighbourhoods, aisles graph, travel distance, pinned rooms | stress cases (columns in aisles, door in the spine, corner windows) produce no errors and honest reports |
| 4 | L tier: multiple cores, zoning, instanced rendering (≥ 5000 elements at 60 fps on a laptop), batch building (200 per call, journal per batch), import of zone polygons from Archicad | a 600-person floor generates in < 1 s, renders smoothly, builds and verifies against the mock |
| 5 | Optional: library Objects instead of morphs (user picks the library part per kind), multiple floors, IFC-friendly classification | per-kind object mapping, verified by read-back |

At the end of every phase:
- **Commit and push.**
- **Rebuild the package**, and send the zip and screenshots.
- **Say plainly** what was tested against the real Archicad and what only against the mock.

---

## 13. Working style

- **Ask only** when a decision is genuinely the user's (e.g. which desk standard or which jurisdiction's egress rules). Otherwise choose a sensible default and say so.
- **Treat a user's screenshot of a failure as data.** Find the pattern in the numbers. "Off by 600 / 597 mm, only on the side runs" pointed straight at the axis convention.
- **Reproduce the failure in the mock before fixing it**, then add the regression test.
- **Never drop an element silently.** Every shed, move, clamp or refusal produces a check message with the measured amount.
- **Keep the site sacred:** nothing the user fixed may change as a side effect.
