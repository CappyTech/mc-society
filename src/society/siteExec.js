/**
 * Doing a job from the work board. The thin impure half of site.js.
 *
 * Everything decidable is decided in site.js, which is pure and tested. This
 * file only touches the world, and it exists as one call because a turn is one
 * tool call: a 16-block road segment done a block at a time would be ten turns
 * and half a minute of pathfinding churn, against a Paper server already
 * carrying eight LLM agents.
 *
 * THE CHUNK RULE
 * --------------
 * A bot only loads chunks near itself, so `blockAt` beyond that returns null --
 * not air, null. Every job here therefore refuses to act until the villager is
 * standing in it, and verification treats unseen as unknown rather than as
 * missing. Without that a distant job either verifies as complete having never
 * been built, or can never verify at all.
 */

import Vec3 from 'vec3';
import * as skills from '../agent/library/skills.js';
import { verifySpec } from './site.js';

/** Anything the villager can stand on. Roads are walked, not admired. */
const PAVING = ['cobblestone', 'stone', 'dirt', 'gravel', 'andesite', 'oak_planks'];

const has = (bot, name) => {
    try {
        return (bot.inventory.items() ?? []).some((i) => i.name === name && i.count > 0);
    } catch { return false; }
};

/** The first thing in `names` this villager is actually carrying. */
const firstHeld = (bot, names) => names.find((n) => has(bot, n)) ?? null;

/**
 * Read the blocks at a set of points, as far as the villager can see them.
 *
 * null means "could not see", NOT "empty" -- outside the loaded chunks blockAt
 * returns null, and verifySpec relies on being able to tell those apart.
 */
function observe(bot, points) {
    const out = {};
    for (const p of points) {
        try {
            const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
            out[`${p.x},${p.z}`] = b ? b.name : null;
        } catch {
            out[`${p.x},${p.z}`] = null;
        }
    }
    return out;
}

/**
 * Carry out one job.
 *
 * @returns {Promise<{done:boolean, reason:string}>} `done` means the job's spec
 *   is satisfied and it may be closed. Anything else leaves it claimed so the
 *   villager can come back to it, or leaves it to expire if they do not.
 */
export async function executeJob(bot, job) {
    if (!job) return { done: false, reason: 'no job' };

    const target = job.from ?? job.to;
    if (!target) return { done: false, reason: 'job has no location' };

    // Get there first. Everything below reads or writes blocks, and none of it
    // means anything from outside the loaded chunks.
    const pos = bot.entity?.position;
    const far = !pos || Math.hypot(target.x - pos.x, target.z - pos.z) > 32;
    if (far) {
        await skills.goToPosition(bot, target.x, target.y, target.z, 4);
    }

    switch (job.kind) {
        case 'lattice_cell': {
            if (!has(bot, 'torch')) {
                skills.log(bot, 'No torches to light this with.');
                return { done: false, reason: 'no torch' };
            }
            const placed = await skills.placeBlock(bot, 'torch', target.x, target.y, target.z, 'bottom', true);
            return { done: placed, reason: placed ? 'lit' : 'could not place' };
        }

        case 'road_segment': {
            const torches = job.spec?.torches ?? [];
            let placed = 0;
            for (const t of torches) {
                if (!has(bot, 'torch')) break;
                await skills.goToPosition(bot, t.x, t.y, t.z, 3);
                if (await skills.placeBlock(bot, 'torch', t.x, t.y, t.z, 'bottom', true)) placed++;
            }
            const check = verifySpec(observe(bot, torches), torches, 'torch');
            skills.log(bot, `Worked the road: ${placed} torch(es) placed, ${check.missing.length} still dark.`);
            return { done: check.done, reason: check.done ? 'segment lit' : 'partly lit' };
        }

        case 'chest': {
            const wood = firstHeld(bot, ['chest', 'oak_planks', 'spruce_planks', 'birch_planks']);
            if (!wood) return { done: false, reason: 'nothing to build a chest from' };
            if (wood !== 'chest') {
                const made = await skills.craftRecipe(bot, 'chest', 1);
                if (!made) return { done: false, reason: 'could not craft a chest' };
            }
            const ok = await skills.placeBlock(bot, 'chest', target.x, target.y + 1, target.z, 'bottom', true);
            return { done: ok, reason: ok ? 'chest placed' : 'could not place the chest' };
        }

        case 'fence_run': {
            const fence = firstHeld(bot, ['oak_fence', 'spruce_fence', 'birch_fence']);
            if (!fence) return { done: false, reason: 'no fence' };
            const ok = await skills.placeBlock(bot, fence, target.x, target.y, target.z, 'bottom', true);
            return { done: ok, reason: ok ? 'fenced' : 'could not place' };
        }

        default: {
            const block = firstHeld(bot, PAVING);
            if (!block) return { done: false, reason: 'nothing to build with' };
            const ok = await skills.placeBlock(bot, block, target.x, target.y, target.z, 'bottom', true);
            return { done: ok, reason: ok ? 'built' : 'could not place' };
        }
    }
}
