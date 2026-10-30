// Office Configurator — layout generator.
// Pure functions, no DOM: the same module runs in the browser and in Node (tools/check.js).
//
// Units are millimetres. Origin is the interior south-west corner, x east, y north.
// Walls run counter-clockwise S -> E -> N -> W, so the room is always on the wall's left.
// In a wall frame, "s" is the distance along the wall from its start corner and
// "n" the distance into the room from the wall face (negative n is inside the wall / outside).

export const STANDARDS = Object.freeze({
  deskW: 1600, deskD: 800, deskH: 740,
  chairZone: 1000,           // free depth behind a desk for the chair
  chairW: 500, chairD: 500, chairH: 900,
  boothW: 1100, boothD: 1100, boothH: 2200, boothFront: 900,
  tableH: 740, seatPitch: 700, tableRing: 800,
  passage: 900,              // clear width of the route from a door to every workpoint
  thresholdDepth: 1500, thresholdSide: 300,
  windowBandDepth: 1000,     // anything taller than the sill may not stand this close to a window
  step: 50,                  // sweep step along walls
  grid: 100,                 // table search grid and reachability grid
});

export const STRATEGIES = Object.freeze({
  daylight: { label: 'Daylight first', order: ['booths', 'desks', 'table'],
    note: 'Booths on the solid walls away from the door, desks along the window walls, table in the middle.' },
  meeting: { label: 'Meeting first', order: ['table', 'booths', 'desks'],
    note: 'The meeting table takes the middle first; booths and desks fill the walls around it.' },
  compact: { label: 'Compact', order: ['desks', 'booths', 'table'],
    note: 'Desks along the longest walls first, booths in the corners, table wherever it still fits.' },
});

export const TIERS = Object.freeze({
  S: { label: 'S: single room', available: true },
  M: { label: 'M: floor with columns and a core (phase 3)', available: false },
  L: { label: 'L: multi-core floor (phase 4)', available: false },
});

export const WALLS = ['S', 'E', 'N', 'W'];
export const WALL_CORNERS = Object.freeze({ S: ['SW', 'SE'], E: ['SE', 'NE'], N: ['NE', 'NW'], W: ['NW', 'SW'] });
export const WALL_ROT = Object.freeze({ S: 0, E: 90, N: 180, W: 270 });
const EPS = 0.5;

const LIMITS = {
  width: [2400, 60000], depth: [2400, 60000], height: [2200, 10000], wall: [50, 1000],
};

// ---------- geometry ----------

export function wallLength(site, wall) {
  return wall === 'S' || wall === 'N' ? site.width : site.depth;
}

export function wallPoint(site, wall, s, n) {
  const W = site.width, D = site.depth;
  switch (wall) {
    case 'S': return [s, n];
    case 'E': return [W - n, s];
    case 'N': return [W - s, D - n];
    default: return [n, D - s];
  }
}

export function wallRect(site, wall, s0, s1, n0, n1) {
  const a = wallPoint(site, wall, s0, n0), b = wallPoint(site, wall, s1, n1);
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}

// Distance along the wall from its start corner to the opening's first edge.
export function openingStart(site, o) {
  const L = wallLength(site, o.wall);
  return o.ref === WALL_CORNERS[o.wall][1] ? L - o.offset - o.width : o.offset;
}

// The offset that keeps the opening where it is when it is measured from `ref` instead.
export function offsetFromRef(site, o, ref) {
  const s = openingStart(site, o);
  return ref === WALL_CORNERS[o.wall][1] ? wallLength(site, o.wall) - s - o.width : s;
}

export function overlaps(a, b) {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
}

function inside(r, W, D) {
  return r.x0 >= -EPS && r.y0 >= -EPS && r.x1 <= W + EPS && r.y1 <= D + EPS;
}

function expand(r, m) {
  return { x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m };
}

function clip(r, W, D) {
  return { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(W, r.x1), y1: Math.min(D, r.y1) };
}

function centre(r) {
  return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
}

