// Browser check: starts serve.py, drives the page in Chromium like a user, screenshots every preset and view.
//   node tools/browser_check.js              screenshots go to dist/screens/
// Fails on any page error or console error.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'dist', 'screens');
mkdirSync(SHOTS, { recursive: true });

let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };

function startServer() {
  return new Promise((resolve, reject) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(py, [path.join(ROOT, 'serve.py'), '--port', '8791'], { env: { ...process.env, OFFICE_SERVE_QUIET: '1' } });
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) resolve({ proc, url: m[0] });
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('serve.py did not start')), 10000);
  });
}

const { proc, url } = await startServer();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const layout = () => page.evaluate(() => window.__layout);
const val = (tid) => page.locator(`[data-testid="${tid}"]`).inputValue();
async function setField(tid, value) {
  const el = page.locator(`[data-testid="${tid}"]`);
  if (await el.evaluate((n) => n.tagName) === 'SELECT') await el.selectOption(String(value));
  else { await el.fill(String(value)); await el.press('Enter'); }
  await page.waitForTimeout(50);
}
async function dimChain(wall) {
  return page.evaluate((w) => {
    const segs = [...document.querySelectorAll(`[data-testid^="dim-${w}-"]`)].filter((n) => !n.dataset.testid.endsWith('total')).map((n) => Number(n.dataset.value));
    const total = Number(document.querySelector(`[data-testid="dim-${w}-total"]`).dataset.value);
    return { segs, total };
  }, wall);
}

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__layout && document.querySelector('#three-pane canvas'));

  // 1. every preset in every view
  console.log('Presets x views');
  const presets = await page.locator('[data-testid="preset"] option').evaluateAll((os) => os.map((o) => o.value));
  for (const key of presets) {
    await setField('preset', key);
    const L = await layout();
    const deskRects = await page.locator('#plan [data-kind="desk"]').count();
    ok(deskRects === L.readouts.desksPlaced, `${key}: plan shows ${deskRects} desks, layout has ${L.readouts.desksPlaced}`);
    ok((await page.locator('[data-testid="ro-desks"]').textContent()).trim() === `${L.readouts.desksPlaced} / ${L.readouts.desksRequested}`, `${key}: desk readout text`);
    for (const w of ['S', 'E', 'N', 'W']) {
      const { segs, total } = await dimChain(w);
      ok(segs.reduce((a, b) => a + b, 0) === total, `${key}: ${w} chain ${segs.join('+')} != ${total}`);
      ok(total === (w === 'S' || w === 'N' ? L.site.width : L.site.depth), `${key}: ${w} overall dimension ${total}`);
    }
    for (const v of ['split', '3d', 'plan']) {
      await page.click(`[data-testid="view-${v}"]`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, `${key}-${v}.png`) });
    }
    await page.click('[data-testid="view-split"]');
  }

  // 2. exact mm entry
  console.log('Openings editor');
  await setField('preset', 'team8');
  await setField('op.0.offset', 1234);
  let L = await layout();
  const door = L.site.openings[0];
  ok(door.s0 === 1234, `typed offset 1234 gives s0 ${door.s0}`);
  ok((await dimChain('S')).segs[0] === 1234, `S chain first segment ${(await dimChain('S')).segs[0]} after typing 1234`);

  // 3. switch reference corner: the door must not move, the offset must convert
  await setField('op.0.ref', 'SE');
  L = await layout();
  const expected = L.site.width - 1234 - door.width;
  ok(Number(await val('op.0.offset')) === expected, `offset from SE shows ${await val('op.0.offset')}, expected ${expected}`);
  ok(L.site.openings[0].s0 === 1234, `door moved to s0 ${L.site.openings[0].s0} after switching corner`);
  await setField('op.0.ref', 'SW');
  ok(Number(await val('op.0.offset')) === 1234, 'switching back to SW restores 1234');

  // 4. add and remove an opening
  const before = (await layout()).site.openings.length;
  await page.click('[data-testid="add-window"]');
  ok((await layout()).site.openings.length === before + 1, 'add window adds an opening');
  await page.click(`[data-testid="remove-op-${before}"]`);
  ok((await layout()).site.openings.length === before, 'remove takes it away again');
  await page.click('[data-testid="add-door"]');
  ok((await layout()).site.openings.filter((o) => o.kind === 'door').length === 2, 'add door adds a door');
  await page.click(`[data-testid="remove-op-${before}"]`);

  // 5. fix the site: presets and strategies may only change the furniture
  console.log('Fixed site');
  await page.click('[data-testid="toggle-fix"]');
  ok(await page.locator('[data-testid="site.width"]').isDisabled(), 'site width is locked when fixed');
  ok(await page.locator('[data-testid="add-door"]').isDisabled(), 'add door is locked when fixed');
  const siteBefore = JSON.stringify((await layout()).site);
  await setField('preset', 'corner10');
  L = await layout();
  ok(JSON.stringify(L.site) === siteBefore, 'preset changed the fixed site');
  ok(L.readouts.desksRequested === 10, 'preset programme applied while the site is fixed');
  ok(await page.locator('[data-testid="note"]').isVisible(), 'note explains that only the programme was applied');
  for (const s of ['meeting', 'compact', 'daylight']) {
    await setField('strategy', s);
    ok(JSON.stringify((await layout()).site) === siteBefore, `strategy ${s} changed the fixed site`);
  }
  await page.click('[data-testid="view-plan"]');

  // 6. reload and confirm the state comes back
  console.log('Reload');
  const stateBefore = JSON.stringify(await layout());
  await page.reload();
  await page.waitForFunction(() => window.__layout);
  ok(JSON.stringify(await layout()) === stateBefore, 'layout differs after reload');
  ok(await page.locator('[data-testid="fixed-badge"]').isVisible(), 'fixed badge restored');
  ok(Number(await val('op.0.offset')) === 1234, 'typed offset restored');
  ok((await page.locator('[data-testid="view-plan"]').getAttribute('aria-pressed')) === 'true', 'view mode restored');

  // 7. the URL alone restores the state in a fresh browser profile
  const shared = page.url();
  const page2 = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  page2.on('pageerror', (e) => errors.push(`pageerror (2nd): ${e.message}`));
  await page2.goto(shared);
  await page2.waitForFunction(() => window.__layout);
  ok(JSON.stringify(await page2.evaluate(() => window.__layout)) === stateBefore, 'shared URL gives a different layout');

  // 8. release
  await page.click('[data-testid="view-split"]');
  await page.click('[data-testid="toggle-fix"]');
  ok(!(await page.locator('[data-testid="site.width"]').isDisabled()), 'site width unlocked after release');

  // desk arrangement and table shape
  console.log('Programme options');
  await setField('preset', 'team8');
  await setField('programme.deskLayout', 'benches');
  L = await layout();
  ok(L.deskLayout === 'benches' && L.elements.some((e) => e.bench), 'choosing benches gives bench desks');
  await setField('programme.tableShape', 'round');
  L = await layout();
  ok(L.elements.some((e) => e.kind === 'table' && e.shape === 'round'), 'choosing round gives a round table');
  ok(await page.locator('#plan circle[data-kind="table"]').count() === 1, 'round table drawn as a circle');
  await page.screenshot({ path: path.join(SHOTS, 'team8-benches-round.png') });

  // build file download
  console.log('Build file');
  await setField('preset', 'team8');
  await setField('name', 'Team room North');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="download"]')]);
  ok(dl.suggestedFilename() === 'team-room-north.office-build.json', `download name ${dl.suggestedFilename()}`);
  const bf = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  ok(bf.format === 'office-configurator-build' && bf.version === 1 && bf.name === 'Team room North', 'downloaded build file format and name');
  ok(bf.model.boxes.length > 40 && bf.model.walls.length === 4 && bf.walls === true, 'downloaded build file has the model');

  // a Zone handed over by the Build in Archicad window becomes a fixed site
  const zone = Buffer.from(JSON.stringify({ name: 'Studio North', width: 9, depth: 6.6, origin: [20, 4, 0], rotationDeg: 15, story: 1 })).toString('base64url');
  await page.goto(`${url}#zone=${zone}`);
  await page.waitForFunction(() => window.__layout);
  L = await layout();
  ok(L.site.width === 9000 && L.site.depth === 6600, `zone size taken over: ${L.site.width} x ${L.site.depth}`);
  ok(await page.locator('[data-testid="fixed-badge"]').isVisible(), 'zone site is fixed');
  ok(await page.locator('[data-testid="zone-note"]').isVisible(), 'zone note shown');
  ok(!page.url().includes('#zone='), 'zone hash replaced by the saved state');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="download"]')]);
  const bf2 = JSON.parse(readFileSync(await dl2.path(), 'utf8'));
  ok(bf2.walls === false && bf2.placement.rotationDeg === 15 && bf2.placement.story === 1 && bf2.placement.origin[0] === 20, 'zone build file: no site walls, zone placement');
  await page.screenshot({ path: path.join(SHOTS, 'zone-handover.png') });
  await page.click('[data-testid="toggle-fix"]');

  // clearances on, for the screenshot set
  await setField('preset', 'team8');
  await page.check('[data-testid="show-zones"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, 'team8-clearances.png') });
  ok(await page.locator('#plan [data-zone="threshold"]').count() > 0, 'clearance zones drawn');
  await page.uncheck('[data-testid="show-zones"]');

  // ---------- tier M ----------
  console.log('Tier M');
  await setField('tier', 'M');
  await page.waitForFunction(() => window.__layout && window.__layout.tier === 'M');
  for (const key of ['floor36', 'floorL']) {
    await setField('m.preset', key);
    L = await layout();
    ok(L.tier === 'M' && L.readouts.desksPlaced === L.readouts.desksRequested, `${key}: programme met in the browser`);
    ok(await page.locator('#plan [data-kind="column"]').count() === L.readouts.columns, `${key}: plan shows every column`);
    ok(await page.locator('#plan [data-kind="room"]').count() === L.readouts.roomsPlaced, `${key}: plan shows every room`);
    ok(await page.locator('#plan [data-aisle="SPINE"]').count() === 1, `${key}: spine drawn`);
    for (const e of L.site.edges) {
      const segs = await page.evaluate((id) => [...document.querySelectorAll(`[data-testid^="dim-${id}-"]`)].filter((n) => !n.dataset.testid.endsWith('total')).map((n) => Number(n.dataset.value)), e.id);
      const total = Number(await page.locator(`[data-testid="dim-${e.id}-total"]`).getAttribute('data-value'));
      ok(total === e.length, `${key}: ${e.id} overall dimension ${total} = ${e.length}`);
      ok(segs.every((v) => v > 0), `${key}: ${e.id} chain segments positive`);
    }
    for (const v of ['split', '3d', 'plan']) {
      await page.click(`[data-testid="view-${v}"]`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `m-${key}-${v}.png`) });
    }
    await page.click('[data-testid="view-split"]');
  }
  // exact mm on an edge opening, and switching which end it is measured from
  await setField('m.preset', 'floor36');
  await setField('m.op.0.offset', 4321);
  L = await layout();
  ok(L.site.openings[0].s0 === 4321, `M: typed offset 4321 gives s0 ${L.site.openings[0].s0}`);
  await setField('m.op.0.ref', 'end');
  L = await layout();
  ok(L.site.openings[0].s0 === 4321 && Number(await val('m.op.0.offset')) === 36000 - 4321 - 1800, 'M: measuring from the other end keeps the door in place');
  // add / remove an opening
  const nOps = L.site.openings.length;
  await page.click('[data-testid="m-add-window"]');
  ok((await layout()).site.openings.length === nOps + 1, 'M: add window');
  await page.click(`[data-testid="m-remove-op-${nOps}"]`);
  ok((await layout()).site.openings.length === nOps, 'M: remove window');
  // shape -> L outline
  await setField('m.shape.kind', 'L');
  await setField('m.shape.a', 14000);
  await setField('m.shape.b', 10000);
  await page.click('[data-testid="m-apply-shape"]');
  L = await layout();
  ok(L.site.outline.length === 6, `M: L outline has 6 corners (${L.site.outline.length})`);
  await page.screenshot({ path: path.join(SHOTS, 'm-shape-L.png') });
  // pin a room exactly where asked
  await setField('m.preset', 'floor36');
  await page.click('[data-testid="m-add-pin"]');
  const pinI = (await page.evaluate(() => window.__layout)).elements ? (await page.locator('[data-testid^="m-pin-"]').count()) - 1 : 0;
  await setField(`m.pin.${pinI}.x`, 1000);
  await setField(`m.pin.${pinI}.y`, 13500);
  await setField(`m.pin.${pinI}.front`, 'E');
  L = await layout();
  const pinned = L.elements.find((e) => e.kind === 'room' && e.pinned);
  ok(pinned && pinned.x0 === 1000 && pinned.y0 === 13500 && pinned.front === 'E', `M: pinned room exactly where asked ${pinned && [pinned.x0, pinned.y0, pinned.front]}`);
  await page.screenshot({ path: path.join(SHOTS, 'm-pinned.png') });
  // fix the floor plate; presets and strategies only change the programme
  await page.click('[data-testid="toggle-fix"]');
  ok(await page.locator('[data-testid="m.shape.W"]').isDisabled(), 'M: floor plate locked when fixed');
  const siteM = JSON.stringify((await layout()).site);
  await setField('m.preset', 'floorL');
  ok(JSON.stringify((await layout()).site) === siteM, 'M: preset leaves a fixed floor plate alone');
  for (const st of ['meeting', 'compact', 'daylight']) {
    await setField('strategy', st);
    ok(JSON.stringify((await layout()).site) === siteM, `M: strategy ${st} leaves the floor plate alone`);
  }
  // build file for the floor
  const [dlm] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="download"]')]);
  const bfm = JSON.parse(readFileSync(await dlm.path(), 'utf8'));
  ok(bfm.model.tier === 'M' && bfm.model.beams.length === (await layout()).readouts.roomsPlaced && bfm.model.walls.some((w) => w.site === false), 'M: build file has partitions and thresholds');
  // reload restores tier M
  const beforeM = JSON.stringify(await layout());
  await page.reload();
  await page.waitForFunction(() => window.__layout);
  ok(JSON.stringify(await layout()) === beforeM, 'M: reload restores the floor');
  await page.click('[data-testid="toggle-fix"]');
  await setField('tier', 'S');
  ok((await layout()).tier === 'S', 'back to tier S');
} catch (err) {
  failures++;
  console.log(`  FAIL exception: ${err.stack || err}`);
} finally {
  for (const e of errors) { failures++; console.log(`  FAIL ${e}`); }
  await browser.close();
  proc.kill();
}
console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${path.relative(ROOT, SHOTS)}/`);
process.exit(failures ? 1 : 0);
