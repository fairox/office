// Office Configurator — tier M generator: a rectilinear floor plate with columns and one core.
// Pure functions, no DOM. Units mm; the outline runs counter-clockwise so the floor is on each
// edge's left. Pipeline: site -> pinned rooms -> spine + connector aisles -> rooms packed along
// the spine -> furniture in rooms -> open-plan benches in neighbourhoods -> reachability -> travel.
import { STANDARDS, STRATEGIES, overlaps, tableSize } from './generator.js';

export const M_STANDARDS = Object.freeze({
  spine: 1800,            // primary aisle clear width
  connector: 1200,        // aisle from an entry or core door to the spine
  partition: 100,         // room partition thickness (inside the room's rectangle)
  roomDoor: 900,
  roomDoorFrom: 300,      // door's distance from the room's corner along its front
  coreDoor: 1200,
  coreClear: 1500,        // keep-out in front of a core door
  column: 400,
  travelLimit: 45000,     // default limit to the nearest exit; jurisdiction dependent (see README)
  grid: 100,
});

export const ROOM_TYPES = Object.freeze({
  meetingS: { label: 'Meeting room (4)', w: 3600, d: 3000, seats: 4, category: 'meeting' },
  meetingL: { label: 'Meeting room (8)', w: 5400, d: 3600, seats: 8, category: 'meeting' },
  focus: { label: 'Focus room', w: 3000, d: 2400, seats: 1, category: 'focus' },
  support: { label: 'Print / storage', w: 2400, d: 2400, seats: 0, category: 'support' },
});

const EPS = 0.5;
const SIDES = ['N', 'S', 'E', 'W'];
const mm = (v) => `${Math.round(v)} mm`;
const m1 = (v) => `${(v / 1000).toFixed(1)} m`;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const R = (x0, y0, x1, y1) => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
const expand = (r, m) => ({ x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m });
const centre = (r) => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);

function overlapSize(a, b) {
  return [Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)];
}

// ---------- polygon ----------

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    // on the boundary counts as inside
    if (Math.min(xi, xj) - EPS <= x && x <= Math.max(xi, xj) + EPS && Math.min(yi, yj) - EPS <= y && y <= Math.max(yi, yj) + EPS &&
      Math.abs((xj - xi) * (y - yi) - (yj - yi) * (x - xi)) < EPS * Math.max(1, Math.hypot(xj - xi, yj - yi))) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A rectangle lies inside a rectilinear polygon when its corners do and no edge runs through its interior.
export function rectInPoly(r, poly) {
  for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]) if (!pointInPoly(x, y, poly)) return false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    if (Math.abs(ay - by) < EPS) {
      if (r.y0 + EPS < ay && ay < r.y1 - EPS && Math.min(r.x1, Math.max(ax, bx)) - Math.max(r.x0, Math.min(ax, bx)) > EPS) return false;
    } else if (r.x0 + EPS < ax && ax < r.x1 - EPS && Math.min(r.y1, Math.max(ay, by)) - Math.max(r.y0, Math.min(ay, by)) > EPS) return false;
  }
  return true;
}

function bboxOf(poly) {
  return { x0: Math.min(...poly.map((p) => p[0])), y0: Math.min(...poly.map((p) => p[1])), x1: Math.max(...poly.map((p) => p[0])), y1: Math.max(...poly.map((p) => p[1])) };
}

export function edgesOf(poly) {
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    return { id: `E${i + 1}`, index: i, a, b, L, dir, normal: [-dir[1], dir[0]] };
  });
}

export function edgePoint(e, s, n) {
  return [e.a[0] + e.dir[0] * s + e.normal[0] * n, e.a[1] + e.dir[1] * s + e.normal[1] * n];
}

export function edgeRect(e, s0, s1, n0, n1) {
  const p = edgePoint(e, s0, n0), q = edgePoint(e, s1, n1);
  return R(p[0], p[1], q[0], q[1]);
}

// ---------- site ----------

