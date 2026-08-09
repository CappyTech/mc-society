/**
 * Pick a model that is actually loaded, instead of trusting a hardcoded id.
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
 * It will correct a name to a loaded instance of the same model, and spread
 * villagers across multiple instances of it. It will NOT quietly move a
 * villager onto a different model family: the whole tool-calling design here is
 * tuned to one reasoning model's behaviour (see docs/reasoning-model.md), and
 * silently swapping Qwen for Gemma would change how every villager behaves
 * while looking like a config that worked. That case is logged loudly and left
 * alone, because a village that is obviously broken is better than one that is
 * subtly different.
 */

const MIN_CONTEXT = 12000;
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
 * Choose from what is loaded. PURE, so the policy is testable without a server.
 *
 * @param {string} preferred the id written in the profile
 * @param {object[]} models rows from /api/v0/models
 * @param {string} who the villager, used only to spread load deterministically
 * @returns {{model: string, reason: string}}
 */
export function chooseModel(preferred, models, who = '') {
    const rows = Array.isArray(models) ? models : [];
    const loaded = rows.filter((m) => m?.state && m.state !== 'not-loaded');

    // Exactly what was asked for, and it is up. The overwhelmingly common case.
    if (loaded.some((m) => m.id === preferred)) {
        return { model: preferred, reason: 'as configured' };
    }

    // Instances of the same model, big enough to hold a turn. A turn runs about
    // 9,500 tokens, so an 8,192-context instance cannot serve one at all -- it
    // is worse than useless, because it fails only once the prompt is fully
    // assembled.
    const family = loaded.filter((m) =>
        baseName(m.id) === baseName(preferred) &&
        (m.loaded_context_length ?? 0) >= MIN_CONTEXT);

    if (family.length) {
        // Spread villagers across instances by name. Each LM Studio instance
        // has its own KV pool, so two villagers sharing one is roughly the
        // limit; this is the automatic version of hand-pinning half the roster
        // to a second instance.
        const sorted = family.map((m) => m.id).sort();
        let h = 0;
        for (const ch of String(who)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const pick = sorted[h % sorted.length];
        return {
            model: pick,
            reason: preferred === pick
                ? 'as configured'
                : `"${preferred}" is not loaded; using ${sorted.length > 1 ? 'instance ' : ''}"${pick}"`,
        };
    }

    // Nothing of the right family. Say so plainly and change nothing: a
    // different model would behave differently while looking fine.
    const alternatives = loaded.map((m) => m.id).join(', ') || 'none';
    return {
        model: preferred,
        reason: `NOT LOADED and no instance of "${baseName(preferred)}" is available `
              + `(loaded: ${alternatives}). Requests will fail until one is loaded.`,
    };
}

/**
 * Ask LM Studio what it has and reconcile, once per process.
 *
 * Never throws and never blocks startup for long: if the probe fails we keep
 * the configured name, which is exactly today's behaviour.
 */
export async function resolveModel(preferred, who = '', { baseUrl, apiKey } = {}) {
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
        // Unreachable inference server is its own, very visible failure. Do not
        // add a second one on top of it.
        return preferred;
    }

    const { model, reason } = chooseModel(preferred, models, who);
    if (reason !== 'as configured') console.warn(`[model] ${who || 'agent'}: ${reason}`);
    cache = { preferred, who, model };
    return model;
}

/** Test seam. */
export function _resetForTests() { cache = null; }