const round = (v) => Math.round(v);
const mm = (v) => `${round(v)} mm`;

// ---------- site ----------

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function resolveSite(input, report) {
  const src = input || {};
  const site = {};
  for (const key of ['width', 'depth', 'height', 'wall']) {
    const [lo, hi] = LIMITS[key];
    const raw = num(src[key], NaN);
    let v = Number.isFinite(raw) ? raw : lo;
    if (!Number.isFinite(raw)) report('error', `site.${key}`, `Room ${key} is not a number; using ${mm(lo)}.`);
    else if (v < lo || v > hi) {
      const c = Math.min(hi, Math.max(lo, v));
      report('error', `site.${key}`, `Room ${key} ${mm(v)} is outside ${lo}–${hi} mm; using ${mm(c)} (clamped by ${mm(Math.abs(c - v))}).`, { amount: round(Math.abs(c - v)) });
      v = c;
    }
    site[key] = round(v);
  }

  const openings = [];
  const seen = new Set();
  (Array.isArray(src.openings) ? src.openings : []).forEach((o, i) => {
    const kind = o.kind === 'window' ? 'window' : 'door';
    const id = String(o.id || `${kind === 'door' ? 'DOOR' : 'WIN'}-${i + 1}`);
    if (seen.has(id)) report('warn', 'opening.id', `Opening ID ${id} is used twice.`, { ref: id });
    seen.add(id);
    let wall = o.wall;
    if (!WALLS.includes(wall)) {
      report('error', 'opening.wall', `${id}: unknown wall "${wall}"; placed on S.`, { ref: id });
      wall = 'S';
    }
    let ref = o.ref;
    if (!WALL_CORNERS[wall].includes(ref)) {
      if (ref !== undefined) report('warn', 'opening.ref', `${id}: corner ${ref} is not on the ${wall} wall; measured from ${WALL_CORNERS[wall][0]}.`, { ref: id });
      ref = WALL_CORNERS[wall][0];
    }
    for (const key of ['offset', 'width', 'height', 'sill']) {
      if (o[key] !== undefined && !Number.isFinite(Number(o[key]))) report('error', `opening.${key}`, `${id}: ${key} "${o[key]}" is not a number; using the default.`, { ref: id });
    }
    const width = Math.max(300, round(num(o.width, 900)));
    if (num(o.width, 900) < 300) report('error', 'opening.width', `${id}: width below 300 mm; using 300 mm.`, { ref: id });
    const offset = round(num(o.offset, 0));
    const defH = kind === 'door' ? 2100 : 1500;
    let height = Math.max(100, round(num(o.height, defH)));
    let sill = kind === 'door' ? 0 : Math.max(0, round(num(o.sill, 900)));
    if (sill + height > site.height) {
      const over = sill + height - site.height;
      report('error', 'opening.height', `${id}: head at ${mm(sill + height)} is above the ${mm(site.height)} room height by ${mm(over)}; drawn to the ceiling.`, { ref: id, amount: over });
      height = Math.max(100, site.height - sill);
    }
    const L = wallLength(site, wall);
    const rec = { id, kind, wall, ref, offset, width, height, sill,
      hinge: o.hinge === 'end' ? 'end' : 'start', swing: o.swing === 'out' ? 'out' : 'in' };
    const s = openingStart(site, rec);
    let s0 = s, s1 = s + width;
    if (s0 < 0 || s1 > L) {
      const cut = Math.max(0, -s0) + Math.max(0, s1 - L);
      s0 = Math.max(0, s0);
      s1 = Math.min(L, s1);
      if (s1 - s0 < 300) {
        report('error', 'opening.outside', `${id}: lies outside the ${wall} wall (${mm(L)} long); not built.`, { ref: id, amount: round(cut) });
        return;
      }
      report('error', 'opening.clipped', `${id}: runs past the end of the ${wall} wall by ${mm(cut)}; clipped to ${mm(s1 - s0)}.`, { ref: id, amount: round(cut) });
    }
    rec.s0 = round(s0);
    rec.s1 = round(s1);
    rec.rect = wallRect(site, wall, rec.s0, rec.s1, -site.wall, 0);
    openings.push(rec);
  });

  for (const wall of WALLS) {
    const on = openings.filter((o) => o.wall === wall).sort((a, b) => a.s0 - b.s0);
    for (let i = 1; i < on.length; i++) {
      const over = on[i - 1].s1 - on[i].s0;
      if (over > EPS) report('error', 'opening.overlap', `${on[i - 1].id} and ${on[i].id} overlap by ${mm(over)} on the ${wall} wall.`, { ref: on[i].id, amount: round(over) });
    }
  }
  if (!openings.some((o) => o.kind === 'door')) report('error', 'site.nodoor', 'The room has no door; nothing can be reached.');
  site.openings = openings;
  site.walls = WALLS.map((w) => {
    const [x0, y0] = wallPoint(site, w, 0, 0), [x1, y1] = wallPoint(site, w, wallLength(site, w), 0);
    return { id: w, x0, y0, x1, y1, length: wallLength(site, w) };
  });
  return site;
}