function resolveSite(src, report) {
  const s = src || {};
  let poly = (Array.isArray(s.outline) ? s.outline : []).map((p) => [Math.round(num(p && p[0], NaN)), Math.round(num(p && p[1], NaN))]);
  const bad = poly.length < 4 || poly.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]));
  let rectilinear = !bad;
  if (!bad) {
    // drop repeated and collinear points
    poly = poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]; return p[0] !== q[0] || p[1] !== q[1]; });
    poly = poly.filter((p, i) => {
      const a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) !== 0;
    });
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (a[0] !== b[0] && a[1] !== b[1]) rectilinear = false;
    }
    if (poly.length < 4) rectilinear = false;
  }
  if (bad || !rectilinear) {
    const b = bad ? { x0: 0, y0: 0, x1: 20000, y1: 12000 } : bboxOf(poly);
    report('error', 'site.outline', bad ? 'The outline needs at least 4 numeric corners; using a 20 x 12 m rectangle.'
      : 'The outline is not rectilinear (every edge must run along x or y); using its bounding rectangle.');
    poly = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  }
  if (signedArea(poly) < 0) {
    poly = poly.reverse();
    report('info', 'site.outline', 'The outline ran clockwise; it was reversed to counter-clockwise (edge numbers follow the new order).');
  }
  // self-intersection: non-adjacent edges must not touch
  const E = edgesOf(poly);
  for (let i = 0; i < E.length; i++) for (let j = i + 2; j < E.length; j++) {
    if (i === 0 && j === E.length - 1) continue;
    const a = R(...E[i].a, ...E[i].b), b = R(...E[j].a, ...E[j].b);
    if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) report('error', 'site.outline', `Outline edges ${E[i].id} and ${E[j].id} cross or touch.`);
  }
  const site = {
    outline: poly, edges: E, bbox: bboxOf(poly),
    height: Math.round(Math.min(10000, Math.max(2200, num(s.height, 3000)))),
    wall: Math.round(Math.min(1000, Math.max(50, num(s.wall, 300)))),
  };
  site.area = Math.abs(signedArea(poly));

  // openings on edges
  site.openings = [];
  (Array.isArray(s.openings) ? s.openings : []).forEach((o, i) => {
    const kind = o.kind === 'window' ? 'window' : 'door';
    const id = String(o.id || `${kind === 'door' ? 'DOOR' : 'WIN'}-${i + 1}`);
    const e = E[Number(o.edge)];
    if (!e) { report('error', 'opening.edge', `${id}: edge ${o.edge} does not exist (the outline has ${E.length}); not built.`, { ref: id }); return; }
    const width = Math.max(300, num(o.width, 1000)), offset = num(o.offset, 0);
    let s0 = o.ref === 'end' ? e.L - offset - width : offset, s1 = s0 + width;
    if (s0 < 0 || s1 > e.L) {
      const cut = Math.max(0, -s0) + Math.max(0, s1 - e.L);
      s0 = Math.max(0, s0); s1 = Math.min(e.L, s1);
      if (s1 - s0 < 300) { report('error', 'opening.outside', `${id}: lies outside edge ${e.id}; not built.`, { ref: id, amount: Math.round(cut) }); return; }
      report('error', 'opening.clipped', `${id}: runs past the end of ${e.id} by ${mm(cut)}; clipped.`, { ref: id, amount: Math.round(cut) });
    }
    const sill = kind === 'door' ? 0 : Math.max(0, num(o.sill, 900));
    const height = Math.min(site.height - sill, Math.max(100, num(o.height, kind === 'door' ? 2100 : 1500)));
    site.openings.push({ id, kind, edge: e.index, ref: o.ref === 'end' ? 'end' : 'start', offset, width: s1 - s0, height, sill,
      hinge: o.hinge === 'end' ? 'end' : 'start', swing: o.swing === 'out' ? 'out' : 'in', s0: Math.round(s0), s1: Math.round(s1),
      rect: edgeRect(e, s0, s1, -site.wall, 0) });
  });
  for (const e of E) {
    const on = site.openings.filter((o) => o.edge === e.index).sort((a, b) => a.s0 - b.s0);
    for (let i = 1; i < on.length; i++) if (on[i].s0 < on[i - 1].s1 - EPS) report('error', 'opening.overlap', `${on[i - 1].id} and ${on[i].id} overlap by ${mm(on[i - 1].s1 - on[i].s0)}.`, { amount: Math.round(on[i - 1].s1 - on[i].s0) });
  }

  // core
  site.core = null;
  if (s.core && Number.isFinite(Number(s.core.w)) && Number(s.core.w) > 0) {
    const c = s.core, r = R(num(c.x, 0), num(c.y, 0), num(c.x, 0) + num(c.w, 0), num(c.y, 0) + num(c.d, 0));
    if (!rectInPoly(r, poly)) report('error', 'core.outside', 'The core is not inside the floor plate; it is drawn but rooms and desks avoid it.');
    const side = SIDES.includes(c.door) ? c.door : 'S';
    const dw = M_STANDARDS.coreDoor, [cx, cy] = centre(r);
    const door = side === 'N' || side === 'S' ? R(cx - dw / 2, side === 'N' ? r.y1 : r.y0, cx + dw / 2, side === 'N' ? r.y1 : r.y0) : R(side === 'E' ? r.x1 : r.x0, cy - dw / 2, side === 'E' ? r.x1 : r.x0, cy + dw / 2);
    const k = M_STANDARDS.coreClear, half = dw / 2 + 300;
    const clear = side === 'N' ? R(cx - half, r.y1, cx + half, r.y1 + k) : side === 'S' ? R(cx - half, r.y0 - k, cx + half, r.y0)
      : side === 'E' ? R(r.x1, cy - half, r.x1 + k, cy + half) : R(r.x0 - k, cy - half, r.x0, cy + half);
    site.core = { id: 'CORE', rect: r, door: side, doorRect: door, clear };
  }

  // columns on a grid, inside the plate and clear of the core
  site.columns = [];
  const cg = s.columns || {};
  const spacingOk = num(cg.spacingX, 0) >= 1500 && num(cg.spacingY, 0) >= 1500;
  if (cg.enabled !== false && (cg.spacingX !== undefined || cg.spacingY !== undefined) && !spacingOk) {
    report('error', 'site.columns', `Column spacing ${cg.spacingX} x ${cg.spacingY} mm is below 1500 mm; no columns drawn.`);
  }
  if (cg.enabled !== false && spacingOk) {
    const size = Math.min(1200, Math.max(200, num(cg.size, M_STANDARDS.column))), h = size / 2;
    const sx = num(cg.spacingX, 8100), sy = num(cg.spacingY, 8100), ox = num(cg.offsetX, sx), oy = num(cg.offsetY, sy);
    let dropped = 0, ci = 0;
    for (let x = site.bbox.x0 + ox, i = 0; x < site.bbox.x1; x += sx, i++) {
      for (let y = site.bbox.y0 + oy, j = 0; y < site.bbox.y1; y += sy, j++) {
        const r = R(x - h, y - h, x + h, y + h);
        if (!rectInPoly(r, poly) || (site.core && overlaps(r, site.core.rect))) { dropped++; continue; }
        site.columns.push({ id: `COL-${String.fromCharCode(65 + (i % 26))}${j + 1}`, rect: r, n: ci++ });
      }
    }
    if (dropped) report('info', 'site.columns', `${dropped} grid position(s) fall in the outer walls, outside the plate or in the core; no column drawn there.`, { amount: dropped });
  }

  // clearance zones (as tier S, per edge)
  const S = STANDARDS;
  site.zones = [];
  for (const o of site.openings) {
    const e = E[o.edge];
    if (o.kind === 'door') {
      if (o.swing === 'in') site.zones.push({ kind: 'door-swing', ref: o.id, ...edgeRect(e, o.s0, o.s1, 0, o.s1 - o.s0) });
      site.zones.push({ kind: 'threshold', ref: o.id, ...edgeRect(e, Math.max(0, o.s0 - S.thresholdSide), Math.min(e.L, o.s1 + S.thresholdSide), 0, S.thresholdDepth) });
    } else {
      site.zones.push({ kind: 'window-band', ref: o.id, sill: o.sill, ...edgeRect(e, o.s0, o.s1, 0, S.windowBandDepth) });
    }
  }
  if (site.core) site.zones.push({ kind: 'core-clear', ref: 'CORE', ...site.core.clear });
  return site;
}

// ---------- obstacles and placement tests ----------

function fixedObstacles(site) {
  const out = site.columns.map((c) => ({ id: c.id, kind: 'column', rect: c.rect }));
  if (site.core) out.push({ id: 'CORE', kind: 'core', rect: site.core.rect });
  return out;
}

// Can `cand` (rect + access rects, height h) go here? Aisles are keep-out for everything but other aisles.
function fits(ctx, cand) {
  const poly = ctx.site.outline;
  for (const r of [cand.rect, ...cand.access]) if (!rectInPoly(r, poly)) return false;
  const mine = [cand.rect, ...cand.access];
  for (const o of ctx.fixed) for (const r of mine) if (overlaps(r, o.rect)) return false;
  for (const a of ctx.aisles) for (const r of mine) if (overlaps(r, a.rect)) return false;
  for (const it of ctx.items) {
    for (const r of mine) {
      if (overlaps(r, it.rect)) return false;
      for (const z of it.access) if (overlaps(r, z)) return false;
    }
  }
  for (const z of ctx.site.zones) {
    if (z.kind === 'window-band') { if (cand.h > z.sill && overlaps(cand.rect, z)) return false; } else for (const r of mine) if (overlaps(r, z)) return false;
  }
  return true;
}

// ---------- rooms ----------

// A room: outer rectangle, door on its `front` side, partitions inside the rectangle.
function roomGeometry(type, x, y, front) {
  const T = ROOM_TYPES[type], P = M_STANDARDS.partition, along = front === 'N' || front === 'S';
  const w = along ? T.w : T.d, d = along ? T.d : T.w;
  const rect = R(x, y, x + w, y + d);
  const df = M_STANDARDS.roomDoorFrom, dw = M_STANDARDS.roomDoor;
  // door span along the front, measured from the front's lower coordinate
  const door = along ? [rect.x0 + df, rect.x0 + df + dw] : [rect.y0 + df, rect.y0 + df + dw];
  const parts = [];
  const N = R(rect.x0, rect.y1 - P, rect.x1, rect.y1), Sx = R(rect.x0, rect.y0, rect.x1, rect.y0 + P);
  const Wx = R(rect.x0, rect.y0 + P, rect.x0 + P, rect.y1 - P), Ex = R(rect.x1 - P, rect.y0 + P, rect.x1, rect.y1 - P);
  const sides = { N, S: Sx, W: Wx, E: Ex };
  for (const s of SIDES) {
    const p = sides[s];
    if (s !== front) { parts.push(p); continue; }
    if (along) { parts.push(R(p.x0, p.y0, door[0], p.y1), R(door[1], p.y0, p.x1, p.y1)); } else { parts.push(R(p.x0, p.y0, p.x1, door[0]), R(p.x0, door[1], p.x1, p.y1)); }
  }
  const swing = front === 'N' ? R(door[0], rect.y1 - P - dw, door[1], rect.y1 - P) : front === 'S' ? R(door[0], rect.y0 + P, door[1], rect.y0 + P + dw)
    : front === 'E' ? R(rect.x1 - P - dw, door[0], rect.x1 - P, door[1]) : R(rect.x0 + P, door[0], rect.x0 + P + dw, door[1]);
  // the aisle side of the door must stay clear: a 1200 mm landing outside
  const outside = front === 'N' ? R(door[0], rect.y1, door[1], rect.y1 + 1200) : front === 'S' ? R(door[0], rect.y0 - 1200, door[1], rect.y0)
    : front === 'E' ? R(rect.x1, door[0], rect.x1 + 1200, door[1]) : R(rect.x0 - 1200, door[0], rect.x0, door[1]);
  return { type, label: T.label, category: T.category, seats: T.seats, front, rect, door, parts, swing, outside,
    interior: R(rect.x0 + P, rect.y0 + P, rect.x1 - P, rect.y1 - P) };
}

