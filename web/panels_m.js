// Tier M panels: floor plate (outline, openings on edges, columns, core), programme (neighbourhoods,
// rooms, pinned rooms, booths, open table, travel limit), result. Paths start with "m.".
import { ROOM_TYPES } from './generator_m.js';
import { PRESETS_M, presetStateM } from './presets.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SIDES = [['N', 'North'], ['S', 'South'], ['E', 'East'], ['W', 'West']];

export const SHAPES = {
  rect: { label: 'Rectangle', make: ({ W, D }) => [[0, 0], [W, 0], [W, D], [0, D]] },
  L: { label: 'L', make: ({ W, D, a, b }) => [[0, 0], [W, 0], [W, b], [a, b], [a, D], [0, D]] },
  U: { label: 'U', make: ({ W, D, a, b }) => [[0, 0], [W, 0], [W, D], [W - a, D], [W - a, b], [a, b], [a, D], [0, D]] },
  T: { label: 'T', make: ({ W, D, a, b }) => [[(W - a) / 2, 0], [(W + a) / 2, 0], [(W + a) / 2, D - b], [W, D - b], [W, D], [0, D], [0, D - b], [(W - a) / 2, D - b]] },
};

export function ensureM(state) {
  if (!state.siteM || !state.programmeM) {
    const p = presetStateM('floor36', state.strategy);
    state.siteM = p.siteM;
    state.programmeM = p.programmeM;
    state.presetM = 'floor36';
  }
  state.shapeM = state.shapeM || { kind: 'rect', W: 36000, D: 18000, a: 12000, b: 8000 };
}

