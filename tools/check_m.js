// Tier M checks: run by tools/check.js. Geometry is re-derived from the raw input with this file's own
// polygon tests, so the generator cannot vouch for itself.
import { generate, STRATEGIES, STANDARDS } from '../web/generator.js';
import { PRESETS_M, presetStateM } from '../web/presets.js';

const EPS = 0.5;
const clone = (x) => JSON.parse(JSON.stringify(x));
const ov = (a, b) => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
const within = (a, b) => a.x0 >= b.x0 - EPS && a.y0 >= b.y0 - EPS && a.x1 <= b.x1 + EPS && a.y1 <= b.y1 + EPS;
const rs = (r) => `[${Math.round(r.x0)},${Math.round(r.y0)}–${Math.round(r.x1)},${Math.round(r.y1)}]`;

// independent containment: sample the rectangle's boundary and interior on a 50 mm lattice
function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (Math.min(xi, xj) - EPS <= x && x <= Math.max(xi, xj) + EPS && Math.min(yi, yj) - EPS <= y && y <= Math.max(yi, yj) + EPS && (xi === xj || yi === yj)) {
      if ((xi === xj && Math.abs(x - xi) < EPS) || (yi === yj && Math.abs(y - yi) < EPS)) return true;
    }
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function rectInside(poly, r) {
  const sx = Math.max(1, Math.ceil((r.x1 - r.x0) / 50)), sy = Math.max(1, Math.ceil((r.y1 - r.y0) / 50));
  for (let i = 0; i <= sx; i++) for (let j = 0; j <= sy; j++) {
    if (!inside(poly, r.x0 + ((r.x1 - r.x0) * i) / sx, r.y0 + ((r.y1 - r.y0) * j) / sy)) return false;
  }
  return true;
}
function ccw(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [a, b] = poly[i], [c, d] = poly[(i + 1) % poly.length]; s += a * d - c * b; }
  return s > 0 ? poly : [...poly].reverse();
}