function roomFits(ctx, g, { allowAisleLanding = true } = {}) {
  if (!rectInPoly(g.rect, ctx.site.outline)) return false;
  for (const o of ctx.fixed) if (overlaps(g.rect, o.rect)) return false;
  for (const a of ctx.aisles) if (overlaps(g.rect, a.rect)) return false;
  for (const it of ctx.items) {
    if (overlaps(g.rect, it.rect)) return false;
    for (const z of it.access) if (overlaps(g.rect, z)) return false;
    if (it.kind === 'room' && overlaps(g.outside, it.rect)) return false;
  }
  for (const z of ctx.site.zones) if (overlaps(g.rect, z)) return false; // rooms are tall: no window bands either
  if (!allowAisleLanding && !rectInPoly(g.outside, ctx.site.outline)) return false;
  return rectInPoly(g.outside, ctx.site.outline);
}

function roomItem(g, id, pinned) {
  return { kind: 'room', id, rect: g.rect, access: [g.outside], h: 99999, g, pinned };
}

function placePinned(ctx, pins, report) {
  const out = [];
  pins.forEach((p, i) => {
    const id = String(p.id || `PIN-${i + 1}`);
    if (!ROOM_TYPES[p.type]) { report('error', 'pinned.type', `${id}: unknown room type "${p.type}"; not placed.`, { ref: id }); return; }
    const front = SIDES.includes(p.front) ? p.front : 'S';
    const x = Math.round(num(p.x, 0)), y = Math.round(num(p.y, 0));
    let g = roomGeometry(p.type, x, y, front);
    let moved = 0;
    if (!roomFits(ctx, g)) {
      // nearest position that fits, searching outward on the grid
      let best = null;
      for (let rad = 100; rad <= 8000 && !best; rad += 100) {
        for (let dx = -rad; dx <= rad && !best; dx += 100) {
          for (const dy of Math.abs(dx) === rad ? range(-rad, rad, 100) : [-rad, rad]) {
            const t = roomGeometry(p.type, x + dx, y + dy, front);
            if (roomFits(ctx, t)) { best = t; moved = Math.hypot(dx, dy); break; }
          }
        }
      }
      if (!best) { report('error', 'pinned.unplaced', `${id} (${ROOM_TYPES[p.type].label}) does not fit at ${x}, ${y} or within 8 m of it; not placed.`, { ref: id }); return; }
      g = best;
      report('warn', 'pinned.moved', `${id} (${g.label}) could not stay at ${x}, ${y}; moved by ${mm(moved)} to ${g.rect.x0}, ${g.rect.y0}.`, { ref: id, amount: Math.round(moved) });
    }
    const it = roomItem(g, id, { x, y, front, moved: Math.round(moved) });
    ctx.items.push(it);
    out.push(it);
  });
  return out;
}

function range(a, b, step) {
  const out = [];
  for (let v = a; v <= b; v += step) out.push(v);
  return out;
}

// ---------- spine and connectors ----------

function chooseSpine(ctx, report) {
  const site = ctx.site, bb = site.bbox, W = M_STANDARDS.spine, horiz = bb.x1 - bb.x0 >= bb.y1 - bb.y0;
  const lo = horiz ? bb.y0 : bb.x0, hi = horiz ? bb.y1 : bb.x1;
  const along0 = horiz ? bb.x0 : bb.y0, along1 = horiz ? bb.x1 : bb.y1;
  const band = (o, a0, a1) => (horiz ? R(a0, o - W / 2, a1, o + W / 2) : R(o - W / 2, a0, o + W / 2, a1));
  const blockers = [...ctx.items.filter((it) => it.kind === 'room').map((it) => it.rect), ...(site.core ? [site.core.rect] : [])];
  let target = (lo + hi) / 2;
  const c = site.core;
  if (c && (horiz ? (c.door === 'N' || c.door === 'S') : (c.door === 'E' || c.door === 'W'))) {
    const edge = { N: c.rect.y1, S: c.rect.y0, E: c.rect.x1, W: c.rect.x0 }[c.door];
    const sign = c.door === 'N' || c.door === 'E' ? 1 : -1;
    target = edge + sign * (M_STANDARDS.coreClear + W / 2);
  }
  let best = null;
  for (let o = lo + W / 2; o <= hi - W / 2 + EPS; o += 100) {
    // longest run along the axis that is inside the plate and clear of the core and pinned rooms
    let runStart = null, bestRun = null;
    for (let a = along0; a <= along1; a += 100) {
      const slice = band(o, a, Math.min(a + 100, along1));
      const okSlice = a + 100 <= along1 + EPS && rectInPoly(slice, site.outline) && !blockers.some((b) => overlaps(slice, b));
      if (okSlice && runStart === null) runStart = a;
      if ((!okSlice || a + 100 > along1 - EPS) && runStart !== null) {
        const end = okSlice ? Math.min(a + 100, along1) : a;
        if (!bestRun || end - runStart > bestRun[1] - bestRun[0]) bestRun = [runStart, end];
        runStart = null;
      }
    }
    if (!bestRun || bestRun[1] - bestRun[0] < 3000) continue;
    const rect = band(o, bestRun[0], bestRun[1]);
    const hits = site.columns.filter((col) => overlaps(col.rect, rect));
    const score = hits.length * 1e6 + Math.abs(o - target) - (bestRun[1] - bestRun[0]) * 0.2;
    if (!best || score < best.score) best = { score, rect, hits, horiz, o };
  }
  if (!best) {
    report('error', 'aisle.spine', 'No primary aisle (spine) fits through the plate: it needs a straight run of 3 m, 1800 mm wide, clear of the core and pinned rooms.');
    return null;
  }
  const spine = { id: 'SPINE', kind: 'spine', rect: best.rect, horiz: best.horiz, width: W };
  for (const col of best.hits) {
    const [ox, oy] = overlapSize(col.rect, best.rect), cut = best.horiz ? oy : ox;
    report('warn', 'aisle.column', `${col.id} stands in the primary aisle: clear width there is ${mm(W - cut)} of ${mm(W)}.`, { ref: col.id, amount: Math.round(cut) });
  }
  return spine;
}

// Exits: entry doors in the outline and the core door.
function exitsOf(site) {
  const out = site.openings.filter((o) => o.kind === 'door').map((o) => {
    const e = site.edges[o.edge];
    return { id: o.id, kind: 'entry', at: edgePoint(e, (o.s0 + o.s1) / 2, 0), normal: e.normal, width: o.s1 - o.s0 };
  });
  if (site.core) {
    const c = site.core, d = c.doorRect, n = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] }[c.door];
    out.push({ id: 'CORE', kind: 'core', at: centre(d), normal: n, width: M_STANDARDS.coreDoor });
  }
  return out;
}