export function renderSideM(state, layout, { num, sel, note, designName, TIERS, STRATEGIES }) {
  const s = state, sm = s.siteM, pm = s.programmeM, locked = !!s.siteFixed, r = layout.readouts;
  const edges = layout.site.edges;
  const short = (a, b) => (a < b ? ' class="short"' : '');
  const rank = { error: 0, warn: 1, info: 2, ok: 3 };
  const checks = [...layout.checks].sort((a, b) => rank[a.level] - rank[b.level]);
  const issues = checks.filter((c) => c.level === 'error' || c.level === 'warn').length;
  const sh = s.shapeM;
  const opCard = (o, i) => {
    const door = o.kind === 'door', e = edges[o.edge];
    return `<div class="op" data-testid="m-opening-${i}">
      <div class="op-head">${esc(o.id)} <span class="kind">${door ? 'door' : 'window'}</span><span class="spacer"></span>
        <button type="button" class="icon" data-action="m-remove-op" data-index="${i}" data-testid="m-remove-op-${i}" title="Remove ${esc(o.id)}"${locked ? ' disabled' : ''}>×</button></div>
      <div class="grid3">
        ${sel(`m.op.${i}.edge`, 'Edge', String(o.edge), edges.map((x) => [String(x.index), `${x.id} · ${(x.length / 1000).toFixed(1)} m`]), { disabled: locked })}
        ${sel(`m.op.${i}.ref`, 'Measured from', o.ref || 'start', [['start', e ? `${e.id} start` : 'start'], ['end', e ? `${e.id} end` : 'end']], { disabled: locked })}
        ${num(`m.op.${i}.offset`, 'Offset', o.offset, { disabled: locked })}
        ${num(`m.op.${i}.width`, 'Width', o.width, { disabled: locked, min: 300 })}
        ${num(`m.op.${i}.height`, 'Height', o.height, { disabled: locked })}
        ${door ? sel(`m.op.${i}.swing`, 'Swing', o.swing || 'in', [['in', 'Inwards'], ['out', 'Outwards']], { disabled: locked }) : num(`m.op.${i}.sill`, 'Sill', o.sill, { disabled: locked })}
      </div></div>`;
  };
  const tr = layout.travel || {};
  return `
  <section class="group">
    <h2>Start from</h2>
    <div class="grid2">
      ${sel('m.preset', 'Floor preset', s.presetM, Object.entries(PRESETS_M).map(([k, p]) => [k, p.label]))}
      ${sel('tier', 'Tier', s.tier, Object.entries(TIERS).map(([k, t]) => [k, t.label, !t.available]))}
    </div>
    <label class="f" style="margin-top:6px">Design name<input type="text" data-path="name" data-testid="name" value="${esc(designName())}"></label>
    ${note ? `<p class="note" data-testid="note">${esc(note)}</p>` : ''}
  </section>
  <section class="group">
    <h2>Floor plate ${locked ? '<span class="fixed-badge" data-testid="fixed-badge">fixed</span>' : ''}<span class="spacer"></span>
      <button type="button" class="btn${locked ? '' : ' primary'}" data-action="toggle-fix" data-testid="toggle-fix">${locked ? 'Release site' : 'Fix site'}</button></h2>
    <div class="grid3">
      ${sel('m.shape.kind', 'Shape', sh.kind, Object.entries(SHAPES).map(([k, v]) => [k, v.label]), { disabled: locked })}
      ${num('m.shape.W', 'Width', sh.W, { disabled: locked })}
      ${num('m.shape.D', 'Depth', sh.D, { disabled: locked })}
      ${sh.kind !== 'rect' ? num('m.shape.a', sh.kind === 'T' ? 'Stem width' : 'Arm / cut A', sh.a, { disabled: locked }) : ''}
      ${sh.kind !== 'rect' ? num('m.shape.b', sh.kind === 'T' ? 'Bar depth' : 'Cut B', sh.b, { disabled: locked }) : ''}
    </div>
    <div class="row-btns" style="margin:6px 0"><button type="button" class="btn" data-action="m-apply-shape" data-testid="m-apply-shape"${locked ? ' disabled' : ''}>Make outline from shape</button></div>
    <details${locked ? '' : ' open'}><summary class="note">Outline corners (mm, counter-clockwise)</summary>
      <div class="grid2" data-testid="m-outline">${sm.outline.map((p, i) => `${num(`m.outline.${i}.0`, `Corner ${i + 1} x`, p[0], { disabled: locked })}${num(`m.outline.${i}.1`, 'y', p[1], { disabled: locked })}`).join('')}</div>
    </details>
    <div class="grid2" style="margin-top:6px">
      ${num('m.site.height', 'Ceiling height', sm.height, { disabled: locked })}
      ${num('m.site.wall', 'Outer wall', sm.wall, { disabled: locked })}
    </div>
  </section>
  <section class="group">
    <h2>Openings<span class="spacer"></span>
      <span class="row-btns"><button type="button" class="btn" data-action="m-add-door" data-testid="m-add-door"${locked ? ' disabled' : ''}>+ Door</button>
      <button type="button" class="btn" data-action="m-add-window" data-testid="m-add-window"${locked ? ' disabled' : ''}>+ Window</button></span></h2>
    ${sm.openings.map(opCard).join('') || '<p class="note">No openings.</p>'}
  </section>
  <section class="group">
    <h2>Columns and core</h2>
    <div class="grid3">
      ${sel('m.col.enabled', 'Columns', sm.columns && sm.columns.enabled === false ? 'no' : 'yes', [['yes', 'Grid'], ['no', 'None']], { disabled: locked })}
      ${num('m.col.spacingX', 'Spacing x', (sm.columns || {}).spacingX ?? 8100, { disabled: locked })}
      ${num('m.col.spacingY', 'Spacing y', (sm.columns || {}).spacingY ?? 8100, { disabled: locked })}
      ${num('m.col.offsetX', 'First at x', (sm.columns || {}).offsetX ?? 8100, { disabled: locked })}
      ${num('m.col.offsetY', 'First at y', (sm.columns || {}).offsetY ?? 8100, { disabled: locked })}
      ${num('m.col.size', 'Size', (sm.columns || {}).size ?? 400, { disabled: locked })}
    </div>
    <div class="grid3" style="margin-top:6px">
      ${sel('m.core.present', 'Core', sm.core ? 'yes' : 'no', [['yes', 'One core'], ['no', 'None']], { disabled: locked })}
      ${sm.core ? `${num('m.core.x', 'x', sm.core.x, { disabled: locked })}${num('m.core.y', 'y', sm.core.y, { disabled: locked })}
      ${num('m.core.w', 'Width', sm.core.w, { disabled: locked })}${num('m.core.d', 'Depth', sm.core.d, { disabled: locked })}
      ${sel('m.core.door', 'Core door', sm.core.door || 'S', SIDES, { disabled: locked })}` : ''}
    </div>
  </section>
  <section class="group">
    <h2>Neighbourhoods<span class="spacer"></span><button type="button" class="btn" data-action="m-add-nbh" data-testid="m-add-nbh">+ Team</button></h2>
    ${pm.neighbourhoods.map((n, i) => `<div class="grid3" data-testid="m-nbh-${i}">
      <label class="f">Team<input type="text" data-path="m.nbh.${i}.name" data-testid="m.nbh.${i}.name" value="${esc(n.name)}"></label>
      ${num(`m.nbh.${i}.desks`, 'Desks', n.desks, { unit: false, min: 0 })}
      <label class="f">&nbsp;<button type="button" class="btn" data-action="m-remove-nbh" data-index="${i}" data-testid="m-remove-nbh-${i}">Remove</button></label></div>`).join('')}
  </section>
  <section class="group">
    <h2>Rooms and more</h2>
    <div class="grid2">
      ${Object.entries(ROOM_TYPES).map(([k, t]) => num(`m.room.${k}`, `${t.label} (${t.w / 1000} x ${t.d / 1000} m)`, (pm.rooms || {})[k] ?? 0, { unit: false, min: 0 })).join('')}
      ${num('m.prog.booths', 'Phone booths', pm.booths ?? 0, { unit: false, min: 0 })}
      ${num('m.prog.meetingSeats', 'Open meeting table seats', pm.meetingSeats ?? 0, { unit: false, min: 0 })}
      ${num('m.prog.travelLimit', 'Travel limit to an exit', pm.travelLimit ?? 45000)}
    </div>
    <div style="margin-top:6px">${sel('strategy', 'Strategy', s.strategy, Object.entries(STRATEGIES).map(([k, v]) => [k, v.label]))}</div>
    <p class="note">The travel limit depends on your jurisdiction's escape rules; 45 m is a placeholder, not a rule.</p>
  </section>
  <section class="group">
    <h2>Pinned rooms<span class="spacer"></span><button type="button" class="btn" data-action="m-add-pin" data-testid="m-add-pin">+ Pin a room</button></h2>
    ${(pm.pinned || []).map((p, i) => {
      const placed = layout.elements.find((e) => e.kind === 'room' && e.id === p.id);
      const moved = layout.checks.find((c) => c.ref === p.id && c.code.startsWith('pinned.'));
      return `<div class="op" data-testid="m-pin-${i}"><div class="op-head">${esc(p.id)} <span class="kind">${moved ? esc(moved.code === 'pinned.moved' ? `moved ${moved.amount} mm` : 'not placed') : placed ? 'exactly as pinned' : ''}</span><span class="spacer"></span>
        <button type="button" class="icon" data-action="m-remove-pin" data-index="${i}" data-testid="m-remove-pin-${i}" title="Unpin">×</button></div>
        <div class="grid2">
          ${sel(`m.pin.${i}.type`, 'Room', p.type, Object.entries(ROOM_TYPES).map(([k, t]) => [k, t.label]))}
          ${sel(`m.pin.${i}.front`, 'Door side', p.front || 'S', SIDES)}
          ${num(`m.pin.${i}.x`, 'Corner x', p.x)}${num(`m.pin.${i}.y`, 'Corner y', p.y)}
        </div></div>`;
    }).join('') || '<p class="note">Pin a room to keep it exactly where you put it; everything else is laid out around it.</p>'}
  </section>
  <section class="group">
    <h2>Result</h2>
    <dl class="readouts" data-testid="readouts">
      <dt>Open-plan desks</dt><dd${short(r.desksPlaced, r.desksRequested)} data-testid="ro-desks">${r.desksPlaced} / ${r.desksRequested}</dd>
      <dt>Rooms</dt><dd${short(r.roomsPlaced, r.roomsRequested)} data-testid="ro-rooms">${r.roomsPlaced} / ${r.roomsRequested}</dd>
      <dt>Focus-room desks</dt><dd>${r.focusDesks}</dd>
      <dt>Seats in meeting rooms</dt><dd>${r.roomSeats}</dd>
      <dt>Phone booths</dt><dd${short(r.boothsPlaced, r.boothsRequested)}>${r.boothsPlaced} / ${r.boothsRequested}</dd>
      <dt>Furthest from an exit</dt><dd${r.travelMax > r.travelLimit ? ' class="short"' : ''} data-testid="ro-travel">${(r.travelMax / 1000).toFixed(1)} m${tr.worst ? ` (${esc(tr.worst)})` : ''} / ${(r.travelLimit / 1000).toFixed(0)} m</dd>
      <dt>Floor area</dt><dd>${r.floorArea.toFixed(1)} m²</dd>
      <dt>Area per workpoint</dt><dd>${r.areaPerWorkpoint === null ? '–' : `${r.areaPerWorkpoint.toFixed(1)} m²`}</dd>
      <dt>Columns</dt><dd>${r.columns}</dd>
    </dl>
  </section>
  <section class="group">
    <h2>Checks <span data-testid="issue-count">${issues ? `${issues} issue${issues > 1 ? 's' : ''}` : 'all clear'}</span></h2>
    <ul class="checks" data-testid="checks">${checks.map((c) => `<li class="${c.level}" data-code="${esc(c.code)}">${esc(c.msg)}</li>`).join('')}</ul>
  </section>`;
}

