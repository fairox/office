// SVG plan for tier M: outline walls with openings, columns, core, aisles, rooms, furniture,
// neighbourhoods, the furthest workpoint and a dimension chain per edge. mm, north up.
import { edgesOf, edgePoint } from './generator_m.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function drawPlanM(svg, layout, { showZones = false } = {}) {
  const { site } = layout, poly = site.outline, edges = edgesOf(poly), t = site.wall, bb = site.bbox;
  const fs = Math.min(600, Math.max(160, Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) / 55));
  const m = t + fs * 6;
  const P = (x, y) => `${x.toFixed(1)},${(-y).toFixed(1)}`;
  const rect = (r, cls, extra = '') => `<rect class="${cls}" x="${r.x0}" y="${-r.y1}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" ${extra}/>`;
  const ep = (e, s, n) => P(...edgePoint(e, s, n));
  const text = (x, y, s, cls = 'lbl', extra = '') => `<text class="${cls}" x="${x}" y="${-y}" ${extra}>${esc(s)}</text>`;
  const out = [];
  out.push(`<style>
    .floor{fill:var(--plan-floor)} .wall{fill:var(--plan-wall)} .gap{fill:var(--plan-floor)}
    .glass{stroke:var(--plan-wall);stroke-width:${t / 10};fill:none}
    .leaf{stroke:var(--plan-wall);stroke-width:${Math.max(25, t / 6)};fill:none} .arc{stroke:var(--plan-wall);stroke-width:15;fill:none;stroke-dasharray:80 60}
    .column{fill:var(--plan-wall)} .core{fill:var(--plan-wall);opacity:.18;stroke:var(--plan-wall);stroke-width:30} .coredoor{stroke:var(--plan-floor);stroke-width:90}
    .aisle{fill:var(--accent);opacity:.08} .aisle-spine{fill:var(--accent);opacity:.13}
    .room{fill:var(--plan-booth);opacity:.22} .room-meeting{fill:var(--plan-table);opacity:.35} .room-focus{fill:var(--plan-booth);opacity:.3} .room-support{fill:var(--plan-chair);opacity:.25}
    .partition{fill:var(--plan-wall)} .storage{fill:var(--plan-chair);stroke:var(--plan-wall);stroke-width:10}
    .desk{fill:var(--plan-desk);stroke:var(--plan-desk-stroke);stroke-width:15} .table{fill:var(--plan-table);stroke:var(--plan-desk-stroke);stroke-width:15}
    .chair{fill:var(--plan-chair)} .booth{fill:var(--plan-booth);stroke:var(--plan-wall);stroke-width:20}
    .nbh{fill:none;stroke:var(--accent);stroke-width:25;stroke-dasharray:160 100;opacity:.6}
    .z-door{fill:var(--zone-door)} .z-window{fill:var(--zone-window)} .z-access{fill:none;stroke:var(--zone-access);stroke-width:12;stroke-dasharray:50 40}
    .dim{stroke:var(--plan-dim);stroke-width:12;fill:none} .tick{stroke:var(--plan-dim);stroke-width:22}
    .dimt{fill:var(--plan-dim);font:${fs}px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central}
    .lbl{fill:var(--ink);font:${fs * 0.75}px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central;opacity:.8}
    .lblb{fill:var(--ink);font:600 ${fs * 0.9}px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central}
    .nbht{fill:var(--accent);font:600 ${fs}px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central}
    .worst{fill:none;stroke:var(--warn);stroke-width:40}
  </style>`);

  // outer wall band: the outline pushed out by the wall thickness (mitred corners), then the floor on top
  const outward = (e) => [e.dir[1], -e.dir[0]];
  const outer = poly.map((v, i) => {
    const a = outward(edges[(i + edges.length - 1) % edges.length]), b = outward(edges[i]);
    return [v[0] + (a[0] + b[0]) * t, v[1] + (a[1] + b[1]) * t];
  });
  out.push(`<polygon class="wall" points="${outer.map((p) => P(...p)).join(' ')}"/>`);
  out.push(`<polygon class="floor" data-testid="floor" points="${poly.map((p) => P(...p)).join(' ')}"/>`);

  for (const a of layout.aisles || []) out.push(rect(a.rect, a.kind === 'spine' ? 'aisle-spine' : 'aisle', `data-aisle="${esc(a.id)}"`));
  if (showZones) for (const z of layout.zones) out.push(rect(z, z.kind === 'window-band' ? 'z-window' : 'z-door', `data-zone="${z.kind}"`));

  for (const o of site.openings) {
    const e = edges[o.edge];
    out.push(rect(o.rect, 'gap', `data-opening="${esc(o.id)}"`));
    if (o.kind === 'window') {
      for (const f of [0.3, 0.5, 0.7]) out.push(`<polyline class="glass" points="${ep(e, o.s0, -t * f)} ${ep(e, o.s1, -t * f)}"/>`);
    } else {
      const w = o.s1 - o.s0, sh = o.hinge === 'end' ? o.s1 : o.s0, so = o.hinge === 'end' ? o.s0 : o.s1;
      const sg = o.swing === 'out' ? -1 : 1, base = o.swing === 'out' ? -t : 0;
      out.push(`<polyline class="leaf" points="${ep(e, sh, base)} ${ep(e, sh, base + sg * w)}"/>`);
      const arc = [];
      for (let k = 0; k <= 18; k++) { const a = (k / 18) * Math.PI / 2; arc.push(ep(e, sh + (so - sh) * Math.sin(a), base + sg * w * Math.cos(a))); }
      out.push(`<polyline class="arc" points="${arc.join(' ')}"/>`);
    }
  }

  const els = layout.elements;
  for (const r of els.filter((e) => e.kind === 'room')) {
    out.push(rect(r, `room room-${r.category}`, `data-id="${esc(r.id)}" data-kind="room"`));
    // door swing inside the room
    const s = r.swing, f = r.front, horiz = f === 'N' || f === 'S';
    const hx = horiz ? s.x0 : (f === 'E' ? s.x1 : s.x0), hy = horiz ? (f === 'N' ? s.y1 : s.y0) : s.y0;
    const w = horiz ? s.x1 - s.x0 : s.y1 - s.y0, inn = f === 'N' || f === 'E' ? -1 : 1, arc = [];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI / 2;
      arc.push(horiz ? P(hx + w * Math.sin(a), hy + inn * w * Math.cos(a)) : P(hx + inn * w * Math.cos(a), hy + w * Math.sin(a)));
    }
    out.push(`<polyline class="leaf" points="${horiz ? `${P(hx, hy)} ${P(hx, hy + inn * w)}` : `${P(hx, hy)} ${P(hx + inn * w, hy)}`}"/>`, `<polyline class="arc" points="${arc.join(' ')}"/>`);
  }
  for (const e of els) {
    if (e.kind === 'room') continue;
    const cls = { partition: 'partition', column: 'column', core: 'core', storage: 'storage' }[e.kind] || e.kind;
    out.push(rect(e, cls, `data-id="${esc(e.id)}" data-kind="${e.kind}"${e.kind === 'chair' ? ' rx="80"' : ''}`));
    if (showZones && e.access && e.kind !== 'room') for (const a of e.access) out.push(rect(a, 'z-access'));
  }
  if (site.core) {
    const d = site.core.doorRect;
    out.push(`<polyline class="coredoor" points="${P(d.x0, d.y0)} ${P(d.x1, d.y1)}"/>`);
    const r = site.core.rect;
    out.push(text((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 'CORE', 'lblb'));
  }
  for (const r of els.filter((e) => e.kind === 'room')) out.push(text((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 + fs * 0.5, r.name, 'lbl'), text((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 - fs * 0.5, r.id, 'lbl'));
  for (const n of layout.neighbourhoods || []) {
    for (const r of n.rects) out.push(rect(r, 'nbh', `data-nbh="${esc(n.id)}"`));
    const top = [...n.rects].sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)[0];
    out.push(text((top.x0 + top.x1) / 2, top.y1 + fs * 0.7, `${n.name} · ${n.desks.length}`, 'nbht'));
  }
  const worst = els.find((e) => e.id === (layout.travel && layout.travel.worst));
  if (worst) {
    const [x, y] = [(worst.x0 + worst.x1) / 2, (worst.y0 + worst.y1) / 2];
    out.push(`<circle class="worst" cx="${x}" cy="${-y}" r="${fs * 1.6}" data-testid="travel-worst"/>`);
    out.push(text(x, y - fs * 2.4, `furthest ${(layout.travel.max / 1000).toFixed(1)} m`, 'lblb'));
  }

  // dimension chains: openings chain and overall, outside each edge
  for (const e of edges) {
    const ch = layout.dims[e.id];
    if (!ch) continue;
    const rows = [{ n: -(t + fs * 2.2), pts: ch.points, total: false }, { n: -(t + fs * 4.4), pts: [0, ch.length], total: true }];
    const vertical = Math.abs(e.dir[0]) < 0.5;
    for (const row of rows) {
      out.push(`<polyline class="dim" points="${ep(e, 0, row.n)} ${ep(e, ch.length, row.n)}"/>`);
      for (const s of row.pts) {
        out.push(`<polyline class="dim" points="${ep(e, s, -t - fs * 0.4)} ${ep(e, s, row.n - fs * 0.5)}"/>`);
        out.push(`<polyline class="tick" points="${ep(e, s - fs * 0.35, row.n - fs * 0.35)} ${ep(e, s + fs * 0.35, row.n + fs * 0.35)}"/>`);
      }
      for (let i = 1; i < row.pts.length; i++) {
        const a = row.pts[i - 1], b = row.pts[i], v = Math.round(b - a);
        if (!row.total && v < fs * 2.2) continue;   // no room for the number
        const [x, y] = edgePoint(e, (a + b) / 2, row.n - fs * 0.75);
        const tid = row.total ? `dim-${e.id}-total` : `dim-${e.id}-${i - 1}`;
        out.push(`<text class="dimt" data-testid="${tid}" data-value="${v}" x="${x}" y="${-y}"${vertical ? ` transform="rotate(-90 ${x} ${-y})"` : ''}>${v}</text>`);
      }
    }
    // edge name, inside the corner of each edge's start
    const [lx, ly] = edgePoint(e, fs * 1.6, fs * 1.2);
    out.push(text(lx, ly, e.id, 'lbl', 'opacity=".5"'));
  }
  out.push(text(bb.x1 + t + fs * 3, bb.y1 + t + fs * 3, 'N ↑', 'lblb'));
  svg.setAttribute('viewBox', `${bb.x0 - m} ${-bb.y1 - m} ${bb.x1 - bb.x0 + 2 * m} ${bb.y1 - bb.y0 + 2 * m}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = out.join('');
}
