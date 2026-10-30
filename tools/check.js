// Runs the generator over every preset x tier x strategy plus stress cases and verifies the geometry.
// Geometry rules are re-derived here from the raw input, not taken from the generator,
// so a bug in the generator's own zone maths cannot hide itself.
//   node tools/check.js            all cases
//   node tools/check.js --verbose  also print each case's readouts
import { generate, STRATEGIES, TIERS, STANDARDS } from '../web/generator.js';
import { PRESETS, presetState } from '../web/presets.js';

const verbose = process.argv.includes('--verbose');
const EPS = 0.5;
let failures = 0, cases = 0, assertions = 0;

function fail(name, msg) {
  failures++;
  console.log(`  FAIL ${name}: ${msg}`);
}
function expect(name, cond, msg) {
  assertions++;
  if (!cond) fail(name, msg);
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const ov = (a, b) => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
const rectStr = (r) => `[${Math.round(r.x0)},${Math.round(r.y0)}–${Math.round(r.x1)},${Math.round(r.y1)}]`;

// Independent wall maths: each wall as start corner + unit direction + inward normal.
function wallFrame(W, D, wall) {
  return {
    S: { o: [0, 0], d: [1, 0], n: [0, 1], L: W, start: 'SW', end: 'SE' },
    E: { o: [W, 0], d: [0, 1], n: [-1, 0], L: D, start: 'SE', end: 'NE' },
    N: { o: [W, D], d: [-1, 0], n: [0, -1], L: W, start: 'NE', end: 'NW' },
    W: { o: [0, D], d: [0, -1], n: [1, 0], L: D, start: 'NW', end: 'SW' },
  }[wall];
}
function frameRect(f, s0, s1, n0, n1) {
  const pts = [[s0, n0], [s1, n1]].map(([s, n]) => [f.o[0] + f.d[0] * s + f.n[0] * n, f.o[1] + f.d[1] * s + f.n[1] * n]);
  return { x0: Math.min(pts[0][0], pts[1][0]), y0: Math.min(pts[0][1], pts[1][1]), x1: Math.max(pts[0][0], pts[1][0]), y1: Math.max(pts[0][1], pts[1][1]) };
}
function inputOpenings(state) {
  const { width: W, depth: D } = state.site;
  return (state.site.openings || []).filter((o) => ['offset', 'width'].every((k) => Number.isFinite(Number(o[k])))).map((o) => {
    const f = wallFrame(W, D, o.wall);
    const s = o.ref === f.end ? f.L - o.offset - o.width : o.offset;
    const s0 = Math.max(0, s), s1 = Math.min(f.L, s + o.width);
    return { ...o, f, s0, s1 };
  });
}

function allNumbers(x, path, out) {
  if (typeof x === 'number') { if (!Number.isFinite(x)) out.push(path); return out; }
  if (x && typeof x === 'object') for (const k of Object.keys(x)) allNumbers(x[k], `${path}.${k}`, out);
  return out;
}

function verify(name, state, layout, { clean = false } = {}) {
  const site = layout.site, W = site.width, D = site.depth;
  const els = layout.elements;
  const furniture = els.filter((e) => e.kind !== 'chair');
  const chairs = els.filter((e) => e.kind === 'chair');

  // finite geometry
  const bad = allNumbers(layout, 'layout', []).filter((p) => !p.endsWith('areaPerWorkpoint'));
  expect(name, bad.length === 0, `non-finite numbers at ${bad.slice(0, 3).join(', ')}`);

  // inside the floor plate
  for (const e of els) {
    for (const r of [e, ...(e.access || [])]) {
      expect(name, r.x0 >= -EPS && r.y0 >= -EPS && r.x1 <= W + EPS && r.y1 <= D + EPS, `${e.id} ${rectStr(r)} is outside the ${W} x ${D} floor plate`);
      expect(name, r.x1 > r.x0 && r.y1 > r.y0, `${e.id} has an empty rectangle`);
    }
  }

  // no overlaps
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const a = els[i], b = els[j];
    expect(name, !ov(a, b), `${a.id} ${rectStr(a)} overlaps ${b.id} ${rectStr(b)}`);
  }
  for (const a of furniture) for (const b of furniture) {
    if (a === b) continue;
    for (const z of a.access || []) expect(name, !ov(z, b), `${b.id} stands in the access zone of ${a.id}`);
  }
  for (const c of chairs) {
    const owner = furniture.find((f) => f.id === c.of);
    expect(name, !!owner, `${c.id} belongs to a missing element ${c.of}`);
    if (owner && owner.kind === 'desk') expect(name, ov(c, owner.access[0]), `${c.id} is not in its desk's chair zone`);
  }

  // door swing, threshold, window band (re-derived from the input)
  const S = STANDARDS;
  for (const o of inputOpenings(state)) {
    if (o.s1 - o.s0 < 300 || !layout.site.openings.some((x) => x.id === o.id)) continue;
    const across = o.wall === 'S' || o.wall === 'N' ? D : W;
    if (o.kind === 'door') {
      const zones = [frameRect(o.f, Math.max(0, o.s0 - S.thresholdSide), Math.min(o.f.L, o.s1 + S.thresholdSide), 0, Math.min(across, S.thresholdDepth))];
      if (o.swing !== 'out') zones.push(frameRect(o.f, o.s0, o.s1, 0, Math.min(across, o.s1 - o.s0)));
      for (const z of zones) for (const e of els) {
        expect(name, !ov(e, z), `${e.id} ${rectStr(e)} is in the swing/threshold of ${o.id} ${rectStr(z)}`);
        for (const a of e.access || []) expect(name, !ov(a, z), `access zone of ${e.id} is in the swing/threshold of ${o.id}`);
      }
    } else {
      const band = frameRect(o.f, o.s0, o.s1, 0, Math.min(across, S.windowBandDepth));
      for (const e of furniture) if (e.h > (o.sill ?? 900)) expect(name, !ov(e, band), `${e.id} (${e.h} mm tall) stands across window band of ${o.id} (sill ${o.sill})`);
    }
  }

  // programme met or reported, with the measured amount
  const rd = layout.readouts;
  const codes = (c) => layout.checks.filter((x) => x.code === c);
  for (const [key, placed, req] of [['desks', rd.desksPlaced, rd.desksRequested], ['booths', rd.boothsPlaced, rd.boothsRequested], ['meetingSeats', rd.meetingSeatsPlaced, rd.meetingSeatsRequested]]) {
    if (placed < req) {
      const msg = codes(`programme.${key}`)[0];
      expect(name, !!msg && msg.amount === req - placed, `${key}: ${placed}/${req} placed but no programme.${key} report with amount ${req - placed}`);
    }
    expect(name, placed <= req, `${key}: placed ${placed} exceeds requested ${req}`);
  }
  const ids = new Set(els.map((e) => e.id));
  for (const c of layout.checks.filter((x) => x.code.startsWith('reach.'))) expect(name, !ids.has(c.ref), `${c.ref} reported removed but still present`);

  // readouts match geometry
  const n = (k, role) => els.filter((e) => e.kind === k && (!role || e.role === role)).length;
  expect(name, rd.desksPlaced === n('desk'), `readout desksPlaced ${rd.desksPlaced} != ${n('desk')} desks`);
  expect(name, rd.boothsPlaced === n('booth'), `readout boothsPlaced ${rd.boothsPlaced} != ${n('booth')} booths`);
  expect(name, rd.meetingSeatsPlaced === n('chair', 'meeting'), `readout meetingSeatsPlaced ${rd.meetingSeatsPlaced} != ${n('chair', 'meeting')}`);
  expect(name, n('chair', 'desk') === n('desk'), `${n('chair', 'desk')} desk chairs for ${n('desk')} desks`);
  expect(name, Math.abs(rd.floorArea - W * D / 1e6) < 0.01, `floor area ${rd.floorArea} != ${W * D / 1e6}`);
  expect(name, rd.openings === site.openings.length, 'openings readout mismatch');

  // dimension chains: each sums to the wall length and lands on every opening edge
  for (const [w, chain] of Object.entries(layout.dims)) {
    const sum = chain.segments.reduce((t, v) => t + v, 0);
    expect(name, Math.abs(sum - chain.length) < EPS, `${w} chain sums to ${sum}, wall is ${chain.length}`);
    expect(name, chain.segments.every((v) => v > 0), `${w} chain has a zero or negative segment`);
    for (const o of inputOpenings(state).filter((x) => x.wall === w && layout.site.openings.some((y) => y.id === x.id))) {
      expect(name, chain.points.includes(Math.round(o.s0)) && chain.points.includes(Math.round(o.s1)), `${w} chain misses edges of ${o.id} (${o.s0}, ${o.s1})`);
    }
  }

  if (clean) {
    const errs = layout.checks.filter((c) => c.level === 'error');
    expect(name, errs.length === 0, `preset reports errors: ${errs.map((c) => c.msg).join(' | ')}`);
    expect(name, !layout.checks.some((c) => c.code.startsWith('reach.')), 'preset loses items to reachability');
  }
}

