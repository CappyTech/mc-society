/**
 * Reconciling the model id in a profile against what is actually loaded.
 *
 * Every case here is one that really happened, in one afternoon:
 *
 *   qwen/qwen3.5-9b-Q4_K_M    the quantisation suffix is @q4_k_m, not -Q4_K_M
 *   qwen/qwen3.5-9b-Q4_K_M:2  a second instance nobody had loaded
 *   qwen/qwen3.5-9b           a sibling catalogue entry, not the loaded one
 *
 * All three failed identically and invisibly: the villagers connected, appeared
 * in the player list, and took zero turns. The village sat dead for eighteen
 * hours on one of them. Nothing in game shows you a bad model string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseModel, baseName } from '../../src/society/modelResolver.js';

const loaded = (id, ctx = 25600) => ({ id, state: 'loaded', loaded_context_length: ctx });
const notLoaded = (id) => ({ id, state: 'not-loaded', loaded_context_length: null });

test('a name that is loaded is used unchanged', () => {
    const r = chooseModel('qwen/qwen3.5-9b@q4_k_m', [loaded('qwen/qwen3.5-9b@q4_k_m')], 'Bram');
    assert.equal(r.model, 'qwen/qwen3.5-9b@q4_k_m');
    assert.equal(r.reason, 'as configured');
});

test('a wrong quantisation suffix is corrected to the loaded instance', () => {
    // The real bug: `-Q4_K_M` where LM Studio wants `@q4_k_m`.
    const r = chooseModel('qwen/qwen3.5-9b-Q4_K_M', [
        loaded('qwen/qwen3.5-9b@q4_k_m'),
        notLoaded('qwen/qwen3.5-9b'),
    ], 'Bram');
    assert.equal(r.model, 'qwen/qwen3.5-9b@q4_k_m');
    assert.match(r.reason, /not loaded/i);
});

test('a second instance nobody loaded falls back to the one that exists', () => {
    // This one silenced four villagers on every turn for eighteen hours.
    const r = chooseModel('qwen/qwen3.5-9b-Q4_K_M:2', [loaded('qwen/qwen3.5-9b@q4_k_m')], 'Nia');
    assert.equal(r.model, 'qwen/qwen3.5-9b@q4_k_m');
});

test('villagers spread across the instances that do exist', () => {
    // Each LM Studio instance has its own KV pool and a turn is ~9,500 tokens,
    // so about two villagers fit per pool. This is the automatic version of
    // hand-pinning half the roster to a second instance.
    const models = [loaded('qwen/qwen3.5-9b@q4_k_m'), loaded('qwen/qwen3.5-9b@q4_k_m:2')];
    const picks = ['Bram', 'Nia', 'Corin', 'Wren', 'Odile', 'Tobias', 'Sable', 'Ivo']
        .map((n) => chooseModel('qwen/qwen3.5-9b', models, n).model);
    assert.equal(new Set(picks).size, 2, 'everyone landed on one instance');
    // Deterministic: the same villager must not hop between instances on a
    // restart, or memory and KV cache locality are both wasted.
    assert.equal(chooseModel('qwen/qwen3.5-9b', models, 'Bram').model, picks[0]);
});

test('an instance too small to hold a turn is not used', () => {
    // gemma-4-e4b:2 was loaded at 8,192 while a turn runs ~9,500. That fails
    // only once the prompt is fully assembled, which is the worst moment.
    const r = chooseModel('gemma/x', [loaded('gemma/x@q4', 8192)], 'Bram');
    assert.notEqual(r.model, 'gemma/x@q4');
    assert.match(r.reason, /NOT LOADED/);
});

test('a different model family is never substituted silently', () => {
    // The tool-calling design is tuned to one reasoning model's behaviour.
    // Swapping Qwen for Gemma would change how every villager behaves while
    // looking like a config that worked. Better obviously broken than subtly
    // different.
    const r = chooseModel('qwen/qwen3.5-9b', [loaded('google/gemma-4-e4b', 40704)], 'Bram');
    assert.equal(r.model, 'qwen/qwen3.5-9b');
    assert.match(r.reason, /NOT LOADED/);
    assert.match(r.reason, /google\/gemma-4-e4b/, 'the operator is not told what IS available');
});

test('nothing loaded at all keeps the configured name and says so', () => {
    const r = chooseModel('qwen/qwen3.5-9b', [notLoaded('qwen/qwen3.5-9b')], 'Bram');
    assert.equal(r.model, 'qwen/qwen3.5-9b');
    assert.match(r.reason, /loaded: none/);
});

test('a malformed or missing model list changes nothing', () => {
    // The probe runs at startup against a server that may be down. It must not
    // turn one visible problem into two.
    for (const bad of [null, undefined, [], 'nonsense', [{}], [{ id: null }]]) {
        const r = chooseModel('qwen/qwen3.5-9b', bad, 'Bram');
        assert.equal(r.model, 'qwen/qwen3.5-9b');
    }
});

test('base names ignore quantisation and instance suffixes, in either spelling', () => {
    // Both spellings must reduce to the same family, and the hyphenated one is
    // the whole point: that is the id we were actually misconfigured with. If
    // only `@` were stripped, the one case this module exists to fix would look
    // like a different model family and be left alone.
    assert.equal(baseName('qwen/qwen3.5-9b@q4_k_m:2'), 'qwen/qwen3.5-9b');
    assert.equal(baseName('qwen/qwen3.5-9b-Q4_K_M'), 'qwen/qwen3.5-9b');
    assert.equal(baseName('qwen/qwen3.5-9b-Q4_K_M:2'), 'qwen/qwen3.5-9b');
    assert.equal(baseName('qwen/qwen3.5-9b'), 'qwen/qwen3.5-9b');
    // A version number is not a quantisation and must survive.
    assert.equal(baseName('google/gemma-4-e4b'), 'google/gemma-4-e4b');
    assert.equal(baseName(null), '');
});
