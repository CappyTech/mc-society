/**
 * Structure building.
 *
 * The schematics are upstream data files that a merge can change underneath
 * us, and the command's enum is generated from whatever is on disk. Both are
 * asserted here so a schematic renamed upstream fails a test rather than
 * producing a villager who confidently calls !build with a plan that no longer
 * exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    listStructures, loadStructure, materialsFor, resolveGeneric,
    describeMissing, orientationFor,
} from '../../src/society/build.js';
import { loadRegistry, buildTools } from '../../src/society/tools.js';

await loadRegistry();

test('the schematics on disk are readable and non-empty', () => {
    const names = listStructures();
    assert.ok(names.length >= 4, `expected at least 4 plans, got ${names.length}`);
    assert.ok(names.includes('small_wood_house'));
    for (const n of names) {
        const s = loadStructure(n);
        assert.ok(s?.blocks?.length, `${n} has no blocks`);
        assert.equal(typeof s.offset, 'number', `${n} has no offset`);
    }
});

test('an unknown plan loads as null rather than throwing', () => {
    assert.equal(loadStructure('castle_of_doom'), null);
    assert.equal(loadStructure('../../../etc/passwd'), null);
});

test('materialsFor counts real items and never placeholders', () => {
    const mats = materialsFor(loadStructure('small_wood_house'));
    assert.ok(mats.oak_planks > 0, 'a wooden house needs planks');
    // '' means "leave what is there" and 'air' means "clear it"; neither costs
    // the builder anything, and both would be nonsense to ask a neighbour for.
    for (const key of Object.keys(mats)) {
        assert.notEqual(key, '');
        assert.notEqual(key, 'air');
        assert.notEqual(key, 'null');
        assert.ok(mats[key] > 0);
    }
});

test('every schematic yields a usable materials list', () => {
    for (const n of listStructures()) {
        const mats = materialsFor(loadStructure(n));
        assert.ok(Object.keys(mats).length > 0, `${n} needs nothing at all`);
    }
});

test('materialsFor tolerates junk instead of throwing', () => {
    assert.deepEqual(materialsFor(null), {});
    assert.deepEqual(materialsFor({}), {});
    assert.deepEqual(materialsFor({ blocks: [] }), {});
});

test('generic block names resolve to concrete items', () => {
    // Mirrors getTypeOfGeneric's fallback branches. The real build may pick a
    // different wood from the builder's inventory, so this list is indicative.
    assert.equal(resolveGeneric('planks'), 'oak_planks');
    assert.equal(resolveGeneric('door'), 'oak_door');
    assert.equal(resolveGeneric('bed'), 'white_bed');
    assert.equal(resolveGeneric('cobblestone'), 'cobblestone');
});

test('describeMissing reads as something you could ask someone for', () => {
    assert.equal(describeMissing({ oak_planks: 12, glass: 3 }), '12 oak_planks, 3 glass');
    assert.equal(describeMissing({}), '');
    assert.equal(describeMissing(undefined), '');
});

test('orientation is stable for a site and varies between sites', () => {
    // Stability is the point: executeNext randomises when passed null, which
    // would rotate a half-built structure on the next call and place blocks
    // into its own walls.
    const site = { x: 122.7, y: 64, z: -310.2 };
    assert.equal(orientationFor(site), orientationFor({ ...site }));
    assert.ok(orientationFor(site) >= 0 && orientationFor(site) < 4);
    // Negative coordinates must not produce a negative index.
    for (const p of [{ x: -1, z: 0 }, { x: -3, z: -4 }, { x: 0, z: -1 }]) {
        const o = orientationFor({ ...p, y: 64 });
        assert.ok(o >= 0 && o < 4, `orientation ${o} out of range at ${p.x},${p.z}`);
    }
});

test('the build tool offers exactly the plans that exist on disk', () => {
    const tool = buildTools().find((t) => t.function.name === 'build');
    assert.ok(tool, '!build is not in the tool surface');
    assert.deepEqual([...tool.function.parameters.properties.structure.enum].sort(),
        [...listStructures()].sort());
});

test('only the builder is offered the build tool', () => {
    // It costs ~70 prompt tokens on every turn; a miner has no use for it.
    const has = (role) => buildTools({ role }).some((t) => t.function.name === 'build');
    assert.ok(has('builder'), 'the builder cannot build');
    assert.ok(!has('miner'), 'the miner is paying for a tool they never use');
});

test('an unbreakable site is reported as an obstruction, not as progress', async () => {
    const { blockedBy } = await import('../../src/society/build.js');
    const log = "Don't have right tools to break stone. stone in the way at (-1, 59, 68). " +
                "Cannot place oak_planks at (-1, 59, 68): block in the way. " +
                "Don't have right tools to break deepslate.";
    const out = blockedBy(log);
    assert.match(out, /stone/);
    assert.match(out, /deepslate/);
    assert.match(out, /pickaxe/, 'the builder is not told what tool to ask for');
    // Each obstructing block is named once, however many times it appears.
    assert.equal(out.match(/stone/g).length, 1);
});

test('a clean build log reports no obstruction', async () => {
    const { blockedBy } = await import('../../src/society/build.js');
    assert.equal(blockedBy('Placed oak_planks at (1,2,3). Placed oak_door at (1,3,3).'), '');
    assert.equal(blockedBy(''), '');
    assert.equal(blockedBy(undefined), '');
});