export function siteZones(site) {
  const S = STANDARDS, zones = [];
  for (const o of site.openings) {
    const L = wallLength(site, o.wall);
    const across = o.wall === 'S' || o.wall === 'N' ? site.depth : site.width;
    if (o.kind === 'door') {
      if (o.swing === 'in') {
        zones.push({ kind: 'door-swing', ref: o.id, ...clip(wallRect(site, o.wall, o.s0, o.s1, 0, Math.min(across, o.s1 - o.s0)), site.width, site.depth) });
      }
      zones.push({ kind: 'threshold', ref: o.id, ...wallRect(site, o.wall, Math.max(0, o.s0 - S.thresholdSide), Math.min(L, o.s1 + S.thresholdSide), 0, Math.min(across, S.thresholdDepth)) });
    } else {
      zones.push({ kind: 'window-band', ref: o.id, sill: o.sill, ...wallRect(site, o.wall, o.s0, o.s1, 0, Math.min(across, S.windowBandDepth)) });
    }
  }
  return zones;
}

// ---------- placement ----------

function canPlace(ctx, cand) {
  const { width: W, depth: D } = ctx.site;
  const mine = [cand.rect, ...cand.access];
  for (const r of mine) if (!inside(r, W, D)) return false;
  for (const it of ctx.items) {
    const theirs = [it.rect, ...it.access];
    for (const a of mine) for (const b of theirs) if (overlaps(a, b)) return false;
  }
  for (const z of ctx.zones) {
    if (z.kind === 'window-band') {
      if (cand.h > z.sill && overlaps(cand.rect, z)) return false;
    } else {
      for (const a of mine) if (overlaps(a, z)) return false;
    }
  }
  return true;
}

function deskCandidate(site, wall, s) {
  const S = STANDARDS;
  return {
    kind: 'desk', wall, s, rot: WALL_ROT[wall], lw: S.deskW, ld: S.deskD, h: S.deskH,
    rect: wallRect(site, wall, s, s + S.deskW, 0, S.deskD),
    access: [wallRect(site, wall, s, s + S.deskW, S.deskD, S.deskD + S.chairZone)],
  };
}

function boothCandidate(site, wall, s) {
  const S = STANDARDS;
  return {
    kind: 'booth', wall, s, rot: WALL_ROT[wall], lw: S.boothW, ld: S.boothD, h: S.boothH,
    rect: wallRect(site, wall, s, s + S.boothW, 0, S.boothD),
    access: [wallRect(site, wall, s, s + S.boothW, S.boothD, S.boothD + S.boothFront)],
  };
}

export function tableSize(seats) {
  const S = STANDARDS;
  const perSide = Math.max(1, Math.ceil(seats / 2));
  return { length: Math.max(800, perSide * S.seatPitch), depth: seats <= 2 ? 800 : 1000, perSide };
}

