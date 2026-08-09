/**
 * What "safe ground" and "a road" are made of. Pure geometry, no database, no
 * mineflayer.
 *
 * SAFETY IS GEOMETRIC, NEVER MEASURED
 * -----------------------------------
 * The obvious way to ask whether somewhere is safe is to read the light level.
 * That is not available: `block.light` and `skyLight` are documented as bugged
 * in this version (see queries.js), and a safety check that silently returns
 * the wrong answer is worse than none.
 *
 * So safety is defined as a lattice property instead. A torch is light 14 and
 * light falls about one per block, so torches on a 7-block grid leave the worst
 * point inside a cell at roughly 8 -- far above the 0 that hostile spawning
 * requires, with margin for occlusion. That is checkable with ordinary block
 * reads: count the lattice points that hold a torch. Somewhere is safe when
 * every cell is lit, and "how much work is left" is a subtraction rather than
 * a judgement.
 *
 * FENCES DO NOT STOP SPAWNS
 * -------------------------
 * Worth saying in the code, because it is the mistake somebody will make later:
 * mobs spawn in darkness INSIDE a fenced area perfectly happily, spiders climb
 * fences and skeletons shoot over them. What fences actually buy is keeping
 * villagers in (nobody walks off a ravine lip in the dark), keeping zombies and
 * creepers from strolling through, and making pathfinding predictable. Lighting
 * does the safety work. Adding more fence to a settlement that keeps spawning
 * mobs will never help.
 *
 * DETERMINISM IS LOAD-BEARING
 * ---------------------------
 * Every function here must return the same thing given the same input, in the
 * same order. Eight independent villager processes each generate the job list
 * from the same agreed project, and they identify jobs by a deterministic id --
 * so identical output is what lets all eight race to fill the work board and
 * produce one board rather than eight.
 */

/** Torch spacing. Conventional play, and it leaves light ~8 in the worst corner. */
export const LATTICE_SPACING = 7;
/** Road segments are chunk-sized, so a job is addressable and bounded. */
export const SEGMENT_LEN = 16;
/** Roads are three wide: one to walk, one either side so mobs cannot crowd you. */
export const ROAD_WIDTH = 3;
/** A drop worth fencing. Below this you take no fall damage worth the planks. */
export const FENCE_DROP = 3;

const r = (n) => Math.round(n);

/**
 * The torch positions that light a settlement.
 *
 * Ordered outward from the centre, deterministically, so the first jobs claimed
 * light the middle of a settlement rather than a random edge of it -- a half-lit
 * ring around a dark core is the worst possible intermediate state.
 */
export function latticePoints(node) {
    const c = node?.centre;
    if (!c) return [];
    const radius = node.radius ?? 24;
    const out = [];
    const steps = Math.floor(radius / LATTICE_SPACING);
    for (let i = -steps; i <= steps; i++) {
        for (let j = -steps; j <= steps; j++) {
            const x = r(c.x) + i * LATTICE_SPACING;
            const z = r(c.z) + j * LATTICE_SPACING;
            if (Math.hypot(x - c.x, z - c.z) > radius) continue;
            out.push({ x, y: r(c.y), z, d: Math.abs(i) + Math.abs(j) });
        }
    }
    // Centre first, then a stable tie-break so every process agrees.
    out.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
    return out.map(({ x, y, z }) => ({ x, y, z }));
}

/** How many lattice cells a settlement has, and whether it is fully lit. */
export function litState(node, litCells = 0) {
    const cells = latticePoints(node).length;
    return { cells, litCells, safe: cells > 0 && litCells >= cells };
}

/**
 * A road split into segments.
 *
 * Straight-line, deliberately: the villagers' pathfinder handles terrain, and a
 * road that follows the ground exactly would need a survey nobody can do from
 * inside a turn. Each segment is a claim, a unit of work, and a thing that can
 * be verified by standing in it.
 */
export function segmentsBetween(from, to, len = SEGMENT_LEN) {
    if (!from || !to) return [];
    const dx = to.x - from.x, dz = to.z - from.z;
    const total = Math.hypot(dx, dz);
    if (total < 1) return [];
    const count = Math.max(1, Math.ceil(total / len));
    const out = [];
    for (let i = 0; i < count; i++) {
        const t0 = i / count, t1 = (i + 1) / count;
        out.push({
            index: i,
            from: { x: r(from.x + dx * t0), y: r(from.y), z: r(from.z + dz * t0) },
            to: { x: r(from.x + dx * t1), y: r(to.y), z: r(from.z + dz * t1) },
        });
    }
    return out;
}

