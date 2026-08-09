/**
 * The survival ladder.
 *
 * Two failure shapes are guarded here, and neither announces itself at runtime.
 *
 * The first is a need the villager cannot act on: under `tool_choice:
 * "required"` the model emits exactly one tool call and cannot deliberate in
 * prose, so a line that does not name a tool -- or names one this villager does
 * not carry -- costs a whole turn and produces nothing. Every rendered line is
 * checked against the real tool surface for that reason.
 *
 * The second is the ladder quietly eating the economy. It is meant to sit
 * underneath the trade layer, so a villager with nothing wrong must fall
 * through to their standing goal saying nothing at all. An always-on block
 * would look like it was working while the village stopped trading.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TIER, THRESHOLDS, TOOLS, FOCUS_MAX_CHARS, VILLAGE_PLACE,
    evaluate, renderFocus, _resetForTests,
} from '../../src/society/needs.js';
import { CORE_TOOLS, ROLE_TOOLS } from '../../src/society/tools.js';

const NOON = 6000;
const NIGHT = 15000;

/** A villager with nothing whatsoever wrong. */
const wellFed = (over = {}) => ({
    name: 'Wren', role: 'forester',
    health: 20, food: 20, timeOfDay: NOON,
    pos: { x: 0, y: 64, z: 0 },
    roofHeight: 3,
    inventory: { bread: 3, stone_sword: 1, stone_pickaxe: 1, stone_axe: 1 },
    sleptSinceLogin: true,
    underThreat: false,
    ...over,
});

const ctx = (over = {}) => ({ now: 1_000_000, latches: new Map(), raised: new Map(), ...over });

/**
 * A full tool kit, spread into fixtures that are testing something else.
 *
 * Overriding `inventory` wholesale drops the tools too, so tier 4 fires and
 * masks the tier actually under test. That is the ladder behaving correctly --
 * it always reports the highest unmet need -- but it makes for a confusing
 * test, so anything not about tools carries a kit.
 */
const KIT = { stone_sword: 1, stone_pickaxe: 1, stone_axe: 1 };

/** Somewhere well outside any settlement. */
const WILDS = { x: 900, y: 64, z: 900 };

const lit = { safe: true, cells: 4, litCells: 4 };
// The settlement id is literally the word villagers type into
// goToRememberedPlace -- see territory.js. The fixture uses the real one so
// that assertions about the rendered text are assertions about production.
const graphWith = (over = {}) => ({
    nodes: [{ _id: VILLAGE_PLACE, label: 'the village', centre: { x: 0, y: 64, z: 0 }, radius: 24, lit, beds: [] }],
    edges: [], chest: null, ...over,
});

test('a villager with nothing wrong says nothing at all', () => {
    // The whole premise of "underneath, not instead of". An empty section still
    // costs tokens and tells the model there is a slot it ought to be filling.
    const need = evaluate(wellFed(), graphWith(), ctx());
    assert.equal(need, null);
    assert.equal(renderFocus(need), '');
});

test('only the top unmet need is ever spoken', () => {
    // Exposed, starving and unarmed at once. The model can act on one of them,
    // so it is told about one of them -- the one that kills first.
    const need = evaluate(
        wellFed({ timeOfDay: NIGHT, roofHeight: null, pos: WILDS, food: 2, inventory: {} }),
        graphWith(), ctx(),
    );
    assert.equal(need.tier, TIER.EXPOSED);
    const text = renderFocus(need);
    assert.match(text, /^NEEDS\n/);
    assert.doesNotMatch(text, /hungry/i);
    assert.doesNotMatch(text, /smith/i);
});

test('night under a roof is not exposure, and neither is night on lit ground', () => {
    const roofed = wellFed({ timeOfDay: NIGHT, roofHeight: 2 });
    assert.equal(evaluate(roofed, graphWith(), ctx()), null);

    // Standing in a lit settlement with open sky above is safe -- that is what
    // building the lattice buys, and the ladder has to agree or the work is
    // pointless.
    const inTown = wellFed({ timeOfDay: NIGHT, roofHeight: null });
    assert.equal(evaluate(inTown, graphWith(), ctx()), null);

    // And so is a lit road between settlements.
    const onRoad = wellFed({ timeOfDay: NIGHT, roofHeight: null, pos: WILDS });
    assert.equal(evaluate(onRoad, graphWith({ onRoad: true }), ctx()), null);
});

test('a villager too far from anywhere lit is told to dig in, not to walk', () => {
    // Sending someone on a 400-block night walk is worse advice than telling
    // them to get underground where they stand.
    const far = wellFed({ timeOfDay: NIGHT, roofHeight: null, pos: WILDS });
    const need = evaluate(far, graphWith(), ctx());
    assert.equal(need.tier, TIER.EXPOSED);
    assert.match(renderFocus(need), new RegExp(TOOLS.shelter));
    assert.doesNotMatch(renderFocus(need), new RegExp(TOOLS.goTo));
});

