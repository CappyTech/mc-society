/**
 * The tool adapter: schema generation, role scoping, and the command round trip.
 *
 * These are the checks that fail silently in production if they regress. A
 * mistyped name in ROLE_TOOLS does not throw -- it just removes a tool from a
 * villager's surface, and the only symptom is that villager quietly never doing
 * part of their job. Likewise a broken round trip renders a call the command
 * parser cannot read, and upstream's retry loop swallows it as a hallucination.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    loadRegistry, buildTools, resolveToolCall, mcDataReady,
    CORE_TOOLS, ROLE_TOOLS,
} from '../../src/society/tools.js';
import { renderTurn, executedArgs } from '../../src/society/toolCommandBridge.js';
import { parseCommandMessage, containsCommand } from '../../src/agent/commands/index.js';
import { ROSTER } from '../../src/society/roster.js';

await loadRegistry();

const fullSurface = buildTools();
const fullNames = new Set(fullSurface.map((t) => t.function.name));

test('the full surface is non-trivial and uniquely named', () => {
    assert.ok(fullSurface.length > 40, `expected >40 tools, got ${fullSurface.length}`);
    assert.equal(fullNames.size, fullSurface.length, 'duplicate tool names');
});

test('newAction is withheld while insecure coding is off', () => {
    // It executes model-written code. It self-guards, but it should not even be
    // offered -- an unavailable tool cannot be talked into running.
    assert.ok(!fullNames.has('newAction'));
});

test('every name in CORE_TOOLS and ROLE_TOOLS is a real command', () => {
    const named = [...CORE_TOOLS, ...Object.values(ROLE_TOOLS).flat()];
    const bogus = [...new Set(named)].filter((n) => !fullNames.has(n));
    assert.deepEqual(bogus, [], `not real commands: ${bogus.join(', ')}`);
});

test('every roster role has a tool set', () => {
    const missing = ROSTER.map((a) => a.role).filter((r) => !ROLE_TOOLS[r]);
    assert.deepEqual(missing, [], `roles with no ROLE_TOOLS entry: ${missing.join(', ')}`);
});

test('a scoped surface is a strict subset that still contains the core', () => {
    for (const role of Object.keys(ROLE_TOOLS)) {
        const names = new Set(buildTools({ role }).map((t) => t.function.name));
        assert.ok(names.size < fullNames.size, `${role} was not actually scoped down`);
        for (const c of CORE_TOOLS)
            assert.ok(names.has(c), `${role} is missing core tool ${c}`);
        for (const n of names)
            assert.ok(fullNames.has(n), `${role} offers unknown tool ${n}`);
    }
});

test('every villager can still perceive, carry, speak and stop', () => {
    // `stay` matters more than it looks: under tool_choice:'required' there is
    // no "produce no output", so it is the only way to do nothing.
    for (const agent of ROSTER) {
        const names = new Set(buildTools({ role: agent.role }).map((t) => t.function.name));
        for (const need of ['inventory', 'givePlayer', 'startConversation', 'stay', 'goal'])
            assert.ok(names.has(need), `${agent.name} (${agent.role}) cannot ${need}`);
    }
});

test('an unknown role falls back to the full surface, not to silence', () => {
    // A typo in a profile should make a villager verbose, never mute.
    const names = buildTools({ role: 'blacksmithy' }).map((t) => t.function.name);
    assert.equal(names.length, fullSurface.length);
});

test('blocked commands are removed under either spelling', () => {
    for (const spelling of ['!goToBed', 'goToBed']) {
        const names = buildTools({ blocked: [spelling] }).map((t) => t.function.name);
        assert.ok(!names.includes('goToBed'), `blocking by "${spelling}" did not take`);
    }
});

test('every tool schema is well formed', () => {
    for (const t of fullSurface) {
        assert.match(t.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
        assert.ok(t.function.description, `${t.function.name} has no description`);
        const p = t.function.parameters;
        assert.equal(p.type, 'object');
        // Upstream's executor requires every declared param, so required must
        // list all of them -- a partially-required schema lets the model omit an
        // argument the command then reads as undefined.
        assert.deepEqual(new Set(p.required), new Set(Object.keys(p.properties)));
    }
});

/**
 * A rendered turn must survive the parser that upstream's agent loop feeds it
 * to. Rendering is deliberately lossy -- quotes and newlines are sanitised,
 * because the command parser has no unescaping step -- so the comparison is
 * against executedArgs(), not the raw arguments.
 */