function windowLength(site, wall) {
  return site.openings.filter((o) => o.wall === wall && o.kind === 'window').reduce((t, o) => t + o.s1 - o.s0, 0);
}

function doorCentres(site) {
  return site.openings.filter((o) => o.kind === 'door').map((o) => wallPoint(site, o.wall, (o.s0 + o.s1) / 2, 0));
}

function deskWallOrder(site, strategy) {
  const info = WALLS.map((w, i) => ({
    w, i, L: wallLength(site, w), win: windowLength(site, w),
    door: site.openings.some((o) => o.wall === w && o.kind === 'door') ? 1 : 0,
  }));
  if (strategy === 'compact') info.sort((a, b) => b.L - a.L || a.i - b.i);
  else info.sort((a, b) => b.win - a.win || a.door - b.door || b.L - a.L || a.i - b.i);
  return info.map((x) => x.w);
}

// Greedy sweep along the walls. With `fast` (look-ahead only) the reachability test is skipped.
function placeDesks(ctx, count, strategy, fast = false) {
  const S = STANDARDS, site = ctx.site;
  let placed = 0;
  for (const wall of deskWallOrder(site, strategy)) {
    const L = wallLength(site, wall);
    for (let s = 0; s + S.deskW <= L + EPS && placed < count;) {
      const cand = deskCandidate(site, wall, s);
      if (canPlace(ctx, cand)) {
        ctx.items.push(cand);
        if (fast || unreachable(ctx).length === 0) {
          if (!fast) cand.id = `DESK-${String(++ctx.counters.desk).padStart(2, '0')}`;
          placed++;
          s += S.deskW;
          continue;
        }
        ctx.items.pop();
      }
      s += S.step;
    }
  }
  return placed;
}

// How many of the desks still to come would fit if `cand` were placed.
function desksAfter(ctx, cand, count, strategy) {
  const sim = { ...ctx, items: [...ctx.items, cand] };
  return placeDesks(sim, count, strategy, true);
}

// Try candidates best-first; accept the first that keeps every placed item reachable.
// With `ahead` (desks still to be placed), candidates are first ranked by how many of those desks they leave room for.
function placeBest(ctx, cands, score, ahead) {
  let valid = cands.filter((c) => canPlace(ctx, c)).map((c) => ({ c, k: score(c), fit: 0 }));
  if (ahead && ahead.count > 0 && valid.length) {
    const stride = Math.max(1, Math.floor(valid.length / 150));
    valid = valid.filter((_, i) => i % stride === 0);
    for (const v of valid) v.fit = desksAfter(ctx, v.c, ahead.count, ahead.strategy);
  }
  valid.sort((a, b) => b.fit - a.fit || a.k - b.k);
  let tested = 0;
  for (const { c } of valid) {
    if (tested++ > 300) break;
    ctx.items.push(c);
    if (unreachable(ctx).length === 0) return c;
    ctx.items.pop();
  }
  return null;
}

function placeBooths(ctx, count, strategy, ahead) {
  const S = STANDARDS, site = ctx.site, doors = doorCentres(site);
  let placed = 0;
  for (let k = 0; k < count; k++) {
    const cands = [];
    for (const wall of WALLS) {
      const L = wallLength(site, wall);
      for (let s = 0; s + S.boothW <= L + EPS; s += S.grid) cands.push(boothCandidate(site, wall, s));
      if ((L - S.boothW) % S.grid) cands.push(boothCandidate(site, wall, L - S.boothW));
    }
    const doorDist = (c) => {
      const [cx, cy] = centre(c.rect);
      return doors.length ? Math.min(...doors.map(([x, y]) => Math.hypot(cx - x, cy - y))) : 0;
    };
    const score = strategy === 'compact'
      ? (c) => Math.min(c.s, wallLength(site, c.wall) - c.s - S.boothW) * 10 - doorDist(c) / 1000
      : (c) => -doorDist(c) + windowLength(site, c.wall) / 10;
    const got = placeBest(ctx, cands, score, ahead);
    if (!got) break;
    got.id = `BOOTH-${String(++ctx.counters.booth).padStart(2, '0')}`;
    placed++;
  }
  return placed;
}