/** Torches along a road segment, alternating sides so one side is never dark. */
export function segmentTorches(seg) {
    if (!seg) return [];
    const dx = seg.to.x - seg.from.x, dz = seg.to.z - seg.from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) return [];
    // Perpendicular, normalised, for the offset to either side of the path.
    const px = -dz / len, pz = dx / len;
    const out = [];
    for (let d = 0, n = 0; d <= len; d += LATTICE_SPACING, n++) {
        const t = d / len;
        const side = n % 2 === 0 ? 1 : -1;
        out.push({
            x: r(seg.from.x + dx * t + px * side),
            y: r(seg.from.y),
            z: r(seg.from.z + dz * t + pz * side),
        });
    }
    return out;
}

/**
 * Turn something the village has agreed on into a list of jobs.
 *
 * Idempotent by construction: ids are derived from what the job is and where,
 * never from a counter or a timestamp, so running this twice -- or eight times
 * at once, on eight processes -- yields the same board.
 *
 * @param {{kind:'node'|'edge', node?:object, edge?:object, from?:object, to?:object}} target
 * @returns {object[]} job documents ready to upsert
 */
export function expandProject(target) {
    if (!target) return [];
    const jobs = [];

    if (target.kind === 'edge') {
        const { edge, from, to } = target;
        if (!edge || !from || !to) return [];
        for (const seg of segmentsBetween(from, to)) {
            const n = String(seg.index).padStart(2, '0');
            jobs.push({
                _id: `road:${edge._id}:seg:${n}`,
                kind: 'road_segment',
                ref: edge._id,
                from: seg.from,
                to: seg.to,
                spec: { width: ROAD_WIDTH, torches: segmentTorches(seg) },
                materials: { cobblestone: SEGMENT_LEN * ROAD_WIDTH, torch: segmentTorches(seg).length },
                // Earlier segments first: a road built from the ends inwards is
                // unusable until the last piece lands, and the whole point is
                // being able to walk part of it tonight.
                priority: 100 - seg.index,
                roles: [],
            });
        }
        return jobs;
    }

    const node = target.node;
    if (!node?.centre) return [];

    // Lighting first and at the highest priority. It is the only one of these
    // that stops a villager dying, and an unlit settlement with a beautiful
    // fence around it is still somewhere you cannot sleep.
    latticePoints(node).forEach((p, i) => {
        jobs.push({
            _id: `light:${node._id}:${p.x}_${p.z}`,
            kind: 'lattice_cell',
            ref: node._id,
            from: p, to: p,
            spec: { block: 'torch' },
            materials: { torch: 1 },
            priority: 200 - i,
            roles: [],
        });
    });

    jobs.push({
        _id: `chest:${node._id}`,
        kind: 'chest',
        ref: node._id,
        from: node.centre, to: node.centre,
        spec: { block: 'chest' },
        materials: { oak_planks: 8 },
        priority: 150,
        roles: [],
    });

    return jobs;
}

/**
 * Does what is actually on the ground match what the job asked for?
 *
 * `observed` maps "x,z" to a block name, or to null/undefined for anywhere the
 * villager could not see. UNKNOWN IS NOT MISSING, and that distinction is the
 * whole reason this function exists separately: bots only load chunks near
 * themselves, so a job checked from 200 blocks away reads as entirely empty.
 * Treating that as "nothing is built" would mark real work as undone for ever;
 * treating it as "all built" would mark it done having never touched it. So an
 * unseen cell means "come back and look", and verification requires having
 * actually seen every point.
 */
export function verifySpec(observed, points, wanted = 'torch') {
    if (!points?.length) return { done: false, seen: 0, missing: [], unknown: [] };
    const missing = [], unknown = [];
    let seen = 0;
    for (const p of points) {
        const key = `${p.x},${p.z}`;
        const block = observed ? observed[key] : undefined;
        if (block === undefined || block === null) { unknown.push(p); continue; }
        seen++;
        if (!String(block).includes(wanted)) missing.push(p);
    }
    return { done: unknown.length === 0 && missing.length === 0, seen, missing, unknown };
}
