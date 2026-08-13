/**
 * Deciding whether the village agrees to build something.
 *
 * The rules that stop this deadlocking -- the vote timeout and consent by
 * contribution -- are load-bearing rather than polish, and both fail *silently*
 * when they regress: the village simply never builds anything again, with the
 * single open-proposal slot held forever by a proposal nobody will answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    tally, supporters, objectors, outstanding, projectLine,
    VOTE_TIMEOUT_MS, QUORUM_YES, QUORUM_NO,
} from '../../src/society/projects/tally.js';

const now = Date.now();
const project = (over = {}) => ({
    name: 'small_wood_house',
    proposer: 'Odile',
    builder: 'Odile',
    status: 'proposed',
    votes: [],
    required: { oak_planks: 55, oak_log: 8 },
    delivered: {},
    contributed: {},
    createdAt: new Date(now),
    ...over,
});

const votes = (...pairs) => pairs.map(([voter, approve]) => ({ voter, approve, at: new Date(now) }));

test('a proposer does not have to vote for their own proposal', () => {
    // Making them do so is ceremony, and it costs a whole LLM turn.
    assert.ok(supporters(project()).has('Odile'));
    assert.equal(tally(project(), { now }).yes, 1);
});

test('a clear majority agrees it', () => {
    const p = project({ votes: votes(['Bram', true], ['Nia', true], ['Corin', true], ['Wren', true]) });
    const t = tally(p, { now });
    assert.equal(t.status, 'agreed');
    assert.ok(t.yes >= QUORUM_YES);
});

test('enough objections drop it', () => {
    const p = project({ votes: votes(['Bram', false], ['Nia', false], ['Corin', false], ['Wren', false]) });
    const t = tally(p, { now });
    assert.equal(t.status, 'abandoned');
    assert.ok(t.no >= QUORUM_NO);
});

test('an undecided proposal stays open', () => {
    const p = project({ votes: votes(['Bram', true], ['Nia', false]) });
    assert.equal(tally(p, { now }).status, 'proposed');
});

test('a vote that never happens is resolved by the timeout', () => {
    // Villagers are usually busy mining and will simply not vote. Without this
    // the first proposal holds the only slot forever and nothing is ever built.
    const stale = project({ votes: votes(['Bram', true], ['Nia', true]) });
    const t = tally(stale, { now: now + VOTE_TIMEOUT_MS + 1 });
    assert.equal(t.status, 'agreed', 'three in favour and none against should carry at timeout');
});

test('the timeout drops a proposal nobody supported', () => {
    const ignored = project({ proposer: 'Odile', votes: [] });
    // Only the proposer is in favour -- below the timeout threshold.
    assert.equal(tally(ignored, { now: now + VOTE_TIMEOUT_MS + 1 }).status, 'abandoned');
});

test('the timeout does not overturn a majority against', () => {
    const p = project({ votes: votes(['Bram', false], ['Nia', false], ['Corin', false]) });
    assert.equal(tally(p, { now: now + VOTE_TIMEOUT_MS + 1 }).status, 'abandoned');
});

test('handing over materials counts as agreeing', () => {
    // The signal that carries the system when the model ignores the proposal
    // line -- which it will, often. Injected context is a suggestion.
    const p = project({ contributed: { Wren: { oak_planks: 20 }, Bram: { oak_log: 4 } } });
    const s = supporters(p);
    assert.ok(s.has('Wren'));
    assert.ok(s.has('Bram'));
    assert.equal(tally(p, { now }).yes, 3);   // Wren, Bram, and the proposer
});

test('contributing overrides an earlier objection', () => {
    // Turning up with the planks is a better answer than the vote was.
    const p = project({
        votes: votes(['Wren', false]),
        contributed: { Wren: { oak_planks: 20 } },
    });
    assert.ok(supporters(p).has('Wren'));
    assert.ok(!objectors(p).has('Wren'));
});

test('a villager cannot be counted twice', () => {
    const p = project({ votes: votes(['Bram', true], ['Bram', true], ['Bram', true], ['Bram', true]) });
    assert.equal(tally(p, { now }).yes, 2, 'one villager voting repeatedly reached quorum alone');
});

test('a decided project is never reopened', () => {
    // A build in progress must not be abandoned because someone votes late.
    for (const status of ['agreed', 'building', 'complete', 'abandoned']) {
        const p = project({ status, votes: votes(['Bram', false], ['Nia', false], ['Corin', false], ['Wren', false]) });
        assert.equal(tally(p, { now }).status, status);
    }
});

test('outstanding materials account for what has arrived', () => {
    const p = project({ required: { oak_planks: 55, oak_log: 8 }, delivered: { oak_planks: 24, oak_log: 8 } });
    assert.deepEqual(outstanding(p), { oak_planks: 31 });
    assert.deepEqual(outstanding(project({ required: {}, delivered: {} })), {});
});

test('an open proposal is put only to villagers who have not answered', () => {
    const p = project({ votes: votes(['Bram', true]) });
    assert.match(projectLine(p, { name: 'Nia', produces: ['wheat'] }, { now }), /Vote on it/);
    assert.equal(projectLine(p, { name: 'Bram', produces: ['stone'] }, { now }), '',
        'a villager who already voted was asked again');
    assert.equal(projectLine(p, { name: 'Odile', produces: ['shelter'] }, { now }), '',
        'the proposer was asked to vote on their own proposal');
});

test('once agreed, only people who make what is missing are asked', () => {
    // Telling the cook the house needs cobblestone is noise, and noise inside a
    // 900-character budget costs a relationship line.
    const p = project({ status: 'agreed', required: { oak_planks: 55 }, delivered: { oak_planks: 10 } });
    assert.match(projectLine(p, { name: 'Wren', produces: ['oak_log', 'planks'] }, { now }),
        /oak_planks.*Odile/);
    assert.equal(projectLine(p, { name: 'Tobias', produces: ['bread', 'stew'] }, { now }), '',
        'the cook was asked for planks');
});

test('the builder is told what the project still needs', () => {
    const p = project({ status: 'building', required: { oak_planks: 55 }, delivered: { oak_planks: 24 } });
    assert.match(projectLine(p, { name: 'Odile', produces: ['shelter'] }, { now }), /31 oak_planks/);
});

test('a finished or unfunded project says nothing', () => {
    assert.equal(projectLine(project({ status: 'complete' }), { name: 'Wren', produces: ['planks'] }, { now }), '');
    assert.equal(projectLine(project({ status: 'abandoned' }), { name: 'Wren', produces: ['planks'] }, { now }), '');
    const done = project({ status: 'agreed', required: { oak_planks: 5 }, delivered: { oak_planks: 5 } });
    assert.equal(projectLine(done, { name: 'Wren', produces: ['planks'] }, { now }), '');
    assert.equal(projectLine(null, { name: 'Wren' }, { now }), '');
});

test('an idle village nudges the people who can propose', () => {
    // The flaw that kept the whole mechanism from ever starting: over fifteen
    // unprompted minutes villagers called voteProject three times and
    // workOnProject twice, and nobody proposed anything -- because the brief
    // was silent exactly when a nudge mattered.
    const builder = { name: 'Odile', role: 'builder', produces: ['shelter'] };
    const keeper = { name: 'Ivo', role: 'keeper', produces: ['brokerage'] };
    const miner = { name: 'Bram', role: 'miner', produces: ['stone'] };

    for (const state of [null, project({ status: 'complete' }), project({ status: 'abandoned' })]) {
        assert.match(projectLine(state, builder, { now }), /could propose one/);
        assert.match(projectLine(state, keeper, { now }), /could propose one/);
        // Everyone else is told nothing -- they cannot propose, and the budget
        // is better spent on a relationship line.
        assert.equal(projectLine(state, miner, { now }), '');
    }
});

test('an open proposal is never replaced by the nudge', () => {
    const p = project();
    assert.match(projectLine(p, { name: 'Wren', role: 'forester', produces: ['planks'] }, { now }),
        /Vote on it/);
});
