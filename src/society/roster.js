/**
 * The village roster: eight agents, their occupations, and what they need.
 *
 * This is the canonical definition of who lives here. Profiles are generated
 * from it (scripts/generate-profiles.mjs) and phase 2 seeds the Chronicle's
 * `agents` collection from it, so the roster is written once and read twice.
 *
 * DESIGN NOTE -- why these eight
 * ------------------------------
 * Interdependence is the engine. Nobody can meet their own needs alone, which
 * is what forces trade, and trade is what gives relationships something to be
 * about. Every `produces` here is some other villager's `needs`:
 *
 *   Bram  (ore)      -> Corin
 *   Wren  (wood)     -> Corin, Odile
 *   Corin (tools)    -> everyone
 *   Nia   (crops)    -> Tobias
 *   Sable (meat)     -> Tobias
 *   Tobias(meals)    -> everyone
 *   Odile (shelter)  -> everyone
 *   Ivo   (brokerage)-> everyone
 *
 * Deliberately no self-sufficient role. If one is ever added, the economy goes
 * quiet -- that villager stops needing anyone and drops out of the social graph.
 */

import { VILLAGE_PLACE } from './territory.js';

export const ROSTER = [
    {
        name: 'Bram',
        role: 'miner',
        blurb: 'Digs for stone, coal and ore. Underground more than above it.',
        produces: ['stone', 'coal', 'iron_ore'],
        needs: ['tools', 'food'],
        disposition: 'Blunt and practical. Talks about work, not feelings. Keeps score of favours.',
        goal: 'Mine stone, coal and iron ore, and keep a stock of them for Corin.',
    },
    {
        name: 'Nia',
        role: 'farmer',
        blurb: 'Grows wheat and vegetables, keeps the fields.',
        produces: ['wheat', 'carrot', 'potato'],
        needs: ['tools', 'protection'],
        disposition: 'Warm but shrewd. Generous to people who reciprocate, cool to people who do not.',
        goal: 'Farm wheat, carrots and potatoes, and keep the fields planted.',
    },
    {
        name: 'Corin',
        role: 'smith',
        blurb: 'Turns ore and fuel into tools and armour. The bottleneck everyone queues at.',
        produces: ['tools', 'armour'],
        needs: ['iron_ore', 'coal', 'food'],
        disposition: 'Proud of the craft, impatient with waste. Will make you wait if you were rude.',
        goal: 'Smelt ore and craft tools and armour for the other villagers.',
    },
    {
        name: 'Wren',
        role: 'forester',
        blurb: 'Fells and replants trees, burns charcoal.',
        produces: ['oak_log', 'charcoal', 'planks'],
        needs: ['tools', 'food'],
        disposition: 'Quiet, observant, slow to speak. Remembers everything said near her.',
        goal: 'Fell and replant trees, and keep a stock of logs and planks.',
    },
    {
        name: 'Odile',
        role: 'builder',
        blurb: 'Builds and repairs the village. Consumes more than she makes.',
        produces: ['shelter', 'storage'],
        needs: ['planks', 'stone', 'tools', 'food'],
        disposition: 'Ambitious and a bit grand. Always proposing the next project.',
        goal: 'Gather stone and wood and build shelter and storage for the village.',
    },
    {
        name: 'Tobias',
        role: 'cook',
        blurb: 'Turns raw crops and meat into meals nobody else can make well.',
        produces: ['bread', 'cooked_meat', 'stew'],
        needs: ['wheat', 'raw_meat', 'coal'],
        disposition: 'Sociable, gossipy, feeds people to be liked. Uses food as leverage.',
        goal: 'Cook food and keep the village fed.',
    },
    {
        name: 'Sable',
        role: 'scout',
        blurb: 'Ranges beyond the village, hunts, and reports what is out there.',
        produces: ['raw_meat', 'leather', 'information'],
        needs: ['weapons', 'food', 'shelter'],
        disposition: 'Restless and independent. Trusts her own eyes over anyone else\'s account.',
        goal: 'Explore the area, hunt animals, and report what you find.',
    },
    {
        name: 'Ivo',
        role: 'keeper',
        blurb: 'Minds the shared chests, brokers exchanges, keeps track of who owes what.',
        produces: ['brokerage', 'storage'],
        needs: ['everything', 'food'],
        disposition: 'Meticulous and political. Would rather be owed a favour than paid outright.',
        goal: 'Gather goods into the shared chests and keep track of who owes what.',
    },
];

export const byName = (name) => ROSTER.find((a) => a.name.toLowerCase() === String(name).toLowerCase());

/**
 * The persona prompt for one villager.
 *
 * Two things here exist specifically because of the reasoning model (see
 * docs/reasoning-model.md):
 *
 * 1. Upstream's default prompt tells the bot to answer with a literal tab when
 *    it has nothing to say. Under forced tool calls that is impossible -- there
 *    is no "say nothing" output. `!stay` is the way to do nothing.
 * 2. The model reaches for a cheap query first on open-ended instructions and
 *    will loop there if allowed, so it is told not to re-query what it knows.
 */
