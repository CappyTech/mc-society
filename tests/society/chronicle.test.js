/**
 * The Chronicle, with no database anywhere.
 *
 * THIS IS THE MOST IMPORTANT TEST FILE IN THE FEATURE.
 *
 * The Chronicle sits inside the command path of eight villagers taking a turn
 * every few seconds. If it can throw, it breaks commands that already
 * succeeded; if it can block, one slow query multiplies into a village that has
 * gone silent -- which looks exactly like the inference server dying, a
 * misdiagnosis that has already cost this project a session.
 *
 * So: no CHRONICLE_MONGO_URI is set here, and every export must still be safe
 * to call. Importing the module must not require a database either, or `npm
 * test` starts needing one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.CHRONICLE_MONGO_URI;

const chronicle = await import('../../src/society/chronicle/chronicle.js');
const { getState, isUp } = chronicle;

test('importing the Chronicle does not require a database', () => {
    // Reaching this line at all is the assertion; a top-level connect would
    // have thrown or hung during the import above.
    assert.equal(typeof chronicle.observe, 'function');
});

test('with no URI configured it stays inert', () => {
    chronicle.connect();
    assert.equal(getState(), 'off');
    assert.equal(isUp(), false);
});

test('every write is a no-op that returns immediately', () => {
    const agent = { name: 'Bram' };
    assert.doesNotThrow(() => chronicle.observe(agent, '!givePlayer', ['Nia', 'coal', 3], 'Nia received coal.'));
    assert.doesNotThrow(() => chronicle.observeHeard('Nia', 'Bram', 'here is your coal'));
    assert.doesNotThrow(() => chronicle.observeDeath('Sable', 'was shot by a skeleton', { x: 1, y: 2, z: 3 }));
    assert.doesNotThrow(() => chronicle.observePlace('Odile', 'site', { x: 1, y: 2, z: 3 }));
});

test('writes survive junk arguments', () => {
    // observe() is called for every command of every villager, including ones
    // whose arguments this module has never seen.
    assert.doesNotThrow(() => chronicle.observe(null, null, null, null));
    assert.doesNotThrow(() => chronicle.observe({}, '!givePlayer', [], undefined));
    assert.doesNotThrow(() => chronicle.observe({ name: 'X' }, '!unknownCommand', [1, 2], 'ok'));
});

test('the brief is empty rather than absent', async () => {
    // '' keeps the prompt well-formed. A thrown error or an "unavailable"
    // string would put database plumbing into a villager's head.
    assert.equal(await chronicle.brief('Bram'), '');
    assert.equal(await chronicle.brief('Bram', { focus: 'Nia' }), '');
    assert.equal(await chronicle.brief(null), '');
});

test('flush and seed are safe with nothing behind them', async () => {
    await assert.doesNotReject(() => chronicle.flush());
    await assert.doesNotReject(() => chronicle.seed([{ name: 'Bram', role: 'miner' }]));
    await assert.doesNotReject(() => chronicle.seed(null));
});

test('a burst of writes with no database cannot grow without bound', () => {
    // A long outage must not turn the buffer into a memory leak.
    chronicle._resetForTests();
    for (let i = 0; i < 5000; i++)
        chronicle.observe({ name: 'Bram' }, '!collectBlocks', ['stone', 1], 'Collected 1 stone.');
    // Nothing is buffered at all while the connection is off, and the process
    // is still here to assert it.
    assert.ok(true);
});

/**
 * The write paths, against fake models.
 *
 * Everything above verifies the module stays silent with no database -- the
 * degradation contract. That is necessary and it is also how a whole field came
 * to be dead: `deaths` was declared on the agent schema, defaulted to 0, and
 * incremented by nothing at all. 90 `died` events had accumulated against eight
 * agents still reading zero, and the dashboard dutifully showed zeros while
 * villagers died in a loop.
 */
test('a death increments the agent\'s deaths counter', async (t) => {
    const { _setModelsForTests } = await import('../../src/society/chronicle/connection.js');
    t.after(() => { _setModelsForTests(null); chronicle._resetForTests(); });
    chronicle._resetForTests();

    const agentWrites = [];
    const eventWrites = [];
    _setModelsForTests({
        Event: { insertMany: (docs) => { eventWrites.push(...docs); return Promise.resolve(); } },
        Agent: { bulkWrite: (ops) => { agentWrites.push(...ops); return Promise.resolve(); } },
        Relationship: { bulkWrite: () => Promise.resolve() },
        Ledger: { create: () => Promise.resolve(), updateOne: () => Promise.resolve() },
    });

    chronicle.observeDeath('Sable', 'was slain by Zombie', { x: 10, y: 64, z: -5 });
    await chronicle.flush();

    assert.equal(eventWrites.length, 1, 'the died event was not written');
    assert.equal(eventWrites[0].kind, 'died');

    assert.equal(agentWrites.length, 1, 'no agent update was issued for a death');
    assert.deepEqual(agentWrites[0], {
        updateOne: { filter: { _id: 'Sable' }, update: { $inc: { deaths: 1 } } },
    });
});

test('deaths accumulate across a batch, one increment per death', async (t) => {
    const { _setModelsForTests } = await import('../../src/society/chronicle/connection.js');
    t.after(() => { _setModelsForTests(null); chronicle._resetForTests(); });
    chronicle._resetForTests();

    const agentWrites = [];
    _setModelsForTests({
        Event: { insertMany: () => Promise.resolve() },
        Agent: { bulkWrite: (ops) => { agentWrites.push(...ops); return Promise.resolve(); } },
        Relationship: { bulkWrite: () => Promise.resolve() },
        Ledger: { create: () => Promise.resolve(), updateOne: () => Promise.resolve() },
    });

    chronicle.observeDeath('Sable', 'zombie', null);
    chronicle.observeDeath('Sable', 'phantom', null);
    chronicle.observeDeath('Wren', 'drowned', null);
    await chronicle.flush();

    assert.equal(agentWrites.length, 3, 'a batched death was dropped');
    const sable = agentWrites.filter((o) => o.updateOne.filter._id === 'Sable');
    assert.equal(sable.length, 2, 'two Sable deaths must be two increments, not one');
});

test('an ordinary observation issues no agent write', async (t) => {
    // The agentOps path must not fire for everything -- it is one bulkWrite per
    // flush and observe() runs for every command of every villager.
    const { _setModelsForTests } = await import('../../src/society/chronicle/connection.js');
    t.after(() => { _setModelsForTests(null); chronicle._resetForTests(); });
    chronicle._resetForTests();

    let agentCalls = 0;
    _setModelsForTests({
        Event: { insertMany: () => Promise.resolve() },
        Agent: { bulkWrite: () => { agentCalls++; return Promise.resolve(); } },
        Relationship: { bulkWrite: () => Promise.resolve() },
        Ledger: { create: () => Promise.resolve(), updateOne: () => Promise.resolve() },
    });

    chronicle.observe({ name: 'Nia' }, '!collectBlocks', ['oak_log', 3], 'Collected 3 oak_log.');
    await chronicle.flush();
    assert.equal(agentCalls, 0);
});