// Returns a note to show, or '' (and mutates state).
export function applyFieldM(state, path, raw) {
  const p = path.split('.'), sm = state.siteM, pm = state.programmeM, n = Number(raw);
  if (path === 'm.preset') {
    const pre = presetStateM(raw, state.strategy);
    state.presetM = pre.presetM;
    state.programmeM = pre.programmeM;
    if (state.siteFixed) return `Site is fixed: applied the "${PRESETS_M[raw].label}" programme only.`;
    state.siteM = pre.siteM;
    return '';
  }
  if (p[1] === 'shape') { state.shapeM[p[2]] = p[2] === 'kind' ? raw : n; return ''; }
  if (p[1] === 'outline') { sm.outline[Number(p[2])][Number(p[3])] = n; return ''; }
  if (p[1] === 'site') { sm[p[2]] = n; return ''; }
  if (p[1] === 'op') {
    const o = sm.openings[Number(p[2])];
    if (!o) return '';
    if (p[3] === 'ref' && raw !== o.ref) {
      // keep the opening where it is: convert the offset to the other end
      const e = edgeLength(sm.outline, o.edge);
      o.offset = Math.round(e - o.offset - o.width);
    }
    o[p[3]] = ['edge', 'offset', 'width', 'height', 'sill'].includes(p[3]) ? n : raw;
    return '';
  }
  if (p[1] === 'col') {
    sm.columns = sm.columns || {};
    sm.columns[p[2]] = p[2] === 'enabled' ? raw === 'yes' : n;
    return '';
  }
  if (p[1] === 'core') {
    if (p[2] === 'present') {
      if (raw === 'no') sm.core = null;
      else if (!sm.core) {
        const xs = sm.outline.map((q) => q[0]), ys = sm.outline.map((q) => q[1]);
        sm.core = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2 - 3000), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2 - 2500), w: 6000, d: 5000, door: 'S' };
      }
      return '';
    }
    sm.core[p[2]] = p[2] === 'door' ? raw : n;
    return '';
  }
  if (p[1] === 'nbh') { pm.neighbourhoods[Number(p[2])][p[3]] = p[3] === 'name' ? raw : n; return ''; }
  if (p[1] === 'room') { pm.rooms = pm.rooms || {}; pm.rooms[p[2]] = n; return ''; }
  if (p[1] === 'prog') { pm[p[2]] = n; return ''; }
  if (p[1] === 'pin') { pm.pinned[Number(p[2])][p[3]] = ['x', 'y'].includes(p[3]) ? n : raw; return ''; }
  return '';
}

