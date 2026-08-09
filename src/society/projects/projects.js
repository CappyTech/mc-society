/**
 * Shared projects: proposing, agreeing, supplying and building.
 *
 * The database side of src/society/projects/tally.js. Everything here degrades
 * the same way the rest of the Chronicle does -- with no database the tools
 * report plainly that the village cannot agree on anything right now, rather
 * than throwing inside a villager's turn.
 */

import * as world from '../../agent/library/world.js';
import { getModels, isUp, read } from '../chronicle/chronicle.js';
import { listStructures, loadStructure, materialsFor, describeMissing, buildStep } from '../build.js';
import { tally, outstanding, supporters, projectLine, CAN_PROPOSE } from './tally.js';

export { projectLine, tally, outstanding, CAN_PROPOSE };

const NO_DB = 'I cannot reach the village record right now, so nothing can be agreed.';

/**
 * Somewhere the structure can actually stand, near the proposer.
 *
 * Falls back to their own position only if no clear space can be found, so a
 * proposal is never blocked outright by awkward terrain -- the build itself
 * reports what it cannot clear.
 */
function siteFor(agent, name) {
    const construction = agent.npc?.constructions?.[name];
    const size = construction?.blocks?.[0]?.[0]?.length ?? 5;
    for (let shrink = 0; shrink < size; shrink++) {
        const found = world.getNearestFreeSpace(agent.bot, size - shrink, 16);
        if (found) return { x: Math.floor(found.x), y: Math.floor(found.y), z: Math.floor(found.z) };
    }
    const pos = agent.bot?.entity?.position;
    return pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : undefined;
}

/** The one open proposal, or the project currently being built. */
export async function current() {
    return await read(async (m) => {
        const proposed = await m.Project.findOne({ status: 'proposed' }).lean();
        if (proposed) return proposed;
        return await m.Project.findOne({ status: { $in: ['agreed', 'building'] } })
            .sort({ createdAt: -1 }).lean();
    }, null);
}

/**
 * Resolve a proposal's status lazily, on read.
 *
 * No timer and no scheduled job: there are eight independent agent processes
 * and no leader among them, so anything time-based has to be evaluated by
 * whoever happens to look. Idempotent, so all eight looking at once is fine.
 */
export async function settleStatus(project) {
    if (!project || project.status !== 'proposed') return project;
    const state = tally(project);
    if (state.status === 'proposed') return project;

    const models = getModels();
    if (!models) return project;
    const set = { status: state.status };
    if (state.status === 'agreed') set.agreedAt = new Date();
    try {
        await models.Project.updateOne({ _id: project._id }, { $set: set });
    } catch { /* another process got there first, which is fine */ }
    return { ...project, ...set };
}

/** Propose a build. One open proposal village-wide. */
export async function propose(agent, name) {
    if (!isUp()) return NO_DB;
    if (!listStructures().includes(name))
        return `I don't know how to build "${name}". I can propose: ${listStructures().join(', ')}.`;

    const models = getModels();
    const open = await settleStatus(await current());
    if (open && open.status === 'proposed')
        return `${open.proposer} has already proposed a ${open.name}. The village should vote on that first.`;
    if (open && (open.status === 'agreed' || open.status === 'building'))
        return `The village is already building a ${open.name}. That should be finished first.`;

    // Pick somewhere the house can actually stand.
    //
    // The proposer's raw position is wherever they happen to be -- observed:
    // Odile proposed from a treetop, the village agreed to a site in mid-air,
    // and the build reported "nothing to place on" for every block. The village
    // votes on a site, so the site has to be buildable before it is put to them.
    const site = siteFor(agent, name);
    const doc = {
        name,
        proposer: agent.name,
        builder: agent.name,
        site,
        status: 'proposed',
        votes: [],
        required: materialsFor(loadStructure(name)),
        delivered: {},
        contributed: {},
        createdAt: new Date(),
    };

    try {
        await models.Project.create(doc);
    } catch {
        // The partial unique index is the authority on "one open proposal", so
        // two villagers proposing at the same instant is resolved here rather
        // than by a check that could race.
        return 'Someone else proposed something at the same moment. I should vote on theirs.';
    }

    return `I proposed building a ${name}. It needs ${describeMissing(doc.required)}. ` +
           `The others should vote.`;
}