test('hunger only fires when there is genuinely nothing to eat', () => {
    // auto-eat handles "hungry with food" silently and without an LLM turn.
    // If this fires while the villager is carrying bread, the two mechanisms
    // are fighting and the turn is wasted.
    const withBread = wellFed({ food: 6, inventory: { ...KIT, bread: 1 } });
    assert.equal(evaluate(withBread, graphWith(), ctx()), null);

    const empty = wellFed({ food: 6, inventory: KIT });
    assert.equal(evaluate(empty, graphWith(), ctx()).tier, TIER.HUNGRY);
});

test('village stores beat your own pockets', () => {
    const empty = wellFed({ food: 6, inventory: KIT });
    const graph = graphWith({
        chest: { x: 10, y: 64, z: 10, contents: { bread: 12 }, contentsAt: new Date(1_000_000 - 1000) },
    });
    const text = renderFocus(evaluate(empty, graph, ctx()));
    assert.match(text, /12 bread/);
    assert.match(text, new RegExp(TOOLS.take));
});

test('a stale chest reading is hedged, never asserted', () => {
    // A villager sent to a chest emptied twenty minutes ago wastes a turn and
    // learns to distrust the block. Hedging keeps the location useful without
    // promising the contents.
    const empty = wellFed({ food: 6, inventory: KIT });
    const graph = graphWith({
        chest: {
            x: 10, y: 64, z: 10, contents: { bread: 12 },
            contentsAt: new Date(1_000_000 - THRESHOLDS.STALE_MS - 1),
        },
    });
    const text = renderFocus(evaluate(empty, graph, ctx()));
    assert.doesNotMatch(text, /12 bread/);
    assert.match(text, /may be food/);
});

test('a missing tool outranks upgrading a present one', () => {
    const noSword = wellFed({ inventory: { stone_pickaxe: 1, stone_axe: 1 } });
    const need = evaluate(noSword, graphWith(), ctx());
    assert.equal(need.tier, TIER.UNARMED);
    assert.match(renderFocus(need), /no sword/);
});

test('wood is a waypoint, not a destination', () => {
    // A villager who has crafted wooden tools has started, not finished.
    const wooden = wellFed({ inventory: { wooden_sword: 1, wooden_pickaxe: 1, wooden_axe: 1 } });
    assert.equal(evaluate(wooden, graphWith(), ctx()).tier, TIER.UNARMED);

    const stone = wellFed({ inventory: { stone_sword: 1, stone_pickaxe: 1, stone_axe: 1 } });
    assert.equal(evaluate(stone, graphWith(), ctx()), null);
});

test('the tool tier line names the smith, because the fix is social', () => {
    const noSword = wellFed({ inventory: { stone_pickaxe: 1, stone_axe: 1 } });
    const text = renderFocus(evaluate(noSword, graphWith(), ctx()));
    assert.match(text, /Corin/);
    assert.match(text, new RegExp(TOOLS.speak));
});

test('no bed is raised, because dying without one loses everything', () => {
    const bedless = wellFed({ sleptSinceLogin: false });
    const need = evaluate(bedless, graphWith(), ctx());
    assert.equal(need.tier, TIER.UNSECURED);
    assert.match(renderFocus(need), new RegExp(TOOLS.bed));

    // A bed claimed in the village counts, even across a restart -- that is
    // what the graph remembers it for.
    const claimed = graphWith();
    claimed.nodes[0].beds = [{ x: 1, y: 64, z: 1, claimedBy: 'Wren' }];
    assert.equal(evaluate(bedless, claimed, ctx()), null);
});

test('a need just met is not raised again immediately', () => {
    // Guards oscillation: a villager sitting exactly on a threshold would
    // otherwise be told about it every single turn.
    const empty = wellFed({ food: 6, inventory: KIT });
    const latches = new Map([['hungry', 1_000_000 - 1000]]);
    assert.equal(evaluate(empty, graphWith(), ctx({ latches })), null);

    const old = new Map([['hungry', 1_000_000 - THRESHOLDS.LATCH_MS - 1]]);
    assert.equal(evaluate(empty, graphWith(), ctx({ latches: old })).tier, TIER.HUNGRY);
});

test('chronic needs are throttled, urgent ones are not', () => {
    // A missing pickaxe is true for hours. Saying so every turn for hours is
    // how a survival layer drowns a trade layer.
    const noSword = wellFed({ inventory: { stone_pickaxe: 1, stone_axe: 1 } });
    const raised = new Map([['unarmed', 1_000_000 - 1000]]);
    assert.equal(evaluate(noSword, graphWith(), ctx({ raised })), null);

    // Exposure is not throttled: it is true for one night and it kills.
    const exposed = wellFed({ timeOfDay: NIGHT, roofHeight: null, pos: WILDS });
    const raisedExposed = new Map([['exposed', 1_000_000 - 1000]]);
    assert.equal(evaluate(exposed, graphWith(), ctx({ raised: raisedExposed })).tier, TIER.EXPOSED);
});

