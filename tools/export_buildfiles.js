// Writes a build file for every preset, plus rotated / other-story variants, for the Archicad-side tests.
//   node tools/export_buildfiles.js <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generate } from '../web/generator.js';
import { PRESETS, presetState } from '../web/presets.js';
import { buildFile, slug } from '../web/buildfile.js';

const out = process.argv[2] || 'dist/buildfiles';
mkdirSync(out, { recursive: true });
const created = '2026-10-31T00:00:00.000Z';
const write = (name, state) => {
  const file = buildFile(state, generate(state), { name, created });
  const p = path.join(out, `${slug(name)}.office-build.json`);
  writeFileSync(p, JSON.stringify(file, null, 1));
  return p;
};
for (const [key, p] of Object.entries(PRESETS)) write(p.label, presetState(key));
write('Team room rotated 30', { ...presetState('team8'), placement: { origin: [12.5, -3.2, 0], rotationDeg: 30, story: 1 } });
write('Exec suite rotated 90', { ...presetState('exec6'), placement: { origin: [-4, 20, 0.15], rotationDeg: 90, story: 0 } });
write('From zone', { ...presetState('studio4'), placement: { fromZone: true, zoneName: 'Studio', origin: [3, 4, 0], rotationDeg: 0, story: 0 } });
console.log(`Build files written to ${out}`);