// From each exit to the spine: the cheapest route on a 100 mm grid for a band `connector` wide,
// with few turns, around the core and rooms; through a column only when there is no other way (reported).
function connectors(ctx, spine, exits, report) {
  const W = M_STANDARDS.connector, site = ctx.site, g = M_STANDARDS.grid, bb = site.bbox, half = W / 2;
  const nx = Math.ceil((bb.x1 - bb.x0) / g), ny = Math.ceil((bb.y1 - bb.y0) / g), N = nx * ny;
  const cx = (i) => bb.x0 + (i + 0.5) * g, cy = (j) => bb.y0 + (j + 0.5) * g;
  const walk = new Uint8Array(N), colCost = new Uint8Array(N), inSpine = new Uint8Array(N);
  const solid = [...(site.core ? [site.core.rect] : []), ...ctx.items.filter((it) => it.kind === 'room').map((it) => it.rect)];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = cx(i), y = cy(j), k = j * nx + i, cell = R(x - half, y - half, x + half, y + half);
    if (!rectInPoly(cell, site.outline) || solid.some((s) => overlaps(cell, s))) continue;
    walk[k] = 1;
    if (site.columns.some((c) => overlaps(cell, c.rect))) colCost[k] = 1;
    if (x >= spine.rect.x0 - EPS && x <= spine.rect.x1 + EPS && y >= spine.rect.y0 - EPS && y <= spine.rect.y1 + EPS) inSpine[k] = 1;
  }
  const out = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const x of exits) {
    // start just inside the door, far enough in for the band
    let start = -1;
    for (let d = half; d <= half + 6 * g && start < 0; d += g / 2) {
      const i = Math.floor((x.at[0] + x.normal[0] * d - bb.x0) / g), j = Math.floor((x.at[1] + x.normal[1] * d - bb.y0) / g);
      if (i >= 0 && j >= 0 && i < nx && j < ny && walk[j * nx + i]) start = j * nx + i;
    }
    if (start < 0) { report('error', 'aisle.connector', `No aisle ${mm(W)} wide fits in front of ${x.id}.`, { ref: x.id }); continue; }
    // Dijkstra over (cell, heading): a step costs 1, a turn 15, a column cell 400
    const S4 = N * 4, cost = new Float64Array(S4).fill(Infinity), prev = new Int32Array(S4).fill(-1), heap = [];
    const push = (st, c, from) => {
      if (c >= cost[st]) return;
      cost[st] = c; prev[st] = from; heap.push([c, st]);
      for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const popMin = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
      return top;
    };
    const first = Math.abs(x.normal[0]) > 0.5 ? (x.normal[0] > 0 ? 0 : 1) : (x.normal[1] > 0 ? 2 : 3);
    push(start * 4 + first, 0, -1);
    let goal = -1;
    while (heap.length) {
      const [c, st] = popMin();
      if (c > cost[st]) continue;
      const k = st >> 2, h = st & 3;
      if (inSpine[k]) { goal = st; break; }
      const i = k % nx, j = (k - i) / nx;
      for (let nd = 0; nd < 4; nd++) {
        const a = i + dirs[nd][0], b = j + dirs[nd][1];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const kk = b * nx + a;
        if (!walk[kk]) continue;
        push(kk * 4 + nd, c + 1 + (nd !== h ? 15 : 0) + (colCost[kk] ? 400 : 0), st);
      }
    }
    if (goal < 0) { report('error', 'aisle.connector', `No aisle ${mm(W)} wide reaches the spine from ${x.id}.`, { ref: x.id }); continue; }
    // path -> straight runs -> bands
    const cells = [];
    for (let st = goal; st >= 0; st = prev[st]) cells.push(st >> 2);
    cells.reverse();
    const runs = [];
    let a = cells[0];
    for (let n = 1; n <= cells.length; n++) {
      const b = cells[n - 1], c2 = cells[n];
      const same = c2 !== undefined && (n - 1 === 0 || (cells[n - 1] - cells[n - 2]) === (c2 - b));
      if (!same) { runs.push([a, b]); a = b; }
    }
    const legs = runs.map(([p, q]) => {
      const pi = p % nx, pj = (p - pi) / nx, qi = q % nx, qj = (q - qi) / nx;
      return R(Math.min(cx(pi), cx(qi)) - half, Math.min(cy(pj), cy(qj)) - half, Math.max(cx(pi), cx(qi)) + half, Math.max(cy(pj), cy(qj)) + half);
    });
    // the first leg starts at the door itself
    const l0 = legs[0], [dx, dy] = x.at;
    if (Math.abs(x.normal[1]) > 0.5) { if (x.normal[1] > 0) l0.y0 = Math.min(l0.y0, dy); else l0.y1 = Math.max(l0.y1, dy); }
    else if (x.normal[0] > 0) l0.x0 = Math.min(l0.x0, dx); else l0.x1 = Math.max(l0.x1, dx);
    for (const l of legs) for (const col of site.columns.filter((c) => overlaps(l, c.rect))) {
      const [ox, oy] = overlapSize(col.rect, l), wide = l.x1 - l.x0 >= l.y1 - l.y0, cut = Math.min(wide ? oy : ox, W);
      report('warn', 'aisle.column', `${col.id} stands in the aisle from ${x.id}: clear width there is ${mm(W - cut)} of ${mm(W)}.`, { ref: col.id, amount: Math.round(cut) });
    }
    legs.forEach((l, i) => out.push({ id: `AISLE-${x.id}${legs.length > 1 ? `-${i + 1}` : ''}`, kind: 'connector', from: x.id, rect: l }));
  }
  return out;
}

function aisleGraph(spine, conns, exits) {
  const nodes = exits.map((x) => ({ id: x.id, kind: x.kind, at: x.at }));
  const edges = [];
  if (spine) {
    const r = spine.rect;
    const a = spine.horiz ? [r.x0, (r.y0 + r.y1) / 2] : [(r.x0 + r.x1) / 2, r.y0], b = spine.horiz ? [r.x1, (r.y0 + r.y1) / 2] : [(r.x0 + r.x1) / 2, r.y1];
    nodes.push({ id: 'SPINE-A', kind: 'end', at: a }, { id: 'SPINE-B', kind: 'end', at: b });
    edges.push({ from: 'SPINE-A', to: 'SPINE-B', aisle: 'SPINE', length: Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])) });
    for (const x of exits) {
      const legs = conns.filter((c) => c.from === x.id);
      if (!legs.length) continue;
      const len = legs.reduce((t, l) => t + Math.max(l.rect.x1 - l.rect.x0, l.rect.y1 - l.rect.y0), 0);
      nodes.push({ id: `J-${x.id}`, kind: 'junction', at: centre(legs[legs.length - 1].rect) });
      edges.push({ from: x.id, to: `J-${x.id}`, aisle: legs.map((l) => l.id).join('+'), length: Math.round(len) });
    }
  }
  return { nodes, edges };
}

// ---------- room packing along the spine ----------

function packRooms(ctx, spine, wanted, strategy, report) {
  const queue = [];
  for (const [type, n] of Object.entries(wanted)) for (let i = 0; i < n; i++) queue.push(type);
  queue.sort((a, b) => ROOM_TYPES[b].w * ROOM_TYPES[b].d - ROOM_TYPES[a].w * ROOM_TYPES[a].d);
  const placed = [];
  if (!spine || !queue.length) return { placed, left: queue };
  const r = spine.rect, site = ctx.site;
  // sides of the spine: core side first for daylight (rooms inside, desks by the windows)
  let sides = spine.horiz ? ['N', 'S'] : ['E', 'W'];
  const coreSide = site.core ? (spine.horiz ? (centre(site.core.rect)[1] > (r.y0 + r.y1) / 2 ? 'N' : 'S') : (centre(site.core.rect)[0] > (r.x0 + r.x1) / 2 ? 'E' : 'W')) : null;
  if (coreSide && strategy !== 'compact') sides = [coreSide, ...sides.filter((s) => s !== coreSide)];
  let n = 0;
  for (const side of sides) {
    const front = { N: 'S', S: 'N', E: 'W', W: 'E' }[side];   // the door faces the spine
    const a0 = spine.horiz ? r.x0 : r.y0, a1 = spine.horiz ? r.x1 : r.y1;
    for (let a = a0; a < a1 && queue.length;) {
      let done = false;
      for (let qi = 0; qi < queue.length && !done; qi++) {
        const type = queue[qi], T = ROOM_TYPES[type];
        const along = spine.horiz ? T.w : T.d, depth = spine.horiz ? T.d : T.w;
        if (a + along > a1 + EPS) continue;
        const x = spine.horiz ? a : side === 'E' ? r.x1 : r.x0 - depth, y = spine.horiz ? (side === 'N' ? r.y1 : r.y0 - depth) : a;
        const g = roomGeometry(type, x, y, front);
        if (!roomFits(ctx, g)) continue;
        const it = roomItem(g, `ROOM-${String(++n).padStart(2, '0')}`, null);
        ctx.items.push(it);
        if (unreachable(ctx).length) { ctx.items.pop(); n--; continue; }
        placed.push(it);
        queue.splice(qi, 1);
        a += along;
        done = true;
      }
      if (!done) a += 100;
    }
  }
  return { placed, left: queue };
}

