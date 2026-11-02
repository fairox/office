// Starting points. A preset sets the site (room + openings) and the programme;
// when the site is fixed, choosing a preset only applies its programme.

const door = (id, wall, ref, offset, extra = {}) => ({ id, kind: 'door', wall, ref, offset, width: 1000, height: 2100, sill: 0, hinge: 'start', swing: 'in', ...extra });
const win = (id, wall, ref, offset, width, extra = {}) => ({ id, kind: 'window', wall, ref, offset, width, height: 1500, sill: 900, ...extra });

export const PRESETS = {
  studio4: {
    label: 'Studio, 4 desks',
    site: { width: 6000, depth: 4800, height: 2800, wall: 200,
      openings: [door('DOOR-1', 'S', 'SE', 400), win('WIN-1', 'N', 'NW', 900, 3600)] },
    programme: { desks: 4, meetingSeats: 4, booths: 0, deskLayout: 'walls', tableShape: 'round' },
  },
  team8: {
    label: 'Team room, 8 desks',
    site: { width: 7800, depth: 6600, height: 2800, wall: 200,
      openings: [door('DOOR-1', 'S', 'SW', 600), win('WIN-1', 'N', 'NW', 600, 2400), win('WIN-2', 'N', 'NE', 600, 2400)] },
    programme: { desks: 8, meetingSeats: 6, booths: 1, deskLayout: 'walls', tableShape: 'rect' },
  },
  corner10: {
    label: 'Corner office, 10 desks',
    site: { width: 9000, depth: 6600, height: 3000, wall: 250,
      openings: [door('DOOR-1', 'W', 'SW', 900, { hinge: 'end' }), win('WIN-1', 'N', 'NE', 0, 4800), win('WIN-2', 'E', 'NE', 0, 3600)] },
    programme: { desks: 10, meetingSeats: 8, booths: 2, deskLayout: 'walls', tableShape: 'rect' },
  },
  narrow6: {
    label: 'Narrow room, 6 desks',
    site: { width: 10800, depth: 4200, height: 2700, wall: 200,
      openings: [door('DOOR-1', 'E', 'SE', 1600), win('WIN-1', 'S', 'SW', 600, 6000, { sill: 800 })] },
    programme: { desks: 6, meetingSeats: 4, booths: 1, deskLayout: 'walls', tableShape: 'rect' },
  },
  twoDoors: {
    label: 'Two doors, 6 desks',
    site: { width: 8400, depth: 6000, height: 2800, wall: 200,
      openings: [door('DOOR-1', 'S', 'SW', 800), door('DOOR-2', 'N', 'NE', 800, { swing: 'out' }), win('WIN-1', 'E', 'SE', 1200, 3600)] },
    programme: { desks: 6, meetingSeats: 6, booths: 1, deskLayout: 'walls', tableShape: 'rect' },
  },
  // After the reference "Executive Office Suite" plan: 6.90 x 11.35 m, glazing down the west side,
  // one 2 x 3 bench and a round 8-seat table.
  exec6: {
    label: 'Executive suite, 6-desk bench',
    site: { width: 6900, depth: 11350, height: 3000, wall: 250,
      openings: [door('DOOR-1', 'E', 'SE', 5900, { width: 900 }), win('WIN-1', 'W', 'NW', 1700, 2950), win('WIN-2', 'W', 'SW', 1300, 3990)] },
    programme: { desks: 6, meetingSeats: 8, booths: 0, deskLayout: 'benches', tableShape: 'round' },
  },
  // After the reference open-plan studio: double door mid south wall, glazing north and south,
  // two 2 x 3 benches and a 10-seat meeting table.
  open12: {
    label: 'Open plan, two 6-desk benches',
    site: { width: 9600, depth: 12000, height: 3000, wall: 250,
      openings: [door('DOOR-1', 'S', 'SW', 3900, { width: 1800 }),
        win('WIN-1', 'N', 'NW', 1200, 1500), win('WIN-2', 'N', 'NE', 1600, 4200),
        win('WIN-3', 'S', 'SW', 900, 1900), win('WIN-4', 'S', 'SE', 800, 3000)] },
    programme: { desks: 12, meetingSeats: 10, booths: 0, deskLayout: 'benches', tableShape: 'rect' },
  },
};

