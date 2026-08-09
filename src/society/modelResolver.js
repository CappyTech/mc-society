/**
 * Pick a model LM Studio can actually serve, instead of trusting a hardcoded id.
 *
 * NOTHING IS EVER LOADED BY ASKING FOR IT
 * ---------------------------------------
 * LM Studio JIT-loads a model when someone requests one and evicts it again on
 * a timer, so a request is not merely a question -- it is an instruction to
 * allocate VRAM. This module refuses to give that instruction. Models are
 * loaded deliberately by whoever runs the box; the village chooses from what is
 * already resident and does nothing at all when there is nothing suitable.
 *
 * That is an operations decision, and the evidence for it is on this
 * deployment. Left to load on demand, LM Studio produced an instance with an
 * 8,192-token context against turns that run ~9,500 -- useless, and useless
 * only once a prompt was fully assembled. It evicted resident models to make
 * room for new ones. Capacity became a thing that happened rather than a thing
 * anyone chose, and "how many villagers can think at once" stopped having an
 * answer.
 *
 * So: choose among loaded instances, or decline. A village that plainly cannot
 * think because nobody loaded a model is a five-second diagnosis. A village
 * quietly thrashing a GPU is not.
 *
 * WHY THIS EXISTS
 * ---------------
 * A profile names a model as a literal string, and that string has now been
 * wrong three separate ways in one afternoon:
 *
 *   - `qwen/qwen3.5-9b-Q4_K_M`   -- the quantisation suffix is `@q4_k_m`, not
 *                                   `-Q4_K_M`. Resolved only while a JIT load
 *                                   happened to have that alias resident.
 *   - `qwen/qwen3.5-9b-Q4_K_M:2` -- a second instance nobody had loaded. Four
 *                                   villagers 400'd on every single turn.
 *   - `qwen/qwen3.5-9b`          -- a different catalogue entry from the
 *                                   quantised one that is actually loaded.
 *
 * Every one of those failed the same way: the villager connects, appears in the
 * player list, looks healthy by every ordinary measure, and silently takes zero
 * turns. The whole village sat dead for eighteen hours on the second of them.
 * That is the most expensive failure shape this project has, and it is caused
 * by a string in a config file rather than by anything anyone can see in game.
 *
 * So the id in a profile becomes a PREFERENCE rather than an instruction. At
 * startup we ask LM Studio what it actually has, and reconcile.
 *
 * WHAT IT WILL AND WILL NOT DO
 * ----------------------------
 * It will correct a name to a LOADED instance of the same model, and spread
 * villagers across several such instances. It will not do anything else:
 *
 *  - It will not move a villager onto a different model family. The whole
 *    tool-calling design is tuned to one reasoning model's behaviour (see
 *    docs/reasoning-model.md), so swapping Qwen for Gemma would change how
 *    every villager behaves while looking like a config that worked.
 *  - It will not name a model that is not resident, because naming one is what
 *    loads it.
 *
 * Both cases return null and log why. A village that obviously cannot think is
 * better than one that is subtly different, or one quietly eating a GPU.
 */

/**
 * Context a chat model needs to be worth choosing. A villager's turn runs about
 * 9,500 tokens, so anything under this refuses them only once the prompt is
 * fully assembled -- the worst possible moment to find out.
 */
const MIN_CONTEXT = 12000;
/**
 * Embedding models are sized for a sentence, not a turn: the one in use here
 * has a 2,048 maximum and is entirely correct at it. Judging it by the chat
 * threshold would rule out every embedding model that exists.
 */
export const MIN_EMBED_CONTEXT = 512;
const PROBE_TIMEOUT_MS = 4000;

let cache = null;

/**
 * Strip instance and quantisation markers: `qwen/qwen3.5-9b@q4_k_m:2` and
 * `qwen/qwen3.5-9b-Q4_K_M:2` both reduce to `qwen/qwen3.5-9b`.
 *
 * The trailing `-q4_k_m` form has to be stripped too, and that is the whole
 * point rather than a nicety -- the id we were actually misconfigured with
 * wrote the quantisation with a hyphen. Matching only `@` would leave the one
 * case this module exists to fix looking like a different model family, and it
 * would decline to correct it.
 */
const QUANT_SUFFIX = /-(q\d+(_[a-z0-9]+)*|f16|bf16|fp16|fp8|int[48])$/i;

export function baseName(id) {
    const bare = String(id ?? '').split('@')[0].split(':')[0].toLowerCase();
    return bare.replace(QUANT_SUFFIX, '');
}

