/**
 * The village's territory: where its settlements are and what joins them.
 *
 * WHY A GRAPH
 * -----------
 * "Make the area safe" and "build a road to the mine" are the same problem once
 * you notice the village is a graph. Settlements are nodes, roads are edges,
 * and everything else falls out of that: safety is a property of a node or an
 * edge, navigation is walking it, expansion is adding to it, and the work board
 * is a list of the pieces that are not built yet.
 *
 * It also makes the answer to "am I safe tonight" a question about
 * infrastructure rather than luck, which is what gives the villagers a reason
 * to build anything. A lit road is not decoration; it is the difference between
 * walking home and dying in a field.
 *
 * NO LEADER, NO STARTUP ORDER
 * ---------------------------
 * The eight villagers are separate node processes (src/process/agent_process.js
 * spawns one per profile), so nothing is shared in memory and there is nobody to
 * elect. Every write here is an idempotent upsert on a deterministic id, so all
 * eight may race and the result is identical. The Chronicle's Mongo is the only
 * shared memory, and it already degrades safely when it is down -- with no
 * database the graph reads empty and the survival ladder falls back to
 * individual survival, which is a supported state rather than a failure.
 */

import { isUp, getModels, read } from './chronicle/connection.js';
import { edgeKey } from './chronicle/models.js';

/**
 * The shared base, and the word the villagers actually type.
 *
 * A node's `_id` IS the name `!goToRememberedPlace` takes, so there is no
 * mapping between "what the persona says" and "what the graph calls it" -- a
 * mapping that drifted would fail silently and look exactly like the model
 * being stupid. One name, no translation.
 *
 * It must also survive the tool->text->parser round trip byte-identically:
 * lowercase, one word, no punctuation (toolCommandBridge.js sanitises quotes
 * and collapses newlines, and the parser's argument regex has no unescaping).
 */
export const HEARTH = 'village';
/** Kept for the persona text and the ladder, which speak of it as a place. */
export const VILLAGE_PLACE = HEARTH;
/** World spawn: where everyone respawns, so the one node always worth having. */
export const SPAWN = 'spawn';
/** How long a cached graph is good for. Matches the brief's cache. */
const GRAPH_TTL_MS = 15000;

let cache = null;

/** Names must survive the tool->text->parser round trip byte-identically. */
export const slug = (name) =>
    String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/**
 * Found a settlement, or leave the existing one exactly as it is.
 *
 * $setOnInsert throughout: the FIRST villager to name a place wins and every
 * later namer is a no-op. That is deliberate and not merely a race guard -- a
 * base that moved every time somebody said "here is the village" would be worse
 * than no base at all, and eight villagers each nominating their own spot is
 * precisely what would happen.
 */
export function upsertNode(id, { kind = 'outpost', label, centre, radius, purpose, foundedBy, projectId } = {}) {
    try {
        if (!isUp() || !id || !centre) return;
        const models = getModels();
        void models?.Node.updateOne(
            { _id: id },
            {
                $setOnInsert: {
                    kind, label: label ?? id, centre, purpose: purpose ?? null,
                    radius: radius ?? 24, foundedBy: foundedBy ?? null,
                    projectId: projectId ?? null, foundedAt: new Date(),
                },
                $set: { updatedAt: new Date() },
            },
            { upsert: true },
        ).catch(() => {});
        cache = null;
    } catch { /* territory must never break a turn */ }
}

/** Join two settlements with a road. Endpoint order cannot create a second. */
export function upsertEdge(a, b) {
    try {
        if (!isUp() || !a || !b || a === b) return;
        const models = getModels();
        const [x, y] = [a, b].sort();
        void models?.Edge.updateOne(
            { _id: edgeKey(a, b) },
            { $setOnInsert: { a: x, b: y, createdAt: new Date() } },
            { upsert: true },
        ).catch(() => {});
        cache = null;
    } catch { /* territory must never break a turn */ }
}

/** Record the shared chest for a settlement. First one wins, as with the node. */
export function setChest(nodeId, pos) {
    try {
        if (!isUp() || !nodeId || !pos) return;
        const models = getModels();
        void models?.Node.updateOne(
            { _id: nodeId, 'chest.x': { $exists: false } },
            { $set: { chest: { x: pos.x, y: pos.y, z: pos.z }, updatedAt: new Date() } },
        ).catch(() => {});
        cache = null;
    } catch { /* ignore */ }
}

/**
 * Claim a bed, so this villager wakes near their things instead of at world
 * spawn. Recorded on the node rather than on the agent because it has to
 * survive a container restart, and because a bed is a place before it is a
 * possession.
 */
