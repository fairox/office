// UI: state, panels, persistence (URL hash + localStorage) and the two views.
import { generate, STRATEGIES, TIERS, WALLS, WALL_CORNERS, DESK_LAYOUTS, TABLE_SHAPES, offsetFromRef } from './generator.js';
import { PRESETS, DEFAULT_PRESET, presetState } from './presets.js';
import { drawPlan } from './plan.js';
import { buildFile, slug } from './buildfile.js';
import { ensureM, renderSideM, applyFieldM, actionM } from './panels_m.js';
import { PRESETS_M } from './presets.js';

const STORE_KEY = 'office-configurator/state/v1';
const UI_KEY = 'office-configurator/ui/v1';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- persistence ----------

function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
function valid(s) {
  return s && typeof s === 'object' && s.site && Array.isArray(s.site.openings) && s.programme;
}
// The Build in Archicad window opens the app with #zone=<...> to hand over the selected Zone as a fixed site.
function fromZone(z) {
  const base = (() => { try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (valid(s)) return s; } catch { /* none */ } return presetState(DEFAULT_PRESET); })();
  const mm = (v) => Math.round(Number(v) * 1000);
  return {
    ...base, siteFixed: true, name: z.name || base.name,
    site: { ...base.site, width: mm(z.width), depth: mm(z.depth), height: z.height ? mm(z.height) : base.site.height, openings: [] },
    placement: { fromZone: true, zoneName: z.name || '', origin: (z.origin || [0, 0, 0]).map(Number), rotationDeg: Number(z.rotationDeg) || 0, story: Number(z.story) || 0 },
  };
}

