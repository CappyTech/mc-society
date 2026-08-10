/**
 * What the turn loop does when there is nothing to think with.
 *
 * Two behaviours cost sixteen hours of village time on 2026-08-09, and neither
 * had a test because prompter.js and self_prompter.js had no tests at all:
 *
 *   1. promptConvo could not distinguish "no model is loaded" from "the model had
 *      nothing to add" -- both surfaced as an empty string. (Its three-attempt
 *      loop was never the problem: an empty generation returns immediately, and
 *      only thrown errors and hallucinated turns are retried.)
 *   2. self_prompter counted each of those as "the agent did not use a command"
 *      and STOPPED THE LOOP PERMANENTLY at three. So loading a model would not
 *      have revived the village -- every villager's driver was already dead and
 *      only a container restart could start it again.
 *
 * Both are about the difference between "this attempt failed" and "attempting is
 * currently pointless", which is what society/cognition.js exists to express.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NO_MODEL } from '../../src/society/memoryGuard.js';
import * as cognition from '../../src/society/cognition.js';

/**
 * A chat model with no model loaded -- the live 2026-08-09 condition. Counts how
 * many times it is asked, which is the whole point of the first test.
 */
function deadModel() {
    const m = {
        calls: 0,
        sendToolRequest() {
            m.calls++;
            return Promise.resolve({ tool_calls: [], text: '', usage: null, error: NO_MODEL, terminal: true });
        },
    };
    return m;
}

async function prompterWith(chat_model) {
    const { Prompter } = await import('../../src/models/prompter.js');
    const p = Object.create(Prompter.prototype);
    p.chat_model = chat_model;
    p.agent = { name: 'Testling', history: { getHistory: () => [] } };
    p.profile = { conversing: 'system prompt', society: { role: 'miner' } };
    p.convo_examples = null;
    p.checkCooldown = () => Promise.resolve();
    p.replaceStrings = (s) => Promise.resolve(s);
    p._saveLog = () => Promise.resolve();
    p._society_tools = [{ type: 'function', function: { name: 'stay', parameters: {} } }];
    return p;
}

test('a turn with no model declines cleanly, asking exactly once', async (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();

    const model = deadModel();
    const p = await prompterWith(model);
    const out = await p.promptConvo([{ role: 'user', content: 'hello' }]);

    assert.equal(out, '', 'a turn with no model must produce nothing');
    assert.equal(model.calls, 1,
        `asked ${model.calls} times for something only an operator can fix`);
});

test('a terminal failure marks cognition unavailable', async (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();

    const p = await prompterWith(deadModel());
    await p.promptConvo([{ role: 'user', content: 'hello' }]);

    assert.equal(cognition.available(), false);
    assert.match(cognition.lastReason(), /No suitable model/);
});

test('a TRANSIENT failure does not look like an outage', async (t) => {
    // Both kinds cost one request -- promptConvo's three attempts are consumed
    // only by thrown errors and hallucinated turns, not by an empty generation,
    // which returns immediately. So the difference between transient and
    // terminal is NOT the request count; it is whether the self-prompt loop
    // treats this as "try again shortly" or "wait for an operator".
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();

    const model = {
        calls: 0,
        sendToolRequest() {
            model.calls++;
            return Promise.resolve({ tool_calls: [], text: '', usage: null, error: 'socket hang up', terminal: false });
        },
    };
    const p = await prompterWith(model);
    const out = await p.promptConvo([{ role: 'user', content: 'hello' }]);
    assert.equal(out, '');
    assert.equal(model.calls, 1);
    assert.equal(cognition.available(), true, 'a socket error must not suppress the whole village');
});

test('the self-prompt loop survives an outage instead of stopping for ever', async (t) => {
    // THE PERMANENT-STOP BUG. MAX_NO_COMMAND is 3, so three failed turns used to
    // set state = STOPPED and break -- unrecoverable without a container restart,
    // and reached within milliseconds because the failure path had no sleep.
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTerminal(NO_MODEL);

    const { SelfPrompter } = await import('../../src/agent/self_prompter.js');
    let asked = 0;
    const agent = {
        handleMessage: () => { asked++; return Promise.resolve(false); },   // never uses a command
        openChat: () => {},
    };
    const sp = new SelfPrompter(agent);
    sp.prompt = 'keep the fields planted';
    sp.cooldown = 0;
    sp.state = 1;                       // ACTIVE, as start() would leave it

    // Let it spin briefly. It should be asleep in its backoff, not stopped.
    // (This test takes a few seconds because that backoff is real -- the
    // alternative is a fake timer for a five-line assertion.)
    const loop = sp.startLoop();
    await new Promise((r) => setTimeout(r, 120));

    assert.notEqual(sp.state, 0, 'the loop STOPPED during an outage and cannot restart itself');
    // And it backed off rather than hammering: without cognition it waits
    // seconds, so a 120ms window admits at most a couple of attempts. The old
    // code had no sleep at all on this path and reached its limit immediately.
    assert.ok(asked <= 2, `hot-looped ${asked} times in 120ms`);

    sp.interrupt = true;
    await loop;
});

test('with cognition available, the give-up threshold still works', async (t) => {
    // The threshold is not removed -- a model that answers but never uses a
    // command is a real condition worth giving up on, and always was.
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();

    const { SelfPrompter } = await import('../../src/agent/self_prompter.js');
    let asked = 0;
    const agent = {
        handleMessage: () => { asked++; return Promise.resolve(false); },
        openChat: () => {},
    };
    const sp = new SelfPrompter(agent);
    sp.prompt = 'keep the fields planted';
    sp.cooldown = 0;
    sp.state = 1;

    await sp.startLoop();
    assert.equal(sp.state, 0, 'a model that answers without commands should stop the loop');
    assert.equal(asked, 3, `gave up after ${asked} attempts, expected MAX_NO_COMMAND (3)`);
});