/**
 * Spread villagers across instances by name.
 *
 * Each LM Studio instance has its own KV pool and a turn is ~9,500 tokens, so
 * about two villagers fit per pool. This is the automatic version of
 * hand-pinning half the roster to a second instance -- and it is a hash rather
 * than a counter so that a villager lands on the same instance across restarts,
 * where a counter would reshuffle everyone and throw away KV locality.
 */
function pick(candidates, preferred, who, note = '') {
    const sorted = candidates.map((m) => m.id).sort();
    let h = 0;
    for (const ch of String(who)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const chosen = sorted[h % sorted.length];
    return {
        model: chosen,
        available: true,
        reason: preferred === chosen
            ? 'as configured'
            : `"${preferred}" is not loaded; using "${chosen}"${note}`,
    };
}

/**
 * Choose a model. PURE, so the policy is testable without a server.
 *
 * @param {string} preferred the id written in the profile
 * @param {object[]} models rows from /api/v0/models
 * @param {string} who the villager, used only to spread load deterministically
 * @returns {{model: string, reason: string}}
 */
export function chooseModel(preferred, models, who = '', minContext = MIN_CONTEXT) {
    const rows = (Array.isArray(models) ? models : []).filter((m) => m?.id);
    const isLoaded = (m) => m.state && m.state !== 'not-loaded';

    const bigEnough = (m) => (m.loaded_context_length ?? 0) >= minContext;

    // Exactly what was asked for, resident, and big enough. The common case,
    // and the only one where nothing needs saying.
    //
    // The size check applies here too, deliberately. Being named correctly does
    // not make a model able to serve a turn: an instance loaded at 8,192 under
    // exactly the configured id would be accepted and then refuse every prompt
    // once assembled, which is the failure this whole module exists to make
    // loud rather than silent.
    if (rows.some((m) => m.id === preferred && isLoaded(m) && bigEnough(m))) {
        return { model: preferred, available: true, reason: 'as configured' };
    }

    // Resident instances of the same model, big enough to hold a turn. The
    // loaded context is the real limit -- an unloaded model's maximum describes
    // what it COULD have, and we are never going to be the thing that loads it.
    //
    // A turn runs about 9,500 tokens, so an 8,192-context instance cannot serve
    // one at all, and fails only once the prompt is fully assembled. Better to
    // treat it as absent than to hand villagers a model that will refuse them.
    const family = rows.filter((m) => isLoaded(m)
        && baseName(m.id) === baseName(preferred)
        && bigEnough(m));

    if (family.length) return pick(family, preferred, who);

    // Nothing suitable is resident. Decline, rather than naming something that
    // would cause a load -- and say what IS there, because the fix is one
    // deliberate `lms load` on the inference box.
    const up = rows.filter(isLoaded).map((m) => `${m.id} (${m.loaded_context_length ?? '?'})`);
    return {
        model: null,
        available: false,
        reason: `no loaded instance of "${baseName(preferred)}" with at least ${minContext} context. `
              + `Loaded: ${up.join(', ') || 'nothing'}. Load one on the inference host; `
              + `nothing here will load it for you.`,
    };
}

/**
 * Ask LM Studio what is resident and choose from it, once per process.
 *
 * @returns {Promise<string|null>} the id to send, or null to send nothing.
 *   Null is a real answer, not an error: it means no suitable model is loaded,
 *   and the correct response is to take no turn rather than to cause a load.
 */
export async function resolveModel(preferred, who = '', { baseUrl, apiKey, minContext = MIN_CONTEXT } = {}) {
    if (!preferred) return preferred;
    if (cache?.preferred === preferred && cache?.who === who) return cache.model;

    const url = (baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1')
        .replace(/\/v1\/?$/, '') + '/api/v0/models';

    let models = [];
    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey || process.env.LMSTUDIO_API_KEY || 'lm-studio'}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.ok) models = (await res.json())?.data ?? [];
    } catch {
        // An unreachable inference server is its own, very visible failure, and
        // nothing can be resident on a host we cannot reach. Decline rather
        // than guess.
        console.warn(`[model] ${who || 'agent'}: cannot reach LM Studio to see what is loaded`);
        return null;
    }

    const { model, reason } = chooseModel(preferred, models, who, minContext);
    if (reason !== 'as configured') console.warn(`[model] ${who || 'agent'}: ${reason}`);
    cache = { preferred, who, model };
    return model;
}

/** Test seam. */
export function _resetForTests() { cache = null; }