// ---------- furniture in rooms ----------

function roomFurniture(room) {
  const g = room.g, I = g.interior, S = STANDARDS, out = [];
  const fitsIn = (r) => r.x0 >= I.x0 - EPS && r.y0 >= I.y0 - EPS && r.x1 <= I.x1 + EPS && r.y1 <= I.y1 + EPS && !overlaps(r, g.swing);
  if (g.category === 'meeting') {
    const { length, depth, perSide } = tableSize(g.seats);
    const wide = I.x1 - I.x0 >= I.y1 - I.y0;
    const tw = wide ? length : depth, td = wide ? depth : length;
    let [cx, cy] = centre(I);
    // slide away from the door swing if the chairs would hit it
    const chairs = (tx, ty) => {
      const t = R(tx - tw / 2, ty - td / 2, tx + tw / 2, ty + td / 2), cs = [];
      for (let k = 0; k < g.seats; k++) {
        const sd = k % 2, idx = Math.floor(k / 2), f = (idx + 0.5) / perSide, h = S.chairW / 2, gap = 100;
        const [x, y] = wide ? [t.x0 + f * tw, sd ? t.y1 + gap + h : t.y0 - gap - h] : [sd ? t.x0 - gap - h : t.x1 + gap + h, t.y0 + f * td];
        cs.push({ rect: R(x - h, y - h, x + h, y + h), rot: wide ? (sd ? 180 : 0) : (sd ? 270 : 90) });
      }
      return { t, cs };
    };
    let best = null;
    for (let d = 0; d <= 1500 && !best; d += 100) {
      for (const [dx, dy] of wide ? [[d, 0], [-d, 0]] : [[0, d], [0, -d]]) {
        const c = chairs(cx + dx, cy + dy);
        if (fitsIn(c.t) && c.cs.every((ch) => fitsIn(ch.rect))) { best = c; break; }
      }
    }
    if (best) {
      out.push({ kind: 'table', shape: 'rect', rect: best.t, h: S.tableH, rot: wide ? 0 : 90, lw: length, ld: depth, seats: g.seats });
      best.cs.forEach((ch) => out.push({ kind: 'chair', role: 'meeting', rect: ch.rect, h: S.chairH, rot: ch.rot }));
    }
  } else if (g.category === 'focus') {
    // desk against the wall opposite the door, at the end away from it
    const back = { N: 'S', S: 'N', E: 'W', W: 'E' }[g.front];
    for (const atEnd of [true, false]) {
      const hor = back === 'N' || back === 'S';
      const x0 = hor ? (atEnd ? I.x1 - S.deskW : I.x0) : (back === 'W' ? I.x0 : I.x1 - S.deskD);
      const y0 = hor ? (back === 'S' ? I.y0 : I.y1 - S.deskD) : (atEnd ? I.y1 - S.deskW : I.y0);
      const desk = R(x0, y0, x0 + (hor ? S.deskW : S.deskD), y0 + (hor ? S.deskD : S.deskW));
      const rot = { S: 0, N: 180, W: 270, E: 90 }[back];
      const dir = { 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] }[rot];
      const [dcx, dcy] = centre(desk), reach = S.deskD / 2 + 350, h = S.chairW / 2;
      const chair = R(dcx + dir[0] * reach - h, dcy + dir[1] * reach - h, dcx + dir[0] * reach + h, dcy + dir[1] * reach + h);
      if (fitsIn(desk) && fitsIn(chair)) {
        out.push({ kind: 'desk', rect: desk, h: S.deskH, rot, lw: S.deskW, ld: S.deskD, inRoom: true });
        out.push({ kind: 'chair', role: 'desk', rect: chair, h: S.chairH, rot: (rot + 180) % 360 });
        break;
      }
    }
  } else if (g.category === 'support') {
    const back = { N: 'S', S: 'N', E: 'W', W: 'E' }[g.front], hor = back === 'N' || back === 'S', len = 1200, dep = 450;
    const span = hor ? [I.x0, I.x1] : [I.y0, I.y1];
    for (let a = span[0]; a + len <= span[1] + EPS; a += len) {
      const r = hor ? R(a, back === 'S' ? I.y0 : I.y1 - dep, a + len, back === 'S' ? I.y0 + dep : I.y1)
        : R(back === 'W' ? I.x0 : I.x1 - dep, a, back === 'W' ? I.x0 + dep : I.x1, a + len);
      if (fitsIn(r)) out.push({ kind: 'storage', rect: r, h: 2000, rot: { S: 0, N: 180, W: 270, E: 90 }[back] });
    }
  }
  return out;
}

// ---------- open plan: benches, booths, open table ----------

function benchCand(x, y, per, rows, rot) {
  const S = STANDARDS, len = per * S.deskW, dep = rows * S.deskD, cz = S.chairZone;
  const rect = rot === 0 ? R(x, y, x + len, y + dep) : R(x, y, x + dep, y + len);
  const lo = rot === 0 ? R(rect.x0, rect.y0 - cz, rect.x1, rect.y0) : R(rect.x0 - cz, rect.y0, rect.x0, rect.y1);
  const hi = rot === 0 ? R(rect.x0, rect.y1, rect.x1, rect.y1 + cz) : R(rect.x1, rect.y0, rect.x1 + cz, rect.y1);
  return { kind: 'bench', rot, per, rows, desks: per * rows, h: S.deskH, rect, access: rows === 2 ? [lo, hi] : [hi] };
}

function rectPointDist(r, [x, y]) {
  return Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));
}

function placeBenches(ctx, count, strategy, spine) {
  const S = STANDARDS, bb = ctx.site.bbox, g = 200;
  // benches run at right angles to the spine and gather towards the windows (daylight) or the spine (compact)
  const rot = spine ? (spine.horiz ? 90 : 0) : 0;
  const wins = ctx.site.openings.filter((o) => o.kind === 'window');
  const anchors = strategy === 'compact' || !wins.length
    ? [spine ? centre(spine.rect) : centre(bb)]
    : wins.map((o) => edgePoint(ctx.site.edges[o.edge], (o.s0 + o.s1) / 2, 0));
  let placed = 0, n = 0;
  while (placed < count) {
    const left = count - placed;
    const shapes = [];
    for (let per = Math.min(S.benchMaxPerSide, Math.floor(left / 2)); per >= 1; per--) shapes.push([per, 2]);
    for (let per = Math.min(S.benchMaxPerSide, left); per >= 1; per--) shapes.push([per, 1]);
    let got = null;
    for (const [per, rows] of shapes) {
      const cands = [];
      for (const r of [rot, (rot + 90) % 180]) {
        const probe = benchCand(0, 0, per, rows, r), bw = probe.rect.x1 - probe.rect.x0, bd = probe.rect.y1 - probe.rect.y0;
        for (let x = bb.x0; x + bw <= bb.x1 + EPS; x += g) for (let y = bb.y0; y + bd <= bb.y1 + EPS; y += g) cands.push(benchCand(x, y, per, rows, r));
      }
      const score = (c) => (c.rot === rot ? 0 : 4000) + Math.min(...anchors.map((p) => rectPointDist(c.rect, p)));
      const ranked = cands.map((c) => ({ c, k: score(c) })).sort((a, b) => a.k - b.k);
      let tested = 0;
      for (const { c } of ranked) {
        if (!fits(ctx, c)) continue;
        if (tested++ > 60) break;
        ctx.items.push(c);
        if (!unreachable(ctx).length) { got = c; break; }
        ctx.items.pop();
      }
      if (got) break;
    }
    if (!got) break;
    got.id = `BENCH-${String(++n).padStart(2, '0')}`;
    placed += got.desks;
  }
  return placed;
}

