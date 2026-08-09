/**
 * What a villager should be dealing with right now. Pure core, thin shell.
 *
 * WHY A LADDER AND NOT A PERSONA
 * ------------------------------
 * The roster gives each villager a trade and a standing goal, which is enough
 * to keep them busy but says nothing about staying alive. With the world on
 * `easy`, auto-eat silently handling hunger and mobs switched off, that was
 * fine: their `needs` were narrative, and nothing bad happened to Nia for
 * having no food. On `hard` it is not fine, and a persona cannot express it --
 * "I am a farmer" does not tell you to get indoors when the sun goes down.
 *
 * So survival is computed from the live world each turn and stated as context,
 * in a fixed order of precedence. It sits UNDERNEATH the trade economy rather
 * than replacing it: a villager whose needs are met falls straight through to
 * their standing goal, and most turns that is exactly what happens.
 *
 *   1. imminent threat      -- NOT HERE. See the split rule below.
 *   2. dark and exposed     -> get to lit ground, or dig in
 *   3. hungry with no food  -> eat, hunt, take from the chest
 *   4. missing a tool tier  -> craft one, or ask Corin
 *   5. unsecured progress   -> a bed, a chest, lit ground
 *   ---- slack line ----
 *   6. your claimed job from the village work board
 *   7. nothing: your trade, unchanged
 *
 * THE SPLIT RULE
 * --------------
 * Anything that must happen faster than one LLM turn is a mode; anything else
 * is prompt state. A villager takes a turn every ~3 seconds at best (a 3s
 * cooldown plus inference), and on `hard` a creeper's fuse is 1.5s. Tier 1 can
 * therefore never be a prompt, and it is not: `self_preservation`,
 * `creeper_awareness`, `cowardice` and `self_defense` run off-LLM in the 300ms
 * mode loop. Tiers 2-5 have minutes of warning and belong here.
 *
 * THE SECOND RULE
 * ---------------
 * This never touches self-prompter state. It steers what a villager does on a
 * turn they were already taking. Stopping the goal loop to insert a survival
 * task is exactly the bug `modeGuard.js` exists to fix, one level up -- and
 * because nothing stops, nothing has to be resumed: when the need clears, the
 * block renders '' and the unchanged standing goal carries them back to work.
 *
 * WHAT IT COSTS
 * -------------
 * Nothing, on a turn where survival is met. The block is '' and the village
 * brief keeps its full 900 characters. When it does fire it takes its budget
 * FROM that 900 rather than adding to it, so the worst case is a squeezed
 * brief -- the shared-project line goes first. A villager about to freeze in
 * the dark does not need reminding that Ivo owes them a plank.
 */

import { ROSTER } from './roster.js';
import { nodeContaining, nearestNode, VILLAGE_PLACE as HEARTH_NAME } from './territory.js';

/** Lower number wins. 6 is the slack line: below it, survival; at it, work. */
export const TIER = Object.freeze({
    THREAT: 1, EXPOSED: 2, HUNGRY: 3, UNARMED: 4, UNSECURED: 5, JOB: 6, WORK: 7,
});

/**
 * ~80 tokens. Taken out of the village brief's 900, never added to it --
 * see chronicle/brief.js, where the budget is the design.
 */
export const FOCUS_MAX_CHARS = 320;
/** No single line may crowd out the other. Matches brief.js. */
const LINE_MAX = 160;

/**
 * The place name every villager uses for the shared base.
 *
 * Owned by territory.js, where it is also the settlement's primary key, and
 * re-exported here because the persona and this ladder both speak of it as a
 * place rather than as a database row. One definition: a contract between the
 * graph, the persona text, `!rememberHere` and `!goToRememberedPlace` that
 * drifts silently if it is ever written down twice.
 */
export const VILLAGE_PLACE = HEARTH_NAME;

/**
 * Every threshold in one table, so the aggressiveness of the whole ladder is
 * one edit. If survival fires on more than about a third of turns in steady
 * state it has eaten the economy, and this is the thing to loosen -- not the
 * brakes further down.
 */