const ROUND_TRIP_CASES = [
    ['collectBlocks', { type: 'oak_log', num: 8 }],
    ['goToCoordinates', { x: 12, y: 64, z: -30, closeness: 1 }],
    ['givePlayer', { player_name: 'Corin', item_name: 'iron_ore', num: 3 }],
    ['searchForBlock', { type: 'iron_ore', search_range: 64 }],
    ['stay', { type: -1 }],
];

/**
 * `parseCommandMessage` validates BlockName/ItemName arguments against
 * minecraft-data, and those tables are only populated by initBot() on bot
 * login -- there is no offline way to fill them. So the parse assertion is
 * split in two: the shape of the rendered command is checked always, and the
 * value-validating parse only where the tables exist. Skipping is announced
 * rather than silent, so a suite that has quietly stopped checking the second
 * half is visible in the output.
 */
const MC_DATA = mcDataReady();

for (const [name, args] of ROUND_TRIP_CASES) {
    test(`round trip: ${name}`, () => {
        const call = { function: { name, arguments: JSON.stringify(args) } };
        const resolved = resolveToolCall(call);
        assert.ok(resolved.ok, resolved.error);

        const turn = renderTurn(resolved.command, resolved.args);
        assert.ok(containsCommand(turn), `parser sees no command in: ${turn}`);
        assert.ok(turn.includes(resolved.command.name), `wrong command rendered: ${turn}`);

        // Arity is checked here because it does not need minecraft-data, and a
        // mis-ordered or dropped argument is the failure this whole adapter
        // exists to avoid.
        const inner = turn.slice(turn.indexOf(resolved.command.name) + resolved.command.name.length);
        const rendered = inner.slice(inner.indexOf('(') + 1, inner.lastIndexOf(')'));
        const expected = executedArgs(resolved.command, resolved.args);
        assert.equal(
            rendered === '' ? 0 : rendered.split(',').length, expected.length,
            `rendered ${rendered} does not match ${JSON.stringify(expected)}`
        );

        if (!MC_DATA) return;
        const parsed = parseCommandMessage(turn);
        assert.equal(typeof parsed, 'object', `parser rejected: ${turn} (${parsed})`);
        assert.equal(parsed.commandName, resolved.command.name);
        assert.deepEqual(parsed.args, expected);
    });
}

test('minecraft-data availability is reported, not assumed', () => {
    if (!MC_DATA) {
        console.warn(
            'minecraft-data is not initialised (no bot login), so BlockName/ItemName ' +
            'argument validation was not exercised. Run against a live world to cover it.'
        );
    }
    assert.equal(typeof MC_DATA, 'boolean');
});

test('speech is sanitised so one utterance stays one chat line', () => {
    // A newline in Minecraft chat splits the message in two, so half the
    // sentence arrives as a separate utterance from nobody in particular.
    const call = {
        function: {
            name: 'startConversation',
            arguments: JSON.stringify({
                player_name: 'Nia',
                message: 'I need "iron".\nBring some.',
            }),
        },
    };
    const resolved = resolveToolCall(call);
    assert.ok(resolved.ok, resolved.error);
    const turn = renderTurn(resolved.command, resolved.args);
    assert.ok(!turn.includes('\n'), `turn spans lines: ${JSON.stringify(turn)}`);
    assert.ok(containsCommand(turn));
});

test('a bad argument is reported, not thrown', () => {
    const call = { function: { name: 'collectBlocks', arguments: '{"type":"oak_log"}' } };
    const resolved = resolveToolCall(call);
    assert.equal(resolved.ok, false);
    assert.ok(resolved.error);
});

test('an unknown tool name is reported, not thrown', () => {
    const call = { function: { name: 'summonDragon', arguments: '{}' } };
    const resolved = resolveToolCall(call);
    assert.equal(resolved.ok, false);
});
