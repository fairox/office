# Reference drawings

Four reference images supplied by the user on 2026-10-31. They are not committed (third-party
drawings); this note records what was taken from each and what is deferred.

## 1. Dimensions.com: Private Office Clearances

| Clearance | Sheet | Used here |
|---|---|---|
| Desk back clearance (desk edge to behind the chair) | 1070–1520 mm (42–60") | `chairZone` 1100 mm, all desks incl. benches; check.js enforces 1070–1520 |
| Table zone (table edge to outside of chairs) | 560–760 mm (22–30") | `tableRing` 760 mm; check.js enforces 560–760 and keeps chairs inside it |
| Desk side clearance | 610–1220 mm (24–48") | covered by the 900 mm route check for now; not a separate rule yet |
| Overall guest zone (guest chairs in front of a desk) | 1120–1520 mm (44–60") | not yet: needs a "private office desk with guest chairs" item |
| Guest front / guest back | 250–360 / 510–760 mm | not yet (same item) |
| Sofa zone | 410–910 mm (16–36") | not yet: lounge item |
| Bookcase / storage depth | 250–300 / 460–610 mm | not yet: wall storage item |
| Round table | 4 seats (42" ≈ 1070 mm) | round tables: 4 seats 1070, 6 seats 1220, 8 seats 1520 mm |

## 2. Ground floor plan (grid A–D x 1–5, scale 1:75)

Column grid (3500 / 3000 / 3500 mm), stair and toilet core, a curved wall, rooms (manager, server,
archive, lobby, foyer, pantry) and 120° pinwheel workstation clusters around the "r. staff" area.
This is **M/L tier** material: columns, a core, rooms along a spine, non-rectangular clusters.
Kept as the reference for phases 3 and 4.

## 3. Illustrated open-plan studio

Two free-standing 2 x 3 back-to-back benches with a central aisle, a glazed meeting room with a
10-seat table, a lounge (sofa, armchairs, coffee tables), a kitchen run with a high table, planters
and a double entrance door.

- Adopted: **back-to-back benches** (desk arrangement "Back-to-back benches" / "Walls, then benches"),
  parallel rows drawn towards the main window wall; preset **open12** approximates the room
  (9.6 x 12.0 m, double door mid south wall, glazing north and south, 12 desks, 10-seat table).
- Deferred: the glazed meeting room (a room with partitions, M tier), lounge, kitchen, planters.

## 4. Executive Office Suite (6.90 x 11.35 m, 78.84 m²)

One 2 x 3 bench by the west glazing, a round 8-seat table, a sofa with a side table, planters,
low storage along the south wall.

- Adopted: preset **exec6** (6900 x 11350, west glazing, east door, 6-desk bench, round 8-seat table).
- Deferred: sofa, storage run, planters.