export function claimBed(nodeId, pos, who) {
    try {
        if (!isUp() || !nodeId || !pos || !who) return;
        const models = getModels();
        void models?.Node.updateOne(
            { _id: nodeId, 'beds.claimedBy': { $ne: who } },
            { $push: { beds: { x: pos.x, y: pos.y, z: pos.z, claimedBy: who, at: new Date() } } },
        ).catch(() => {});
        cache = null;
    } catch { /* ignore */ }
}

/**
 * The whole graph, cached briefly.
 *
 * Small enough to fetch entire -- a village has a handful of settlements, not
 * thousands -- and fetching it whole means the survival ladder can answer
 * "where is the nearest lit ground" without a second round trip mid-turn.
 */
export async function graph() {
    if (cache && Date.now() - cache.at < GRAPH_TTL_MS) return cache.value;

    const rows = await read(async (m) => {
        const [nodes, edges] = await Promise.all([
            m.Node.find({}).lean(),
            m.Edge.find({}).lean(),
        ]);
        return { nodes, edges };
    }, null);

    // No database is a supported state, not an error: the ladder degrades to
    // individual survival rather than failing.
    const value = rows
        ? { ...rows, chest: rows.nodes.find((n) => n.chest?.x !== undefined)?.chest ?? null }
        : { nodes: [], edges: [], chest: null };

    cache = { at: Date.now(), value };
    return value;
}

/**
 * Mirror shared places into one villager's own memory bank.
 *
 * This is what lets a settlement named by one villager be walked to by the
 * other seven WITHOUT A NEW TOOL. `!goToRememberedPlace` and `!savedPlaces`
 * already exist and already read the memory bank; the bank is just per-process.
 * So the Chronicle becomes the transport and the bank becomes its local cache,
 * and eight independent processes end up agreeing on where everything is using
 * commands that were already in CORE_TOOLS.
 */
export function syncPlaces(agent, g) {
    try {
        const bank = agent?.memory_bank;
        if (!bank?.rememberPlace) return;
        for (const n of g?.nodes ?? []) {
            if (n.centre) bank.rememberPlace(n._id, n.centre.x, n.centre.y, n.centre.z);
        }
        const chest = g?.chest;
        if (chest) bank.rememberPlace('village_chest', chest.x, chest.y, chest.z);
    } catch { /* a stale place is better than a lost turn */ }
}

/* ------------------------------------------------------------------ *
 * Geometry. Pure, and shared with the survival ladder so that "am I at the
 * village" means exactly one thing everywhere.
 * ------------------------------------------------------------------ */

/** The settlement a position is inside, or null. */
export function nodeContaining(g, pos) {
    if (!pos) return null;
    return (g?.nodes ?? []).find((n) => {
        const c = n.centre;
        if (!c) return false;
        return Math.hypot(c.x - pos.x, c.z - pos.z) <= (n.radius ?? 24);
    }) ?? null;
}

/** How wide a strip either side of a road still counts as being on it. */
export const ROAD_MARGIN = 4;

/**
 * Is this position on a finished, lit road?
 *
 * This is the payoff for the whole territory layer, and the reason it is worth
 * building: standing on a road the village has lit is a legitimate answer to
 * "it is dark and I am outside". Without it, infrastructure would be scenery
 * and the survival ladder would send villagers underground every night
 * regardless of what they had built.
 *
 * Only `open` edges count -- an edge whose segments are half done is a line on
 * a map, not somewhere to stand at night. Straight-line distance to the segment
 * between the two settlements, which matches how the road was laid out in the
 * first place (see site.js: segments are a straight line, and the pathfinder
 * handles the terrain).
 */
export function onRoad(g, pos, margin = ROAD_MARGIN) {
    if (!pos) return false;
    const byId = new Map((g?.nodes ?? []).map((n) => [n._id, n]));
    for (const e of g?.edges ?? []) {
        if (!e.open) continue;
        const a = byId.get(e.a)?.centre, b = byId.get(e.b)?.centre;
        if (!a || !b) continue;

        // Distance from the point to the segment ab, in the horizontal plane.
        const abx = b.x - a.x, abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        if (len2 === 0) continue;
        let t = ((pos.x - a.x) * abx + (pos.z - a.z) * abz) / len2;
        t = Math.max(0, Math.min(1, t));
        const dx = a.x + abx * t - pos.x, dz = a.z + abz * t - pos.z;
        if (Math.hypot(dx, dz) <= margin) return true;
    }
    return false;
}