export function runM({ expect, runCaseHooks }) {
  let cases = 0;
  const verify = (name, state, L, { clean = false } = {}) => {
    const E = L.elements, site = L.site, poly = site.outline;
    const solid = E.filter((e) => ['desk', 'table', 'booth', 'storage', 'room', 'partition', 'column', 'core'].includes(e.kind));
    // inside the plate
    for (const e of E) {
      if (e.kind === 'column' || e.kind === 'core') continue;
      for (const r of [e, ...(e.access || [])]) expect(name, rectInside(poly, r), `${e.id} ${rs(r)} leaves the floor plate`);
    }
    // overlaps: only a room with its own partitions and furniture
    const allowed = (a, b) => (a.kind === 'room' && (b.room === a.id || b.of === a.id)) || (b.kind === 'room' && (a.room === b.id || a.of === b.id)) ||
      (a.kind === 'partition' && b.kind === 'partition' && a.of === b.of);
    for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
      const a = E[i], b = E[j];
      if (a.kind === 'chair' && b.kind === 'chair') { expect(name, !ov(a, b), `${a.id} overlaps ${b.id}`); continue; }
      if (allowed(a, b)) continue;
      expect(name, !ov(a, b), `${a.id} (${a.kind}) ${rs(a)} overlaps ${b.id} (${b.kind}) ${rs(b)}`);
    }
    for (const a of solid) for (const b of E) {
      if (a === b || allowed(a, b) || !a.access) continue;
      for (const z of a.access) if (b.kind !== 'chair' || b.of !== a.id) expect(name, !(ov(z, b) && b.kind !== 'chair'), `${b.id} stands in the access zone of ${a.id}`);
    }
    // room contents stay inside the room, clear of the partitions and the door swing
    for (const r of E.filter((e) => e.kind === 'room')) {
      for (const f of E.filter((e) => e.room === r.id)) {
        expect(name, within(f, r.interior), `${f.id} sticks out of ${r.id}`);
        expect(name, !ov(f, r.swing), `${f.id} is in the door swing of ${r.id}`);
      }
      for (const p of E.filter((e) => e.of === r.id && e.kind === 'partition')) expect(name, within(p, r), `${p.id} outside its room`);
    }
    // clearances from the input: door swings / thresholds / core front / window bands
    for (const z of L.zones) {
      for (const e of E) {
        if (e.kind === 'column' || e.kind === 'core' || e.kind === 'chair') continue;
        if (z.kind === 'window-band') { if ((e.h || 0) > z.sill) expect(name, !ov(e, z), `${e.id} (${e.h} mm) stands across window band of ${z.ref}`); }
        else expect(name, !ov(e, z) || e.kind === 'room' && false, `${e.id} stands in the ${z.kind} of ${z.ref}`);
      }
    }
    // aisles: nothing solid in them, except columns, which must be reported
    for (const a of L.aisles) {
      expect(name, rectInside(poly, a), `aisle ${a.id} leaves the plate`);
      for (const e of solid) {
        if (!ov(e, a.rect)) continue;
        if (e.kind === 'column') expect(name, L.checks.some((c) => c.code === 'aisle.column' && c.ref === e.id), `${e.id} in aisle ${a.id} is not reported`);
        else expect(name, false, `${e.id} (${e.kind}) stands in aisle ${a.id}`);
      }
    }
    for (const x of site.openings.filter((o) => o.kind === 'door').map((o) => o.id).concat(site.core ? ['CORE'] : [])) {
      const linked = L.graph.edges.some((g) => g.from === x);
      expect(name, linked || L.checks.some((c) => c.code === 'aisle.connector' && c.ref === x) || !L.aisles.length, `exit ${x} has no aisle and no report`);
    }
    // pinned rooms: exactly where asked, or reported as moved / unplaced
    for (const p of (state.programmeM && state.programmeM.pinned) || []) {
      const r = E.find((e) => e.kind === 'room' && e.id === p.id);
      const rep = L.checks.find((c) => c.ref === p.id && (c.code === 'pinned.moved' || c.code === 'pinned.unplaced' || c.code === 'pinned.type'));
      if (!r) { expect(name, !!rep, `pinned ${p.id} missing without a report`); continue; }
      const exact = Math.abs(r.x0 - p.x) < EPS && Math.abs(r.y0 - p.y) < EPS && r.front === (p.front || 'S');
      if (exact) expect(name, !rep, `pinned ${p.id} in place but reported as moved`);
      else expect(name, rep && rep.code === 'pinned.moved' && Math.abs(rep.amount - Math.hypot(r.x0 - p.x, r.y0 - p.y)) <= 1, `pinned ${p.id} moved by ${Math.round(Math.hypot(r.x0 - p.x, r.y0 - p.y))} mm, report says ${rep && rep.amount}`);
    }
    // programme met or reported
    const rd = L.readouts, rep = (code) => L.checks.find((c) => c.code === code);
    const pm = state.programmeM || {};
    const want = (pm.neighbourhoods || []).reduce((t, n) => t + Math.max(0, Math.round(Number(n.desks) || 0)), 0);
    if (rd.desksPlaced < want) expect(name, rep('programme.desks') && rep('programme.desks').amount === want - rd.desksPlaced, `desks short by ${want - rd.desksPlaced} without a report`);
    for (const [t, n] of Object.entries(pm.rooms || {})) {
      const pinnedOfType = (pm.pinned || []).filter((p) => p.type === t).length;
      const ask = Math.max(n, pinnedOfType), got = E.filter((e) => e.kind === 'room' && e.type === t).length;
      if (got < ask) expect(name, rep(`programme.room.${t}`) && rep(`programme.room.${t}`).amount === ask - got, `${t}: ${got}/${ask} without a report`);
    }
    // readouts match geometry
    const cnt = (k, f = () => true) => E.filter((e) => e.kind === k && f(e)).length;
    expect(name, rd.desksPlaced === cnt('desk', (e) => !e.room), 'desksPlaced readout');
    expect(name, rd.focusDesks === cnt('desk', (e) => e.room), 'focusDesks readout');
    expect(name, rd.roomsPlaced === cnt('room'), 'roomsPlaced readout');
    expect(name, rd.boothsPlaced === cnt('booth'), 'boothsPlaced readout');
    expect(name, rd.columns === cnt('column'), 'columns readout');
    expect(name, cnt('chair', (e) => e.role === 'desk') === cnt('desk'), 'one chair per desk');
    const travelVals = [...Object.values(L.travel.perDesk), ...Object.values(L.travel.perRoom)].filter((v) => v !== null);
    expect(name, rd.travelMax === (travelVals.length ? Math.max(...travelVals) : 0), 'travelMax readout is the largest travel distance');
    expect(name, Object.keys(L.travel.perDesk).length === rd.desksPlaced, 'travel distance for every open-plan desk');
    expect(name, Object.values(L.travel.perDesk).every((v) => v !== null), 'every desk has a finite travel distance');
    if (rd.travelMax > rd.travelLimit) expect(name, !!rep('travel.limit'), 'travel over the limit is reported');
    // a travel distance is never shorter than the straight line to the nearest exit
    const exits = site.openings.filter((o) => o.kind === 'door').map((o) => {
      const e = site.edges[o.edge], L2 = e.length, t = (o.s0 + o.s1) / 2 / L2;
      return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
    }).concat(site.core ? [[(site.core.doorRect.x0 + site.core.doorRect.x1) / 2, (site.core.doorRect.y0 + site.core.doorRect.y1) / 2]] : []);
    for (const d of E.filter((e) => e.kind === 'desk' && !e.room)) {
      const z = d.access[0], c = [(z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2];
      const straight = Math.min(...exits.map(([x, y]) => Math.hypot(c[0] - x, c[1] - y))) - Math.hypot(z.x1 - z.x0, z.y1 - z.y0) / 2 - 300;
      expect(name, L.travel.perDesk[d.id] >= straight - 1, `${d.id} travel ${L.travel.perDesk[d.id]} is shorter than the straight line ${Math.round(straight)}`);
    }
    // dimension chains
    for (const [id, ch] of Object.entries(L.dims)) expect(name, ch.segments.reduce((a, b) => a + b, 0) === ch.length, `${id} chain sum`);
    if (clean) {
      const errs = L.checks.filter((c) => c.level === 'error');
      expect(name, !errs.length, `errors: ${errs.map((c) => c.msg).join(' | ')}`);
      expect(name, !L.checks.some((c) => c.code.startsWith('reach.')), 'items lost to reachability');
    }
  };

  const run = (name, state, opts = {}) => {
    cases++;
    const before = clone(state), t = performance.now();
    const L = generate(state);
    const ms = performance.now() - t;
    expect(name, JSON.stringify(state) === JSON.stringify(before), 'generate() mutated its input');
    expect(name, ms < (opts.maxMs || 4000), `took ${ms.toFixed(0)} ms`);
    verify(name, state, L, opts);
    for (const c of opts.expectCodes || []) expect(name, L.checks.some((x) => x.code === c), `expected a ${c} report; got ${L.checks.map((x) => x.code).join(', ')}`);
    if (runCaseHooks.verbose) console.log(`  ${name.padEnd(44)} ${ms.toFixed(0).padStart(5)} ms  ${JSON.stringify(L.readouts)}`);
    return L;
  };

  console.log('Tier M presets x strategies');
  for (const key of Object.keys(PRESETS_M)) {
    const sites = [];
    for (const s of Object.keys(STRATEGIES)) {
      const st = presetStateM(key, s);
      st.siteFixed = true;
      const L = run(`M/${key}/${s}`, st, { clean: true, maxMs: 2000 });
      sites.push(JSON.stringify(L.site));
      if (s === 'daylight') {
        const r = L.readouts;
        expect(`M/${key}`, r.desksPlaced === r.desksRequested && r.roomsPlaced >= r.roomsRequested && r.boothsPlaced === r.boothsRequested && r.meetingSeatsPlaced === r.meetingSeatsRequested, `programme not met: ${JSON.stringify(r)}`);
      }
    }
    expect(`M/${key}`, sites.every((x) => x === sites[0]), 'fixed site differs between strategies');
  }

  console.log('Tier M stress cases');
  const door = (id, edge, offset, extra = {}) => ({ id, kind: 'door', edge, ref: 'start', offset, width: 1800, height: 2400, swing: 'out', ...extra });
  const win = (id, edge, offset, width, extra = {}) => ({ id, kind: 'window', edge, ref: 'start', offset, width, height: 2000, sill: 800, ...extra });
  const rect = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];
  const mk = (siteM, programmeM) => ({ v: 1, tier: 'M', strategy: 'daylight', siteFixed: true, siteM: { height: 3000, wall: 300, ...siteM },
    programmeM: { neighbourhoods: [{ name: 'A', desks: 12 }], rooms: { meetingS: 2, focus: 2 }, booths: 1, meetingSeats: 0, pinned: [], ...programmeM } });
  const stress = {
    // every straight 1800 mm band hits a column: the generator must say how much clear width is left
    'columns in aisles': [mk({ outline: rect(30000, 12000), openings: [door('DOOR-1', 0, 3000), win('WIN-1', 2, 2000, 26000)],
      columns: { spacingX: 3000, spacingY: 2000, offsetX: 1500, offsetY: 1000, size: 400 } }, {}), { expectCodes: ['aisle.column'] }],
    // the only entry is in the short end wall, right where the spine runs
    'door in the spine': [mk({ outline: rect(32000, 14000), openings: [door('DOOR-1', 1, 6100), win('WIN-1', 0, 2000, 28000), win('WIN-2', 2, 2000, 28000)],
      columns: { spacingX: 8000, spacingY: 7000, offsetX: 8000, offsetY: 3500 } }, { neighbourhoods: [{ name: 'A', desks: 24 }] }), {}],
    // windows meet at a convex corner on two edges
    'corner windows': [mk({ outline: rect(24000, 16000), openings: [door('DOOR-1', 3, 6000), win('WIN-1', 0, 14000, 10000), win('WIN-2', 1, 0, 10000),
      win('WIN-3', 2, 0, 9000), win('WIN-4', 1, 11000, 5000)], core: { x: 3000, y: 6000, w: 4000, d: 4000, door: 'E' } }, { neighbourhoods: [{ name: 'A', desks: 18 }] }), {}],
    'U-shaped floor': [mk({ outline: [[0, 0], [30000, 0], [30000, 20000], [22000, 20000], [22000, 8000], [8000, 8000], [8000, 20000], [0, 20000]],
      openings: [door('DOOR-1', 0, 14000), win('WIN-1', 1, 1000, 18000), win('WIN-2', 7, 1000, 18000)], columns: { spacingX: 7500, spacingY: 6000, offsetX: 3750, offsetY: 4000 } }, {}), {}],
    'pinned room on the core': [mk({ outline: rect(28000, 16000), openings: [door('DOOR-1', 0, 2000)], core: { x: 11000, y: 9000, w: 6000, d: 5000, door: 'S' } },
      { pinned: [{ id: 'PIN-1', type: 'meetingS', x: 12000, y: 10000, front: 'S' }] }), { expectCodes: ['pinned.moved'] }],
    'pinned rooms on top of each other': [mk({ outline: rect(28000, 16000), openings: [door('DOOR-1', 0, 2000)] },
      { pinned: [{ id: 'PIN-1', type: 'focus', x: 2000, y: 10000, front: 'E' }, { id: 'PIN-2', type: 'focus', x: 2500, y: 10500, front: 'E' }] }), { expectCodes: ['pinned.moved'] }],
    'pinned room outside the plate': [mk({ outline: rect(20000, 12000), openings: [door('DOOR-1', 0, 2000)] }, { pinned: [{ id: 'PIN-1', type: 'meetingL', x: 50000, y: 50000 }] }), { expectCodes: ['pinned.unplaced'] }],
    'pinned room exactly placed': [mk({ outline: rect(28000, 16000), openings: [door('DOOR-1', 0, 2000)] }, { pinned: [{ id: 'PIN-1', type: 'meetingL', x: 1000, y: 11000, front: 'E' }] }), {}],
    'small floor, big programme': [mk({ outline: rect(12000, 9000), openings: [door('DOOR-1', 0, 1000)] },
      { neighbourhoods: [{ name: 'A', desks: 40 }, { name: 'B', desks: 30 }], rooms: { meetingL: 6, meetingS: 6 }, booths: 6 }), { expectCodes: ['programme.desks', 'programme.neighbourhood'] }],
    'tight travel limit': [mk({ outline: rect(40000, 14000), openings: [door('DOOR-1', 3, 6000)] }, { travelLimit: 15000, neighbourhoods: [{ name: 'A', desks: 30 }] }), { expectCodes: ['travel.limit'] }],
    'no exits': [mk({ outline: rect(20000, 12000), openings: [win('WIN-1', 0, 1000, 8000)] }, {}), { expectCodes: ['site.noexit', 'programme.desks'] }],
    'not rectilinear': [mk({ outline: [[0, 0], [20000, 0], [18000, 12000], [0, 12000]], openings: [door('DOOR-1', 0, 2000)] }, {}), { expectCodes: ['site.outline'] }],
    'clockwise outline': [mk({ outline: [[0, 0], [0, 12000], [20000, 12000], [20000, 0]], openings: [door('DOOR-1', 2, 2000)] }, {}), { expectCodes: ['site.outline'] }],
    'opening on a missing edge': [mk({ outline: rect(20000, 12000), openings: [door('DOOR-1', 0, 2000), door('DOOR-2', 9, 2000)] }, {}), { expectCodes: ['opening.edge'] }],
  };
  for (const [name, [state, opts]] of Object.entries(stress)) {
    const sites = [];
    for (const s of Object.keys(STRATEGIES)) {
      const st = clone(state);
      st.strategy = s;
      sites.push(JSON.stringify(run(`M stress/${name}/${s}`, st, opts).site));
    }
    expect(name, sites.every((x) => x === sites[0]), 'fixed site differs between strategies');
  }
  // the three acceptance stress cases must produce no errors
  for (const name of ['columns in aisles', 'door in the spine', 'corner windows']) {
    const L = generate(stress[name][0]);
    expect(`M acceptance/${name}`, !L.checks.some((c) => c.level === 'error'), `errors: ${L.checks.filter((c) => c.level === 'error').map((c) => c.msg).join(' | ')}`);
  }
  return cases;
}