function placeFree(ctx, make, count, score) {
  const bb = ctx.site.bbox, out = [];
  for (let k = 0; k < count; k++) {
    const cands = [];
    for (let x = bb.x0; x <= bb.x1; x += 200) for (let y = bb.y0; y <= bb.y1; y += 200) for (const c of make(x, y)) cands.push(c);
    const ranked = cands.map((c) => ({ c, s: score(c) })).sort((a, b) => a.s - b.s);
    let got = null, tested = 0;
    for (const { c } of ranked) {
      if (!fits(ctx, c)) continue;
      if (tested++ > 60) break;
      ctx.items.push(c);
      if (!unreachable(ctx).length) { got = c; break; }
      ctx.items.pop();
    }
    if (!got) break;
    out.push(got);
  }
  return out;
}

// ---------- reachability and travel ----------

function raster(ctx, r) {
  const site = ctx.site, g = M_STANDARDS.grid, bb = site.bbox;
  const nx = Math.ceil((bb.x1 - bb.x0) / g), ny = Math.ceil((bb.y1 - bb.y0) / g);
  ctx.bases = ctx.bases || {};
  if (!ctx.bases[r]) {
    // inside the plate and at least r from its outline
    const base = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = bb.x0 + (i + 0.5) * g, y = bb.y0 + (j + 0.5) * g;
      if (!pointInPoly(x, y, site.outline)) continue;
      let near = false;
      for (const e of site.edges) {
        const t = Math.max(0, Math.min(e.L, (x - e.a[0]) * e.dir[0] + (y - e.a[1]) * e.dir[1]));
        if (Math.hypot(x - e.a[0] - e.dir[0] * t, y - e.a[1] - e.dir[1] * t) < r - EPS) { near = true; break; }
      }
      if (!near) base[j * nx + i] = 1;
    }
    ctx.bases[r] = base;
  }
  const walk = ctx.bases[r].slice();
  const lo = (v, o) => Math.max(0, Math.floor((v - o + EPS) / g - 0.5) + 1);
  const hi = (v, o, n) => Math.min(n - 1, Math.ceil((v - o - EPS) / g - 0.5) - 1);
  const block = (rect) => {
    const b = expand(rect, r);
    for (let j = lo(b.y0, bb.y0), j1 = hi(b.y1, bb.y0, ny); j <= j1; j++) for (let i = lo(b.x0, bb.x0), i1 = hi(b.x1, bb.x0, nx); i <= i1; i++) walk[j * nx + i] = 0;
  };
  for (const o of ctx.fixed) block(o.rect);
  for (const it of ctx.items) block(it.rect);
  return { walk, nx, ny, g, bb };
}

function cellOf(G, x, y) {
  const i = Math.floor((x - G.bb.x0) / G.g), j = Math.floor((y - G.bb.y0) / G.g);
  return i >= 0 && j >= 0 && i < G.nx && j < G.ny ? j * G.nx + i : -1;
}

// Grid distance field from the exits (8-neighbour, mm), over cells clear by half a passage.
function distanceField(ctx, r) {
  const G = raster(ctx, r), N = G.nx * G.ny, dist = new Float64Array(N).fill(Infinity);
  const heap = [];
  const push = (k, d) => { if (d < dist[k]) { dist[k] = d; heap.push([d, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const x of ctx.exits) {
    // the first clear cell walking in from the door
    for (let d = G.g / 2; d <= r + 3 * G.g; d += G.g / 2) {
      const k = cellOf(G, x.at[0] + x.normal[0] * d, x.at[1] + x.normal[1] * d);
      if (k >= 0 && G.walk[k]) { push(k, d); break; }
    }
  }
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    const i = k % G.nx, j = (k - i) / G.nx;
    for (const [di, dj, c] of steps) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= G.nx || b >= G.ny) continue;
      const kk = b * G.nx + a;
      if (!G.walk[kk]) continue;
      if (di && dj && (!G.walk[j * G.nx + a] || !G.walk[b * G.nx + i])) continue;
      push(kk, d + c * G.g);
    }
  }
  return { G, dist };
}

function zoneDistance(F, zone, exclude) {
  const { G, dist } = F;
  let best = Infinity;
  const i0 = Math.max(0, Math.floor((zone.x0 - G.bb.x0) / G.g)), i1 = Math.min(G.nx - 1, Math.floor((zone.x1 - G.bb.x0) / G.g));
  const j0 = Math.max(0, Math.floor((zone.y0 - G.bb.y0) / G.g)), j1 = Math.min(G.ny - 1, Math.floor((zone.y1 - G.bb.y0) / G.g));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = G.bb.x0 + (i + 0.5) * G.g, y = G.bb.y0 + (j + 0.5) * G.g;
    if (x <= zone.x0 || x >= zone.x1 || y <= zone.y0 || y >= zone.y1) continue;
    if (exclude && x > exclude.x0 && x < exclude.x1 && y > exclude.y0 && y < exclude.y1) continue;
    best = Math.min(best, dist[j * G.nx + i]);
  }
  return best;
}

// Plain breadth-first reachability (cheaper than the distance field; run after every placement).
function unreachable(ctx) {
  const r = STANDARDS.passage / 2, G = raster(ctx, r), N = G.nx * G.ny, seen = new Uint8Array(N), q = [];
  for (const x of ctx.exits) {
    for (let d = G.g / 2; d <= r + 3 * G.g; d += G.g / 2) {
      const k = cellOf(G, x.at[0] + x.normal[0] * d, x.at[1] + x.normal[1] * d);
      if (k >= 0 && G.walk[k]) { if (!seen[k]) { seen[k] = 1; q.push(k); } break; }
    }
  }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], i = k % G.nx, j = (k - i) / G.nx;
    if (i > 0 && G.walk[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; q.push(k - 1); }
    if (i < G.nx - 1 && G.walk[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; q.push(k + 1); }
    if (j > 0 && G.walk[k - G.nx] && !seen[k - G.nx]) { seen[k - G.nx] = 1; q.push(k - G.nx); }
    if (j < G.ny - 1 && G.walk[k + G.nx] && !seen[k + G.nx]) { seen[k + G.nx] = 1; q.push(k + G.nx); }
  }
  const dist = new Float32Array(N);
  for (let k = 0; k < N; k++) dist[k] = seen[k] ? 0 : Infinity;
  return ctx.items.filter((it) => it.access.some((z) => !Number.isFinite(zoneDistance({ G, dist }, z, it.rect))));
}

// ---------- elements ----------

