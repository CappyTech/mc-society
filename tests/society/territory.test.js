/**
 * The village's territory graph.
 *
 * What is being guarded here is mostly leaderlessness. The eight villagers are
 * separate node processes with no coordinator and no startup order, so every
 * shared fact has to be writable by all of them at once with an identical
 * result. Anything here that depended on who went first would produce a village
 * with two bases, or two roads between the same pair of places, and it would do
 * so intermittently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    HEARTH, SPAWN, VILLAGE_PLACE, slug, nodeContaining, nearestNode, onRoad, ROAD_MARGIN,
} from '../../src/society/territory.js';
import { edgeKey } from '../../src/society/chronicle/models.js';
import { TOOLS } from '../../src/society/needs.js';

const node = (id, x, z, over = {}) =>
    ({ _id: id, centre: { x, y: 64, z }, radius: 24, ...over });

test('the base is named the same thing everywhere', () => {
    // A node's _id IS the string !goToRememberedPlace takes. If the graph and
    // the persona ever disagree, the villagers walk nowhere and it looks like
    // the model being stupid rather than like a broken constant.
    assert.equal(HEARTH, VILLAGE_PLACE);
    assert.equal(HEARTH, 'village');
});

test('place names survive the tool-to-text round trip', () => {
    // toolCommandBridge sanitises quotes and collapses newlines, and the
    // parser's argument regex has no unescaping, so anything the model is asked
    // to type back must be plain.
    for (const name of [HEARTH, SPAWN, slug('Iron Ridge'), slug("Odile's camp!")]) {
        assert.match(name, /^[a-z0-9_]+$/, `"${name}" would not survive`);
    }
    assert.equal(slug('Iron Ridge'), 'iron_ridge');
    assert.equal(slug('  --Iron  Ridge--  '), 'iron_ridge');
    assert.equal(slug(''), '');
    assert.equal(slug(null), '');
});

test('a road is one road whichever end you start from', () => {
    // Two villagers deciding to link the same pair of places must not create
    // two documents. The id is the pair, sorted.
    assert.equal(edgeKey('village', 'spawn'), edgeKey('spawn', 'village'));
    assert.equal(edgeKey('spawn', 'village'), 'spawn--village');
});

test('you are at a settlement when you are inside its radius', () => {
    const g = { nodes: [node('village', 0, 0), node('iron_ridge', 200, 0)] };
    assert.equal(nodeContaining(g, { x: 5, y: 64, z: 5 })._id, 'village');
    assert.equal(nodeContaining(g, { x: 205, y: 64, z: 0 })._id, 'iron_ridge');
    // Height is deliberately ignored: a villager in a mine below the village is
    // still at the village, and one on a tower above it still is too.
    assert.equal(nodeContaining(g, { x: 0, y: 12, z: 0 })._id, 'village');
    assert.equal(nodeContaining(g, { x: 100, y: 64, z: 100 }), null);
});

test('an empty or absent graph is a supported state, not an error', () => {
    // With Mongo down the ladder degrades to purely individual survival. It
    // must not throw on the way there.
    for (const g of [undefined, null, {}, { nodes: [] }, { nodes: [{ _id: 'x' }] }]) {
        assert.doesNotThrow(() => nodeContaining(g, { x: 0, y: 64, z: 0 }));
        assert.doesNotThrow(() => nearestNode(g, { x: 0, y: 64, z: 0 }));
        assert.equal(nodeContaining(g, { x: 0, y: 64, z: 0 }), null);
    }
    // And a villager with no position yet is not "at" anywhere.
    assert.equal(nodeContaining({ nodes: [node('village', 0, 0)] }, null), null);
});

test('the nearest settlement is the one you are told to run to', () => {
    const g = { nodes: [node('village', 0, 0), node('iron_ridge', 100, 0)] };
    const near = nearestNode(g, { x: 90, y: 64, z: 0 });
    assert.equal(near.node._id, 'iron_ridge');
    assert.equal(near.distance, 10);

    // Distance is rounded because it is going into a sentence a model reads,
    // not into a calculation.
    assert.equal(Number.isInteger(nearestNode(g, { x: 33, y: 64, z: 47 }).distance), true);
});

test('the ladder can name a place the villager can actually walk to', () => {
    // The join between the graph and the survival ladder: a node id is
    // rendered straight into a goToRememberedPlace call, so the two have to
    // agree about what a name looks like.
    assert.equal(TOOLS.goTo, 'goToRememberedPlace');
    assert.match(HEARTH, /^[a-z0-9_]+$/);
});

test('only a finished road counts as somewhere safe to be at night', () => {
    // The worst possible bug in this layer would be a half-built road reading
    // as safe: the ladder would confidently tell villagers to walk down a dark
    // corridor after dark. Only `open` edges count, and an edge only opens when
    // its last segment is done.
    const nodes = [
        { _id: 'village', centre: { x: 0, y: 64, z: 0 }, radius: 24 },
        { _id: 'spawn', centre: { x: 200, y: 64, z: 0 }, radius: 16 },
    ];
    const half = { nodes, edges: [{ _id: 'spawn--village', a: 'spawn', b: 'village', open: false }] };
    const done = { nodes, edges: [{ _id: 'spawn--village', a: 'spawn', b: 'village', open: true }] };
    const onIt = { x: 100, y: 64, z: 0 };

    assert.equal(onRoad(half, onIt), false, 'an unfinished road read as safe');
    assert.equal(onRoad(done, onIt), true);
});

test('being near a road is not being on it', () => {
    const nodes = [
        { _id: 'village', centre: { x: 0, y: 64, z: 0 }, radius: 24 },
        { _id: 'spawn', centre: { x: 200, y: 64, z: 0 }, radius: 16 },
    ];
    const g = { nodes, edges: [{ _id: 'spawn--village', a: 'spawn', b: 'village', open: true }] };
    assert.equal(onRoad(g, { x: 100, y: 64, z: ROAD_MARGIN - 1 }), true);
    assert.equal(onRoad(g, { x: 100, y: 64, z: ROAD_MARGIN + 5 }), false);
    // Past the end of the road is off it, not on an infinite line.
    assert.equal(onRoad(g, { x: 400, y: 64, z: 0 }), false);
});

test('a road to a settlement nobody has heard of is not walked', () => {
    // Edges outlive nodes if a settlement is ever removed. A dangling edge must
    // not resolve to "safe ground" somewhere in the middle of nowhere.
    const g = {
        nodes: [{ _id: 'village', centre: { x: 0, y: 64, z: 0 }, radius: 24 }],
        edges: [{ _id: 'ghost--village', a: 'ghost', b: 'village', open: true }],
    };
    assert.doesNotThrow(() => onRoad(g, { x: 10, y: 64, z: 0 }));
    assert.equal(onRoad(g, { x: 10, y: 64, z: 0 }), false);
    assert.equal(onRoad(null, { x: 0, y: 64, z: 0 }), false);
    assert.equal(onRoad({ nodes: [], edges: [] }, null), false);
});