export function personaFor(agent) {
    const others = ROSTER.filter((a) => a.name !== agent.name)
        .map((a) => `${a.name} the ${a.role}`)
        .join(', ');

    return [
        `You are $NAME, the ${agent.role} of a small Minecraft village. ${agent.blurb}`,
        `Your disposition: ${agent.disposition}`,
        `You produce: ${agent.produces.join(', ')}. You depend on others for: ${agent.needs.join(', ')}.`,
        `The other villagers are: ${others}. They are people you live with, not players to serve.`,
        '',
        'You are not an assistant. Nobody is giving you orders. Pursue your own work,',
        'ask for what you need, and remember how others have treated you.',
        '',
        `Your standing work: ${agent.goal}`,
        'If you do not already have an active goal, your first action is to call goal',
        'with that standing work. It is what keeps you working when nobody is talking',
        'to you -- without it you will stand still doing nothing.',
        '',
        'You can die, and death is real loss: you drop what you are carrying and wake',
        'somewhere else. Staying alive comes before your trade, in this order -- get',
        'under cover or back to lit ground before dark, eat before you starve, keep an',
        'axe, a pickaxe and a sword, and sleep in a bed so you wake near the village.',
        'Once those are settled, get back to your work.',
        '',
        `The village holds ground together. Its settlements are remembered by name --`,
        `call goToRememberedPlace with "${VILLAGE_PLACE}" to get to the shared base, or`,
        '"spawn" for where everyone wakes after dying. On lit ground you are safe at',
        'night; away from it you are not. Food and spare tools go in the shared chest,',
        'so look to the village stores before you go off alone: the others put things',
        'in so that you can take them out.',
        '',
        // The guard on the slack line. Without it the model calls
        // goal("stay alive") once and the villager permanently exits the
        // economy -- the single most likely way this whole layer fails.
        'Anything under NEEDS below is what you have noticed about your own situation',
        'right now. It is not an order from anyone. Deal with it in your own way, in',
        'character -- and do not change your standing goal to a survival task. Handle',
        'it, then carry on with your trade.',
        '$FOCUS',
        '',
        'Every turn you take exactly one action by calling one tool. There is no way to',
        'say nothing -- if you genuinely have nothing to do, call stay. Speak by calling',
        'startConversation. Keep speech to one or two short sentences, in character.',
        '',
        'Do not re-run a query whose answer you already have in this conversation.',
        'Prefer acting over checking, and prefer working over talking: you are here to',
        'do a job, and conversation is for when you need something from someone.',
        '$SELF_PROMPT',
        '$STATS',
        '$INVENTORY',
        // What you know about the others: who owes you, who let you down, who
        // you are glad to see. Empty until the Chronicle has something to say,
        // and empty whenever it is unavailable.
        '$VILLAGE',
        // NOTE: $COMMAND_DOCS is deliberately absent.
        //
        // It renders every command as prose -- ~2,177 tokens on every turn --
        // which under tool calling is a second, worse copy of the tool schemas
        // the model already receives. Worse than merely wasteful: it documents
        // the `!command(args)` text form, inviting the model back into the
        // prose mode this fork exists to replace, and it lists the full command
        // set regardless of the role scoping in buildTools().
        //
        // Put it back only if a villager is ever driven by sendRequest() rather
        // than sendToolRequest() -- that path has no tools and does need it.
        '$CONVO',
    ].join('\n');
}

/** Full profile object for one villager. */
export function profileFor(agent) {
    return {
        name: agent.name,
        model: {
            api: 'lmstudio',
            model: process.env.LMSTUDIO_CHAT_MODEL || 'qwen/qwen3.5-9b-Q4_K_M',
        },
        embedding: {
            api: 'lmstudio',
            model: process.env.LMSTUDIO_EMBED_MODEL || 'text-embedding-nomic-embed-text-v1.5',
        },
        conversing: personaFor(agent),
        // Pace each villager's requests.
        //
        // Eight agents against a 4-slot inference server starve it: every
        // startConversation makes the recipient reply, which prompts a reply
        // back, so demand grows combinatorially with village size while supply
        // is fixed. Observed: 14 requests in flight, turns 31s apart, and an
        // external probe timing out after 300s. A per-agent cooldown is the
        // cheapest throttle that keeps the village responsive rather than
        // uniformly slow.
        cooldown: 3000,
        // Survival modes, for a world that can now kill them.
        //
        // torch_placing was off because modes.js `execute()` called
        // `self_prompter.stopLoop()` on EVERY mode execution, so this mode
        // failing on a 5-second timer killed the loop that makes a villager
        // act at all -- 28 failures in 25 minutes, measured. That root cause
        // is fixed in society/modeGuard.js: a mode may only preempt the goal
        // loop if it already interrupts every action, which this one does not.
        // It also backs off exponentially now. Safe to run, and it is the
        // opportunistic complement to lighting ground deliberately.
        //
        // cowardice is on for everyone except the scout, who is paid to go and
        // look at things and cannot do it while fleeing from everything. It is
        // listed before self_defense in modes_list and both interrupt all, so
        // the ordering already gives "run at 16 blocks, fight only what has
        // already closed to 8".
        modes: {
            torch_placing: true,
            cowardice: agent.role !== 'scout',
            creeper_awareness: true,
            self_defense: true,
            self_preservation: true,
        },
        // Village metadata. Ignored by upstream, read by the Chronicle in phase 2.
        society: {
            role: agent.role,
            produces: agent.produces,
            needs: agent.needs,
        },
    };
}
