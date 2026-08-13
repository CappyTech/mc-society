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
 * It will correct a name to a LOADED instance of the same model, spread
 * villagers across several such instances, and -- failing that -- SUBSTITUTE
 * the best loaded alternative of the same architecture. It will not name a
 * model that is not resident, because naming one is what loads it. That one
 * rule is absolute; everything else is a ranking.
 *
 * Substitution was added because the alternative was measured and it is worse.
 * The policy here used to be "same model family or nothing", and on
 * 2026-08-09 the box was left with `andy-4.2` resident while every profile
 * asked for `qwen/qwen3.5-9b@q4_k_m`. Those are different catalogue entries, so
 * this module correctly declined -- every turn, for sixteen hours. Eight
 * villagers stayed connected, burned 31% of a CPU on reflexes, died ninety
 * times, and took not one single turn. "Obviously cannot think" turns out to
 * look exactly like "playing badly" from outside the logs.
 *
 * So a loaded sibling is now preferred to silence. The substitute must share
 * the configured model's ARCHITECTURE (`arch` in the catalogue, e.g. `qwen35`),
 * which is the honest version of the old family rule: what docs/reasoning-model.md
 * tunes against is an architecture's behaviour under forced tool calls, and
 * `arch` is what the API actually reports. `andy-4.2` and `qwen/qwen3.5-9b` are
 * both `qwen35`; Gemma is not, and still will not be chosen.
 *
 * Declining remains possible and still logs why -- there is simply less that
 * can cause it. Set MODEL_SUBSTITUTE=0 to restore the old behaviour.
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

/**
 * What a resolved model is going to be asked to do.
 *
 * Explicit, rather than inferred from minContext, because the two callers are
 * distinguished by a number that is only incidentally different. A chat turn
 * asking for >=12000 already excludes a 2,048-context embedder by size alone --
 * but an embedding request asking for >=512 does NOT exclude a 42,752-context
 * chat model, and substituting one would send sentence embeddings to a
 * reasoning model. Size is a coincidence; role is the actual constraint.
 */
export const ROLE = Object.freeze({ CHAT: 'chat', EMBED: 'embed' });

/**
 * Classify a catalogue row as chat or embedding.
 *
 * `vlm` counts as chat, and that is load-bearing rather than pedantic: the only
 * chat model resident on this deployment is `andy-4.2`, which reports
 * `type: "vlm"`. Treating vision-language models as a separate thing would
 * decline the one model that works.
 *
 * The `type` field comes from /api/v0/models. LM Studio's OpenAI-compatible
 * /v1/models omits it, so fall back to the id -- every embedding model in
 * practice says so in its name, and guessing "chat" for an unknown row is the
 * safe direction: a chat request still has minContext to protect it.
 */
export function roleOf(row) {
    const type = String(row?.type ?? '').toLowerCase();
    if (type === 'embeddings' || type === 'embedding') return ROLE.EMBED;
    if (type === 'llm' || type === 'vlm') return ROLE.CHAT;
    return /embed/i.test(String(row?.id ?? '')) ? ROLE.EMBED : ROLE.CHAT;
}

const PROBE_TIMEOUT_MS = 6000;
/**
 * One retry, because a probe failure costs a whole turn and a retry costs a
 * round trip. Measured from inside the container the probe answers in ~90ms,
 * and the failures are bursty -- 721 in one hour, then single digits for hours
 * -- so what expires here is almost never a down server, it is a saturated GPU
 * briefly not accepting connections. Untreated that cost 1,373 turns in a day.
 *
 * Worst case is 2 * PROBE_TIMEOUT_MS + PROBE_RETRY_DELAY_MS, comfortably inside
 * the 60s healthcheck interval.
 */
const PROBE_RETRY_DELAY_MS = 250;
/**
 * How long the list of loaded models may be trusted.
 *
 * Short, because it is the only thing standing between "choose from what is
 * loaded" and "ask for something that no longer exists" -- and asking is what
 * loads it. LM Studio evicts on its own timer, so a resolution made once at
 * startup is a statement about a moment that has passed.
 */
const LIST_TTL_MS = 15000;

/**
 * The LIST is cached, not the DECISION.
 *
 * Caching the decision was a real bug and produced exactly the behaviour this
 * module exists to prevent. Three villagers resolved to an instance at startup,
 * LM Studio evicted it minutes later, and they went on requesting it by name
 * for the lifetime of the process -- recreating it on every turn. The village
 * was still creating models rather than using them, just more slowly and with
 * a confident log line saying otherwise.
 *
 * Re-deciding every turn against a list at most LIST_TTL_MS old costs one HTTP
 * request per villager per fifteen seconds and keeps the choice honest.
 */
