// SVG plan: walls with openings, furniture, optional clearance zones and dimension chains.
// Drawing units are mm; plan y is flipped so north is up.
import { wallPoint, wallLength } from './generator.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function drawPlan(svg, layout, { showZones = false } = {}) {
  const { site } = layout;
  const W = site.width, D = site.depth, t = site.wall;
  const fs = Math.min(320, Math.max(130, Math.max(W, D) / 50));
  const m = t + fs * 6;
  const P = (x, y) => [x, D - y];
  const pt = (x, y) => P(x, y).map((v) => v.toFixed(1)).join(',');
  const rect = (r, cls, extra = '') => {
    const [x, y] = P(r.x0, r.y1);
    return `<rect class="${cls}" x="${x}" y="${y}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" ${extra}/>`;
  };
  const wp = (w, s, n) => pt(...wallPoint(site, w, s, n));
  const out = [];

  out.push(`<style>
    .floor{fill:var(--plan-floor)} .wall{fill:var(--plan-wall)}
    .gap{fill:var(--plan-floor)} .glass{stroke:var(--plan-wall);stroke-width:${t / 10};fill:none}
    .leaf{stroke:var(--plan-wall);stroke-width:${Math.max(20, t / 6)};fill:none} .arc{stroke:var(--plan-wall);stroke-width:12;fill:none;stroke-dasharray:60 40}
    .desk{fill:var(--plan-desk);stroke:var(--plan-desk-stroke);stroke-width:15} .table{fill:var(--plan-table);stroke:var(--plan-desk-stroke);stroke-width:15}
    .chair{fill:var(--plan-chair)} .booth{fill:var(--plan-booth);stroke:var(--plan-wall);stroke-width:20}
    .z-door{fill:var(--zone-door)} .z-window{fill:var(--zone-window)} .z-access{fill:none;stroke:var(--zone-access);stroke-width:12;stroke-dasharray:50 40}
    .dim{stroke:var(--plan-dim);stroke-width:10;fill:none} .tick{stroke:var(--plan-dim);stroke-width:18}
    .dimt{fill:var(--plan-dim);font:${fs}px system-ui,sans-serif;text-anchor:middle}
    .lbl{fill:var(--ink);font:${fs * 0.7}px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central;opacity:.75}
    .north{fill:var(--plan-dim);font:600 ${fs}px system-ui,sans-serif;text-anchor:middle}
  </style>`);

  // walls: outer band, floor, then cut the openings out of the band
  out.push(rect({ x0: -t, y0: -t, x1: W + t, y1: D + t }, 'wall'));
  out.push(rect({ x0: 0, y0: 0, x1: W, y1: D }, 'floor', 'data-testid="floor"'));
  for (const o of site.openings) {
    out.push(rect(o.rect, 'gap', `data-opening="${esc(o.id)}"`));
    if (o.kind === 'window') {
      for (const f of [0.3, 0.5, 0.7]) out.push(`<polyline class="glass" points="${wp(o.wall, o.s0, -t * f)} ${wp(o.wall, o.s1, -t * f)}"/>`);
    } else {
      const w = o.s1 - o.s0, sh = o.hinge === 'end' ? o.s1 : o.s0, so = o.hinge === 'end' ? o.s0 : o.s1;
      const sg = o.swing === 'out' ? -1 : 1, base = o.swing === 'out' ? -t : 0;
      out.push(`<polyline class="leaf" points="${wp(o.wall, sh, base)} ${wp(o.wall, sh, base + sg * w)}"/>`);
      const arc = [];
      for (let k = 0; k <= 18; k++) {
        const a = (k / 18) * Math.PI / 2;
        arc.push(wp(o.wall, sh + (so - sh) * Math.sin(a), base + sg * w * Math.cos(a)));
      }
      out.push(`<polyline class="arc" points="${arc.join(' ')}"/>`);
    }
  }

  if (showZones) {
    for (const z of layout.zones) out.push(rect(z, z.kind === 'window-band' ? 'z-window' : 'z-door', `data-zone="${z.kind}"`));
  }

  for (const e of layout.elements) {
    const cls = e.kind === 'chair' ? 'chair' : e.kind;
    const extra = `data-id="${esc(e.id)}" data-kind="${e.kind}"${e.kind === 'chair' ? ' rx="80"' : ''}`;
    if (e.shape === 'round') {
      const [cx, cy] = P((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2);
      out.push(`<circle class="${cls}" cx="${cx}" cy="${cy}" r="${(e.x1 - e.x0) / 2}" ${extra}/>`);
    } else out.push(rect(e, cls, extra));
    if (showZones && e.access) for (const a of e.access) out.push(rect(a, 'z-access'));
  }
  for (const e of layout.elements) {
    if (e.kind === 'chair') continue;
    const [x, y] = P((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2);
    const label = e.kind === 'desk' ? e.id.replace('DESK-', '') : e.kind === 'booth' ? e.id.replace('BOOTH-', 'B') : 'Meeting';
    out.push(`<text class="lbl" x="${x}" y="${y}">${esc(label)}</text>`);
  }

  // dimension chains: openings chain, then overall
  for (const [w, chain] of Object.entries(layout.dims)) {
    const L = wallLength(site, w);
    const rows = [{ n: -(t + fs * 2.2), points: chain.points, id: 'seg' }, { n: -(t + fs * 4.4), points: [0, L], id: 'total' }];
    for (const row of rows) {
      out.push(`<polyline class="dim" points="${wp(w, 0, row.n)} ${wp(w, L, row.n)}"/>`);
      for (const s of row.points) {
        out.push(`<polyline class="dim" points="${wp(w, s, -t - fs * 0.4)} ${wp(w, s, row.n - fs * 0.5)}"/>`);
        out.push(`<polyline class="tick" points="${wp(w, s - fs * 0.35, row.n - fs * 0.35)} ${wp(w, s + fs * 0.35, row.n + fs * 0.35)}"/>`);
      }
      for (let i = 1; i < row.points.length; i++) {
        const a = row.points[i - 1], b = row.points[i], v = Math.round(b - a);
        // baseline just on the wall side of the line; glyphs grow "up", so N and W shift by one text height
        const [x, y] = P(...wallPoint(site, w, (a + b) / 2, row.n + fs * 0.3));
        const rot = w === 'E' || w === 'W' ? -90 : 0;
        const tid = row.id === 'total' ? `dim-${w}-total` : `dim-${w}-${i - 1}`;
        const [tx, ty] = w === 'N' ? [x, y + fs * 0.8] : w === 'W' ? [x + fs * 0.8, y] : [x, y];
        out.push(`<text class="dimt" data-testid="${tid}" data-wall="${w}" data-value="${v}" x="${tx}" y="${ty}"${rot ? ` transform="rotate(${rot} ${tx} ${ty})"` : ''}>${v}</text>`);
      }
    }
  }

  // north arrow
  out.push(`<text class="north" x="${W + t + fs * 3.2}" y="${-t - fs * 3}">N ↑</text>`);

  svg.setAttribute('viewBox', `${-m} ${-m} ${W + 2 * m} ${D + 2 * m}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = out.join('');
}
