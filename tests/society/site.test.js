/**
 * The geometry of safe ground.
 *
 * Two properties are load-bearing here and neither is obvious from reading the
 * code.
 *
 * DETERMINISM. Eight villager processes each derive the job list from the same
 * agreed project and identify jobs by a content-derived id. If any function
 * here returned things in a different order on different processes, the board
 * would fill with near-duplicate jobs and the village would build the same road
 * twice. So "same input, same output, same order" is a correctness requirement,
 * not tidiness.
 *
 * UNKNOWN IS NOT MISSING. Bots only load chunks near themselves, so a job
 * inspected from far away reads as entirely empty. Treating that as "nothing is
 * built" retries finished work for ever; treating it as "all built" closes jobs
 * that were never started. Both failures are silent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LATTICE_SPACING, SEGMENT_LEN,
    latticePoints, litState, segmentsBetween, segmentTorches, expandProject, verifySpec,
} from '../../src/society/site.js';

const node = (over = {}) =>
    ({ _id: 'village', centre: { x: 0, y: 64, z: 0 }, radius: 24, ...over });

test('a lattice covers the whole settlement with no dark gap', () => {
    const points = latticePoints(node());
    assert.ok(points.length > 0);
    // Every point inside the radius is within half a cell diagonal of a torch,
    // which is what keeps the darkest corner well above the light level 0 that
    // hostile spawning needs.
    const worst = Math.hypot(LATTICE_SPACING / 2, LATTICE_SPACING / 2);
    for (let x = -20; x <= 20; x += 2) {
        for (let z = -20; z <= 20; z += 2) {
            if (Math.hypot(x, z) > 20) continue;
            const nearest = Math.min(...points.map((p) => Math.hypot(p.x - x, p.z - z)));
            assert.ok(nearest <= worst + 0.001, `(${x},${z}) is ${nearest.toFixed(1)} from any torch`);
        }
    }
});

test('the lattice is the same list, in the same order, every time', () => {
    // Eight processes derive this independently. Order decides job ids and the
    // order they are worked in; if it wandered, the board would double up.
    const a = latticePoints(node());
    const b = latticePoints(node());
    assert.deepEqual(a, b);
    // Centre outward, so a settlement is never lit as a ring around a dark core.
    assert.deepEqual(a[0], { x: 0, y: 64, z: 0 });
});

test('nothing outside the settlement is lit', () => {
    for (const p of latticePoints(node({ radius: 14 }))) {
        assert.ok(Math.hypot(p.x, p.z) <= 14);
    }
});

test('a settlement is safe only when every cell is lit', () => {
    const n = node();
    const total = latticePoints(n).length;
    assert.equal(litState(n, total).safe, true);
    assert.equal(litState(n, total - 1).safe, false);
    assert.equal(litState(n, 0).safe, false);
    // A settlement with no cells at all is not vacuously safe.
    assert.equal(litState({ _id: 'x' }, 0).safe, false);
});

test('a road is covered exactly once, in chunk-sized pieces', () => {
    const from = { x: 0, y: 64, z: 0 }, to = { x: 100, y: 64, z: 0 };
    const segs = segmentsBetween(from, to);
    assert.ok(segs.length >= Math.floor(100 / SEGMENT_LEN));
    // End to end with no gap and no overlap.
    assert.deepEqual(segs[0].from, from);
    assert.deepEqual(segs.at(-1).to, to);
    for (let i = 1; i < segs.length; i++) assert.deepEqual(segs[i].from, segs[i - 1].to);
    // Indices are stable and dense, because they go into the job ids.
    segs.forEach((s, i) => assert.equal(s.index, i));
});

test('a road to nowhere produces no work', () => {
    assert.deepEqual(segmentsBetween({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }), []);
    assert.deepEqual(segmentsBetween(null, { x: 1, y: 1, z: 1 }), []);
});

test('road torches alternate sides so neither verge is dark', () => {
    const [seg] = segmentsBetween({ x: 0, y: 64, z: 0 }, { x: 16, y: 64, z: 0 });
    const torches = segmentTorches(seg);
    assert.ok(torches.length >= 2);
    // The road runs along x, so alternating sides means z flips sign.
    assert.ok(torches.some((t) => t.z > 0), 'nothing on one side');
    assert.ok(torches.some((t) => t.z < 0), 'nothing on the other');
});

test('expanding a project twice yields the same board', () => {
    // The single most important property: all eight villagers may expand the
    // same agreed project at once, and $setOnInsert on these ids has to make
    // that a no-op rather than a duplicate.
    const target = { kind: 'node', node: node() };
    const a = expandProject(target).map((j) => j._id);
    const b = expandProject(target).map((j) => j._id);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, 'duplicate job ids in one expansion');
});

test('lighting outranks everything else at a new settlement', () => {
    // An unlit settlement with a beautiful chest in it is still somewhere you
    // cannot sleep. Lighting is the only job here that stops a villager dying.
    const jobs = expandProject({ kind: 'node', node: node() });
    const light = jobs.filter((j) => j.kind === 'lattice_cell');
    const chest = jobs.find((j) => j.kind === 'chest');
    assert.ok(light.length > 0 && chest);
    assert.ok(Math.max(...light.map((j) => j.priority)) > chest.priority);
});

test('a road is built from one end, not from both', () => {
    // Half a road built from the middle outwards is unusable. Built in order,
    // the part that exists can be walked tonight.
    const jobs = expandProject({
        kind: 'edge',
        edge: { _id: 'spawn--village' },
        from: { x: 0, y: 64, z: 0 }, to: { x: 64, y: 64, z: 0 },
    });
    assert.ok(jobs.length > 1);
    for (let i = 1; i < jobs.length; i++) {
        assert.ok(jobs[i].priority < jobs[i - 1].priority, 'segments are not ordered');
    }
    // Ids are zero-padded so lexical and numeric order agree -- seg:10 must not
    // sort before seg:2 when the board breaks a priority tie by _id.
    assert.match(jobs[0]._id, /:seg:00$/);
});

test('every job says what it costs, so the board feeds the economy', () => {
    // This is what stops the territory layer starving the trade layer: a road
    // is demand for cobblestone and torches, which is demand for Bram and Wren.
    for (const job of expandProject({ kind: 'node', node: node() })) {
        assert.ok(Object.keys(job.materials ?? {}).length > 0, `${job._id} costs nothing`);
    }
});

test('a job checked from too far away is unknown, not finished', () => {
    // blockAt returns null outside loaded chunks. If that read as "missing" the
    // work would be redone for ever; if it read as "present" the job would
    // close having never been built.
    const points = [{ x: 0, z: 0 }, { x: 7, z: 0 }];
    const unseen = verifySpec({}, points);
    assert.equal(unseen.done, false);
    assert.equal(unseen.seen, 0);
    assert.equal(unseen.unknown.length, 2);
    assert.equal(unseen.missing.length, 0, 'unseen must never be reported as missing');
});

test('one missing torch is enough to leave the job open', () => {
    const points = [{ x: 0, z: 0 }, { x: 7, z: 0 }];
    assert.equal(verifySpec({ '0,0': 'torch', '7,0': 'torch' }, points).done, true);
    const partial = verifySpec({ '0,0': 'torch', '7,0': 'air' }, points);
    assert.equal(partial.done, false);
    assert.deepEqual(partial.missing, [{ x: 7, z: 0 }]);
    // wall_torch counts: placing against a side is still a lit cell.
    assert.equal(verifySpec({ '0,0': 'torch', '7,0': 'wall_torch' }, points).done, true);
});

test('a spec with no points is never done by default', () => {
    assert.equal(verifySpec({}, []).done, false);
    assert.equal(verifySpec(null, null).done, false);
});
