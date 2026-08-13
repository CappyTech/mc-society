/**
 * Not letting eight villagers push one KV pool over its cliff.
 *
 * MEASURED against the resident model (andy-4.2, 42,752 tokens) using the REAL
 * 36-tool schema and a villager-sized prompt (12,955 tokens) plus the adapter's
 * 1,280-token output budget, village stopped so nothing else competed:
 *
 *     concurrency 1  ->  1/1 emit a tool call
 *     concurrency 2  ->  2/2 emit a tool call
 *     concurrency 3  ->  0/3, all HTTP 400
 *
 * The cliff is the point. Over capacity, EVERY request fails -- including the
 * ones that would have fitted -- so eight villagers thinking together get zero
 * turns rather than two. Retries cannot help, because processes that fail
 * together back off together and collide again.
 *
 * And over-subscription does not always announce itself as a context error. At a
 * cap of three there were NO context errors and instead 14 turns "produced prose
 * instead of a tool call" against 7 that worked -- which reads as the model being
 * bad at its job, and was pool pressure truncating the generation. Every one of
 * those failures had spent exactly the full 1,280-token budget, while the same
 * model with the same schema emits a clean call in ~300 tokens at concurrency 2.
 *
 * The gate has to work ACROSS PROCESSES: the villagers are eight forked node
 * processes, so module state would cap each of them at N and the village at 8N.
 * Hence a lock directory, which is also what society/heartbeat.js coordinates
 * through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const slotDir = mkdtempSync(path.join(tmpdir(), 'mcs-slots-'));
process.env.LMSTUDIO_SLOT_DIR = slotDir;
process.env.LMSTUDIO_MAX_INFLIGHT = '4';   // pinned, so the test is about the gate not the tuning

const { acquire, withSlot, MAX_INFLIGHT, _clearForTests } =
    await import('../../src/society/inferenceSlots.js');

test('the cap is what was measured, not a guess', async () => {
    // This file pins MAX_INFLIGHT via the env so the mechanism is tested
    // independently of the tuning. The DEFAULT is the measured number, and it is
    // TWO: a real villager prompt is ~12,955 tokens and the 1,280-token output
    // budget is reserved alongside it, so 42,752 / 14,235 = 3.00 -- three is
    // exactly the edge and measured 0/3, while two measured 2/2.
    assert.equal(MAX_INFLIGHT, 4, 'the env override stopped working');

    delete process.env.LMSTUDIO_MAX_INFLIGHT;
    try {
        const fresh = await import(`../../src/society/inferenceSlots.js?nodefault=${Date.now()}`);
        assert.equal(fresh.MAX_INFLIGHT, 2, 'the shipped default must sit BELOW the measured edge');
    } finally {
        process.env.LMSTUDIO_MAX_INFLIGHT = '4';
    }
});

test('slots up to the cap are granted immediately', async (t) => {
    t.after(() => _clearForTests());
    _clearForTests();

    const releases = [];
    const started = Date.now();
    for (let i = 0; i < MAX_INFLIGHT; i++) releases.push(await acquire(`v${i}`));
    assert.ok(Date.now() - started < 100, 'granting free slots should not involve waiting');
    assert.equal(readdirSync(slotDir).length, MAX_INFLIGHT);

    for (const r of releases) r();
    assert.equal(readdirSync(slotDir).length, 0, 'released slots must be reusable');
});

test('the (cap + 1)th caller waits until somebody releases', async (t) => {
    t.after(() => _clearForTests());
    _clearForTests();

    const held = [];
    for (let i = 0; i < MAX_INFLIGHT; i++) held.push(await acquire(`v${i}`));

    let granted = false;
    const pending = acquire('latecomer').then((r) => { granted = true; return r; });

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(granted, false, 'a fifth request was let through and would fail the whole pool');

    held[0]();                                  // one villager finishes its turn
    const release = await pending;
    assert.equal(granted, true, 'the waiter was not woken when a slot freed');
    release();
    for (const r of held.slice(1)) r();
});

test('never more than the cap are held at once, under a stampede', async (t) => {
    // The real shape: eight villagers wake and all want a turn.
    t.after(() => _clearForTests());
    _clearForTests();

    let inflight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, (_, i) => withSlot(`v${i}`, async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 40));
        inflight--;
    })));

    assert.ok(peak <= MAX_INFLIGHT, `peaked at ${peak} concurrent requests, cap is ${MAX_INFLIGHT}`);
    assert.equal(inflight, 0);
    assert.equal(readdirSync(slotDir).length, 0, 'withSlot leaked a slot');
});

test('withSlot releases even when the request throws', async (t) => {
    // A leaked slot silently and permanently reduces village capacity by one,
    // with nothing in any log. Every request path here can throw.
    t.after(() => _clearForTests());
    _clearForTests();

    await assert.rejects(withSlot('Bram', () => Promise.reject(new Error('context exceeded'))));
    assert.equal(readdirSync(slotDir).length, 0, 'a failed request kept its slot for ever');
});

test('a double release cannot free somebody else\'s slot', async (t) => {
    t.after(() => _clearForTests());
    _clearForTests();

    const first = await acquire('Bram');
    first();
    first();                                    // buggy caller, or a finally plus an explicit call

    const second = await acquire('Nia');        // takes slot-0 again
    assert.equal(readdirSync(slotDir).length, 1);
    first();                                    // must NOT remove Nia's lock
    assert.equal(readdirSync(slotDir).length, 1, 'a stale release freed a live slot');
    second();
});

test('an abandoned slot is reclaimed, not lost for ever', async (t) => {
    // A villager killed mid-request cannot clean up. Without reaping, the cap
    // would ratchet down to zero over enough crashes.
    t.after(() => _clearForTests());
    _clearForTests();

    const old = new Date(Date.now() - 10 * 60 * 1000);
    for (let i = 0; i < MAX_INFLIGHT; i++) {
        const p = path.join(slotDir, `slot-${i}.lock`);
        writeFileSync(p, '999999 Ghost\n');
        utimesSync(p, old, old);
    }

    const release = await acquire('Bram');
    assert.ok(release, 'a village full of dead locks can never think again');
    release();
});

test('a turn that cannot get a slot SKIPS -- it must never barge', async (t) => {
    // This was built the other way round first and it was measurably wrong:
    // proceeding unslotted takes the pool over its cliff and fails every request
    // already in flight along with its own. 12 barges produced 42 context errors
    // and 8 completed turns. A skipped turn costs one villager one turn; a barge
    // costs everyone theirs.
    t.after(() => {
        _clearForTests();
        process.env.LMSTUDIO_SLOT_TIMEOUT_MS = '';
        delete process.env.LMSTUDIO_SLOT_TIMEOUT_MS;
    });
    _clearForTests();

    process.env.LMSTUDIO_SLOT_TIMEOUT_MS = '200';
    const mod = await import(`../../src/society/inferenceSlots.js?skip=${Date.now()}`);

    const held = [];
    for (let i = 0; i < mod.MAX_INFLIGHT; i++) held.push(await mod.acquire(`v${i}`));
    try {
        await assert.rejects(() => mod.acquire('latecomer'), (err) => {
            assert.equal(err.name, 'NoSlot');
            // Transient, so the turn is retried rather than the villager being
            // declared unable to think.
            assert.equal(err.transient, true);
            return true;
        });
    } finally {
        for (const r of held) r();
    }
});

test('a skipped turn is reported as transient, not as an outage', async (t) => {
    // If a full queue read as terminal, cognition would suppress the whole
    // village for being busy -- turning success into a self-inflicted outage.
    t.after(() => _clearForTests());
    const { NoSlot } = await import('../../src/society/inferenceSlots.js');
    assert.equal(new NoSlot('Bram', 1000).transient, true);
    assert.notEqual(new NoSlot('Bram', 1000).terminal, true);
});

test('a genuine fault still fails OPEN: an unusable lock directory does not block', async () => {
    // A gate that can silence the village is the sixteen-hour outage again in a
    // different costume. Point it at a path that cannot be created.
    const dir = mkdtempSync(path.join(tmpdir(), 'mcs-slots-ro-'));
    const blocker = path.join(dir, 'blocked');
    writeFileSync(blocker, 'not a directory');

    // The env must be poisoned BEFORE the import: SLOT_DIR is read once at module
    // evaluation, so importing first would capture the good path and assert
    // nothing at all.
    process.env.LMSTUDIO_SLOT_DIR = path.join(blocker, 'slots');
    try {
        const mod = await import(`../../src/society/inferenceSlots.js?failopen=${Date.now()}`);
        const started = Date.now();
        const release = await mod.acquire('Bram');
        assert.equal(typeof release, 'function');
        assert.ok(Date.now() - started < 1000,
            'a broken lock directory made the caller wait out the full timeout');
        release();
    } finally {
        process.env.LMSTUDIO_SLOT_DIR = slotDir;
    }
});

test('the gate holds ACROSS PROCESSES, which is the whole point', async (t) => {
    // Module state would cap each villager at 4 and the village at 32 -- the bug
    // it exists to prevent. The eight villagers are eight forked processes
    // (src/process/agent_process.js), so this must be verified out-of-process.
    t.after(() => _clearForTests());
    _clearForTests();

    const held = [];
    for (let i = 0; i < MAX_INFLIGHT; i++) held.push(await acquire(`v${i}`));

    // A separate node process must NOT be granted a slot while ours are held.
    const script = `
        process.env.LMSTUDIO_SLOT_DIR = ${JSON.stringify(slotDir)};
        process.env.LMSTUDIO_MAX_INFLIGHT = '${MAX_INFLIGHT}';
        const { acquire } = await import(${JSON.stringify(
        path.resolve('src/society/inferenceSlots.js'))});
        const t = Date.now();
        const timer = setTimeout(() => { console.log('BLOCKED'); process.exit(0); }, 700);
        await acquire('Outsider');
        clearTimeout(timer);
        console.log('GRANTED after ' + (Date.now() - t) + 'ms');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 15000 }).trim();

    assert.equal(out, 'BLOCKED',
        `another process was granted a slot while all ${MAX_INFLIGHT} were held: ${out}`);

    for (const r of held) r();
});