export const THRESHOLDS = Object.freeze({
    /** Start worrying ~50s before mobs spawn, not after. */
    DUSK_TICKS: 11000,
    DAWN_TICKS: 23000,
    /** Blocks overhead that count as being under cover. */
    ROOF_SCAN: 6,
    /** Inside this of a settlement centre, you are "at" it. */
    NODE_RADIUS: 24,
    /** Matches autoEat's minHunger: below this it is already eating if it can. */
    HUNGER: 14,
    /** Facts older than this are hedged, not asserted. */
    STALE_MS: 600000,
    /** A need just met is not raised again for this long. */
    LATCH_MS: 90000,
    /** Chronic tiers (4 and 5) may be raised at most this often. */
    SOFT_TIER_MS: 300000,
});

/**
 * Tool names, interpolated rather than typed as literals.
 *
 * Under `tool_choice: "required"` the model emits exactly one call and cannot
 * deliberate in prose, so a need it cannot map to a tool in one hop is a wasted
 * turn. Naming the tool is what makes the line actionable -- and pulling the
 * names from one place means a rename cannot silently orphan the text. A test
 * checks every one of these against the real tool surface.
 */
export const TOOLS = Object.freeze({
    goTo: 'goToRememberedPlace',
    shelter: 'shelterHere',
    consume: 'consume',
    collect: 'collectBlocks',
    craft: 'craftRecipe',
    take: 'takeFromChest',
    bed: 'goToBed',
    place: 'placeHere',
    speak: 'startConversation',
    work: 'workHere',
});

/**
 * Food a villager may rely on, minus everything agent.js bans from auto-eat.
 *
 * A static set rather than a minecraft-data lookup on purpose: minecraft-data
 * is version-scoped and only live after `initBot()`, and tools.js already
 * carries a `safeLookup` because of exactly that hazard. A needs evaluator must
 * never be the thing that kills a turn.
 */
const EDIBLE = new Set([
    'bread', 'apple', 'carrot', 'potato', 'baked_potato', 'beetroot', 'melon_slice',
    'sweet_berries', 'glow_berries', 'dried_kelp', 'cooked_beef', 'cooked_porkchop',
    'cooked_mutton', 'cooked_rabbit', 'cooked_chicken', 'cooked_cod', 'cooked_salmon',
    'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'pumpkin_pie', 'golden_carrot',
    'cookie', 'honey_bottle',
]);

/**
 * Tool material ranking. Wood is a waypoint, not a destination -- a villager
 * holding only wooden tools has started, not finished, which is why `min < 2`
 * still raises the tier. Gold ranks with stone: fast, but it breaks before it
 * has paid for the ore.
 */