// Tier M floor plates. Openings sit on outline edges (edge index, measured from the edge's start or end).
const mdoor = (id, edge, ref, offset, extra = {}) => ({ id, kind: 'door', edge, ref, offset, width: 1800, height: 2400, sill: 0, hinge: 'start', swing: 'out', ...extra });
const mwin = (id, edge, ref, offset, width, extra = {}) => ({ id, kind: 'window', edge, ref, offset, width, height: 2000, sill: 800, ...extra });

export const PRESETS_M = {
  floor36: {
    label: 'Floor 36 x 18 m, central core',
    siteM: { outline: [[0, 0], [36000, 0], [36000, 18000], [0, 18000]], height: 3000, wall: 300,
      openings: [mdoor('DOOR-1', 0, 'start', 2000), mwin('WIN-1', 0, 'start', 6000, 26000), mwin('WIN-2', 1, 'start', 2000, 14000),
        mwin('WIN-3', 2, 'start', 2000, 30000), mwin('WIN-4', 3, 'start', 2000, 14000)],
      columns: { spacingX: 9000, spacingY: 9000, offsetX: 9000, offsetY: 4500, size: 500 },
      core: { x: 15000, y: 11000, w: 6000, d: 6000, door: 'S' } },
    programmeM: { neighbourhoods: [{ name: 'Product', desks: 24 }, { name: 'Engineering', desks: 24 }, { name: 'Operations', desks: 12 }],
      rooms: { meetingS: 3, meetingL: 2, focus: 4, support: 1 }, booths: 4, meetingSeats: 0, pinned: [], travelLimit: 45000 },
  },
  floorL: {
    label: 'L-shaped floor, 2 entries',
    siteM: { outline: [[0, 0], [30000, 0], [30000, 12000], [14000, 12000], [14000, 26000], [0, 26000]], height: 3000, wall: 300,
      openings: [mdoor('DOOR-1', 0, 'start', 20000), mdoor('DOOR-2', 4, 'start', 4000, { width: 1200 }),
        mwin('WIN-1', 1, 'start', 1500, 9000), mwin('WIN-2', 3, 'start', 2000, 10000), mwin('WIN-3', 5, 'start', 2000, 22000), mwin('WIN-4', 0, 'start', 1000, 16000)],
      columns: { spacingX: 8000, spacingY: 8000, offsetX: 7000, offsetY: 6000, size: 450 },
      core: { x: 2500, y: 3000, w: 5000, d: 4000, door: 'N' } },
    programmeM: { neighbourhoods: [{ name: 'Studio', desks: 18 }, { name: 'Finance', desks: 12 }],
      rooms: { meetingS: 2, meetingL: 1, focus: 3, support: 1 }, booths: 2, meetingSeats: 6,
      pinned: [{ id: 'PIN-1', type: 'meetingL', x: 2000, y: 19000, front: 'E' }], travelLimit: 45000 },
  },
};

export const DEFAULT_PRESET = 'team8';

export function presetStateM(key, strategy = 'daylight') {
  const p = PRESETS_M[key] || PRESETS_M.floor36;
  return {
    v: 1, presetM: PRESETS_M[key] ? key : 'floor36', tier: 'M', strategy, siteFixed: false,
    ...presetState(DEFAULT_PRESET, strategy), tier: 'M', presetM: PRESETS_M[key] ? key : 'floor36',
    siteM: JSON.parse(JSON.stringify(p.siteM)), programmeM: JSON.parse(JSON.stringify(p.programmeM)),
  };
}

export function presetState(key, strategy = 'daylight') {
  const p = PRESETS[key] || PRESETS[DEFAULT_PRESET];
  return {
    v: 1, preset: PRESETS[key] ? key : DEFAULT_PRESET, tier: 'S', strategy, siteFixed: false,
    site: JSON.parse(JSON.stringify(p.site)), programme: { ...p.programme },
  };
}
