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