let listCache = null;
/** Last decision per villager, so a stable choice is not logged every turn. */
const lastReason = new Map();

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
 * Spread villagers across instances.
 *
 * Each LM Studio instance has its own KV pool and a turn is ~9,500 tokens, so
 * about two villagers fit per pool -- with eight of them, an even split is the
 * difference between five contending for one pool and four in each.
 *
 * BY POSITION IN THE ROSTER, not by hashing the name. A hash is deterministic
 * but not balanced: the eight real villager names hash 5/3 across two
 * instances, quietly wasting a third of the capacity somebody deliberately
 * loaded. Their index in a fixed roster round-robins exactly.
 *
 * Falls back to the hash for any name not in the roster (a test fixture, a
 * renamed villager), which is unbalanced but stable -- and stability is the
 * property that matters most: a villager who moves between instances on a
 * restart throws away the KV cache their prompt prefix had warmed.
 */
function pick(candidates, preferred, who, peers = [], note = '') {
    const sorted = candidates.map((m) => m.id).sort();
    const seat = peers.indexOf(who);
    let index;
    if (seat >= 0) {
        index = seat % sorted.length;
    } else {
        let h = 0;
        for (const ch of String(who)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        index = h % sorted.length;
    }
    const chosen = sorted[index];
    return {
        model: chosen,
        available: true,
        reason: preferred === chosen
            ? 'as configured'
            : `"${preferred}" is not loaded; using "${chosen}"${note}`,
    };
}

/**
 * The architecture the configured id belongs to, read from the catalogue.
 *
 * Works for a `not-loaded` row, which is the entire point: on the deployment
 * this was written for, `qwen/qwen3.5-9b` is present in the catalogue at
 * `state: "not-loaded"` and still tells us it is `qwen35`. So the configured
 * model does not need to be resident for us to know what a sibling of it is.
 *
 * Returns null when the configured id is not in the catalogue at all, which
 * disables architecture matching rather than failing -- see rankFamilies.
 */
function archOf(preferred, rows) {
    const exact = rows.find((m) => m.id === preferred);
    if (exact?.arch) return String(exact.arch).toLowerCase();
    const sibling = rows.find((m) => baseName(m.id) === baseName(preferred) && m.arch);
    return sibling?.arch ? String(sibling.arch).toLowerCase() : null;
}

/**
 * Rank candidate substitutes, grouped by base name.
 *
 * BY FAMILY, not by row. Ranking individual rows would collapse to a single
 * winner and silently defeat pick()'s whole purpose -- two loaded instances of
 * the same model are two KV pools, and choosing "the best" one would put all
 * eight villagers in one of them. Group first, rank the groups, then hand the
 * winning group's instances to pick() unchanged.
 */
function rankFamilies(candidates, wantArch) {
    const families = new Map();
    for (const m of candidates) {
        const key = baseName(m.id);
        if (!families.has(key)) families.set(key, []);
        families.get(key).push(m);
    }

    const score = (rows) => ({
        // Same architecture as the configured model. The strongest signal, and
        // the replacement for the old same-family rule.
        arch: wantArch && rows.some((m) => String(m.arch ?? '').toLowerCase() === wantArch) ? 1 : 0,
        // Every villager turn is a MANDATORY tool call (tool_choice: 'required'),
        // so a model without tool_use fails 100% of turns rather than degrading.
        // Absent capabilities are not treated as absent support: older LM Studio
        // builds omit the field, and assuming the worst would rule out
        // everything on those. A model that lies here fails loudly on turn one.
        tools: rows.some((m) => !Array.isArray(m.capabilities)
            || m.capabilities.includes('tool_use')) ? 1 : 0,
        ctx: Math.max(...rows.map((m) => m.loaded_context_length ?? 0)),
        instances: rows.length,
    });

    return [...families.entries()]
        .map(([key, rows]) => ({ key, rows, ...score(rows) }))
        .sort((a, b) => (b.arch - a.arch)
            || (b.tools - a.tools)
            || (b.ctx - a.ctx)
            || (b.instances - a.instances)
            // Total determinism last, so a restart never reshuffles villagers
            // between instances and throws away a warmed KV prefix.
            || a.key.localeCompare(b.key));
}

/**
 * Choose a model. PURE, so the policy is testable without a server.
 *
 * @param {string} preferred the id written in the profile
 * @param {object[]} models rows from /api/v0/models
 * @param {string} who the villager, used only to spread load deterministically
 * @param {object} [opts]
 * @param {number} [opts.minContext] context floor for this kind of work
 * @param {string[]} [opts.peers] roster order, for an even split across instances
 * @param {string} [opts.role] ROLE.CHAT or ROLE.EMBED
 * @param {boolean} [opts.substitute] allow a different model of the same arch
 * @returns {{model: string|null, available: boolean, reason: string}}
 */
export function chooseModel(preferred, models, who = '', {
    minContext = MIN_CONTEXT,
    peers = [],
    role = ROLE.CHAT,
    substitute = true,
} = {}) {
    const rows = (Array.isArray(models) ? models : []).filter((m) => m?.id);
    const isLoaded = (m) => m.state && m.state !== 'not-loaded';

    const bigEnough = (m) => (m.loaded_context_length ?? 0) >= minContext;
    const rightRole = (m) => roleOf(m) === role;

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

    if (family.length) return pick(family, preferred, who, peers);

    // Nothing of the configured model is resident. Substitute the best loaded
    // sibling rather than declining -- sixteen hours of a dead village is what
    // declining actually costs. Still constrained: loaded, big enough, and doing
    // the same KIND of work, so a chat turn can never be handed an embedder.
    if (substitute) {
        const eligible = rows.filter((m) => isLoaded(m) && bigEnough(m) && rightRole(m));
        const best = rankFamilies(eligible, archOf(preferred, rows))[0];
        if (best) {
            const note = best.arch
                ? ` (same architecture, nothing of the configured family is loaded)`
                : ` (nothing of the configured architecture is loaded either)`;
            return pick(best.rows, preferred, who, peers, note);
        }
    }

    // Nothing suitable is resident. Decline, rather than naming something that
    // would cause a load -- and say what IS there, because the fix is one
    // deliberate `lms load` on the inference box.
    //
    // The type is printed because that is the shape this failure actually takes:
    // "the embedder is up and the chat model is not" is invisible in a bare list
    // of ids, and it is what sixteen hours of silence looked like.
    const up = rows.filter(isLoaded)
        .map((m) => `${m.id} (${roleOf(m)}, ${m.loaded_context_length ?? '?'})`);
    return {
        model: null,
        available: false,
        reason: `no loaded ${role} model with at least ${minContext} context `
              + `(wanted "${baseName(preferred)}"). `
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
export async function resolveModel(preferred, who = '', {
    baseUrl, apiKey, minContext = MIN_CONTEXT, role = ROLE.CHAT,
} = {}) {
    if (!preferred) return preferred;

    let models;
    if (listCache && Date.now() - listCache.at < LIST_TTL_MS) {
        models = listCache.models;
    } else {
        const url = (baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1')
            .replace(/\/v1\/?$/, '') + '/api/v0/models';
        const auth = { Authorization: `Bearer ${apiKey || process.env.LMSTUDIO_API_KEY || 'lm-studio'}` };
        const probe = async () => {
            const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
            if (!res.ok) throw new Error(String(res.status));
            return (await res.json())?.data ?? [];
        };
        try {
            try {
                models = await probe();
            } catch {
                await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
                models = await probe();
            }
            listCache = { at: Date.now(), models };
        } catch {
            // An unreachable inference server is its own, very visible failure,
            // and nothing can be resident on a host we cannot reach. Decline
            // rather than guess -- and do NOT fall back to a stale list, which
            // would name a model that may since have been evicted.
            //
            // Rate-limited like every other decision here: 1,373 copies of this
            // one line in a day actively buried the message that mattered.
            const why = 'cannot reach LM Studio to see what is loaded';
            if (lastReason.get(who) !== why) console.warn(`[model] ${who || 'agent'}: ${why}`);
            lastReason.set(who, why);
            return null;
        }
    }

    const { model, reason } = chooseModel(preferred, models, who, {
        minContext, role, peers: await roster(), substitute: process.env.MODEL_SUBSTITUTE !== '0',
    });
    // Logged on change only. Re-deciding every turn would otherwise print the
    // same correction several times a minute for every villager.
    if (reason !== 'as configured' && lastReason.get(who) !== reason) {
        console.warn(`[model] ${who || 'agent'}: ${reason}`);
    }
    lastReason.set(who, reason);
    return model;
}

/**
 * The villager names, in roster order, for an even split across instances.
 *
 * Imported lazily so this module stays loadable on its own: roster.js reaches
 * territory.js and from there the Chronicle's mongoose connection, and a model
 * resolver has no business pulling a database driver into a process that only
 * wanted to know what is loaded.
 */
let peerNames = null;
async function roster() {
    if (peerNames) return peerNames;
    try {
        const { ROSTER } = await import('./roster.js');
        peerNames = ROSTER.map((a) => a.name);
    } catch {
        peerNames = [];      // unbalanced but stable, which is the important half
    }
    return peerNames;
}

/** Test seam. */
export function _resetForTests() { listCache = null; lastReason.clear(); peerNames = null; }