function placeTable(ctx, seats, ahead) {
  const S = STANDARDS, site = ctx.site, { width: W, depth: D } = site;
  const { length, depth } = tableSize(seats);
  const cands = [];
  for (const rot of [0, 90]) {
    const tw = rot === 0 ? length : depth, td = rot === 0 ? depth : length;
    for (let x = S.tableRing; x + tw + S.tableRing <= W + EPS; x += S.grid) {
      for (let y = S.tableRing; y + td + S.tableRing <= D + EPS; y += S.grid) {
        const rect = { x0: x, y0: y, x1: x + tw, y1: y + td };
        cands.push({ kind: 'table', rot, lw: length, ld: depth, h: S.tableH, seats, rect, access: [expand(rect, S.tableRing)] });
      }
    }
  }
  const target = [W / 2, D / 2];
  const longAxisBonus = (c) => ((W >= D) === (c.rot === 0) ? 0 : 1);
  const got = placeBest(ctx, cands, (c) => {
    const [cx, cy] = centre(c.rect);
    return Math.hypot(cx - target[0], cy - target[1]) + longAxisBonus(c);
  }, ahead);
  if (got) got.id = 'TABLE-01';
  return got;
}

// ---------- reachability ----------

// Ids of placed items whose access zone cannot be reached from any door with a clear passage.
function unreachable(ctx) {
  const S = STANDARDS, site = ctx.site, g = S.grid, r = S.passage / 2;
  const nx = Math.ceil(site.width / g), ny = Math.ceil(site.depth / g);
  const walk = new Uint8Array(nx * ny);
  const lo = (v) => Math.max(0, Math.floor((v + EPS) / g - 0.5) + 1);       // first cell centre > v
  const hi = (v, n) => Math.min(n - 1, Math.ceil((v - EPS) / g - 0.5) - 1); // last cell centre < v
  for (let j = lo(r - 2 * EPS); j <= hi(site.depth - r + 2 * EPS, ny); j++) {
    for (let i = lo(r - 2 * EPS); i <= hi(site.width - r + 2 * EPS, nx); i++) walk[j * nx + i] = 1;
  }
  for (const it of ctx.items) {
    const b = expand(it.rect, r);
    for (let j = lo(b.y0), j1 = hi(b.y1, ny); j <= j1; j++) for (let i = lo(b.x0), i1 = hi(b.x1, nx); i <= i1; i++) walk[j * nx + i] = 0;
  }
  const seen = new Uint8Array(nx * ny), queue = [];
  for (const o of site.openings) {
    if (o.kind !== 'door') continue;
    const [x, y] = wallPoint(site, o.wall, (o.s0 + o.s1) / 2, r + g / 2);
    const i = Math.min(nx - 1, Math.max(0, Math.floor(x / g))), j = Math.min(ny - 1, Math.max(0, Math.floor(y / g)));
    if (walk[j * nx + i] && !seen[j * nx + i]) { seen[j * nx + i] = 1; queue.push(j * nx + i); }
  }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], i = c % nx, j = (c - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const k = b * nx + a;
      if (walk[k] && !seen[k]) { seen[k] = 1; queue.push(k); }
    }
  }
  const out = [];
  for (const it of ctx.items) {
    const zone = it.access[0];
    let hit = false;
    const i0 = Math.max(0, Math.floor(zone.x0 / g)), i1 = Math.min(nx - 1, Math.floor(zone.x1 / g));
    const j0 = Math.max(0, Math.floor(zone.y0 / g)), j1 = Math.min(ny - 1, Math.floor(zone.y1 / g));
    for (let j = j0; j <= j1 && !hit; j++) for (let i = i0; i <= i1 && !hit; i++) {
      const cx = (i + 0.5) * g, cy = (j + 0.5) * g;
      if (seen[j * nx + i] && cx > zone.x0 && cx < zone.x1 && cy > zone.y0 && cy < zone.y1 &&
        !(cx > it.rect.x0 && cx < it.rect.x1 && cy > it.rect.y0 && cy < it.rect.y1)) hit = true;
    }
    if (!hit) out.push(it);
  }
  return out;
}

