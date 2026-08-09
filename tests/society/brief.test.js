/**
 * The village brief.
 *
 * This text goes into every turn of every villager, so its size is a hard
 * constraint rather than a preference -- the context has been the binding
 * limit on this project twice already. The tests that matter here are the ones
 * about what gets dropped when the budget binds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderBrief, BRIEF_MAX_CHARS } from '../../src/society/chronicle/brief.js';
import { evaluate, renderFocus } from '../../src/society/needs.js';

/** A villager who is out in the dark, to produce a realistic $FOCUS block. */
const wellFed = (over = {}) => ({
    name: 'Bram', role: 'miner', health: 20, food: 20,
    inventory: { stone_sword: 1, stone_pickaxe: 1, stone_axe: 1 },
    sleptSinceLogin: true, ...over,
});

const now = Date.now();
const rel = (to, sentiment, lastReason = '', ageMs = 0) =>
    ({ from: 'Bram', to, sentiment, lastReason, lastEventAt: now - ageMs });

test('nothing known means nothing said', () => {
    // Not a header with no content: an empty block still costs tokens and
    // tells the model there is a section it should be using.
    assert.equal(renderBrief({ me: 'Bram', now }), '');
    assert.equal(renderBrief({ me: 'Bram', relationships: [], ledger: [], now }), '');
});

test('the person in front of you comes first, however weakly you feel', () => {
    const out = renderBrief({
        me: 'Bram',
        relationships: [rel('Corin', 90, 'gave you a pickaxe'), rel('Nia', 2, 'talked to you')],
        focus: 'Nia', now,
    });
    const lines = out.split('\n');
    assert.equal(lines[0], 'VILLAGE');
    assert.match(lines[1], /^Nia:/, 'the focus person was not first');
    assert.ok(out.includes('Corin'));
});

test('strong feelings outrank weak ones, in both directions', () => {
    const out = renderBrief({
        me: 'Bram',
        relationships: [
            rel('Wren', 3, 'talked to you'),
            rel('Tobias', -70, 'refused you'),
            rel('Corin', 60, 'gave you a pickaxe'),
            rel('Ivo', 1, 'talked to you'),
            rel('Sable', 0, ''),
        ],
        now,
    });
    // A grudge is as memorable as a friendship; indifference is not memorable.
    assert.ok(out.includes('Tobias'), 'a strong grudge was dropped');
    assert.ok(out.includes('Corin'), 'a strong friendship was dropped');
    assert.ok(!out.includes('Sable'), 'an indifferent relationship was included');
});

test('an old strong feeling loses to a recent one', () => {
    const month = 30 * 86_400_000;
    const out = renderBrief({
        me: 'Bram',
        relationships: [rel('Wren', 95, 'saved your life', month), rel('Nia', 20, 'gave you bread', 0)],
        now,
    });
    const lines = out.split('\n').slice(1);
    assert.match(lines[0], /^Nia:/, 'a month-old feeling outranked a fresh one');
});

test('debts are stated, and from the right side', () => {
    const owed = renderBrief({
        me: 'Bram',
        relationships: [rel('Nia', 10)],
        ledger: [{ creditor: 'Bram', debtor: 'Nia', item: 'bread', qty: 3, settledAt: null }],
        focus: 'Nia', now,
    });
    assert.match(owed, /Owes you 3 bread/);

    const owing = renderBrief({
        me: 'Bram',
        relationships: [rel('Corin', 10)],
        ledger: [{ creditor: 'Corin', debtor: 'Bram', item: 'pickaxe', qty: 1, settledAt: null }],
        focus: 'Corin', now,
    });
    assert.match(owing, /You owe them 1 pickaxe/);
});

test('a settled debt is not mentioned', () => {
    const out = renderBrief({
        me: 'Bram',
        relationships: [rel('Nia', 10, 'talked to you')],
        ledger: [{ creditor: 'Bram', debtor: 'Nia', item: 'bread', qty: 3, settledAt: new Date() }],
        focus: 'Nia', now,
    });
    assert.ok(!/Owes you/.test(out), 'a settled debt was still being held against them');
});

test('the budget is never exceeded, however pathological the input', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
        rel(`Villager${i}`, 100 - i, 'x'.repeat(500)));
    const out = renderBrief({
        me: 'Bram', relationships: many, focus: 'Villager7',
        project: 'y'.repeat(400), now,
    });
    assert.ok(out.length <= BRIEF_MAX_CHARS, `brief was ${out.length} chars`);
    assert.ok(out.includes('Villager7'), 'the focus person was dropped to fit');
});

test('the project line is sacrificed before a relationship', () => {
    // It is the only line every villager could reconstruct by asking someone.
    const out = renderBrief({
        me: 'Bram',
        relationships: [rel('Nia', 50, 'z'.repeat(100)), rel('Corin', 40, 'z'.repeat(100)),
                        rel('Wren', 30, 'z'.repeat(100)), rel('Ivo', 20, 'z'.repeat(100))],
        project: 'Project small_wood_house needs 31 more oak_planks.',
        now, budget: 300,
    });
    assert.ok(out.length <= 300);
    assert.ok(!out.includes('small_wood_house'), 'the project line survived at a relationship\'s expense');
});

test('every line is short enough to read', () => {
    const out = renderBrief({
        me: 'Bram',
        relationships: [rel('Nia', 50, 'w'.repeat(400))],
        focus: 'Nia', now,
    });
    for (const line of out.split('\n')) assert.ok(line.length <= 115, `line too long: ${line.length}`);
});

test('survival and the brief share one budget, and survival has first claim', () => {
    // $FOCUS and $VILLAGE are two blocks with one 900-character allowance
    // between them (see models/prompter.js). The point is that a healthy turn
    // costs exactly what it cost before this layer existed, and a turn where
    // survival bites pays for it out of the brief rather than out of the tool
    // schemas. What must never happen is the two summing past the cap.
    const exposed = wellFed({ timeOfDay: 15000, roofHeight: null, pos: { x: 900, y: 64, z: 900 } });
    const focus = renderFocus(evaluate(exposed, {}, { now }));
    assert.ok(focus.length > 0, 'fixture should raise a need');

    const out = renderBrief({
        me: 'Bram',
        relationships: [rel('Nia', 50, 'y'.repeat(100)), rel('Corin', 40, 'y'.repeat(100)),
                        rel('Wren', 30, 'y'.repeat(100)), rel('Ivo', 20, 'y'.repeat(100))],
        focus: 'Nia',
        project: 'Project small_wood_house needs 31 more oak_planks.',
        now,
        budget: BRIEF_MAX_CHARS - focus.length,
    });

    assert.ok(focus.length + out.length <= BRIEF_MAX_CHARS,
        `focus ${focus.length} + brief ${out.length} > ${BRIEF_MAX_CHARS}`);
    // The person in front of you is never what pays for it.
    assert.ok(out.includes('Nia'), 'the focus relationship was dropped to make room');

    // Worth knowing rather than assuming: at today's caps the two blocks
    // cannot actually collide. A full brief is four lines trimmed to LINE_MAX
    // plus a project line -- roughly 500 characters -- and $FOCUS can take at
    // most 320, so 900 is never reached. The shared budget is a guarantee that
    // this stays true if either cap is raised, not a trade being made every
    // night. If this assertion ever fails, the drop order in renderBrief has
    // started doing real work and the project line is what should vanish.
    assert.ok(out.includes('small_wood_house'),
        'the budgets have started to collide -- check the drop order still holds');
});
