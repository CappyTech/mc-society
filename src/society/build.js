/**
 * Structure building, exposed to the model.
 *
 * WHY THIS EXISTS
 * ---------------
 * A villager's entire placement surface was `!placeHere`, which puts one block
 * at the bot's own feet and whose own description says "Do NOT use to build
 * structures". Odile is the village builder with a standing goal of building
 * shelter, and she had no way to build anything.
 *
 * Meanwhile a complete multi-block builder was already present and running:
 * `src/agent/npc/build_goal.js` sites a build, rotates it, clears what is in
 * the way, places block by block, resumes where it stopped, and reports what
 * materials it ran out of. `NPCContoller.init()` loads all four schematics
 * unconditionally and `NPCData.fromObject(undefined)` returns valid defaults,
 * so `agent.npc.build_goal` and `agent.npc.constructions` are live in every
 * villager already. Only `NPCData.goals` is empty, so upstream's `bot.on(idle)`
 * driver never fires and nothing exposed it to the model.
 *
 * So this module is a thin adapter, in the same spirit as `tools.js`. It adds
 * no building logic. It picks a site, keeps it stable across calls, and turns
 * the result into a sentence the model can act on.
 */

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { Vec3 } from 'vec3';
import * as world from '../agent/library/world.js';
import { BuildGoal } from '../agent/npc/build_goal.js';
import { MATCHING_WOOD_BLOCKS } from '../utils/mcdata.js';

/**
 * Resolved from this module's own location, not from the process working
 * directory. `NPCContoller.init()` reads the same directory as the relative
 * path 'src/agent/npc/construction', which only works because the container
 * happens to run with working_dir /app.
 */
const CONSTRUCTION_DIR = fileURLToPath(new URL('../agent/npc/construction/', import.meta.url));

let _structures = null;