const MATERIAL_RANK = { wooden: 1, golden: 2, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const TOOL_KINDS = ['sword', 'pickaxe', 'axe'];

const trim = (s) => (s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + '…' : s);
const smith = () => ROSTER.find((a) => a.role === 'smith')?.name || 'the smith';
const xyz = (p) => (p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?');

/* ------------------------------------------------------------------ *
 * Reading the world
 * ------------------------------------------------------------------ */

/**
 * How far above the villager's head the first solid block sits, or null for
 * open sky.
 *
 * Deliberately not `world.getFirstBlockAboveHead`, which returns a formatted
 * string ("stone (3 blocks up)") that would have to be parsed back -- a lossy
 * round trip for no gain. Deliberately not a light-level check either:
 * `block.light` and `skyLight` are documented as bugged in this version
 * (queries.js), which is why safety here is geometric throughout.
 */
function roofHeight(bot) {
    const pos = bot?.entity?.position;
    if (!pos) return null;
    for (let i = 0; i <= THRESHOLDS.ROOF_SCAN; i++) {
        const b = bot.blockAt?.(pos.offset(0, i + 2, 0));
        if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') return i + 2;
    }
    return null;
}

/**
 * Everything the ladder reads from the live bot, gathered once.
 *
 * Every access is optional-chained. This runs inside a turn, and a villager
 * standing still because their needs evaluator threw would be a worse bug than
 * anything it detects.
 */
export function readBotState(agent) {
    const bot = agent?.bot;
    const pos = bot?.entity?.position ?? null;
    const inventory = {};
    for (const item of bot?.inventory?.items?.() ?? []) {
        inventory[item.name] = (inventory[item.name] ?? 0) + (item.count ?? 0);
    }
    return {
        name: agent?.name ?? '',
        role: ROSTER.find((a) => a.name === agent?.name)?.role ?? null,
        health: bot?.health ?? 20,
        food: bot?.food ?? 20,
        timeOfDay: bot?.time?.timeOfDay ?? 0,
        pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        roofHeight: roofHeight(bot),
        inventory,
        sleptSinceLogin: agent?._sleptSinceLogin === true,
        // Recorded for context only. If a villager is genuinely in danger a mode
        // is executing and there is no turn to render into -- so this can only
        // ever describe a threat already dealt with.
        underThreat: (bot?.lastDamageTime ?? 0) > Date.now() - 10000,
    };
}

/* ------------------------------------------------------------------ *
 * The ladder
 * ------------------------------------------------------------------ */

const isNight = (t) => t >= THRESHOLDS.DUSK_TICKS && t < THRESHOLDS.DAWN_TICKS;

/** Highest material rank held for a tool kind, 0 if the villager has none. */
function toolTier(inventory, kind) {
    let best = 0;
    for (const [name, count] of Object.entries(inventory)) {
        if (!count || !name.endsWith(`_${kind}`)) continue;
        const rank = MATERIAL_RANK[name.slice(0, -(kind.length + 1))];
        if (rank > best) best = rank;
    }
    return best;
}

const hasFood = (inventory) =>
    Object.entries(inventory).some(([name, count]) => count > 0 && EDIBLE.has(name));

/**
 * The single top unmet need, or null when survival is satisfied.
 *
 * PURE: no bot, no database, no clock beyond `ctx.now`. Evaluated in ladder
 * order and short-circuiting at the first unmet tier, which is the cost model
 * and not just semantics -- `food` is a property, but a settlement scan walks
 * every node, eight times a village. Cheap probes at the top, expensive ones at
 * the bottom, and the expensive ones only run on turns where everything above
 * them passed.
 *
 * @param {object} bot from readBotState
 * @param {object} graph the territory graph; {} is a supported state
 * @param {{now:number, latches?:Map<string,number>, raised?:Map<string,number>}} ctx
 * @returns {{tier:number, key:string, lines:string[]}|null}
 */
export function evaluate(bot, graph = {}, ctx = {}) {
    // Normalised up front rather than guarded at each use. This is called from
    // inside a turn against whatever mineflayer happened to have populated, and
    // a villager standing still because their needs evaluator threw would be a
    // worse bug than anything it detects.
    bot = { inventory: {}, ...(bot ?? {}) };
    if (!bot.inventory) bot.inventory = {};
    graph = graph ?? {};

    const now = ctx.now ?? Date.now();
    const latches = ctx.latches ?? new Map();
    const raised = ctx.raised ?? new Map();

    // A need satisfied moments ago is not raised again immediately. Without
    // this a villager hovering on a threshold -- 14 hunger, one torch short --
    // spends every turn being told about it.
    const latched = (key) => now - (latches.get(key) ?? -Infinity) < THRESHOLDS.LATCH_MS;
    // Tiers 4 and 5 are chronic rather than urgent: a missing pickaxe is true
    // for hours, and saying so every turn for hours would drown the trade layer
    // in a need the villager has already decided not to act on.
    const throttled = (key) => now - (raised.get(key) ?? -Infinity) < THRESHOLDS.SOFT_TIER_MS;

    const node = nodeContaining(graph, bot.pos);
    const nearest = nearestNode(graph, bot.pos);

    // --- Tier 2: dark, and nowhere safe to be ------------------------------
    // Lit ground counts wherever it is: inside a settlement, or on a road
    // between them. That is the whole point of building the network -- it makes
    // "am I safe tonight" a question about infrastructure rather than luck.
    if (isNight(bot.timeOfDay) && !latched('exposed')) {
        const sheltered = bot.roofHeight !== null;
        const safeGround = (node && node.lit?.safe) || graph.onRoad === true;
        if (!sheltered && !safeGround) {
            const lines = ['Night, and you are in the open with nothing over you.'];
            if (nearest && nearest.distance <= 96) {
                lines.push(trim(`${nearest.node.label ?? nearest.node._id} is ${nearest.distance} blocks away at ${xyz(nearest.node.centre)} -- call ${TOOLS.goTo} with "${nearest.node._id}", or ${TOOLS.shelter} if you cannot get back.`));
            } else {
                lines.push(trim(`Too far from anywhere lit to make it back -- call ${TOOLS.shelter} and sit the night out.`));
            }
            return { tier: TIER.EXPOSED, key: 'exposed', lines };
        }
    }

    // --- Tier 3: hungry, with nothing to eat -------------------------------
    // This can only fire when there is genuinely nothing: auto-eat handles
    // "hungry with food" silently and without an LLM turn. That is the correct
    // boundary between the two mechanisms -- do not move it by lowering this
    // threshold below autoEat's.
    if (bot.food <= THRESHOLDS.HUNGER && !hasFood(bot.inventory) && !latched('hungry')) {
        const lines = [`You are hungry (${bot.food}/20) and carrying nothing to eat.`];
        const chest = graph.chest;
        const fresh = chest?.contentsAt && now - new Date(chest.contentsAt).getTime() < THRESHOLDS.STALE_MS;
        const stock = fresh
            ? Object.entries(chest.contents ?? {}).filter(([n, c]) => c > 0 && EDIBLE.has(n))
            : [];
        if (stock.length) {
            const [item, count] = stock[0];
            lines.push(trim(`The village chest at ${xyz(chest)} had ${count} ${item} -- call ${TOOLS.goTo} with "village_chest", then ${TOOLS.take}.`));
        } else if (chest) {
            // Hedged, not asserted. Sending someone to a chest emptied twenty
            // minutes ago wastes a turn and teaches them to distrust the block.
            lines.push(trim(`There may be food in the village chest at ${xyz(chest)}, or ask whoever cooks.`));
        } else {
            lines.push(trim(`Hunt something and cook it, or pull a crop -- or ask someone for food with ${TOOLS.speak}.`));
        }
        return { tier: TIER.HUNGRY, key: 'hungry', lines };
    }

    // --- Tier 4: no tool tier ----------------------------------------------
    // The line names the smith rather than the crafting recipe. The fix for
    // this tier is social, and that is the join between staying alive and the
    // economy the village already runs.
    if (!latched('unarmed') && !throttled('unarmed')) {
        const tiers = Object.fromEntries(TOOL_KINDS.map((k) => [k, toolTier(bot.inventory, k)]));
        const missing = TOOL_KINDS.filter((k) => tiers[k] === 0);
        const weakest = Math.min(...TOOL_KINDS.map((k) => tiers[k]));
        if (missing.length || weakest < 2) {
            const named = missing.length > 1
                ? `${missing.slice(0, -1).join(', ')} and no ${missing.at(-1)}`
                : missing[0];
            const lines = missing.length
                ? [`You have no ${named}.`]
                : ['Your tools are all still wood, and wood does not last.'];
            lines.push(trim(`${smith()} the smith makes tools -- ask with ${TOOLS.speak}, or gather stone and ${TOOLS.craft} one yourself.`));
            return { tier: TIER.UNARMED, key: 'unarmed', lines };
        }
    }

    // --- Tier 5: nothing secured -------------------------------------------
    // The most expensive checks in the ladder, at the very bottom, and reached
    // only when everything above is satisfied.
    if (!latched('unsecured') && !throttled('unsecured')) {
        if (!bot.sleptSinceLogin && !(node?.beds ?? []).some((b) => b.claimedBy === bot.name)) {
            return {
                tier: TIER.UNSECURED, key: 'unsecured',
                lines: [
                    'You have no bed, so if you die you wake at world spawn with nothing.',
                    trim(`Sleep somewhere in the village with ${TOOLS.bed} -- that is what makes you wake up near your things.`),
                ],
            };
        }
        if (node && node.lit && !node.lit.safe) {
            const short = Math.max(0, (node.lit.cells ?? 0) - (node.lit.litCells ?? 0));
            return {
                tier: TIER.UNSECURED, key: 'unsecured',
                lines: [
                    `${node.label ?? node._id} is not fully lit -- ${short} spots left, and mobs spawn in the dark ones.`,
                    trim(`Put a torch down where it is dark with ${TOOLS.place}.`),
                ],
            };
        }
    }

    return null;
}

/**
 * Render the block. '' when there is nothing worth saying.
 *
 * A need and a job are mutually exclusive: exactly one thing is ever in the
 * villager's field of view, because under forced tool calls they can only act
 * on one of them anyway, and two competing instructions in one turn reliably
 * produces neither.
 *
 * PURE.
 *
 * @param {{tier:number, lines:string[]}|null} need
 * @param {{lines:string[]}|null} job
 * @param {{budget?:number}} opts
 */
export function renderFocus(need, job = null, { budget = FOCUS_MAX_CHARS } = {}) {
    const chosen = need ?? job;
    if (!chosen?.lines?.length) return '';

    // 'NEEDS' when it is about staying alive, 'WORK' when it is the village's
    // job list. Same block, same budget -- the header is what tells the
    // villager which of the two they are looking at.
    const header = need ? 'NEEDS' : 'WORK';
    let out = header;
    for (const line of chosen.lines) {
        // Assembled line at a time and never truncated mid-line. A half-written
        // survival instruction is worse than none: it reads as a complete
        // sentence about something else.
        if (out.length + 1 + line.length > budget) break;
        out += '\n' + line;
    }
    return out === header ? '' : out;
}

/* ------------------------------------------------------------------ *
 * The impure shell
 * ------------------------------------------------------------------ */

/** Per-process, per-villager. Lost on restart, which costs nothing. */
const latches = new Map();
const raised = new Map();
let lastKey = new Map();

/**
 * Read the territory graph.
 *
 * Empty until the graph lands (stage 3). Returning a neutral object rather
 * than throwing is the supported state, matching the Chronicle's contract: with
 * Mongo down the ladder degrades to individual survival rather than failing.
 */
async function readGraph(agent) {
    try {
        const territory = await import('./territory.js');
        const g = await territory.graph();
        // Mirror the shared places into this villager's own memory bank while
        // we have them, so !goToRememberedPlace can reach anything the village
        // knows about without a tool of its own.
        territory.syncPlaces(agent, g);
        return g;
    } catch {
        // No database is a supported state: the ladder falls back to purely
        // individual survival rather than failing.
        return { nodes: [], edges: [], chest: null };
    }
}

/**
 * Evaluate, latch and render for one villager. Never throws, never blocks a
 * turn on the database.
 *
 * @param {object} agent
 * @returns {Promise<string>}
 */
export async function assess(agent) {
    try {
        const me = agent?.name;
        if (!me) return '';
        const now = Date.now();
        const bot = readBotState(agent);
        // Nothing to say about a villager whose bot has not finished spawning.
        // Their inventory reads as empty, which would otherwise be reported as
        // "you have no sword" to someone who has not yet entered the world.
        if (!bot.pos) return '';
        const graph = await readGraph(agent);

        const need = evaluate(bot, graph, {
            now,
            latches: latches.get(me) ?? new Map(),
            raised: raised.get(me) ?? new Map(),
        });

        // Latch whatever we just stopped raising: the transition from "raised"
        // to "not raised" is the only evidence available that a need was met.
        const previous = lastKey.get(me) ?? null;
        if (previous && previous !== need?.key) {
            if (!latches.has(me)) latches.set(me, new Map());
            latches.get(me).set(previous, now);
        }
        if (need) {
            if (!raised.has(me)) raised.set(me, new Map());
            raised.get(me).set(need.key, now);
        }
        lastKey.set(me, need?.key ?? null);

        return renderFocus(need, null);
    } catch {
        // A broken evaluator must never cost a turn. Silence here means the
        // villager falls through to their standing goal, which is the same
        // thing that happens when everything is fine.
        return '';
    }
}

/** Test seam, mirroring chronicle._resetForTests. */
export function _resetForTests() {
    latches.clear();
    raised.clear();
    lastKey = new Map();
}