function runCase(name, state, opts = {}) {
  cases++;
  const before = clone(state);
  const t = performance.now();
  const layout = generate(state);
  const ms = performance.now() - t;
  expect(name, JSON.stringify(state) === JSON.stringify(before), 'generate() mutated its input');
  expect(name, ms < (opts.maxMs || 2000), `took ${ms.toFixed(0)} ms`);
  expect(name, JSON.stringify(generate(clone(state))) === JSON.stringify(layout), 'output is not deterministic');
  verify(name, state, layout, opts);
  if (opts.expectCodes) for (const c of opts.expectCodes) expect(name, layout.checks.some((x) => x.code === c), `expected a ${c} report`);
  if (verbose) console.log(`  ${name.padEnd(40)} ${ms.toFixed(0).padStart(5)} ms  ${JSON.stringify(layout.readouts)}`);
  return layout;
}

// ---------- presets x tiers x strategies ----------
console.log('Presets x tiers x strategies');
for (const key of Object.keys(PRESETS)) {
  for (const tier of Object.keys(TIERS)) {
    const sites = [];
    for (const strategy of Object.keys(STRATEGIES)) {
      const st = presetState(key, strategy);
      st.tier = tier;
      st.siteFixed = true;
      const layout = runCase(`${key}/${tier}/${strategy}`, st, { clean: true, expectCodes: TIERS[tier].available ? [] : ['tier'] });
      sites.push(JSON.stringify(layout.site));
      // the default strategy must meet each preset's programme
      if (strategy === 'daylight') {
        const r = layout.readouts;
        expect(`${key}/${tier}/${strategy}`, r.desksPlaced === r.desksRequested && r.boothsPlaced === r.boothsRequested && r.meetingSeatsPlaced === r.meetingSeatsRequested, `programme not met: ${JSON.stringify(r)}`);
      }
    }
    expect(`${key}/${tier}`, sites.every((s) => s === sites[0]), 'fixed site differs between strategies');
  }
}