// ---------- elements ----------

function chairAt(site, it, s, n, rot, role, id) {
  const S = STANDARDS;
  const half = S.chairW / 2;
  const rect = wallRect(site, it.wall, s - half, s + half, n - half, n + half);
  return { id, kind: 'chair', role, rot, lw: S.chairW, ld: S.chairD, h: S.chairH, ...rect, of: it.id };
}

function toElements(site, items) {
  const S = STANDARDS, out = [];
  let chairs = 0;
  const chairId = () => `CHAIR-${String(++chairs).padStart(2, '0')}`;
  for (const it of items) {
    out.push({ id: it.id, kind: it.kind, rot: it.rot, lw: it.lw, ld: it.ld, h: it.h, ...it.rect,
      wall: it.wall, access: it.access.map((a) => ({ ...a })), seats: it.seats });
    if (it.kind === 'desk') out.push(chairAt(site, it, it.s + S.deskW / 2, S.deskD + 350, (it.rot + 180) % 360, 'desk', chairId()));
    if (it.kind === 'table') {
      const { perSide } = tableSize(it.seats);
      const long = it.rot === 0 ? 'x' : 'y';
      const r = it.rect, half = S.chairW / 2, gap = 100;
      for (let k = 0; k < it.seats; k++) {
        const side = k % 2, idx = Math.floor(k / 2);
        const t = (idx + 0.5) / perSide;
        let cx, cy, rot;
        if (long === 'x') {
          cx = r.x0 + t * (r.x1 - r.x0);
          cy = side ? r.y1 + gap + half : r.y0 - gap - half;
          rot = side ? 180 : 0;
        } else {
          cy = r.y0 + t * (r.y1 - r.y0);
          cx = side ? r.x0 - gap - half : r.x1 + gap + half;
          rot = side ? 270 : 90;
        }
        out.push({ id: chairId(), kind: 'chair', role: 'meeting', rot, lw: S.chairW, ld: S.chairD, h: S.chairH,
          x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half, of: it.id });
      }
    }
  }
  return out;
}

function dimensionChains(site) {
  const dims = {};
  for (const w of WALLS) {
    const L = wallLength(site, w);
    const pts = [0];
    for (const o of site.openings.filter((x) => x.wall === w).sort((a, b) => a.s0 - b.s0)) pts.push(o.s0, o.s1);
    pts.push(L);
    const points = [...new Set(pts)].sort((a, b) => a - b);
    dims[w] = { length: L, start: WALL_CORNERS[w][0], end: WALL_CORNERS[w][1], points,
      segments: points.slice(1).map((p, i) => p - points[i]) };
  }
  return dims;
}

// ---------- main ----------

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest]));
}