function edgeLength(outline, i) {
  const a = outline[i], b = outline[(i + 1) % outline.length];
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
}

export function actionM(state, action, index) {
  const sm = state.siteM, pm = state.programmeM;
  if (action === 'm-apply-shape') {
    const sh = state.shapeM;
    sm.outline = SHAPES[sh.kind].make(sh).map((q) => q.map(Math.round));
    sm.openings = sm.openings.filter((o) => o.edge < sm.outline.length);
    return `Outline set to a ${SHAPES[sh.kind].label} of ${sh.W} x ${sh.D} mm; openings on edges that no longer exist were removed.`;
  }
  const nextId = (prefix, list) => { let k = 1; while (list.some((o) => o.id === `${prefix}-${k}`)) k++; return `${prefix}-${k}`; };
  if (action === 'm-add-door') sm.openings.push({ id: nextId('DOOR', sm.openings), kind: 'door', edge: 0, ref: 'start', offset: 1000, width: 1800, height: 2400, sill: 0, swing: 'out', hinge: 'start' });
  if (action === 'm-add-window') sm.openings.push({ id: nextId('WIN', sm.openings), kind: 'window', edge: 2 % sm.outline.length, ref: 'start', offset: 1000, width: 4000, height: 2000, sill: 800 });
  if (action === 'm-remove-op') sm.openings.splice(index, 1);
  if (action === 'm-add-nbh') pm.neighbourhoods.push({ name: `Team ${pm.neighbourhoods.length + 1}`, desks: 6 });
  if (action === 'm-remove-nbh') pm.neighbourhoods.splice(index, 1);
  if (action === 'm-add-pin') {
    const xs = sm.outline.map((q) => q[0]), ys = sm.outline.map((q) => q[1]);
    pm.pinned = pm.pinned || [];
    pm.pinned.push({ id: nextId('PIN', pm.pinned), type: 'meetingS', x: Math.min(...xs) + 1000, y: Math.max(...ys) - 4000, front: 'E' });
  }
  if (action === 'm-remove-pin') pm.pinned.splice(index, 1);
  return '';
}
