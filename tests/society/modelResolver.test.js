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

import { chooseModel, baseName, roleOf, MIN_EMBED_CONTEXT, ROLE } from '../../src/society/modelResolver.js';

const loaded = (id, ctx = 25600, extra = {}) =>
    ({ id, state: 'loaded', loaded_context_length: ctx, max_context_length: 262144, ...extra });
const notLoaded = (id, max = 262144, extra = {}) =>
    ({ id, state: 'not-loaded', loaded_context_length: null, max_context_length: max, ...extra });
/** A chat row that declares its architecture, as /api/v0/models really does. */
const chatRow = (id, arch, ctx = 25600) =>
    loaded(id, ctx, { type: 'vlm', arch, capabilities: ['tool_use'] });
const embedRow = (id = 'text-embedding-nomic-embed-text-v1.5', ctx = 2048) =>
    loaded(id, ctx, { type: 'embeddings', arch: 'nomic-bert' });

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
    // The embedder-only fixture is the real shape of the 2026-08-09 outage:
    // something WAS resident, just nothing that could serve a turn. A bare list
    // of ids hides that, so the role is printed too.
    const r = chooseModel('qwen/qwen3.5-9b', [embedRow()], 'Bram');
    assert.equal(r.model, null);
    assert.match(r.reason, /text-embedding-nomic-embed-text-v1\.5/);
    assert.match(r.reason, /embed/, 'the KIND of what is loaded is not reported');
    assert.match(r.reason, /2048/, 'the context of what is loaded is not reported');
});

test('THE 16-HOUR TEST: a loaded sibling is used instead of nothing', () => {
    // The exact live catalogue of 2026-08-09, when every profile asked for
    // qwen3.5-9b and only andy-4.2 was resident. Both are arch `qwen35`. The
    // old policy was "same model family or nothing" and it chose nothing --
    // every turn, for sixteen hours, while eight villagers stayed connected,
    // burned 31% of a CPU on reflexes and died ninety times.
    const rows = [
        chatRow('andy-4.2', 'qwen35', 42752),
        embedRow(),
        notLoaded('google/gemma-4-e4b', 131072, { type: 'vlm', arch: 'gemma4' }),
        notLoaded('qwen/qwen3.5-9b', 262144, { type: 'vlm', arch: 'qwen35' }),
    ];
    const r = chooseModel('qwen/qwen3.5-9b@q4_k_m', rows, 'Bram', { role: ROLE.CHAT });
    assert.equal(r.model, 'andy-4.2');
    assert.equal(r.available, true);
    assert.match(r.reason, /same architecture/);
});

test('a different ARCHITECTURE loses to one that matches', () => {
    // The replacement for the old same-family rule. What docs/reasoning-model.md
    // tunes against is an architecture's behaviour under forced tool calls, and
    // `arch` is what the API actually reports -- so a qwen35 sibling is
    // preferred over a bigger, more capable Gemma.
    const rows = [
        chatRow('google/gemma-4-e4b', 'gemma4', 40704),
        chatRow('andy-4.2', 'qwen35', 16000),
        notLoaded('qwen/qwen3.5-9b', 262144, { type: 'vlm', arch: 'qwen35' }),
    ];
    assert.equal(chooseModel('qwen/qwen3.5-9b', rows, 'Bram').model, 'andy-4.2');
});

test('substitution can be switched off, restoring decline-or-nothing', () => {
    // The escape hatch (MODEL_SUBSTITUTE=0), for when a surprising substitute is
    // worse than an obviously dead village.
    const rows = [chatRow('andy-4.2', 'qwen35', 42752)];
    const r = chooseModel('qwen/qwen3.5-9b', rows, 'Bram', { substitute: false });
    assert.equal(r.model, null);
    assert.equal(r.available, false);
});

test('a substitute must still be RESIDENT -- the rule outranks it', () => {
    // THE RULE is absolute; substitution is only a ranking among loaded rows.
    // A perfect architecture match that is merely downloaded is still not a
    // candidate, because naming it is what loads it.
    const rows = [notLoaded('andy-4.2', 262144, { type: 'vlm', arch: 'qwen35' })];
    assert.equal(chooseModel('qwen/qwen3.5-9b', rows, 'Bram').model, null);
});

test('a chat turn is never handed an embedding model', () => {
    // Size alone would have caught this one (2,048 < 12,000), but role is the
    // actual constraint and must not depend on that coincidence.
    const rows = [embedRow('text-embedding-huge', 40000)];
    assert.equal(chooseModel('qwen/qwen3.5-9b', rows, 'Bram', { role: ROLE.CHAT }).model, null);
});

test('an embedding request is never handed a chat model', () => {
    // And this is the direction size does NOT catch: a 512 floor happily admits
    // a 42,752-context reasoning model, which would then be asked for sentence
    // vectors.
    const rows = [chatRow('andy-4.2', 'qwen35', 42752)];
    const r = chooseModel('some-missing-embedder', rows, 'Bram',
        { role: ROLE.EMBED, minContext: MIN_EMBED_CONTEXT });
    assert.equal(r.model, null);
});