function toElements(items, height) {
  const S = STANDARDS, out = [];
  let desks = 0, chairs = 0;
  const did = () => `DESK-${String(++desks).padStart(2, '0')}`, cid = () => `CHAIR-${String(++chairs).padStart(3, '0')}`;
  const chairFor = (desk) => {
    const dir = { 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] }[desk.rot], [x, y] = centre(desk), reach = S.deskD / 2 + 350, h = S.chairW / 2;
    return { id: cid(), kind: 'chair', role: 'desk', rot: (desk.rot + 180) % 360, lw: S.chairW, ld: S.chairD, h: S.chairH, ...R(x + dir[0] * reach - h, y + dir[1] * reach - h, x + dir[0] * reach + h, y + dir[1] * reach + h), of: desk.id };
  };
  for (const it of items) {
    if (it.kind === 'bench') {
      const rows = it.rows === 2 ? ['low', 'high'] : ['high'];
      rows.forEach((row, ri) => {
        for (let k = 0; k < it.per; k++) {
          const a = k * S.deskW, off = it.rows === 2 && ri === 1 ? S.deskD : 0, r = it.rect;
          const rect = it.rot === 0 ? R(r.x0 + a, r.y0 + off, r.x0 + a + S.deskW, r.y0 + off + S.deskD) : R(r.x0 + off, r.y0 + a, r.x0 + off + S.deskD, r.y0 + a + S.deskW);
          const rot = it.rot === 0 ? (row === 'high' ? 0 : 180) : (row === 'high' ? 270 : 90);
          const dir = { 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] }[rot];
          const zone = R(dir[0] < 0 ? rect.x0 - S.chairZone : dir[0] > 0 ? rect.x1 : rect.x0, dir[1] < 0 ? rect.y0 - S.chairZone : dir[1] > 0 ? rect.y1 : rect.y0,
            dir[0] < 0 ? rect.x0 : dir[0] > 0 ? rect.x1 + S.chairZone : rect.x1, dir[1] < 0 ? rect.y0 : dir[1] > 0 ? rect.y1 + S.chairZone : rect.y1);
          const desk = { id: did(), kind: 'desk', rot, lw: S.deskW, ld: S.deskD, h: S.deskH, ...rect, bench: it.id, access: [zone] };
          out.push(desk, chairFor(desk));
        }
      });
    } else if (it.kind === 'room') {
      const g = it.g;
      out.push({ id: it.id, kind: 'room', type: g.type, name: g.label, category: g.category, front: g.front, door: g.door, seats: g.seats,
        h: height, ...g.rect, interior: g.interior, swing: g.swing, access: [g.outside], pinned: it.pinned || null });
      g.parts.forEach((p, i) => out.push({ id: `${it.id}-P${i + 1}`, kind: 'partition', of: it.id, h: height, ...p }));
      let t = 0;
      for (const f of roomFurniture(it)) {
        const id = f.kind === 'chair' ? cid() : f.kind === 'desk' ? did() : `${it.id}-${f.kind.toUpperCase()}${++t}`;
        const el = { id, kind: f.kind, rot: f.rot, h: f.h, ...f.rect, room: it.id, lw: f.lw, ld: f.ld, seats: f.seats, role: f.role, shape: f.shape };
        if (f.kind === 'desk') el.access = [];
        out.push(el);
      }
    } else if (it.kind === 'booth' || it.kind === 'table') {
      out.push({ id: it.id, kind: it.kind, rot: it.rot, lw: it.lw, ld: it.ld, h: it.h, ...it.rect, access: it.access.map((a) => ({ ...a })), seats: it.seats, shape: it.kind === 'table' ? 'rect' : undefined });
      if (it.kind === 'table') {
        const { perSide } = tableSize(it.seats), r = it.rect, wide = it.rot === 0, h = S.chairW / 2;
        for (let k = 0; k < it.seats; k++) {
          const sd = k % 2, f = (Math.floor(k / 2) + 0.5) / perSide;
          const [x, y] = wide ? [r.x0 + f * (r.x1 - r.x0), sd ? r.y1 + 100 + h : r.y0 - 100 - h] : [sd ? r.x0 - 100 - h : r.x1 + 100 + h, r.y0 + f * (r.y1 - r.y0)];
          out.push({ id: cid(), kind: 'chair', role: 'meeting', rot: wide ? (sd ? 180 : 0) : (sd ? 270 : 90), lw: S.chairW, ld: S.chairD, h: S.chairH, ...R(x - h, y - h, x + h, y + h), of: it.id });
        }
      }
    }
  }
  return out;
}

function dimensionChains(site) {
  const dims = {};
  for (const e of site.edges) {
    const pts = [0, ...site.openings.filter((o) => o.edge === e.index).flatMap((o) => [o.s0, o.s1]), Math.round(e.L)];
    const points = [...new Set(pts)].sort((a, b) => a - b);
    dims[e.id] = { length: Math.round(e.L), points, segments: points.slice(1).map((p, i) => p - points[i]) };
  }
  return dims;
}

// ---------- main ----------

