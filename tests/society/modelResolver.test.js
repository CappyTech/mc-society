/**
 * Choosing a model from what is loaded, and never causing a load.
 *
 * THE RULE. A request to LM Studio is not a question, it is an instruction to
 * allocate VRAM: asking for a model that is not resident makes it load one, at
 * whatever context it feels like, evicting whatever was there. So the village
 * chooses among loaded instances and otherwise takes no turn at all.
 *
 * The evidence is from this deployment. Left to load on demand, LM Studio
 * produced an instance with an 8,192-token context against turns that run
 * ~9,500 -- useless, and useless only once a prompt was fully assembled -- and
 * evicted resident models to make room for new ones.
 *
 * The ids below were each wrong in a different way on one afternoon, and all
 * failed identically and invisibly: the villagers connected, appeared in the
 * player list, and took zero turns. The village sat dead for eighteen hours on
 * one of them. Nothing in game shows you a bad model string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseModel, baseName, MIN_EMBED_CONTEXT } from '../../src/society/modelResolver.js';

const loaded = (id, ctx = 25600) =>
    ({ id, state: 'loaded', loaded_context_length: ctx, max_context_length: 262144 });
const notLoaded = (id, max = 262144) =>
    ({ id, state: 'not-loaded', loaded_context_length: null, max_context_length: max });

test('a model that is loaded is used unchanged', () => {
    const r = chooseModel('qwen/qwen3.5-9b@q4_k_m', [loaded('qwen/qwen3.5-9b@q4_k_m')], 'Bram');
    assert.equal(r.model, 'qwen/qwen3.5-9b@q4_k_m');
    assert.equal(r.available, true);
    assert.equal(r.reason, 'as configured');
});

test('a wrong quantisation suffix is corrected to the loaded instance', () => {
    // `-Q4_K_M` where LM Studio spells it `@q4_k_m`. Correcting this is the
    // whole reason the module exists.
    const r = chooseModel('qwen/qwen3.5-9b-Q4_K_M', [
        loaded('qwen/qwen3.5-9b@q4_k_m'),
        notLoaded('qwen/qwen3.5-9b'),
    ], 'Bram');
    assert.equal(r.model, 'qwen/qwen3.5-9b@q4_k_m');
    assert.equal(r.available, true);
});

test('a second instance nobody loaded falls back to the one that is up', () => {
    // This silenced four villagers on every turn for eighteen hours.
    const r = chooseModel('qwen/qwen3.5-9b-Q4_K_M:2', [loaded('qwen/qwen3.5-9b@q4_k_m')], 'Nia');
    assert.equal(r.model, 'qwen/qwen3.5-9b@q4_k_m');
});

test('a model that is merely downloaded is never chosen', () => {
    // THE RULE. Naming it is what loads it, so a catalogue entry that is not
    // resident is not a candidate -- however perfect a match it looks.
    const r = chooseModel('qwen/qwen3.5-9b@q4_k_m', [notLoaded('qwen/qwen3.5-9b@q4_k_m')], 'Bram');
    assert.equal(r.model, null);
    assert.equal(r.available, false);
    assert.match(r.reason, /nothing here will load it for you/);
});

test('nothing loaded at all means no model, not a guess', () => {
    // The village takes no turn. That is a five-second diagnosis and one
    // deliberate load to fix, where a guess would start a GPU allocation
    // nobody asked for.
    for (const rows of [[], [notLoaded('qwen/qwen3.5-9b')], null, undefined, 'nonsense']) {
        const r = chooseModel('qwen/qwen3.5-9b', rows, 'Bram');
        assert.equal(r.model, null);
        assert.equal(r.available, false);
    }
});

test('the operator is told what IS loaded, since that is the fix', () => {
    const r = chooseModel('qwen/qwen3.5-9b', [loaded('google/gemma-4-e4b', 40704)], 'Bram');
    assert.equal(r.model, null);
    assert.match(r.reason, /google\/gemma-4-e4b/);
    assert.match(r.reason, /40704/, 'the context of what is loaded is not reported');
});

test('a different model family is never substituted', () => {
    // The tool-calling design is tuned to one reasoning model's behaviour, so
    // swapping Qwen for Gemma would change how every villager behaves while
    // looking like a config that worked. Obviously broken beats subtly
    // different.
    assert.equal(chooseModel('qwen/qwen3.5-9b', [loaded('google/gemma-4-e4b', 40704)], 'Bram').model, null);
});

test('an instance too small to hold a turn is treated as absent', () => {
    // gemma-4-e4b:2 was loaded at 8,192 while a turn runs ~9,500. Handing a
    // villager that model fails only once the prompt is fully assembled.
    const r = chooseModel('gemma/x', [loaded('gemma/x@q4', 8192)], 'Bram');
    assert.equal(r.model, null);
    assert.match(r.reason, /at least 12000 context/);
});

test('embedding models are judged by their own scale', () => {
    // The embedding model in use has a 2,048 maximum and is entirely correct at
    // it. Judging it by the chat threshold would rule out every embedding model
    // in existence, and quietly disable examples for ever.
    const rows = [loaded('text-embedding-nomic-embed-text-v1.5', 2048)];
    assert.equal(chooseModel('text-embedding-nomic-embed-text-v1.5', rows, 'Bram').model, null);
    const r = chooseModel('text-embedding-nomic-embed-text-v1.5', rows, 'Bram', MIN_EMBED_CONTEXT);
    assert.equal(r.model, 'text-embedding-nomic-embed-text-v1.5');
    assert.equal(r.available, true);
});

test('villagers spread across the instances that are up', () => {
    // Each instance has its own KV pool and a turn is ~9,500 tokens, so about
    // two villagers fit per pool. This is the automatic version of hand-pinning
    // half the roster to a second instance.
    const models = [loaded('qwen/qwen3.5-9b@q4_k_m'), loaded('qwen/qwen3.5-9b@q4_k_m:2')];
    const picks = ['Bram', 'Nia', 'Corin', 'Wren', 'Odile', 'Tobias', 'Sable', 'Ivo']
        .map((n) => chooseModel('qwen/qwen3.5-9b', models, n).model);
    assert.equal(new Set(picks).size, 2, 'everyone landed on one instance');
    // Deterministic, so a villager does not hop between instances on a restart
    // and throw away KV locality.
    assert.equal(chooseModel('qwen/qwen3.5-9b', models, 'Bram').model, picks[0]);
});

test('a half-loaded instance is not counted as up', () => {
    // LM Studio reports intermediate states. Only a model with a real loaded
    // context can serve a turn.
    const r = chooseModel('qwen/qwen3.5-9b', [
        { id: 'qwen/qwen3.5-9b@q4_k_m', state: 'loading', loaded_context_length: null },
    ], 'Bram');
    assert.equal(r.model, null);
});

test('base names ignore quantisation and instance suffixes, in either spelling', () => {
    // Both spellings must reduce to the same family, and the hyphenated one is
    // the point: it is the id we were actually misconfigured with. If only `@`
    // were stripped, the one case this module exists to fix would look like a
    // different family and be left alone.
    assert.equal(baseName('qwen/qwen3.5-9b@q4_k_m:2'), 'qwen/qwen3.5-9b');
    assert.equal(baseName('qwen/qwen3.5-9b-Q4_K_M'), 'qwen/qwen3.5-9b');
    assert.equal(baseName('qwen/qwen3.5-9b-Q4_K_M:2'), 'qwen/qwen3.5-9b');
    // A version number is not a quantisation and must survive.
    assert.equal(baseName('google/gemma-4-e4b'), 'google/gemma-4-e4b');
    assert.equal(baseName(null), '');
});

test('a choice is re-made against reality, not held for ever', async () => {
    // THE BUG THIS EXISTS FOR. Caching the decision meant three villagers
    // resolved to an instance at startup, LM Studio evicted it minutes later,
    // and they went on requesting it by name for the lifetime of the process --
    // recreating it every turn. The village was still creating models rather
    // than using them, just more slowly, and logging that it was not.
    //
    // The list is cached briefly; the decision never is.
    const { resolveModel, _resetForTests } = await import('../../src/society/modelResolver.js');

    let serving = [loaded('qwen/qwen3.5-9b@q4_k_m'), loaded('qwen/qwen3.5-9b')];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: serving }) });

    try {
        _resetForTests();
        const first = await resolveModel('qwen/qwen3.5-9b', 'Corin');
        assert.ok(first, 'should resolve while two instances are up');

        // LM Studio evicts one. The villager must not keep naming it.
        serving = [loaded('qwen/qwen3.5-9b')];
        _resetForTests();                       // stand in for the list TTL expiring
        const second = await resolveModel('qwen/qwen3.5-9b', 'Corin');
        assert.equal(second, 'qwen/qwen3.5-9b');

        // And everything evicted means no model at all, not the last known one.
        serving = [notLoaded('qwen/qwen3.5-9b')];
        _resetForTests();
        assert.equal(await resolveModel('qwen/qwen3.5-9b', 'Corin'), null);
    } finally {
        globalThis.fetch = originalFetch;
        _resetForTests();
    }
});

test('an unreachable server declines rather than reusing a stale list', async () => {
    // A stale list would name a model that may since have been evicted, which
    // is the same failure by a slower route.
    const { resolveModel, _resetForTests } = await import('../../src/society/modelResolver.js');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    try {
        _resetForTests();
        assert.equal(await resolveModel('qwen/qwen3.5-9b', 'Bram'), null);
    } finally {
        globalThis.fetch = originalFetch;
        _resetForTests();
    }
});