// ---------- stress cases ----------
console.log('Stress cases');
const door = (id, wall, ref, offset, extra = {}) => ({ id, kind: 'door', wall, ref, offset, width: 1000, height: 2100, sill: 0, hinge: 'start', swing: 'in', ...extra });
const win = (id, wall, ref, offset, width, extra = {}) => ({ id, kind: 'window', wall, ref, offset, width, height: 1500, sill: 900, ...extra });
const mk = (site, programme, strategy = 'daylight') => ({ v: 1, tier: 'S', strategy, siteFixed: true, site: { height: 2800, wall: 200, ...site }, programme });

const stress = {
  'tiny room, big programme': [mk({ width: 2400, depth: 2400, openings: [door('DOOR-1', 'S', 'SW', 700)] }, { desks: 10, meetingSeats: 8, booths: 3 }), { expectCodes: ['programme.desks', 'programme.booths', 'programme.meetingSeats'] }],
  'large room': [mk({ width: 20000, depth: 14000, openings: [door('DOOR-1', 'S', 'SW', 2000), door('DOOR-2', 'N', 'NE', 2000), win('WIN-1', 'E', 'SE', 1000, 12000)] }, { desks: 30, meetingSeats: 12, booths: 4 })],
  'low sill along the whole window wall': [mk({ width: 7200, depth: 6000, openings: [door('DOOR-1', 'S', 'SW', 600), win('WIN-1', 'N', 'NW', 0, 7200, { sill: 600 })] }, { desks: 8, meetingSeats: 4, booths: 1 })],
  'doors hard in the corners': [mk({ width: 8000, depth: 6000, openings: [door('DOOR-1', 'S', 'SW', 0), door('DOOR-2', 'E', 'NE', 0, { hinge: 'end' }), door('DOOR-3', 'N', 'NW', 0, { swing: 'out' }), win('WIN-1', 'W', 'NW', 1000, 3000)] }, { desks: 8, meetingSeats: 6, booths: 1 })],
  'every reference corner': [mk({ width: 9000, depth: 7000, openings: [door('DOOR-1', 'S', 'SE', 900), win('WIN-1', 'E', 'NE', 600, 2000), win('WIN-2', 'N', 'NW', 600, 2000), win('WIN-3', 'W', 'SW', 600, 2000)] }, { desks: 10, meetingSeats: 6, booths: 2 })],
  'opening past the wall end': [mk({ width: 6000, depth: 5000, openings: [door('DOOR-1', 'S', 'SW', 500), win('WIN-1', 'N', 'NE', 5200, 1500)] }, { desks: 4, meetingSeats: 4, booths: 0 }), { expectCodes: ['opening.clipped'] }],
  'opening wholly outside the wall': [mk({ width: 6000, depth: 5000, openings: [door('DOOR-1', 'S', 'SW', 500), win('WIN-1', 'N', 'NE', 7000, 1500)] }, { desks: 4, meetingSeats: 0, booths: 0 }), { expectCodes: ['opening.outside'] }],
  'overlapping openings': [mk({ width: 6000, depth: 5000, openings: [door('DOOR-1', 'S', 'SW', 500), win('WIN-1', 'S', 'SW', 1200, 1500)] }, { desks: 4, meetingSeats: 4, booths: 0 }), { expectCodes: ['opening.overlap'] }],
  'no door': [mk({ width: 6000, depth: 5000, openings: [win('WIN-1', 'N', 'NW', 500, 2000)] }, { desks: 4, meetingSeats: 4, booths: 1 }), { expectCodes: ['site.nodoor', 'programme.desks'] }],
  'not-a-number input': [mk({ width: 'abc', depth: 5000, openings: [door('DOOR-1', 'S', 'SW', 'x')] }, { desks: 'four', meetingSeats: 4, booths: 0 }), { expectCodes: ['site.width', 'opening.offset'] }],
  'zero programme': [mk({ width: 6000, depth: 5000, openings: [door('DOOR-1', 'S', 'SW', 500)] }, { desks: 0, meetingSeats: 0, booths: 0 })],
  'corridor-like room, door mid long wall': [mk({ width: 10800, depth: 2600, openings: [door('DOOR-1', 'S', 'SW', 4900)] }, { desks: 6, meetingSeats: 4, booths: 1 })],
  'window head above the ceiling': [mk({ width: 6000, depth: 5000, height: 2400, openings: [door('DOOR-1', 'S', 'SW', 500), win('WIN-1', 'N', 'NW', 500, 2000, { sill: 1200 })] }, { desks: 4, meetingSeats: 0, booths: 0 }), { expectCodes: ['opening.height'] }],
  'unknown strategy and tier': [{ ...mk({ width: 6000, depth: 5000, openings: [door('DOOR-1', 'S', 'SW', 500)] }, { desks: 2, meetingSeats: 2, booths: 0 }, 'bogus'), tier: 'Q' }, { expectCodes: ['strategy', 'tier'] }],
};
for (const [name, [state, opts]] of Object.entries(stress)) {
  const sites = [];
  for (const strategy of Object.keys(STRATEGIES)) {
    const st = clone(state);
    if (STRATEGIES[st.strategy] || st.strategy === 'daylight') st.strategy = strategy;
    sites.push(JSON.stringify(runCase(`${name}/${strategy}`, st, opts || {}).site));
  }
  expect(name, sites.every((s) => s === sites[0]), 'fixed site differs between strategies');
}

// The low-sill window must keep desks out of its band.
{
  const [st] = stress['low sill along the whole window wall'];
  const L = generate(st);
  expect('low sill', !L.elements.some((e) => e.kind === 'desk' && e.wall === 'N'), 'a desk stands across the 600 mm sill');
}

// ---------- regressions (add one per fixed bug) ----------
console.log('Regressions');
{
  // Desks placed after the table used to cut off the route to it (narrow6 / meeting).
  const L = generate(presetState('narrow6', 'meeting'));
  expect('reg: narrow6 meeting reach', !L.checks.some((c) => c.code.startsWith('reach.')), 'items removed for reachability');
  cases++;
}

console.log(`\n${cases} cases, ${assertions} assertions, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
