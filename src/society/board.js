/**
 * The village work board: how eight processes move as one organism.
 *
 * WHY A BOARD AND NOT A LEADER
 * ----------------------------
 * The villagers are separate node processes with no coordinator, no shared
 * memory and no startup order, so "who does what" cannot be assigned. It has to
 * be claimed. A claim here is a single findOneAndUpdate -- first writer wins,
 * no lock, no election -- which means all eight may reach for the same job at
 * the same instant and exactly one gets it.
 *
 * That is also what makes the village look like one animal rather than eight.
 * A villager on a slack turn is not left to improvise; they are told the next
 * piece of work and who is on the pieces either side of them. Cohesion costs
 * one clause in a sentence.
 *
 * WHAT KEEPS IT FROM EATING THE VILLAGE
 * -------------------------------------
 * Three brakes, all of which matter on hard difficulty:
 *
 *  - Claims expire. A villager WILL die mid-job, and without expiry that
 *    segment is orphaned for ever.
 *  - Failed work is counted. One impossible segment -- a ravine, a lava lake --
 *    must not be retried until the end of time; after ATTEMPT_MAX real failures
 *    it drops off so the rest of the board can proceed. Note "failures", not
 *    "claims": a villager who is told about a job and spends the turn on
 *    something else has not attempted anything, and counting that emptied the
 *    whole board to villagers who never touched it.
 *  - Block-laying is capped. Eight bots placing blocks and pathfinding on one
 *    Paper main thread, on a server already running eight LLM agents, is real
 *    load. At most MAX_CONCURRENT_BUILD villagers build at once; the others
 *    keep trading, which is the behaviour we actually want anyway.
 */

import { isUp, getModels, read } from './chronicle/connection.js';

/** A villager will die mid-job; the work must not die with them. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;
/** After this many tries a job is not merely unlucky. */
export const ATTEMPT_MAX = 3;
/**
 * How many villagers may be laying blocks at once.
 *
 * Not a correctness limit -- a tick-budget one. If Paper's tps drops during a
 * road build, this is the first number to lower.
 */
export const MAX_CONCURRENT_BUILD = 3;
/** Kinds that cost Paper real work, and are therefore capped. */
const BUILD_KINDS = ['road_segment', 'lattice_cell', 'fence_run', 'chest'];

/**
 * Put jobs on the board, leaving any that are already there untouched.
 *
 * $setOnInsert throughout, on the deterministic ids from site.js: all eight
 * villagers may expand the same agreed project simultaneously and the board
 * ends up identical. Progress on a job already claimed or done is never
 * clobbered by a villager re-deriving the list.
 */
export function publish(jobs) {
    try {
        if (!isUp() || !jobs?.length) return;
        const models = getModels();
        void models?.Job.bulkWrite(
            jobs.map((j) => ({
                updateOne: {
                    filter: { _id: j._id },
                    update: { $setOnInsert: { ...j, createdAt: new Date() } },
                    upsert: true,
                },
            })),
            { ordered: false },
        ).catch(() => {});
    } catch { /* the board is an optimisation, never a dependency */ }
}

/**
 * The job this villager already holds, if any.
 *
 * Checked before claiming a new one, so a villager keeps working on the thing
 * they walked to rather than being reassigned every turn -- which would look
 * busy and finish nothing.
 */
export function heldBy(who) {
    return read((m) => m.Job.findOne({
        claimedBy: who,
        doneAt: null,
        claimedAt: { $gte: new Date(Date.now() - CLAIM_TTL_MS) },
    }).lean(), null);
}

/**
 * Claim the most urgent job this villager is allowed to take, atomically.
 *
 * Note the two $or clauses are combined with $and explicitly. Written as two
 * bare `$or` keys in one object, the second silently overwrites the first --
 * which would hand out claimed jobs to everybody and be invisible until two
 * villagers were seen digging the same hole.
 */