function loadState() {
  const zm = location.hash.match(/[#&]zone=([^&]+)/);
  if (zm) {
    try { return fromZone(decode(zm[1])); } catch { /* fall through */ }
  }
  const m = location.hash.match(/[#&]s=([^&]+)/);
  if (m) {
    try { const s = decode(m[1]); if (valid(s)) return s; } catch { /* fall through */ }
  }
  try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (valid(s)) return s; } catch { /* fall through */ }
  return presetState(DEFAULT_PRESET);
}
function loadUi() {
  try { return { view: 'split', showZones: false, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch { return { view: 'split', showZones: false }; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* private mode */ }
  history.replaceState(null, '', `#s=${encode(state)}`);
}

let state = loadState();
const ui = loadUi();
let layout = null, view3d = null, note = '';

// ---------- panels ----------

const num = (path, label, value, { disabled = false, unit = true, min, step = 1 } = {}) => `
  <label class="f">${label}<span class="${unit ? 'unit' : ''}"><input type="number" data-path="${path}" data-testid="${path}" value="${esc(value)}" step="${step}"${min !== undefined ? ` min="${min}"` : ''}${disabled ? ' disabled' : ''}></span></label>`;
const sel = (path, label, value, options, { disabled = false } = {}) => `
  <label class="f">${label}<select data-path="${path}" data-testid="${path}"${disabled ? ' disabled' : ''}>${options.map(([v, l, dis]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}${dis ? ' disabled' : ''}>${esc(l)}</option>`).join('')}</select></label>`;

function openingCard(o, i, locked) {
  const corners = WALL_CORNERS[o.wall] || WALL_CORNERS.S;
  const door = o.kind === 'door';
  return `<div class="op" data-testid="opening-${i}">
    <div class="op-head">${esc(o.id)} <span class="kind">${door ? 'door' : 'window'}</span><span class="spacer"></span>
      <button type="button" class="icon" data-action="remove-op" data-index="${i}" data-testid="remove-op-${i}" title="Remove ${esc(o.id)}"${locked ? ' disabled' : ''}>×</button></div>
    <div class="grid3">
      ${sel(`op.${i}.wall`, 'Wall', o.wall, WALLS.map((w) => [w, w]), { disabled: locked })}
      ${sel(`op.${i}.ref`, 'Measured from', o.ref, corners.map((c) => [c, `${c} corner`]), { disabled: locked })}
      ${num(`op.${i}.offset`, 'Offset', o.offset, { disabled: locked })}
      ${num(`op.${i}.width`, 'Width', o.width, { disabled: locked, min: 300 })}
      ${num(`op.${i}.height`, 'Height', o.height, { disabled: locked, min: 100 })}
      ${door
        ? sel(`op.${i}.swing`, 'Swing', o.swing, [['in', 'Into room'], ['out', 'Outwards']], { disabled: locked })
        : num(`op.${i}.sill`, 'Sill', o.sill, { disabled: locked, min: 0 })}
      ${door ? sel(`op.${i}.hinge`, 'Hinge', o.hinge, [['start', `${corners[0]} side`], ['end', `${corners[1]} side`]], { disabled: locked }) : ''}
    </div></div>`;
}

const designName = () => state.name || (state.tier === 'M' && PRESETS_M[state.presetM] ? PRESETS_M[state.presetM].label
  : PRESETS[state.preset] ? PRESETS[state.preset].label : 'Office');

function renderSide() {
  if (state.tier === 'M') {
    $('#side').innerHTML = renderSideM(state, layout, { num, sel, note, designName, TIERS, STRATEGIES });
    return;
  }
  const s = state, locked = !!s.siteFixed, r = layout.readouts;
  const pl = s.placement && s.placement.fromZone ? s.placement : null;
  const short = (a, b) => (a < b ? ' class="short"' : '');
  const rank = { error: 0, warn: 1, info: 2, ok: 3 };
  const checks = [...layout.checks].sort((a, b) => rank[a.level] - rank[b.level]);
  const issues = checks.filter((c) => c.level === 'error' || c.level === 'warn').length;
  $('#side').innerHTML = `
  <section class="group">
    <h2>Start from</h2>
    <div class="grid2">
      ${sel('preset', 'Preset', s.preset, Object.entries(PRESETS).map(([k, p]) => [k, p.label]))}
      ${sel('tier', 'Tier', s.tier, Object.entries(TIERS).map(([k, t]) => [k, t.label, !t.available]))}
    </div>
    <label class="f" style="margin-top:6px">Design name<input type="text" data-path="name" data-testid="name" value="${esc(designName())}"></label>
    ${note ? `<p class="note" data-testid="note">${esc(note)}</p>` : ''}
  </section>
  <section class="group">
    <h2>Site ${locked ? '<span class="fixed-badge" data-testid="fixed-badge">fixed</span>' : ''}<span class="spacer"></span>
      <button type="button" class="btn${locked ? '' : ' primary'}" data-action="toggle-fix" data-testid="toggle-fix">${locked ? 'Release site' : 'Fix site'}</button></h2>
    <div class="grid2">
      ${num('site.width', 'Width (W–E)', s.site.width, { disabled: locked })}
      ${num('site.depth', 'Depth (S–N)', s.site.depth, { disabled: locked })}
      ${num('site.height', 'Room height', s.site.height, { disabled: locked })}
      ${num('site.wall', 'Wall thickness', s.site.wall, { disabled: locked })}
    </div>
    ${pl ? `<p class="note" data-testid="zone-note">From Archicad Zone "${esc(pl.zoneName)}" (story ${pl.story}, origin ${pl.origin.map((v) => v.toFixed(3)).join(' / ')} m, ${pl.rotationDeg}°). Its walls stay as they are in Archicad; add its doors so the checks can find a way in.</p>` : ''}
    <p class="note">${locked ? 'Nothing below changes the room or its openings while the site is fixed.' : 'Fix the site once the room matches the drawing; presets and strategies then only change the furniture.'}</p>
  </section>
  <section class="group">
    <h2>Openings<span class="spacer"></span>
      <span class="row-btns"><button type="button" class="btn" data-action="add-door" data-testid="add-door"${locked ? ' disabled' : ''}>+ Door</button>
      <button type="button" class="btn" data-action="add-window" data-testid="add-window"${locked ? ' disabled' : ''}>+ Window</button></span></h2>
    ${s.site.openings.map((o, i) => openingCard(o, i, locked)).join('') || '<p class="note">No openings.</p>'}
  </section>
  <section class="group">
    <h2>Programme</h2>
    <div class="grid3">
      ${num('programme.desks', 'Desks', s.programme.desks, { unit: false, min: 0 })}
      ${num('programme.meetingSeats', 'Meeting seats', s.programme.meetingSeats, { unit: false, min: 0 })}
      ${num('programme.booths', 'Phone booths', s.programme.booths, { unit: false, min: 0 })}
    </div>
    <div class="grid2" style="margin-top:6px">
      ${sel('programme.deskLayout', 'Desk arrangement', s.programme.deskLayout || 'walls', Object.entries(DESK_LAYOUTS))}
      ${sel('programme.tableShape', 'Meeting table', s.programme.tableShape || 'rect', Object.entries(TABLE_SHAPES))}
    </div>
    <div style="margin-top:6px">${sel('strategy', 'Strategy', s.strategy, Object.entries(STRATEGIES).map(([k, v]) => [k, v.label]))}</div>
    <p class="note">${esc(STRATEGIES[layout.strategy].note)}</p>
  </section>
  <section class="group">
    <h2>Result</h2>
    <dl class="readouts" data-testid="readouts">
      <dt>Desks</dt><dd${short(r.desksPlaced, r.desksRequested)} data-testid="ro-desks">${r.desksPlaced} / ${r.desksRequested}</dd>
      <dt>Meeting seats</dt><dd${short(r.meetingSeatsPlaced, r.meetingSeatsRequested)} data-testid="ro-seats">${r.meetingSeatsPlaced} / ${r.meetingSeatsRequested}</dd>
      <dt>Phone booths</dt><dd${short(r.boothsPlaced, r.boothsRequested)} data-testid="ro-booths">${r.boothsPlaced} / ${r.boothsRequested}</dd>
      <dt>Floor area</dt><dd>${r.floorArea.toFixed(2)} m²</dd>
      <dt>Area per workpoint</dt><dd>${r.areaPerWorkpoint === null ? '–' : `${r.areaPerWorkpoint.toFixed(2)} m²`}</dd>
    </dl>
  </section>
  <section class="group">
    <h2>Checks <span data-testid="issue-count">${issues ? `${issues} issue${issues > 1 ? 's' : ''}` : 'all clear'}</span></h2>
    <ul class="checks" data-testid="checks">${checks.map((c) => `<li class="${c.level}" data-code="${esc(c.code)}">${esc(c.msg)}</li>`).join('')}</ul>
  </section>`;
}

function renderViews() {
  const v = $('#views');
  v.className = `views ${ui.view === '3d' ? 'v3d' : ui.view === 'plan' ? 'vplan' : 'split'}`;
  for (const b of document.querySelectorAll('#view-switch button')) b.setAttribute('aria-pressed', String(b.dataset.view === ui.view));
  $('#show-zones').checked = !!ui.showZones;
  drawPlan($('#plan'), layout, { showZones: ui.showZones });
  if (view3d) { view3d.resize(); view3d.update(layout); }
}

function update({ keepNote = false } = {}) {
  if (!keepNote) note = '';
  if (state.tier === 'M') ensureM(state);
  layout = generate(state);
  window.__layout = layout; // for tools/browser_check.js
  renderSide();
  renderViews();
  save();
}

// ---------- edits ----------

function nextId(kind) {
  const prefix = kind === 'door' ? 'DOOR' : 'WIN';
  let n = 1;
  while (state.site.openings.some((o) => o.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function applyField(path, raw) {
  const parts = path.split('.');
  if (parts[0] === 'm') {
    note = applyFieldM(state, path, raw);
    return !!note;
  }
  if (path === 'preset') {
    const p = presetState(raw, state.strategy);
    if (state.siteFixed) {
      state.preset = p.preset;
      state.programme = p.programme;
      note = `Site is fixed: applied the "${PRESETS[raw].label}" programme only.`;
    } else {
      state = { ...p, strategy: state.strategy, tier: state.tier };
    }
    return true;
  }
  if (path === 'strategy' || path === 'tier' || path === 'name') { state[path] = raw; return false; }
  if (parts[0] === 'site') { state.site[parts[1]] = Number(raw); return false; }
  if (parts[0] === 'programme') {
    state.programme[parts[1]] = ['deskLayout', 'tableShape'].includes(parts[1]) ? raw : Number(raw);
    return false;
  }
  if (parts[0] === 'op') {
    const o = state.site.openings[Number(parts[1])], key = parts[2];
    if (!o) return false;
    if (key === 'ref') o.offset = Math.round(offsetFromRef(state.site, o, raw));
    if (key === 'wall' && raw !== o.wall) {
      o.wall = raw;
      o.ref = WALL_CORNERS[raw][0];
      return false;
    }
    o[key] = ['offset', 'width', 'height', 'sill'].includes(key) ? Number(raw) : raw;
  }
  return false;
}

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id === 'show-zones') { ui.showZones = el.checked; renderViews(); save(); return; }
  if (!el.dataset || !el.dataset.path) return;
  const keepNote = applyField(el.dataset.path, el.value);
  update({ keepNote });
});

function downloadBuildFile() {
  const name = designName();
  const data = buildFile(state, layout, { name });
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(name)}.office-build.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.id === 'download') { downloadBuildFile(); return; }
  if (b.dataset.view) { ui.view = b.dataset.view; renderViews(); save(); return; }
  const a = b.dataset.action;
  if (!a) return;
  if (a === 'toggle-fix') state.siteFixed = !state.siteFixed;
  if (a.startsWith('m-')) {
    note = actionM(state, a, Number(b.dataset.index));
    update({ keepNote: !!note });
    return;
  }
  if (a === 'add-door' || a === 'add-window') {
    const kind = a === 'add-door' ? 'door' : 'window';
    state.site.openings.push(kind === 'door'
      ? { id: nextId('door'), kind, wall: 'S', ref: 'SW', offset: 300, width: 1000, height: 2100, sill: 0, hinge: 'start', swing: 'in' }
      : { id: nextId('window'), kind, wall: 'N', ref: 'NW', offset: 600, width: 1800, height: 1500, sill: 900 });
  }
  if (a === 'remove-op') state.site.openings.splice(Number(b.dataset.index), 1);
  update();
});

// ---------- boot ----------

// A Zone handed over while the app is already open arrives as a hash change, not a page load.
window.addEventListener('hashchange', () => {
  if (/[#&]zone=/.test(location.hash)) {
    state = loadState();
    update();
  }
});

update();
import('./view3d.js').then(({ View3D }) => {
  try {
    view3d = new View3D($('#three-pane'));
    view3d.update(layout);
  } catch (err) {
    $('#three-pane').innerHTML = `<div class="msg">3D view unavailable: ${esc(err.message)}</div>`;
  }
}).catch((err) => {
  $('#three-pane').innerHTML = `<div class="msg">3D view could not load: ${esc(err.message)}</div>`;
});