function lexBetter(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function runOrder(site, zones, prog, strategy, order) {
  const ctx = { site, zones, items: [], counters: { desk: 0, booth: 0 } };
  const placed = { desks: 0, booths: 0, table: 0 };
  for (const [i, step] of order.entries()) {
    const ahead = order.indexOf('desks') > i ? { count: prog.desks, strategy } : null;
    if (step === 'desks') placed.desks = placeDesks(ctx, prog.desks, strategy);
    if (step === 'booths') placed.booths = placeBooths(ctx, prog.booths, strategy, ahead);
    if (step === 'table' && prog.meetingSeats > 0) placed.table = placeTable(ctx, prog.meetingSeats, ahead) ? 1 : 0;
  }
  return { ctx, placed };
}

function resolveProgramme(p, report) {
  const src = p || {};
  const out = {};
  for (const [key, max] of [['desks', 200], ['meetingSeats', 20], ['booths', 10]]) {
    const raw = num(src[key], 0);
    const v = Math.max(0, Math.min(max, Math.round(raw)));
    if (v !== raw) report('warn', `programme.${key}`, `Programme ${key} ${raw} adjusted to ${v} (allowed 0–${max}).`);
    out[key] = v;
  }
  return out;
}

export function generate(state) {
  const checks = [];
  const report = (level, code, msg, extra) => checks.push({ level, code, msg, ...extra });
  const st = state || {};

  let tier = st.tier || 'S';
  if (!TIERS[tier] || !TIERS[tier].available) {
    report('info', 'tier', `Tier ${tier} is not built yet; generated with tier S.`);
    tier = 'S';
  }
  let strategy = st.strategy;
  if (!STRATEGIES[strategy]) {
    if (strategy !== undefined) report('warn', 'strategy', `Unknown strategy "${strategy}"; using daylight.`);
    strategy = 'daylight';
  }

  const site = resolveSite(st.site, report);
  const prog = resolveProgramme(st.programme, report);
  const zones = siteZones(site);
  // The strategy's own order first; other orders are kept only if they do strictly better
  // on the strategy's priorities (its order, read left to right).
  const priority = STRATEGIES[strategy].order;
  let ctx = null, best = null;
  const wanted = priority.map((k) => (k === 'desks' ? prog.desks : k === 'booths' ? prog.booths : prog.meetingSeats > 0 ? 1 : 0));
  for (const order of [priority, ...permutations(priority).filter((o) => o.join() !== priority.join())]) {
    if (best && best.every((v, i) => v === wanted[i])) break;
    const run = runOrder(site, zones, prog, strategy, order);
    const vec = priority.map((k) => run.placed[k]);
    if (!best || lexBetter(vec, best)) {
      best = vec;
      ctx = run.ctx;
    }
  }

  const lost = unreachable(ctx);
  if (lost.length) {
    const ids = new Set(lost.map((x) => x.id));
    for (const it of lost) {
      report('warn', `reach.${it.kind}`, `${it.id} removed: its ${it.kind === 'desk' ? 'chair zone' : 'access zone'} cannot be reached from a door with a ${mm(STANDARDS.passage)} passage.`, { ref: it.id });
    }
    ctx.items = ctx.items.filter((it) => !ids.has(it.id));
  }

  const elements = toElements(site, ctx.items);
  const count = (k, role) => elements.filter((e) => e.kind === k && (!role || e.role === role)).length;
  const readouts = {
    desksRequested: prog.desks, desksPlaced: count('desk'),
    meetingSeatsRequested: prog.meetingSeats, meetingSeatsPlaced: count('chair', 'meeting'),
    boothsRequested: prog.booths, boothsPlaced: count('booth'),
    floorArea: Math.round(site.width * site.depth / 1e4) / 100,
    openings: site.openings.length,
  };
  readouts.workpoints = readouts.desksPlaced;
  readouts.areaPerWorkpoint = readouts.workpoints ? Math.round(readouts.floorArea / readouts.workpoints * 100) / 100 : null;

  const short = (req, got, what, why) => {
    if (got < req) report('warn', `programme.${what}`, `Placed ${got} of ${req} ${what === 'meetingSeats' ? 'meeting seats' : what}; ${req - got} short. ${why}`, { amount: req - got });
  };
  short(prog.desks, readouts.desksPlaced, 'desks', 'No more wall run is free of door, window and access clearances.');
  short(prog.booths, readouts.boothsPlaced, 'booths', 'A booth needs a solid wall stretch of 1100 mm clear of windows and doors.');
  short(prog.meetingSeats, readouts.meetingSeatsPlaced, 'meetingSeats', 'No free area left for the table and its chair ring.');

  if (site.openings.length) report('info', 'site.fixed', `Site: ${mm(site.width)} × ${mm(site.depth)}, ${site.openings.length} opening(s).`);

  return { version: 1, tier, strategy, site, zones, elements, checks, readouts, dims: dimensionChains(site) };
}
