/**
 * The roster and the personas generated from it.
 *
 * These exist because of a real failure: a script assigned standing goals by
 * regex, the pattern did not match Sable's escaped apostrophe, and the result
 * was one villager with no goal and another with two (the second silently
 * winning). Nothing errored. The village just had a member who stood still.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROSTER, byName, personaFor, profileFor } from '../../src/society/roster.js';

test('the roster is eight uniquely named, uniquely employed villagers', () => {
    assert.equal(ROSTER.length, 8);
    assert.equal(new Set(ROSTER.map((a) => a.name)).size, 8, 'duplicate name');
    assert.equal(new Set(ROSTER.map((a) => a.role)).size, 8, 'duplicate role');
});

test('every villager has a goal, and it is theirs', () => {
    for (const a of ROSTER) {
        assert.ok(a.goal && a.goal.trim().length > 10, `${a.name} has no usable goal`);
    }
    assert.equal(new Set(ROSTER.map((a) => a.goal)).size, 8, 'two villagers share a goal');
});

test('nobody is self-sufficient', () => {
    // Interdependence is the engine of the whole village: if one villager can
    // meet their own needs they stop trading, and drop out of the social graph.
    for (const a of ROSTER) {
        assert.ok(a.produces?.length, `${a.name} produces nothing`);
        assert.ok(a.needs?.length, `${a.name} needs nothing`);
        const overlap = a.produces.filter((p) => a.needs.includes(p));
        assert.deepEqual(overlap, [], `${a.name} both produces and needs ${overlap.join(', ')}`);
    }
});

test('byName is case insensitive and returns nothing for a stranger', () => {
    assert.equal(byName('bram')?.name, 'Bram');
    assert.equal(byName('BRAM')?.name, 'Bram');
    assert.equal(byName('Nobody'), undefined);
});

test('a persona names its villager, their goal, and everyone else', () => {
    for (const a of ROSTER) {
        const p = personaFor(a);
        assert.ok(p.includes(a.goal), `${a.name}'s persona omits their standing goal`);
        assert.ok(p.includes(a.role), `${a.name}'s persona omits their role`);
        assert.ok(!p.includes(`${a.name} the ${a.role}`),
            `${a.name}'s persona lists them among the other villagers`);
        for (const other of ROSTER.filter((o) => o.name !== a.name))
            assert.ok(p.includes(other.name), `${a.name} has never heard of ${other.name}`);
    }
});

test('a persona keeps the placeholders the prompter substitutes', () => {
    // An unsubstituted placeholder is inert text in the prompt; a missing one
    // silently removes the villager's stats, inventory or self-prompt.
    const p = personaFor(ROSTER[0]);
    for (const ph of ['$NAME', '$SELF_PROMPT', '$STATS', '$INVENTORY', '$CONVO'])
        assert.ok(p.includes(ph), `persona lost ${ph}`);
});

test('personas do not carry $COMMAND_DOCS', () => {
    // ~2,177 tokens per turn of prose duplicating the tool schemas, and it
    // documents the !command(args) text form this fork replaced. See roster.js.
    for (const a of ROSTER)
        assert.ok(!personaFor(a).includes('$COMMAND_DOCS'), `${a.name} carries $COMMAND_DOCS`);
});

test('a persona tells the villager how to do nothing', () => {
    // Under tool_choice:'required' there is no empty output, so a villager with
    // no instruction for idleness invents an action instead.
    for (const a of ROSTER)
        assert.match(personaFor(a), /\bstay\b/, `${a.name} is never told about stay`);
});

test('a profile carries the role that scopes its tools', () => {
    for (const a of ROSTER) {
        const p = profileFor(a);
        assert.equal(p.name, a.name);
        assert.equal(p.society.role, a.role, 'role mismatch breaks tool scoping');
        assert.ok(p.model?.model, `${a.name} has no chat model`);
        assert.ok(p.cooldown > 0, `${a.name} has no cooldown and will starve the server`);
    }
});
