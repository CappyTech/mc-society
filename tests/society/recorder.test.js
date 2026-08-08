/**
 * Deriving village history from executed commands.
 *
 * The result strings asserted here are copied verbatim from
 * src/agent/library/skills.js. That is deliberate: they are upstream's and a
 * merge can change them, at which point the village would silently stop
 * remembering anything -- no error, no log, just an empty history. This file is
 * what turns that into a failing test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveEvent, isSocial } from '../../src/society/chronicle/recorder.js';
import { applyEvent, decay, describeSentiment, MAX_WEIGHT } from '../../src/society/chronicle/sentiment.js';

test('a successful gift is remembered, with who and what', () => {
    const e = deriveEvent('!givePlayer', ['Nia', 'coal', 3], 'Nia received coal.', 'Bram');
    assert.equal(e.kind, 'gave');
    assert.equal(e.actor, 'Bram');
    assert.equal(e.subject, 'Nia');
    assert.equal(e.item, 'coal');
    assert.equal(e.qty, 3);
});

test('a FAILED gift is not remembered as a gift', () => {
    // Both failure strings from skills.js. This is the case that makes
    // derivation better than asking the model: it would report the gift.
    for (const failure of [
        'Failed to give coal to Nia, too close.',
        'Failed to give coal to Nia, it was never received.',
    ]) {
        assert.equal(deriveEvent('!givePlayer', ['Nia', 'coal', 3], failure, 'Bram'), null, failure);
    }
});

test('queries are never recorded', () => {
    // They are the majority of all commands run; recording them would be pure
    // write volume and would bury the events that matter.
    for (const q of ['!stats', '!inventory', '!nearbyBlocks', '!craftable', '!entities', '!savedPlaces'])
        assert.equal(deriveEvent(q, [], 'STATS ...', 'Bram'), null, q);
});

test('work is recorded only when it succeeded', () => {
    assert.equal(deriveEvent('!collectBlocks', ['stone', 20], 'Collected 14 stone.', 'Bram').qty, 14);
    assert.equal(deriveEvent('!collectBlocks', ['stone', 20], 'Collected 0 stone.', 'Bram'), null);
    assert.equal(deriveEvent('!collectBlocks', ['stone', 20], "Don't have right tools.", 'Bram'), null);

    assert.equal(deriveEvent('!craftRecipe', ['oak_planks', 4],
        'Successfully crafted oak_planks, you now have 4 oak_planks.', 'Wren').kind, 'crafted');
    assert.equal(deriveEvent('!craftRecipe', ['oak_planks', 4],
        'You do not have the resources to craft a oak_planks.', 'Wren'), null);

    assert.equal(deriveEvent('!smeltItem', ['raw_iron', 4],
        'Successfully smelted raw_iron, got 4 Iron Ingot.', 'Corin').kind, 'smelted');
    assert.equal(deriveEvent('!smeltItem', ['raw_iron', 4], 'You do not have enough raw_iron to smelt.', 'Corin'), null);
});

test('a build is remembered as progress or completion, never as failure', () => {
    assert.equal(deriveEvent('!build', ['small_wood_house'],
        'I worked on the small_wood_house at 1, 2, 3.', 'Odile').kind, 'build_progress');
    assert.equal(deriveEvent('!build', ['small_wood_house'],
        'The small_wood_house at 1, 2, 3 is finished.', 'Odile').kind, 'build_done');
    assert.equal(deriveEvent('!build', ['small_wood_house'],
        'I could not clear the ground for the small_wood_house: stone (I need a pickaxe).', 'Odile'), null);
});

test('speech is recorded and truncated', () => {
    const e = deriveEvent('!startConversation', ['Nia', 'x'.repeat(500)], '', 'Bram');
    assert.equal(e.kind, 'spoke');
    assert.equal(e.subject, 'Nia');
    assert.ok(e.detail.length <= 120);
});

test('social events are distinguished from solitary work', () => {
    assert.equal(isSocial(deriveEvent('!givePlayer', ['Nia', 'coal', 1], 'Nia received coal.', 'Bram')), true);
    assert.equal(isSocial(deriveEvent('!collectBlocks', ['stone', 1], 'Collected 1 stone.', 'Bram')), false);
    // A villager talking to themselves is not a relationship.
    assert.equal(isSocial({ actor: 'Bram', subject: 'Bram' }), false);
});

test('a gift warms a relationship and a refusal cools it', () => {
    const after = applyEvent(undefined, { kind: 'gave', item: 'coal', qty: 3, at: Date.now() });
    assert.ok(after.sentiment > 0);
    assert.match(after.lastReason, /gave you/);

    const cooled = applyEvent(after, { kind: 'refused', at: Date.now() });
    assert.ok(cooled.sentiment < after.sentiment);
    assert.equal(cooled.counts.refusals, 1);
});

test('no single event can saturate a relationship', () => {
    // Otherwise one villager handing over a stack of 64 bread pins the
    // relationship at maximum and everything afterwards is invisible.
    let rel;
    for (let i = 0; i < 3; i++) rel = applyEvent(rel, { kind: 'gave', item: 'bread', qty: 64, at: Date.now() });
    assert.ok(rel.sentiment <= MAX_WEIGHT * 3);
});

test('sentiment is clamped at both ends', () => {
    let rel;
    for (let i = 0; i < 200; i++) rel = applyEvent(rel, { kind: 'gave', item: 'bread', at: Date.now() });
    assert.ok(rel.sentiment <= 100);
    for (let i = 0; i < 400; i++) rel = applyEvent(rel, { kind: 'attacked', at: Date.now() });
    assert.ok(rel.sentiment >= -100);
});

test('feelings fade', () => {
    // Without decay every relationship walks to +100 and stays, and the brief
    // becomes 225 tokens a turn of "everyone is wonderful".
    const day = 86_400_000;
    assert.equal(decay(100, 0), 100);
    assert.ok(Math.abs(decay(100, 3 * day) - 50) < 0.001, 'should halve at the half-life');
    assert.ok(decay(100, 30 * day) < 1);
    assert.ok(decay(-100, 3 * day) > -51 && decay(-100, 3 * day) < -49, 'grudges fade too');
    assert.equal(decay(0, 5 * day), 0);
});

test('sentiment reads as a word a villager would use', () => {
    assert.equal(describeSentiment(80), 'close');
    assert.equal(describeSentiment(20), 'warm');
    assert.equal(describeSentiment(0), 'neutral');
    assert.equal(describeSentiment(-20), 'wary');
    assert.equal(describeSentiment(-80), 'hostile');
});

test('a relationship row describes the OTHER person, not the actor', () => {
    // The subtle one. A row is a view OF someone, and lastReason is rendered
    // straight after their name -- "Nia: Gave you 3 coal." Put the actor's own
    // action in it and the text reads fine and is exactly backwards: the
    // villager who has just been given coal is told the giver took it away.
    const given = applyEvent(undefined, { kind: 'gave', item: 'coal', qty: 3, at: Date.now() });
    assert.match(given.lastReason, /gave you 3 coal/);

    const taken = applyEvent(undefined, { kind: 'received', item: 'coal', qty: 3, at: Date.now() });
    assert.match(taken.lastReason, /took 3 coal from you/);

    // Being given to must count for more than giving away.
    assert.ok(given.sentiment > taken.sentiment,
        'receiving a gift should move a relationship more than making one');
});

test('speaking to someone does not overwrite what you know about them', () => {
    // 'spoke' is what the listener records about the speaker; 'spoke_to' is the
    // speaker's own side and has nothing to say about the listener.
    const known = applyEvent(undefined, { kind: 'gave', item: 'bread', qty: 2, at: Date.now() });
    const after = applyEvent(known, { kind: 'spoke_to', at: Date.now() });
    assert.match(after.lastReason, /gave you 2 bread/, 'a real reason was replaced by an empty one');

    const heard = applyEvent(undefined, { kind: 'spoke', at: Date.now() });
    assert.equal(heard.lastReason, 'talked to you');
});
