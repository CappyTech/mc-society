/**
 * Refresh the deployed per-villager profile overrides from the repo profiles.
 *
 *   node scripts/sync-profile-overrides.mjs [dir]
 *
 * WHY THIS EXISTS
 * ---------------
 * Some villagers are pinned to a second LM Studio instance (each instance has
 * its own KV pool, and eight villagers on one pool overflow it). That is done
 * by bind-mounting a copy of the profile with a different `model.model` over
 * the repo's version.
 *
 * Those copies therefore SHADOW the generated profiles. Every persona change --
 * a new prompt placeholder, a reworded goal -- silently reaches only the four
 * villagers that are not overridden, which is the sort of split-brain that
 * shows up much later as "why does Odile behave differently".
 *
 * This regenerates each override from the current roster while preserving the
 * only thing the override is for: which model it points at.
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ROSTER, profileFor, byName } from '../src/society/roster.js';

const dir = process.argv[2] || '/mnt/data/mc-society/profile-overrides';

let files;
try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
} catch (e) {
    console.error(`No override directory at ${dir} (${e.code}). Nothing to do.`);
    process.exit(0);
}

if (!files.length) {
    console.log(`No overrides in ${dir}.`);
    process.exit(0);
}

let changed = 0;
for (const file of files) {
    const full = path.join(dir, file);
    const existing = JSON.parse(readFileSync(full, 'utf8'));
    const agent = byName(existing.name || path.basename(file, '.json'));
    if (!agent) {
        console.warn(`  ${file}: no villager of that name in the roster -- left alone`);
        continue;
    }

    const fresh = profileFor(agent);
    // The whole point of the override, and the only thing kept from it.
    if (existing.model?.model) fresh.model = { ...fresh.model, model: existing.model.model };
    if (existing.embedding?.model) fresh.embedding = { ...fresh.embedding, model: existing.embedding.model };

    const before = JSON.stringify(existing);
    const after = JSON.stringify(fresh);
    writeFileSync(full, JSON.stringify(fresh, null, 4) + '\n');
    if (before !== after) changed++;
    console.log(`  ${file}: ${agent.name} -> ${fresh.model.model}${before !== after ? '  (updated)' : ''}`);
}

console.log(`\n${files.length} override(s) synced from the roster, ${changed} changed.`);
console.log('Restart the village for these to take effect:');
console.log('  cd /mnt/data/mc-society && docker compose -f docker-compose.yml -f docker-compose.village.yml restart village');
