/**
 * The work board's constants and the text it produces.
 *
 * The claim itself is a single atomic findOneAndUpdate and is only meaningful
 * against a real Mongo, so what is tested here is everything around it: the
 * brakes that stop the board eating the village, and the sentence a villager
 * actually reads. Both have failed silently in this codebase's history --
 * a bad query returns wrong rows rather than throwing, and prompt text that
 * names a tool nobody has just wastes a turn per villager per turn.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLAIM_TTL_MS, ATTEMPT_MAX, MAX_CONCURRENT_BUILD } from '../../src/society/board.js';
import { renderJob, renderFocus, TIER, TOOLS, FOCUS_MAX_CHARS } from '../../src/society/needs.js';
import { CORE_TOOLS } from '../../src/society/tools.js';

const job = (over = {}) => ({
    _id: 'road:spawn--village:seg:07',
    kind: 'road_segment',
    ref: 'spawn--village',
    from: { x: 128, y: 68, z: -40 },
    to: { x: 144, y: 68, z: -40 },
    materials: { cobblestone: 48, torch: 3 },
    ...over,
});

test('a claim expires, because a villager will die holding one', () => {
    // On hard this is not hypothetical. Without expiry the segment somebody
    // died on is orphaned for ever and the road never finishes.
    assert.ok(CLAIM_TTL_MS > 0);
    // Long enough to walk somewhere and do the work, short enough that a death
    // does not cost the village an hour.
    assert.ok(CLAIM_TTL_MS >= 5 * 60 * 1000 && CLAIM_TTL_MS <= 20 * 60 * 1000);
});

test('an impossible job is given up on rather than retried for ever', () => {
    // A segment through a ravine or a lava lake cannot be built. Retrying it
    // would hold the highest-priority slot on the board indefinitely.
    assert.ok(ATTEMPT_MAX >= 2 && ATTEMPT_MAX <= 5);
});

test('not everyone may lay blocks at once', () => {
    // A tick-budget limit, not a correctness one: eight bots placing blocks and
    // pathfinding on one Paper main thread, on a server already running eight
    // LLM agents. The villagers not building keep trading, which is the
    // behaviour we want anyway.
    assert.ok(MAX_CONCURRENT_BUILD >= 1 && MAX_CONCURRENT_BUILD < 8);
});

test('a job tells the villager where it is and what to call', () => {
    const rendered = renderJob(job());
    assert.equal(rendered.tier, TIER.JOB);
    const text = renderFocus(null, rendered);
    assert.match(text, /^WORK\n/);
    assert.match(text, /128,68,-40/);
    assert.match(text, new RegExp(TOOLS.work));
    // The tool it names has to be one the villager carries, or the turn is
    // spent producing nothing.
    assert.ok(CORE_TOOLS.includes(TOOLS.work));
});

test('a job says what it costs, which is what keeps the economy fed', () => {
    // The territory layer is meant to create demand for Bram's stone and Wren's
    // charcoal, not to compete with the trade for turns.
    const text = renderFocus(null, renderJob(job()));
    assert.match(text, /48 cobblestone/);
    assert.match(text, /3 torch/);
    assert.match(text, /chest|ask/i);
});

test('a villager is told who is working beside them', () => {
    // The whole of "move as one organism", for the price of one clause.
    const text = renderFocus(null, renderJob(job(), [
        { claimedBy: 'Bram' }, { claimedBy: 'Odile' },
    ]));
    assert.match(text, /Bram and Odile are working/);
});

test('working alone says nothing about company', () => {
    const text = renderFocus(null, renderJob(job(), []));
    assert.doesNotMatch(text, /working the same/);
});

test('a survival need always outranks a job', () => {
    // The slack line. A villager in the dark is not told about the road.
    const need = { tier: TIER.EXPOSED, key: 'exposed', lines: ['Night, and you are in the open.'] };
    const text = renderFocus(need, renderJob(job()));
    assert.match(text, /^NEEDS\n/);
    assert.doesNotMatch(text, new RegExp(TOOLS.work));
});

test('the job block respects the same budget as everything else', () => {
    const text = renderFocus(null, renderJob(job(), [{ claimedBy: 'Bram' }]));
    assert.ok(text.length <= FOCUS_MAX_CHARS, `${text.length} > ${FOCUS_MAX_CHARS}`);
});

test('no job means no block at all', () => {
    // Falling through to the villager's own trade is the default, and it has to
    // cost nothing: an empty header still spends tokens and tells the model
    // there is a slot it should fill.
    assert.equal(renderJob(null), null);
    assert.equal(renderFocus(null, null), '');
});

test('an unknown kind of job still reads as a sentence', () => {
    // The board may outlive the code that made it -- a job kind added later and
    // rolled back, or a document written by a newer villager. It must degrade
    // to something actionable rather than to "undefined".
    const text = renderFocus(null, renderJob(job({ kind: 'quarry', materials: {} })));
    assert.doesNotMatch(text, /undefined/);
    assert.match(text, new RegExp(TOOLS.work));
});