test('a row with no type is classified by its id', () => {
    // LM Studio's OpenAI-compatible /v1/models omits `type`. Guessing "chat" for
    // an unknown row is the safe direction -- minContext still protects a turn.
    assert.equal(roleOf({ id: 'text-embedding-nomic-embed-text-v1.5' }), ROLE.EMBED);
    assert.equal(roleOf({ id: 'andy-4.2' }), ROLE.CHAT);
    // vlm counts as chat, and that is load-bearing: the only chat model resident
    // on this deployment reports type 'vlm'.
    assert.equal(roleOf({ id: 'andy-4.2', type: 'vlm' }), ROLE.CHAT);
    assert.equal(roleOf({ id: 'x', type: 'embeddings' }), ROLE.EMBED);
});

test('a family without tool_use loses to one that has it', () => {
    // Every villager turn is a MANDATORY tool call, so a model without tool_use
    // fails 100% of turns rather than degrading.
    const rows = [
        loaded('big-no-tools', 60000, { type: 'llm', arch: 'qwen35', capabilities: ['vision'] }),
        loaded('small-tools', 16000, { type: 'llm', arch: 'qwen35', capabilities: ['tool_use'] }),
    ];
    assert.equal(chooseModel('qwen/qwen3.5-9b', rows, 'Bram').model, 'small-tools');
});

test('substitutes still split across instances, and stay put', () => {
    // pick() must survive substitution: two loaded instances are two KV pools,
    // and ranking individual rows rather than families would have put all eight
    // villagers in one of them.
    const rows = [chatRow('andy-4.2', 'qwen35'), chatRow('andy-4.2:2', 'qwen35')];
    const peers = ['Bram', 'Nia', 'Corin', 'Wren', 'Odile', 'Tobias', 'Sable', 'Ivo'];
    const picks = peers.map((n) => chooseModel('qwen/qwen3.5-9b', rows, n, { peers }).model);
    const counts = {};
    for (const p of picks) counts[p] = (counts[p] ?? 0) + 1;
    assert.deepEqual(Object.values(counts).sort(), [4, 4], JSON.stringify(counts));
    assert.equal(chooseModel('qwen/qwen3.5-9b', rows, 'Bram', { peers }).model, picks[0]);
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
    const r = chooseModel('text-embedding-nomic-embed-text-v1.5', rows, 'Bram', { minContext: MIN_EMBED_CONTEXT, role: ROLE.EMBED });
    assert.equal(r.model, 'text-embedding-nomic-embed-text-v1.5');
    assert.equal(r.available, true);
});

test('villagers split EVENLY across the instances that are up', () => {
    // Each instance has its own KV pool and a turn is ~9,500 tokens, so about
    // two villagers fit per pool. With eight of them an even split is the
    // difference between five contending for one pool and four in each.
    //
    // Measured against the real roster: hashing the names gave 5/3, quietly
    // wasting a third of the capacity somebody had deliberately loaded. Seat
    // position round-robins exactly.
    const models = [loaded('qwen/qwen3.5-9b@q4_k_m'), loaded('qwen/qwen3.5-9b@q4_k_m:2')];
    const peers = ['Bram', 'Nia', 'Corin', 'Wren', 'Odile', 'Tobias', 'Sable', 'Ivo'];
    const picks = peers.map((n) => chooseModel('qwen/qwen3.5-9b', models, n, { peers }).model);

    const perInstance = {};
    for (const p of picks) perInstance[p] = (perInstance[p] ?? 0) + 1;
    assert.deepEqual(Object.values(perInstance).sort(), [4, 4], `split was ${JSON.stringify(perInstance)}`);

    // Deterministic, so a villager does not hop between instances on a restart
    // and throw away the KV cache their prompt prefix had warmed.
    assert.equal(chooseModel('qwen/qwen3.5-9b', models, 'Bram', { peers }).model, picks[0]);
});

test('three instances divide eight villagers as evenly as eight divides', () => {
    const models = [loaded('m@1'), loaded('m@2'), loaded('m@3')];
    const peers = ['Bram', 'Nia', 'Corin', 'Wren', 'Odile', 'Tobias', 'Sable', 'Ivo'];
    const counts = {};
    for (const n of peers) {
        const id = chooseModel('m', models, n, { peers }).model;
        counts[id] = (counts[id] ?? 0) + 1;
    }
    assert.deepEqual(Object.values(counts).sort(), [2, 3, 3], JSON.stringify(counts));
});

test('a name outside the roster still lands somewhere, and stays there', () => {
    // Stability matters more than balance for a stray name: a villager who
    // moves between instances on a restart throws away KV locality.
    const models = [loaded('m@1'), loaded('m@2')];
    const a = chooseModel('m', models, 'Stranger', { peers: ['Bram', 'Nia'] }).model;
    const b = chooseModel('m', models, 'Stranger', { peers: ['Bram', 'Nia'] }).model;
    assert.equal(a, b);
    assert.ok(['m@1', 'm@2'].includes(a));
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
