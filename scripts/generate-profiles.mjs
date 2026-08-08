/**
 * Write profiles/village/*.json from the roster.
 * Regenerate after editing src/society/roster.js -- the roster is the source of
 * truth, the profiles are build output.
 *
 *   node scripts/generate-profiles.mjs
 */
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROSTER, profileFor } from '../src/society/roster.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'profiles', 'village');

await mkdir(outDir, { recursive: true });

const written = [];
for (const agent of ROSTER) {
    const file = path.join(outDir, `${agent.name.toLowerCase()}.json`);
    await writeFile(file, JSON.stringify(profileFor(agent), null, 4) + '\n');
    written.push(path.relative(root, file));
}

console.log(`wrote ${written.length} profiles:`);
for (const f of written) console.log('  ' + f);
console.log('\nlaunch with:\n  node main.js --profiles ' +
    ROSTER.map((a) => `./profiles/village/${a.name.toLowerCase()}.json`).join(' '));
