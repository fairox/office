// Build file for the Archicad side: format "office-configurator-build", version 1.
// Pure (no DOM). Model coordinates are metres in the design's own frame (origin at the interior
// south-west corner, x east, y north, z up from the story level); `placement` moves and turns
// that frame into the project.
import { WALLS, wallLength } from './generator.js';

export const BUILD_FORMAT = 'office-configurator-build';
export const BUILD_VERSION = 1;

export const LAYERS = Object.freeze({
  walls: 'OFFICE - Walls', rooms: 'OFFICE - Rooms', workstations: 'OFFICE - Workstations',
  meeting: 'OFFICE - Meeting', storage: 'OFFICE - Storage', furniture: 'OFFICE - Furniture',
});

// One surface per configurator colour; the Archicad side names it "OFFICE <material> #rrggbb".
export const MATERIALS = Object.freeze({
  deskTop: ['Oak', '#d9c7a5'], steel: ['Steel', '#5d636b'], fabric: ['Fabric', '#46505c'],
  tableTop: ['Oak', '#c9b38c'], felt: ['Felt', '#6f9c8a'], feltDark: ['Felt', '#3f5f53'],
});

const m = (mm) => Math.round(mm * 10) / 10000; // mm -> m, rounded to 0.1 mm

function box(key, el, part, layer, material, x0, y0, z0, x1, y1, z1) {
  const [name, color] = MATERIALS[material];
  return { key, element: el.id, kind: el.kind, part, rot: el.rot, layer, material: name, color,
    min: [m(x0), m(y0), m(z0)], size: [m(x1 - x0), m(y1 - y0), m(z1 - z0)] };
}

function layerOf(el) {
  if (el.kind === 'desk' || (el.kind === 'chair' && el.role === 'desk')) return LAYERS.workstations;
  if (el.kind === 'table' || el.kind === 'booth' || el.kind === 'chair') return LAYERS.meeting;
  if (el.kind === 'storage') return LAYERS.storage;
  return LAYERS.furniture;
}

// Each furniture element as the boxes the 3D view draws: desk top + two end panels, chair seat + back, ...
function partsOf(el) {
  const L = layerOf(el), out = [];
  if (el.kind === 'desk') {
    out.push(box(`${el.id}-TOP`, el, 'top', L, 'deskTop', el.x0, el.y0, el.h - 25, el.x1, el.y1, el.h));
    const alongX = el.rot % 180 === 0;
    const ends = alongX ? [[el.x0, el.y0, el.x0 + 30, el.y1], [el.x1 - 30, el.y0, el.x1, el.y1]]
      : [[el.x0, el.y0, el.x1, el.y0 + 30], [el.x0, el.y1 - 30, el.x1, el.y1]];
    ends.forEach(([a, b, c, d], i) => out.push(box(`${el.id}-LEG${i + 1}`, el, 'leg', L, 'steel', a, b, 0, c, d, el.h - 25)));
  } else if (el.kind === 'chair') {
    const s = { x0: el.x0 + 40, y0: el.y0 + 40, x1: el.x1 - 40, y1: el.y1 - 40 };
    out.push(box(`${el.id}-SEAT`, el, 'seat', L, 'fabric', s.x0, s.y0, 420, s.x1, s.y1, 470));
    const a = (el.rot * Math.PI) / 180, dx = Math.round(Math.sin(a)), dy = Math.round(-Math.cos(a));
    const b = dx > 0 ? { ...s, x0: s.x1 - 60 } : dx < 0 ? { ...s, x1: s.x0 + 60 } : dy > 0 ? { ...s, y0: s.y1 - 60 } : { ...s, y1: s.y0 + 60 };
    out.push(box(`${el.id}-BACK`, el, 'back', L, 'fabric', b.x0, b.y0, 470, b.x1, b.y1, el.h));
  } else if (el.kind === 'table') {
    const cx = (el.x0 + el.x1) / 2, cy = (el.y0 + el.y1) / 2;
    if (el.shape === 'round') {
      const [name, color] = MATERIALS.tableTop;
      out.push({ key: `${el.id}-TOP`, element: el.id, kind: el.kind, part: 'top', rot: 0, layer: L, material: name, color,
        shape: 'prism', centre: [m(cx), m(cy)], radius: m((el.x1 - el.x0) / 2), sides: 24, z: [m(el.h - 30), m(el.h)],
        min: [m(el.x0), m(el.y0), m(el.h - 30)], size: [m(el.x1 - el.x0), m(el.y1 - el.y0), m(30)] });
    } else {
      out.push(box(`${el.id}-TOP`, el, 'top', L, 'tableTop', el.x0, el.y0, el.h - 30, el.x1, el.y1, el.h));
    }
    out.push(box(`${el.id}-BASE`, el, 'base', L, 'steel', cx - 150, cy - 150, 0, cx + 150, cy + 150, el.h - 30));
  } else if (el.kind === 'booth') {
    out.push(box(`${el.id}-BODY`, el, 'body', L, 'felt', el.x0, el.y0, 0, el.x1, el.y1, el.h - 60));
    out.push(box(`${el.id}-ROOF`, el, 'roof', L, 'feltDark', el.x0, el.y0, el.h - 60, el.x1, el.y1, el.h));
  }
  return out;
}