export function generateM(state, report, strategy) {
  const st = state || {};
  const site = resolveSite(st.siteM, report);
  const p = st.programmeM || {};
  const nbs = (Array.isArray(p.neighbourhoods) ? p.neighbourhoods : []).map((n, i) => ({ name: String(n.name || `Team ${i + 1}`).slice(0, 40), desks: Math.max(0, Math.min(400, Math.round(num(n.desks, 0)))) }));
  const rooms = {};
  for (const t of Object.keys(ROOM_TYPES)) rooms[t] = Math.max(0, Math.min(40, Math.round(num(p.rooms && p.rooms[t], 0))));
  const booths = Math.max(0, Math.min(20, Math.round(num(p.booths, 0))));
  const tableSeats = Math.max(0, Math.min(20, Math.round(num(p.meetingSeats, 0))));
  const limit = Math.max(5000, Math.min(200000, num(p.travelLimit, M_STANDARDS.travelLimit)));
  const pins = Array.isArray(p.pinned) ? p.pinned : [];

  const ctx = { site, fixed: fixedObstacles(site), aisles: [], items: [], exits: exitsOf(site) };
  if (!ctx.exits.length) report('error', 'site.noexit', 'The floor has no entry door and no core: nothing can be reached.');

  const pinned = placePinned(ctx, pins, report);
  const spine = chooseSpine(ctx, report);
  const conns = spine ? connectors(ctx, spine, ctx.exits, report) : [];
  ctx.aisles = [...(spine ? [spine] : []), ...conns];

  // rooms asked for, minus the pinned ones of each type
  const wanted = { ...rooms };
  for (const it of pinned) wanted[it.g.type] = Math.max(0, (wanted[it.g.type] || 0) - 1);
  const pack = packRooms(ctx, spine, wanted, strategy, report);

  // open plan
  const totalDesks = nbs.reduce((t, n) => t + n.desks, 0);
  const S = STANDARDS;
  const boothItems = placeFree(ctx, (x, y) => [0, 90, 180, 270].map((rot) => {
    const rect = R(x, y, x + S.boothW, y + S.boothD), f = S.boothFront;
    const acc = rot === 0 ? R(x, y + S.boothD, x + S.boothW, y + S.boothD + f) : rot === 180 ? R(x, y - f, x + S.boothW, y) : rot === 90 ? R(x - f, y, x, y + S.boothD) : R(x + S.boothW, y, x + S.boothW + f, y + S.boothD);
    return { kind: 'booth', rot, lw: S.boothW, ld: S.boothD, h: S.boothH, rect, access: [acc] };
  }), booths, (c) => {
    // against something solid, near the spine
    const touching = [...ctx.fixed.map((o) => o.rect), ...ctx.items.filter((i) => i.kind === 'room').map((i) => i.rect)].some((r) => overlaps(expand(c.rect, 1), r)) ? 0 : 5000;
    return touching + (spine ? rectPointDist(c.rect, centre(spine.rect)) / 10 : 0);
  });
  boothItems.forEach((b, i) => { b.id = `BOOTH-${String(i + 1).padStart(2, '0')}`; });
  let tableItem = null;
  if (tableSeats > 0) {
    const { length, depth } = tableSize(tableSeats);
    tableItem = placeFree(ctx, (x, y) => [0, 90].map((rot) => {
      const rect = rot === 0 ? R(x, y, x + length, y + depth) : R(x, y, x + depth, y + length);
      return { kind: 'table', rot, lw: length, ld: depth, h: S.tableH, seats: tableSeats, rect, access: [expand(rect, S.tableRing)] };
    }), 1, (c) => (spine ? rectPointDist(c.rect, centre(spine.rect)) : 0))[0] || null;
    if (tableItem) tableItem.id = 'TABLE-01';
  }
  const deskPlaced = placeBenches(ctx, totalDesks, strategy, spine);

  // last word: anything not reachable goes, with a message
  const lost = unreachable(ctx);
  for (const it of lost) report('warn', `reach.${it.kind}`, `${it.id} removed: it cannot be reached from an exit with a ${mm(S.passage)} passage.`, { ref: it.id });
  ctx.items = ctx.items.filter((it) => !lost.includes(it));

  const elements = toElements(ctx.items, site.height);
  for (const c of site.columns) elements.push({ id: c.id, kind: 'column', h: site.height, rot: 0, ...c.rect });
  if (site.core) elements.push({ id: 'CORE', kind: 'core', h: site.height, rot: 0, ...site.core.rect, door: site.core.door, doorRect: site.core.doorRect });

  // neighbourhoods: open-plan desks in order along the spine, split by the teams' sizes
  const axis = spine && !spine.horiz ? 1 : 0;
  // benches in order along the spine; inside a bench, desk pairs along its length, so a team boundary cuts across it
  const benchAt = {};
  for (const it of ctx.items) if (it.kind === 'bench') benchAt[it.id] = it;
  const bkey = (d) => { const b = benchAt[d.bench], c = centre(b.rect); return axis ? c[1] * 1e6 + c[0] : c[0] * 1e6 + c[1]; };
  const along = (d) => (benchAt[d.bench].rot === 0 ? d.x0 * 1e6 + d.y0 : d.y0 * 1e6 + d.x0);
  const open = elements.filter((e) => e.kind === 'desk' && !e.room).sort((a, b) => bkey(a) - bkey(b) || along(a) - along(b));
  const neighbourhoods = [];
  let k = 0;
  nbs.forEach((n, i) => {
    const mine = open.slice(k, k + n.desks);
    k += mine.length;
    mine.forEach((d) => { d.neighbourhood = `NBH-${i + 1}`; });
    if (mine.length) {
      // one area per bench (its desks and chair zones), so a team never claims the floor between its benches
      const bound = (list) => R(Math.min(...list.map((r) => r.x0)), Math.min(...list.map((r) => r.y0)), Math.max(...list.map((r) => r.x1)), Math.max(...list.map((r) => r.y1)));
      const byBench = {};
      for (const d of mine) (byBench[d.bench] = byBench[d.bench] || []).push(d, ...(d.access || []));
      const others = open.filter((d) => !mine.includes(d)).flatMap((d) => [d, ...(d.access || [])]);
      // where a bench is shared with another team, its part is drawn desk by desk
      const rects = Object.entries(byBench).flatMap(([, list]) => {
        const b = bound(list);
        return others.some((o) => overlaps(b, o)) ? mine.filter((d) => list.includes(d)).map((d) => bound([d, ...(d.access || [])])) : [b];
      });
      neighbourhoods.push({ id: `NBH-${i + 1}`, name: n.name, desks: mine.map((d) => d.id), requested: n.desks, rects, rect: bound(rects) });
    }
    if (mine.length < n.desks) report('warn', 'programme.neighbourhood', `${n.name}: ${mine.length} of ${n.desks} desks placed; ${n.desks - mine.length} short.`, { amount: n.desks - mine.length });
  });

  // travel distance to the nearest exit, per workpoint and per room
  const F = distanceField(ctx, 300);
  const travel = { limit, perDesk: {}, perRoom: {}, max: 0, worst: null, over: [] };
  for (const e of elements) {
    let d = Infinity;
    if (e.kind === 'desk' && !e.room) d = zoneDistance(F, e.access[0], e);
    else if (e.kind === 'room') d = zoneDistance(F, e.access[0]) + (e.front === 'N' || e.front === 'S' ? e.y1 - e.y0 : e.x1 - e.x0);
    else continue;
    const key = e.kind === 'room' ? 'perRoom' : 'perDesk';
    travel[key][e.id] = Number.isFinite(d) ? Math.round(d) : null;
    if (Number.isFinite(d) && d > travel.max) { travel.max = Math.round(d); travel.worst = e.id; }
    if (Number.isFinite(d) && d > limit) travel.over.push(e.id);
  }
  if (travel.over.length) report('warn', 'travel.limit', `${travel.over.length} workpoint(s)/room(s) are further than ${m1(limit)} from an exit; furthest ${travel.worst} at ${m1(travel.max)}.`, { amount: travel.max - limit });

  // programme
  const count = (kind, f = () => true) => elements.filter((e) => e.kind === kind && f(e)).length;
  for (const [t, n] of Object.entries(rooms)) {
    const got = count('room', (e) => e.type === t);
    const ask = Math.max(n, pinned.filter((it) => it.g.type === t).length);
    if (got < ask) report('warn', `programme.room.${t}`, `Placed ${got} of ${ask} ${ROOM_TYPES[t].label}; ${ask - got} short. No free stretch along the spine is deep enough.`, { amount: ask - got });
  }
  const openDesks = count('desk', (e) => !e.room);
  if (openDesks < totalDesks) report('warn', 'programme.desks', `Placed ${openDesks} of ${totalDesks} open-plan desks; ${totalDesks - openDesks} short.`, { amount: totalDesks - openDesks });
  if (count('booth') < booths) report('warn', 'programme.booths', `Placed ${count('booth')} of ${booths} booths; ${booths - count('booth')} short.`, { amount: booths - count('booth') });
  const seats = count('chair', (e) => e.role === 'meeting' && !e.room);
  if (seats < tableSeats) report('warn', 'programme.meetingSeats', `Placed ${seats} of ${tableSeats} open meeting seats; ${tableSeats - seats} short.`, { amount: tableSeats - seats });
  if (p.deskLayout && p.deskLayout !== 'benches') report('info', 'programme.deskLayout', 'Tier M arranges open-plan desks as benches.');

  const readouts = {
    desksRequested: totalDesks, desksPlaced: openDesks, focusDesks: count('desk', (e) => e.room),
    roomsRequested: Object.values(rooms).reduce((a, b) => a + b, 0), roomsPlaced: count('room'),
    meetingSeatsRequested: tableSeats, meetingSeatsPlaced: seats,
    roomSeats: count('chair', (e) => e.role === 'meeting' && e.room),
    boothsRequested: booths, boothsPlaced: count('booth'),
    floorArea: Math.round(site.area / 1e4) / 100, columns: site.columns.length, openings: site.openings.length,
    travelMax: travel.max, travelLimit: limit,
  };
  readouts.workpoints = readouts.desksPlaced + readouts.focusDesks;
  readouts.areaPerWorkpoint = readouts.workpoints ? Math.round(readouts.floorArea / readouts.workpoints * 100) / 100 : null;

  const siteOut = { outline: site.outline, edges: site.edges.map(({ id, index, a, b, L }) => ({ id, index, a, b, length: Math.round(L) })),
    bbox: site.bbox, height: site.height, wall: site.wall, area: site.area, openings: site.openings, core: site.core, columns: site.columns,
    width: site.bbox.x1 - site.bbox.x0, depth: site.bbox.y1 - site.bbox.y0 };
  return { site: siteOut, zones: site.zones, elements, aisles: ctx.aisles, graph: aisleGraph(spine, conns, ctx.exits), neighbourhoods,
    travel, readouts, dims: dimensionChains(site), strategy: STRATEGIES[strategy] ? strategy : 'daylight' };
}