export async function claim(who, role, { now = Date.now() } = {}) {
    if (!isUp() || !who) return null;
    const models = getModels();
    if (!models) return null;

    try {
        const building = await models.Job.countDocuments({
            kind: { $in: BUILD_KINDS },
            doneAt: null,
            // $nin, not two $ne keys: `{ $ne: null, $ne: who }` is one object
            // with a duplicate key, so the second silently wins and the null
            // check vanishes. That would have counted only OTHER people's
            // claims correctly by accident and been invisible until two
            // villagers were seen digging the same hole.
            claimedBy: { $nin: [null, who] },
            claimedAt: { $gte: new Date(now - CLAIM_TTL_MS) },
        });
        const kindFilter = building >= MAX_CONCURRENT_BUILD
            ? { kind: { $nin: BUILD_KINDS } }
            : {};

        return await models.Job.findOneAndUpdate(
            {
                doneAt: null,
                attempts: { $lt: ATTEMPT_MAX },
                ...kindFilter,
                $and: [
                    { $or: [{ claimedBy: null }, { claimedAt: { $lt: new Date(now - CLAIM_TTL_MS) } }] },
                    { $or: [{ roles: { $size: 0 } }, { roles: role }] },
                ],
            },
            // NOT $inc attempts. A claim is not an attempt: the villager is
            // told about the job and may well spend the turn on something else
            // entirely -- the block is context, not a control, and the model
            // picks its own tool. Counting claims meant every job burned its
            // three lives to villagers who never touched it, and the whole
            // board would quietly empty itself. Expiry already handles a claim
            // nobody acts on; attempts count real, failed work.
            { $set: { claimedBy: who, claimedAt: new Date(now) } },
            { sort: { priority: -1, _id: 1 }, returnDocument: 'after', new: true },
        ).lean();
    } catch {
        return null;
    }
}

/**
 * Mark a job finished, and open the road if that was the last piece of it.
 *
 * Opening the edge is what makes the work mean anything: `territory.onRoad`
 * only counts `open` edges, so until every segment is lit the survival ladder
 * still treats that ground as the open country it currently is. A half-built
 * road that counted as safe would be the worst possible bug here -- it would
 * tell villagers to walk down a dark corridor at night, confidently.
 */
export async function complete(id, who) {
    try {
        if (!isUp() || !id) return;
        const models = getModels();
        if (!models) return;
        await models.Job.updateOne(
            { _id: id, doneAt: null },
            { $set: { doneAt: new Date(), doneBy: who } },
        );

        const job = await models.Job.findById(id).lean();
        if (!job?.ref) return;

        // Lighting a cell moves a settlement toward being safe, and something
        // has to write that down. Nothing did: `lit.cells` stayed 0 on every
        // node, so a settlement could never report itself lit -- which made the
        // survival ladder treat villagers standing in their own village at
        // night as exposed, and told them to dig a hole in it.
        if (job.kind === 'lattice_cell') {
            const [cells, litCells] = await Promise.all([
                models.Job.countDocuments({ ref: job.ref, kind: 'lattice_cell' }),
                models.Job.countDocuments({ ref: job.ref, kind: 'lattice_cell', doneAt: { $ne: null } }),
            ]);
            await models.Node.updateOne({ _id: job.ref }, {
                $set: {
                    lit: {
                        cells, litCells,
                        // Safe means every cell of the lattice holds a torch.
                        // Anything less is a settlement with dark corners, and
                        // mobs spawn in the dark corners.
                        safe: cells > 0 && litCells >= cells,
                        checkedBy: who, checkedAt: new Date(),
                    },
                    updatedAt: new Date(),
                },
            });
            return;
        }

        if (job.kind !== 'road_segment') return;

        const remaining = await models.Job.countDocuments({
            ref: job.ref, kind: 'road_segment', doneAt: null,
        });
        if (remaining > 0) return;

        await models.Edge.updateOne(
            { _id: job.ref, open: { $ne: true } },
            { $set: { open: true, openedAt: new Date() } },
        );
    } catch { /* a road that stays shut is safe; one wrongly open is not */ }
}

/**
 * Record that the work was tried and did not succeed.
 *
 * Counted here rather than at claim time, so the three lives a job gets are
 * three real failures -- a segment through a ravine, or a villager with no
 * torches -- and not three turns where somebody was told about it and did
 * something else.
 */
export function failed(id) {
    try {
        if (!isUp() || !id) return;
        getModels()?.Job.updateOne({ _id: id, doneAt: null }, { $inc: { attempts: 1 } })
            .catch(() => {});
    } catch { /* ignore */ }
}

/**
 * Give a job back without counting it as progress.
 *
 * Used when a villager is interrupted rather than defeated -- attacked, called
 * into a conversation, or caught by nightfall. The attempt already counted at
 * claim time, which is deliberate: a job that keeps being abandoned is as
 * suspect as one that keeps failing.
 */
export function release(id) {
    try {
        if (!isUp() || !id) return;
        getModels()?.Job.updateOne(
            { _id: id, doneAt: null },
            { $set: { claimedBy: null, claimedAt: null } },
        ).catch(() => {});
    } catch { /* ignore */ }
}

/** Who is working on what, for the "Bram has segment 6" clause. */
export async function neighbours(ref, exclude, limit = 2) {
    const rows = await read((m) => m.Job.find({
        ref,
        doneAt: null,
        claimedBy: { $nin: [null, exclude] },
        claimedAt: { $gte: new Date(Date.now() - CLAIM_TTL_MS) },
    }).limit(limit).lean(), []);
    return rows ?? [];
}
