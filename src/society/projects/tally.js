/**
 * Deciding whether the village agrees to build something. Pure, no database.
 *
 * WHY A DOCUMENT AND NOT A MEETING
 * --------------------------------
 * Villager conversation is strictly 1:1 with one partner at a time
 * (src/agent/conversation.js), so an eight-way town meeting is not merely
 * awkward -- it is O(n^2) full LLM turns against an inference server that
 * already starves at eight agents (docs/inference-server.md). Consensus by
 * conversation would cost dozens of ~4,500-token turns and reliably deadlock.
 *
 * So the Chronicle is the town square. A proposal is a document, the debate is
 * asynchronous, and the ballot box is the prompt: each villager sees the open
 * proposal in their VILLAGE block and can vote with one cheap tool call.
 */

/** Whole village, from the roster. Kept as a parameter so tests can vary it. */
export const DEFAULT_VILLAGE_SIZE = 8;

/** A clear majority of eight. */
export const QUORUM_YES = 5;
/** Enough refusals that the rest cannot carry it. */
export const QUORUM_NO = 4;

/**
 * How long a proposal may sit unresolved.
 *
 * LOAD-BEARING, not polish. Villagers are usually busy mining or farming and
 * will simply not vote; without a timeout the first proposal blocks the single
 * open-proposal slot forever and nothing is ever built again.
 */
export const VOTE_TIMEOUT_MS = 20 * 60 * 1000;
/** At timeout, this many yes votes is enough if they outnumber the noes. */
export const TIMEOUT_MIN_YES = 3;

/**
 * Everyone who has effectively said yes.
 *
 * CONSENT BY CONTRIBUTION. Anyone who has handed over a required material has
 * agreed far more convincingly than a vote could express, and this is what
 * carries the system when the model ignores the proposal line -- which it will,
 * often. Injected context is a suggestion, not a control.
 */
export function supporters(project) {
    const yes = new Set(
        (project?.votes ?? []).filter((v) => v.approve).map((v) => v.voter),
    );
    for (const name of Object.keys(project?.contributed ?? {})) yes.add(name);
    // The proposer wants it built; making them vote for their own proposal is
    // ceremony, and it costs a whole turn.
    if (project?.proposer) yes.add(project.proposer);
    return yes;
}

/** Everyone who has said no and not since contributed. */
export function objectors(project) {
    const yes = supporters(project);
    return new Set(
        (project?.votes ?? [])
            .filter((v) => !v.approve && !yes.has(v.voter))
            .map((v) => v.voter),
    );
}

/**
 * Decide a proposal's status. Pure and idempotent, so it can be evaluated
 * lazily on any read -- no timer, no scheduled job, no leader among the eight
 * independent agent processes.
 *
 * @returns {{status: string, yes: number, no: number, reason: string}}
 */
export function tally(project, { now = Date.now(), villageSize = DEFAULT_VILLAGE_SIZE } = {}) {
    if (!project) return { status: 'none', yes: 0, no: 0, reason: 'no project' };

    // Already decided: never re-open. A build in progress must not be
    // abandoned because someone votes no halfway through it.
    if (project.status && project.status !== 'proposed')
        return { status: project.status, yes: 0, no: 0, reason: 'already decided' };

    const yes = supporters(project).size;
    const no = objectors(project).size;

    const quorumYes = Math.min(QUORUM_YES, villageSize);
    const quorumNo = Math.min(QUORUM_NO, villageSize);

    if (yes >= quorumYes) return { status: 'agreed', yes, no, reason: `${yes} in favour` };
    if (no >= quorumNo) return { status: 'abandoned', yes, no, reason: `${no} against` };

    const age = now - new Date(project.createdAt ?? now).getTime();
    if (age >= VOTE_TIMEOUT_MS) {
        return yes > no && yes >= TIMEOUT_MIN_YES
            ? { status: 'agreed', yes, no, reason: `${yes} in favour when the vote timed out` }
            : { status: 'abandoned', yes, no, reason: 'the village never agreed' };
    }

    return { status: 'proposed', yes, no, reason: `${yes} for, ${no} against` };
}

/** What is still needed, as {item: count}. */
export function outstanding(project) {
    const need = {};
    for (const [item, want] of Object.entries(project?.required ?? {})) {
        const have = project?.delivered?.[item] ?? 0;
        if (want > have) need[item] = want - have;
    }
    return need;
}

/**
 * The one line a villager sees about the shared project.
 *
 * Targeted rather than broadcast: a villager is told about materials they
 * actually produce. Telling the cook that the house needs cobblestone is
 * noise, and noise in a 900-character budget costs a relationship line.
 *
 * @param {object} project
 * @param {object} viewer  the roster entry of whoever is reading
 * @returns {string} '' when this villager has nothing to do with it
 */
/** Trades that may put a proposal to the village. */
export const CAN_PROPOSE = new Set(['builder', 'keeper']);

export function projectLine(project, viewer, { now = Date.now() } = {}) {
    // No shared project at all.
    //
    // This used to render nothing, which turned out to be the flaw that kept
    // the whole mechanism from starting: over fifteen unprompted minutes
    // villagers called voteProject three times and workOnProject twice, and
    // nobody ever proposed anything -- because the one moment a nudge matters,
    // an idle village with nothing agreed, was the one moment the brief was
    // silent. Only the two trades that can propose ever see this line.
    if (!project || ['complete', 'abandoned'].includes(project.status)) {
        return CAN_PROPOSE.has(viewer?.role)
            ? 'The village has no shared project. You could propose one for everyone to vote on.'
            : '';
    }

    const state = tally(project, { now });

    if (state.status === 'proposed') {
        // Only ask people who have not already effectively answered.
        if (supporters(project).has(viewer?.name) || objectors(project).has(viewer?.name)) return '';
        const need = Object.entries(outstanding(project))
            .sort((a, b) => b[1] - a[1]).slice(0, 2)
            .map(([i, n]) => `${n} ${i}`).join(', ');
        return `Proposal: ${project.proposer} wants to build a ${project.name}` +
               (need ? `. It needs ${need}` : '') + '. Vote on it.';
    }

    if (state.status !== 'agreed' && state.status !== 'building') return '';

    const need = outstanding(project);
    if (!Object.keys(need).length) return '';

    // Does this villager make any of what is missing?
    const produces = (viewer?.produces ?? []).map((p) => String(p).toLowerCase());
    const mine = Object.keys(need).filter((item) => {
        const it = item.toLowerCase();
        return produces.some((p) => it.includes(p) || p.includes(it.replace(/^oak_|^white_/, '')));
    });

    if (viewer?.name === project.builder) {
        const list = Object.entries(need).sort((a, b) => b[1] - a[1]).slice(0, 2)
            .map(([i, n]) => `${n} ${i}`).join(', ');
        return `Your ${project.name} still needs ${list}. Ask whoever produces them.`;
    }

    if (!mine.length) return '';
    const list = mine.slice(0, 2).map((i) => `${need[i]} ${i}`).join(', ');
    return `The ${project.name} needs ${list}, which you produce. Give them to ${project.builder}.`;
}
