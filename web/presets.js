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

export const DEFAULT_PRESET = 'team8';

export function presetState(key, strategy = 'daylight') {
  const p = PRESETS[key] || PRESETS[DEFAULT_PRESET];
  return {
    v: 1, preset: PRESETS[key] ? key : DEFAULT_PRESET, tier: 'S', strategy, siteFixed: false,
    site: JSON.parse(JSON.stringify(p.site)), programme: { ...p.programme },
  };
}