/** Schematic names available to build, read once from disk. */
export function listStructures() {
    if (_structures) return _structures;
    try {
        _structures = readdirSync(CONSTRUCTION_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort();
    } catch {
        _structures = [];
    }
    return _structures;
}

/** One schematic, parsed. Used by materialsFor() and by tests. */
export function loadStructure(name) {
    if (!listStructures().includes(name)) return null;
    try {
        return JSON.parse(readFileSync(CONSTRUCTION_DIR + name + '.json', 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Resolve a schematic's generic block name to a concrete item.
 *
 * The schematics use generic names -- 'planks', 'log', 'door', 'bed' -- which
 * `getTypeOfGeneric` (src/agent/npc/utils.js) resolves at build time against
 * whatever wood or wool the bot actually has. That function needs a live bot,
 * so it cannot be used to answer "what will this cost me" before starting.
 *
 * This mirrors only its *fallback* branches: oak for wood, white for beds.
 * Which means a materials list is indicative, not exact -- a builder holding
 * spruce planks will build a spruce house and the real requirement will differ
 * by wood type. That is fine for asking a neighbour for planks, and it is why
 * `missing` from an actual build pass is the authority, not this.
 */
export function resolveGeneric(blockName) {
    if (MATCHING_WOOD_BLOCKS.includes(blockName)) return 'oak_' + blockName;
    if (blockName === 'bed') return 'white_bed';
    return blockName;
}

/**
 * Total materials a schematic needs, as {item: count}.
 * @param {object} construction a parsed schematic
 */
export function materialsFor(construction) {
    const counts = {};
    if (!construction?.blocks) return counts;

    for (const layer of construction.blocks) {
        for (const row of layer) {
            for (const cell of row) {
                // '' means "leave whatever is there", 'air' means "clear it".
                // Neither costs the builder anything.
                if (!cell || cell === 'air') continue;
                const item = resolveGeneric(cell);
                counts[item] = (counts[item] || 0) + 1;
            }
        }
    }
    return counts;
}

/** "12 oak_planks, 3 white_bed" -- longest shortfall first. */
export function describeMissing(missing) {
    return Object.entries(missing || {})
        .sort((a, b) => b[1] - a[1])
        .map(([item, n]) => `${n} ${item}`)
        .join(', ');
}

/**
 * Which blocks the builder could not break, read back out of the skill log.
 *
 * `skills.breakBlockAt` logs "Don't have right tools to break <block>." and
 * gives up. BuildGoal has no channel for that -- it reports only `missing`
 * materials -- so an entire build can fail on a stone hillside while claiming
 * everything is fine. Recovering it from the log text is inelegant, but the
 * alternative is a builder that silently achieves nothing forever.
 *
 * @returns {string} e.g. "stone (I need a pickaxe)", or '' if nothing blocked
 */
export function blockedBy(output) {
    if (!output) return '';
    const blocks = new Set();
    for (const m of String(output).matchAll(/Don't have right tools to break ([a-z_]+)/g))
        blocks.add(m[1]);
    if (!blocks.size) return '';

    const names = [...blocks];
    const needsPick = names.some((b) => /stone|ore|deepslate|cobble|granite|diorite|andesite|tuff/.test(b));
    return names.join(', ') + (needsPick ? ' (I need a pickaxe)' : '');
}

/**
 * Orientation, derived from the site rather than stored or randomised.
 *
 * `executeNext` picks a random orientation when passed null. That is fine for
 * a one-shot build and wrong for a resumable one: a second call would rotate
 * the same half-built structure and place blocks into its own walls. Deriving
 * it from the coordinates keeps successive calls consistent without needing to
 * persist it, and still varies between sites.
 */
export function orientationFor(position) {
    return (((Math.floor(position.x) + Math.floor(position.z)) % 4) + 4) % 4;
}

/** Where a villager's build of `name` lives, once chosen. */
const siteKey = (name) => `build_${name}`;

/**
 * Modes paused while a build runs.
 *
 * A mode's `interrupts` list is NOT what decides whether it interrupts: modes.js
 * `execute()` opens `actions.runAction('mode:<name>')` unconditionally, and
 * runAction stops whatever is currently running. So *any* mode that fires
 * cancels a build, and `interrupts` only selects the wording of the follow-up
 * prompt. That is why `elbow_room`, which lists only `action:followPlayer`,
 * was observed killing builds.
 *
 * Each of these is wrong specifically during a build:
 *   unstuck         a builder standing still placing blocks looks exactly like
 *                   a stuck bot; it walked her 10 blocks off her own site
 *   elbow_room      fires constantly with seven other villagers around
 *   item_collecting wanders off after drops mid-structure
 *   torch_placing   places torches into the walls being built
 *   hunting         chases animals mid-structure
 *   idle_staring    harmless, but still cancels the action
 *
 * Deliberately NOT paused: `self_preservation`, `self_defense` and `cowardice`.
 * Drowning, burning or being shot at *should* interrupt a build -- the pass is
 * resumable, and a dead builder is worse than a delayed house.
 */
const BUILD_INTERRUPTERS = [
    'unstuck', 'elbow_room', 'item_collecting', 'torch_placing', 'hunting', 'idle_staring',
];

/**
 * Run one pass of a structure as a SINGLE agent action.
 *
 * `BuildGoal.wrapSkill` opens a fresh `actions.runAction` for every block it
 * breaks or places. ActionManager counts actions started less than 20ms apart
 * and, at five in a row, calls `cleanKill` on the whole agent
 * ("Infinite action loop detected, shutting down"). A build places dozens of
 * blocks back to back, so it reliably killed the builder mid-house -- observed
 * twice, exit code 1, ~22s after the command. Upstream's idle-loop driver has
 * the same exposure; nothing had ever exercised it.
 *
 * So BuildGoal is handed a facade of the agent whose `runAction` simply runs
 * the function. The real `runAction` is opened once, around the whole pass, by
 * the caller. Nothing in BuildGoal changes, and the loop detector goes back to
 * watching what it was designed to watch.
 *
 * The facade must still report interruption: `executeNext` returns early when
 * a skill reports `interrupted`, which is how a build yields to a conversation
 * or a stop request instead of running to completion regardless.
 */
async function runBuildPass(agent, construction, site, orientation) {
    const facade = Object.create(agent);
    // wrapSkill refuses to act unless the agent is idle -- and it is not, since
    // we are inside its action. From BuildGoal's point of view it is.
    facade.isIdle = () => true;
    facade.actions = {
        runAction: async (_label, fn) => {
            await fn();
            return { success: true, message: '', interrupted: !!agent.bot.interrupt_code, timedout: false };
        },
    };
    return await new BuildGoal(facade).executeNext(construction, site, orientation);
}

/**
 * Run one build pass, resuming an existing site if there is one.
 *
 * @returns {string} a sentence for the model
 */
export async function buildStep(agent, name) {
    const construction = agent.npc?.constructions?.[name];
    if (!construction)
        return `I don't know how to build "${name}". I can build: ${listStructures().join(', ')}.`;

    // Reuse the site across calls, so repeated builds continue one structure
    // instead of starting a new one alongside it. MemoryBank now persists
    // (see src/agent/history.js), so this also survives a restart.
    let site = agent.memory_bank?.recallPlace(siteKey(name));
    if (site) {
        site = { x: site[0], y: site[1], z: site[2] };
    } else {
        const sizex = construction.blocks[0][0].length;
        for (let x = 0; x < sizex; x++) {
            site = world.getNearestFreeSpace(agent.bot, sizex - x, 16);
            if (site) break;
        }
        if (!site)
            return `There is no clear space near me big enough for a ${name}. I should move somewhere more open.`;
        agent.memory_bank?.rememberPlace(siteKey(name), site.x, site.y, site.z);
    }

    // `executeNext` skips any block whose current state it cannot read
    // (`bot.blockAt` returns null for an unloaded chunk). If the whole site is
    // unloaded it therefore does nothing, wants nothing, and reports exactly
    // what a finished house reports -- so check before trusting that.
    if (!agent.bot?.blockAt?.(new Vec3(site.x, site.y, site.z)))
        return `I can't see the ground at the ${name} site from here. I should walk closer to it first.`;

    const orientation = orientationFor(site);

    // One action for the whole pass. Five minutes is generous for the largest
    // schematic and still bounded, so a build that gets stuck cannot hold the
    // villager forever.
    let res = null;
    const outcome = await agent.actions.runAction(
        'action:build',
        async () => {
            const modes = agent.bot?.modes;
            const paused = [];
            for (const m of BUILD_INTERRUPTERS) {
                try {
                    if (modes?.exists(m) && !modes.isOn(m)) continue;
                    modes?.pause(m);
                    paused.push(m);
                } catch { /* a mode this fork does not have */ }
            }
            try {
                res = await runBuildPass(agent, construction, site, orientation);
            } finally {
                // Restore only what we paused, so a mode the operator had
                // already paused stays paused.
                for (const m of paused) { try { modes?.unpause(m); } catch { /* ignore */ } }
            }
        },
        { timeout: 5 }
    );

    // A build is the longest, least observable thing a villager does, and its
    // outcome otherwise only reaches the model. Log it so an operator can see
    // whether a house is being built without reading the agent's history file.
    console.log(`[build] ${agent.name} ${name} @ ${site.x},${site.y},${site.z} ` +
                `orientation=${orientation} acted=${res?.acted} ` +
                `missing=${JSON.stringify(res?.missing ?? null)} ` +
                `interrupted=${!!outcome?.interrupted} timedout=${!!outcome?.timedout}`);
    // The skills log per-block outcomes ("Placed X at ...", "Failed to place
    // X", "X in the way") to bot.output, which never reaches the console. That
    // is the difference between "the pass ran" and "the pass achieved
    // anything", so surface a tail of it.
    if (outcome?.message)
        console.log(`[build] ${agent.name} output: ${String(outcome.message).replace(/\s+/g, ' ').slice(-600)}`);

    if (!res) {
        if (outcome?.timedout)
            return `I ran out of time working on the ${name}. I can carry on where I left off.`;
        return `I was interrupted before I could work on the ${name}.`;
    }

    const missing = describeMissing(res.missing);
    const where = `${Math.floor(site.x)}, ${Math.floor(site.y)}, ${Math.floor(site.z)}`;

    // A pass that changed nothing and wanted nothing means every block is
    // already correct -- that is the only reliable completion signal, since a
    // pass interrupted part-way also returns an empty `missing`.
    if (!res.acted && !missing)
        return `The ${name} at ${where} is finished.`;

    if (missing)
        return `I worked on the ${name} at ${where}. I still need: ${missing}. ` +
               `I should ask whoever produces them.`;

    // `missing` only counts materials the builder lacks. It says nothing about
    // ground that cannot be cleared -- and a site cut into a hillside stops a
    // build just as dead, while reporting nothing missing at all. Without this
    // the builder is told the house is progressing while not one block is
    // placed, and has no reason to go and ask the smith for a pickaxe.
    const blocked = blockedBy(outcome?.message);
    if (blocked)
        return `I could not clear the ground for the ${name} at ${where}: ${blocked}. ` +
               `I need the right tool before I can build here.`;

    return `I worked on the ${name} at ${where} and have the materials to continue.`;
}