/** Vote on the single open proposal. */
export async function vote(agent, approve) {
    if (!isUp()) return NO_DB;
    const models = getModels();

    const open = await settleStatus(await current());
    // Redirect rather than just refuse. Villagers reach for this tool
    // speculatively -- observed three times in fifteen minutes with no proposal
    // open -- so the reply is the cheapest place to turn a wasted turn into the
    // thing that actually needs to happen.
    if (!open || open.status !== 'proposed')
        return 'There is nothing to vote on. If the village needs something built, ' +
               'someone should propose it -- Odile or Ivo can.';
    if ((open.votes ?? []).some((v) => v.voter === agent.name))
        return `I already voted on the ${open.name}.`;

    try {
        await models.Project.updateOne(
            { _id: open._id, 'votes.voter': { $ne: agent.name } },
            { $push: { votes: { voter: agent.name, approve: !!approve, at: new Date() } } },
        );
    } catch { return NO_DB; }

    const after = await read((m) => m.Project.findOne({ _id: open._id }).lean(), null);
    const settled = await settleStatus(after);
    const state = tally(settled ?? after);

    if (settled?.status === 'agreed')
        return `I voted ${approve ? 'for' : 'against'} the ${open.name}. The village has agreed to it.`;
    if (settled?.status === 'abandoned')
        return `I voted against the ${open.name}. The village has dropped the idea.`;
    return `I voted ${approve ? 'for' : 'against'} the ${open.name}. ${state.reason}.`;
}

/**
 * Credit a delivery to the current project.
 *
 * Called from the Chronicle's recorder when a gift lands, so **no new tool is
 * needed to contribute** -- `!givePlayer` already exists and is already hooked.
 * A contribution also counts as consent (see tally.js).
 */
export async function credit(fromName, toName, item, qty) {
    if (!isUp() || !item || !qty) return;
    const models = getModels();
    const project = await current();
    if (!project || !['agreed', 'building'].includes(project.status)) return;
    if (toName !== project.builder) return;
    if (!(item in (project.required ?? {}))) return;

    try {
        await models.Project.updateOne({ _id: project._id }, {
            $inc: {
                [`delivered.${item}`]: qty,
                [`contributed.${fromName}.${item}`]: qty,
            },
        });
    } catch { /* a lost contribution is not worth breaking a gift over */ }
}

/**
 * Do a shift on the agreed project.
 *
 * Wraps `!build` so the builder does not have to remember the structure name or
 * the site, and writes progress back so the rest of the village can see it.
 */
export async function work(agent) {
    if (!isUp()) return NO_DB;
    const models = getModels();

    const project = await settleStatus(await current());
    if (!project) return 'There is no village project to work on. I could propose one.';
    if (project.status === 'proposed')
        return `The ${project.name} has not been agreed yet. The others still need to vote.`;
    if (project.status === 'complete') return `The ${project.name} is already finished.`;
    if (project.builder !== agent.name)
        return `${project.builder} is building the ${project.name}, not me.`;

    // Built where the village agreed it, not wherever the builder last started
    // something. The site is part of what was voted on.
    const result = await buildStep(agent, project.name, { site: project.site });

    const set = { lastBuildAt: new Date() };
    if (project.status === 'agreed') set.status = 'building';
    if (/is finished/.test(result)) { set.status = 'complete'; set.completedAt = new Date(); }
    try {
        await models.Project.updateOne({ _id: project._id }, { $set: set });
    } catch { /* the build itself already happened; the record can lag */ }

    return result;
}


/** For the brief: the project line this villager should see. */
export async function lineFor(viewer) {
    if (!isUp() || !viewer) return '';
    const project = await settleStatus(await current());
    return projectLine(project, viewer);
}

/** Names a villager may propose. */
export const PROPOSABLE = () => listStructures();

/** Convenience for tests and diagnostics. */
export function summarise(project) {
    if (!project) return 'no project';
    const state = tally(project);
    return `${project.name} (${state.status}): ${state.reason}; still needs ` +
           (describeMissing(outstanding(project)) || 'nothing');
}

export { supporters };