test('the block never exceeds its budget and never truncates mid-line', () => {
    // A half-written survival instruction is worse than none: it reads as a
    // complete sentence about something else.
    const exposed = wellFed({ timeOfDay: NIGHT, roofHeight: null, pos: WILDS });
    const need = evaluate(exposed, graphWith(), ctx());

    const full = renderFocus(need);
    assert.ok(full.length <= FOCUS_MAX_CHARS, `${full.length} > ${FOCUS_MAX_CHARS}`);

    const squeezed = renderFocus(need, null, { budget: 60 });
    for (const line of squeezed.split('\n')) assert.ok(!line.endsWith('…') || line.length > 1);
    assert.ok(squeezed.length <= 60);
    // Whatever survives is whole lines from the original.
    for (const line of squeezed.split('\n').slice(1)) assert.ok(need.lines.includes(line));
});

test('every rendered line names a tool that villager actually carries', () => {
    // The failure this guards: a tool renamed in tools.js while the text here
    // keeps the old name. Nothing throws -- the villager is simply told to call
    // something that does not exist, once per turn, for ever.
    const surface = new Set([...CORE_TOOLS, ...Object.values(ROLE_TOOLS).flat()]);

    // Tools the ladder already names but that have not been built yet. Delete
    // an entry as its command lands and the strict check below starts covering
    // it -- the list is meant to shrink to nothing, and an empty set here is
    // the goal state rather than a missing test.
    const pending = new Set([]);

    for (const [key, name] of Object.entries(TOOLS)) {
        if (pending.has(name)) continue;
        assert.ok(surface.has(name), `TOOLS.${key} = "${name}" is not a real tool`);
    }

    // And nothing may sit on the pending list once it exists: that would mean
    // the exemption above is quietly hiding a working tool from the check.
    for (const name of pending) {
        assert.ok(!surface.has(name), `"${name}" exists now -- remove it from the pending list`);
    }
});

test('the village place name survives the tool-to-text round trip', () => {
    // rememberHere and goToRememberedPlace pass this through a parser whose
    // argument regex has no unescaping, and sanitizeString replaces quotes and
    // collapses newlines on the way in.
    assert.match(VILLAGE_PLACE, /^[a-z_]+$/);
});

test('a broken or empty world state does not throw', () => {
    // assess() runs inside a turn. A villager standing still because their
    // needs evaluator threw would be a worse bug than anything it detects.
    _resetForTests();
    for (const bad of [{}, { inventory: {} }, { pos: null, inventory: {}, timeOfDay: NIGHT }]) {
        assert.doesNotThrow(() => renderFocus(evaluate(bad, {}, ctx())));
    }
});

test('the village musters at dusk, while walking home is still safe', () => {
    // Eight villagers converging on one lit settlement each evening is the most
    // visible collective behaviour the design has, and it costs nothing -- they
    // were taking a turn anyway.
    const DUSK = 11500;
    const away = wellFed({ timeOfDay: DUSK, roofHeight: null, pos: { x: 60, y: 64, z: 0 } });
    const need = evaluate(away, graphWith(), ctx());
    assert.equal(need.key, 'muster');
    const text = renderFocus(need);
    assert.match(text, new RegExp(TOOLS.goTo));
    assert.match(text, /village/);
});

test('nobody is called out of shelter once the mobs are up', () => {
    // The dangerous version of the muster, and the reason it is gated on dusk
    // rather than on night: a villager who has already dug in is SAFE. Telling
    // them to walk home after dark takes a survivor and sends them out into the
    // dark, turning collective behaviour into a collective way to die.
    const NIGHT_PROPER = 15000;
    const duginFar = wellFed({
        timeOfDay: NIGHT_PROPER, roofHeight: 2, pos: { x: 60, y: 64, z: 0 },
    });
    assert.equal(evaluate(duginFar, graphWith(), ctx()), null);
});

test('a villager already at the village is not told to go to it', () => {
    const DUSK = 11500;
    const home = wellFed({ timeOfDay: DUSK, roofHeight: null, pos: { x: 2, y: 64, z: 2 } });
    assert.equal(evaluate(home, graphWith(), ctx()), null);
});

test('nobody is asked to cross the world at dusk', () => {
    // Beyond a certain distance the honest advice is to dig in where you are.
    const DUSK = 11500;
    const veryFar = wellFed({ timeOfDay: DUSK, roofHeight: null, pos: { x: 900, y: 64, z: 900 } });
    const need = evaluate(veryFar, graphWith(), ctx());
    assert.notEqual(need?.key, 'muster');
    assert.match(renderFocus(need), new RegExp(TOOLS.shelter));
});
