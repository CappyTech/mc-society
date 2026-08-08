/**
 * The village brief: what a villager knows about the people around them,
 * rendered into the prompt. Pure -- takes rows, returns a string.
 *
 * THE BUDGET IS THE DESIGN
 * ------------------------
 * This text is prepended to every single turn, for all eight villagers. At
 * ~4,500 tokens a turn against a context that has already been the binding
 * constraint on this project twice, an unbounded "here is everything you
 * remember" block would be the largest thing in the prompt and would push the
 * tool schemas out of the window.
 *
 * So it is capped hard at 900 characters (~225 tokens, ~5% of a turn), and the
 * interesting part is what gets dropped first. Relevance beats completeness:
 * what matters is what you know about *whoever is in front of you*, not a
 * roster dump of all seven neighbours.
 */

import { decay, describeSentiment } from './sentiment.js';

export const BRIEF_MAX_CHARS = 900;
/** No single line may crowd out the rest. */
const LINE_MAX = 110;

const trim = (s) => (s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + '…' : s);

/** "Nia: owes you 3 bread. Gave you seeds when you asked. Warm." */
function relationshipLine(rel, now, debt) {
    const s = decay(rel.sentiment ?? 0, now - (rel.lastEventAt ?? now));
    const parts = [];
    if (debt) parts.push(debt);
    if (rel.lastReason) parts.push(capitalise(rel.lastReason) + '.');
    parts.push(capitalise(describeSentiment(s)) + '.');
    return trim(`${rel.to}: ${parts.join(' ')}`);
}

const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "owes you 3 bread" / "you owe him a pickaxe" */
function debtPhrase(ledgerRows, me, them) {
    const theyOwe = ledgerRows.find((l) => l.creditor === me && l.debtor === them && !l.settledAt);
    if (theyOwe) return `Owes you ${theyOwe.qty ?? ''} ${theyOwe.item}.`.replace('  ', ' ');
    const iOwe = ledgerRows.find((l) => l.debtor === me && l.creditor === them && !l.settledAt);
    if (iOwe) return `You owe them ${iOwe.qty ?? ''} ${iOwe.item}.`.replace('  ', ' ');
    return '';
}

/**
 * Render the block.
 *
 * @param {object} input
 * @param {string} input.me
 * @param {object[]} input.relationships rows where from === me
 * @param {object[]} input.ledger open ledger rows touching me
 * @param {string|null} input.focus who this villager is currently dealing with
 * @param {string} input.project one pre-rendered project line, or ''
 * @param {number} input.now
 * @param {number} input.budget
 * @returns {string} '' when there is nothing worth saying
 */
export function renderBrief({
    me, relationships = [], ledger = [], focus = null, project = '',
    now = Date.now(), budget = BRIEF_MAX_CHARS,
} = {}) {
    const lines = [];

    // 1. The person in front of you. Never dropped, whatever it costs and
    //    however weakly this villager feels about them -- a brief that omits
    //    the one relationship currently in play is worse than no brief.
    const focusRel = focus ? relationships.find((r) => r.to === focus) : null;
    if (focusRel) lines.push(relationshipLine(focusRel, now, debtPhrase(ledger, me, focus)));

    // 2. The people you feel most strongly about -- either way. Ranked by
    //    decayed magnitude, so a grudge is as memorable as a friendship and
    //    neither is remembered forever.
    const others = relationships
        .filter((r) => r.to !== focus)
        .map((r) => ({ r, mag: Math.abs(decay(r.sentiment ?? 0, now - (r.lastEventAt ?? now))) }))
        .sort((a, b) => b.mag - a.mag || (b.r.lastEventAt ?? 0) - (a.r.lastEventAt ?? 0))
        .slice(0, 3)
        .map(({ r }) => relationshipLine(r, now, debtPhrase(ledger, me, r.to)));
    lines.push(...others);

    // 3. A debt with someone not already mentioned. Unsettled obligations are
    //    the most actionable thing a villager can be told.
    const named = new Set([focus, ...relationships.filter((r) => r.to !== focus).slice(0, 3).map((r) => r.to)]);
    const orphanDebt = ledger.find((l) => !l.settledAt &&
        !named.has(l.creditor === me ? l.debtor : l.creditor));
    if (orphanDebt) {
        const them = orphanDebt.creditor === me ? orphanDebt.debtor : orphanDebt.creditor;
        lines.push(trim(`${them}: ${debtPhrase(ledger, me, them)}`));
    }

    // 4. The shared project, last -- it is the first thing sacrificed to the
    //    budget, because it is the only line every villager could reconstruct
    //    by asking someone.
    if (project) lines.push(trim(project));

    if (!lines.length) return '';

    // Assemble under budget, dropping from the end.
    const header = 'VILLAGE';
    let out = header;
    for (const line of lines) {
        if (out.length + 1 + line.length > budget) break;
        out += '\n' + line;
    }
    return out === header ? '' : out;
}