/** The closest settlement and how far away it is, for "where do I run to". */
export function nearestNode(g, pos) {
    if (!pos) return null;
    let best = null, bestD = Infinity;
    for (const n of g?.nodes ?? []) {
        if (!n.centre) continue;
        const d = Math.hypot(n.centre.x - pos.x, n.centre.z - pos.z);
        if (d < bestD) { best = n; bestD = d; }
    }
    return best ? { node: best, distance: Math.round(bestD) } : null;
}

/**
 * A villager named a place. Found the shared base if that is what they called
 * it, otherwise do nothing.
 *
 * The decision lives here rather than in the Chronicle so there is exactly one
 * place that knows which name means "the village" -- the Chronicle records
 * every place and does not need to care which of them is special.
 *
 * This is also why founding needs no tool of its own: `!rememberHere` is
 * already in CORE_TOOLS, is already recorded, and saying "this is the village"
 * is precisely the act being observed.
 */
export function notePlaceNamed(owner, name, pos) {
    try {
        if (slug(name) !== HEARTH) return;
        upsertNode(HEARTH, {
            kind: 'hearth', label: 'the village', centre: pos, foundedBy: owner,
        });

        // Founding the village immediately opens the road back to spawn, and
        // fills the board with the work of building and lighting it.
        //
        // This is the one road worth building before any other, and it is not
        // decoration: spawn is where every villager wakes after dying, so a lit
        // road from there to the village turns the worst case in the game --
        // naked, in the dark, hundreds of blocks out, with everything you were
        // carrying on the floor somewhere else -- into a walk home. It is the
        // largest single brake on a death spiral, which is why it is created by
        // the act of founding rather than waiting to be voted for.
        void openRoadTo(HEARTH, pos).catch(() => {});
    } catch { /* never break !rememberHere */ }
}

/**
 * Link a settlement to the nearest place already on the map, and put the road's
 * segments and the settlement's lighting on the work board.
 *
 * Safe for all eight villagers to call at once: the edge id is the sorted pair
 * of endpoints and every job id is derived from its content, so eight identical
 * expansions collapse into one board.
 */
export async function openRoadTo(nodeId, centre) {
    if (!nodeId || !centre) return;
    const [site, board] = await Promise.all([
        import('./site.js'),
        import('./board.js'),
    ]);

    const g = await graph();
    const others = (g.nodes ?? []).filter((n) => n._id !== nodeId && n.centre);
    // Prefer spawn: everyone wakes there, so it is the end that matters most.
    const target = others.find((n) => n._id === SPAWN) ?? nearestNode({ nodes: others }, centre)?.node;

    if (target) {
        upsertEdge(target._id, nodeId);
        board.publish(site.expandProject({
            kind: 'edge',
            edge: { _id: edgeKey(target._id, nodeId) },
            from: target.centre,
            to: centre,
        }));
    }

    board.publish(site.expandProject({
        kind: 'node',
        node: { _id: nodeId, centre, radius: 24 },
    }));
}

/**
 * The name a villager has already given to somewhere near this spot.
 *
 * This is what closes the loop the village actually runs on: Sable ranges out,
 * finds ore and calls `!rememberHere("iron_ridge")`; Odile proposes a build
 * there; the village votes; and the settlement that appears is called
 * `iron_ridge` rather than `small_wood_house`. The scout's word for the place
 * is the one everybody then navigates by, which is both better naming and the
 * only part of founding that a villager chose deliberately.
 *
 * Nearest wins, within `radius`. Ties are broken by name so eight processes
 * asking at once agree.
 */
export async function placeNameNear(pos, radius = 32) {
    if (!pos) return null;
    const rows = await read((m) => m.Place.find({}).lean(), []);
    let best = null, bestD = Infinity;
    for (const p of rows ?? []) {
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        if (d > radius) continue;
        if (d < bestD || (d === bestD && p.name < best.name)) { best = p; bestD = d; }
    }
    return best ? slug(best.name) : null;
}

/**
 * Seed world spawn as a node.
 *
 * Worth having even before anyone has founded anything: it is where every
 * villager respawns, so it is the one location the graph can always assume,
 * and it is the far end of the first road worth building. A villager who dies
 * in the field wakes here, and a lit road from here to the village turns the
 * worst case -- naked in the dark, hundreds of blocks out -- into a walk home.
 *
 * Idempotent, so all eight may call it on connect.
 */
export function seedSpawn(pos) {
    if (!pos) return;
    upsertNode(SPAWN, { kind: 'spawn', label: 'world spawn', centre: pos, radius: 16 });
}

/** Test seam, and used when a write invalidates the read. */
export function _resetForTests() { cache = null; }