// Wall reference lines run along the wall centre, corner to corner, so the walls join at the corners
// and an opening's centre offset is half a wall thickness plus its distance from the start corner.
function siteWalls(site) {
  const t = site.wall, W = site.width, D = site.depth, h = t / 2;
  const ends = { S: [[-h, -h], [W + h, -h]], E: [[W + h, -h], [W + h, D + h]], N: [[W + h, D + h], [-h, D + h]], W: [[-h, D + h], [-h, -h]] };
  return WALLS.map((w) => ({ key: `WALL-${w}`, side: w, layer: LAYERS.walls,
    beg: ends[w][0].map(m), end: ends[w][1].map(m), thickness: m(t), height: m(site.height), length: m(wallLength(site, w) + t) }));
}

export function slug(name) {
  return String(name || 'office').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'office';
}

export function buildFile(state, layout, { name = 'Office', created = new Date().toISOString() } = {}) {
  const site = layout.site, t = site.wall;
  const placement = state.placement && typeof state.placement === 'object' ? state.placement : null;
  const walls = siteWalls(site);
  const openings = site.openings.map((o) => ({
    key: o.id, kind: o.kind, wall: `WALL-${o.wall}`, layer: LAYERS.walls,
    centerOffset: m(t / 2 + (o.s0 + o.s1) / 2), width: m(o.s1 - o.s0), height: m(o.height), sill: m(o.sill),
    swing: o.kind === 'door' ? o.swing : undefined, hinge: o.kind === 'door' ? o.hinge : undefined,
  }));
  const zones = [{
    key: 'ZONE-01', name: placement && placement.zoneName ? placement.zoneName : name, number: '01', category: 'open office',
    layer: LAYERS.rooms, height: m(site.height),
    polygon: [[0, 0], [site.width, 0], [site.width, site.depth], [0, site.depth]].map((p) => p.map(m)),
  }];
  const boxes = layout.elements.flatMap(partsOf);
  const checks = layout.checks.filter((c) => c.level === 'error' || c.level === 'warn').map(({ level, code, msg }) => ({ level, code, msg }));
  return {
    format: BUILD_FORMAT,
    version: BUILD_VERSION,
    created,
    name,
    mode: 'replace',
    // A site taken from an Archicad Zone already has its walls in the project.
    walls: !(placement && placement.fromZone),
    placement: {
      origin: placement && Array.isArray(placement.origin) ? placement.origin.slice(0, 3).map(Number) : [0, 0, 0],
      rotationDeg: placement ? Number(placement.rotationDeg) || 0 : 0,
      story: placement ? Number(placement.story) || 0 : 0,
    },
    model: {
      units: 'm',
      tier: layout.tier, strategy: layout.strategy,
      site: { width: m(site.width), depth: m(site.depth), height: m(site.height), wallThickness: m(t) },
      walls, openings, beams: [], zones, boxes, checks,
      readouts: layout.readouts,
    },
  };
}
