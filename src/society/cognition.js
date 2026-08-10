/**
 * Whether thinking is currently possible at all, and how long to wait before
 * asking again.
 *
 * WHY THIS EXISTS
 * ---------------
 * The turn loop could not tell "the model refused this prompt" from "there is
 * no model", and treated both as worth retrying three times. On 2026-08-09 the
 * second kind lasted sixteen hours, and the cost of not distinguishing them was
 * this:
 *
 *   - promptConvo retried 3x per turn against a condition that cannot change
 *     within seconds, tripling the probes and the log volume.
 *   - self_prompter.startLoop counted those failures toward MAX_NO_COMMAND and
 *     STOPPED PERMANENTLY after three. Its failure branch also has no sleep, so
 *     the three arrived as fast as the server could refuse them. Loading a model
 *     would NOT have revived the village: every villager's self-prompt loop was
 *     already dead and only a container restart could start it again.
 *
 * So an outage needs to be a state the loop can see, not an error each caller
 * rediscovers.
 *
 * FAILS OPEN, DELIBERATELY
 * ------------------------
 * available() returns true unless a terminal failure was recorded RECENTLY. A
 * bug in this module can therefore make the village waste requests, but it can
 * never make a working village silent -- and silent is the failure mode that
 * cost sixteen hours. Nothing here decides anything; it only remembers what the
 * last attempt found.
 *
 * Per-process, like everything else in this codebase: eight villagers are eight
 * OS processes and each keeps its own view. That is correct rather than a
 * limitation -- one villager pinned to an evicted instance is genuinely in a
 * different state from its neighbours.
 */

/** How long a terminal failure suppresses further attempts, in ms. */
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;

const FRESH = { ok: true, since: 0, reason: '', consecutive: 0, waitMs: BACKOFF_MIN_MS };

let state = { ...FRESH };

/**
 * A turn completed. Called from the same point as heartbeat's beat() -- the one
 * place that proves model, tool call and command all worked together.
 */
export function noteOk() {
    state = { ...FRESH };
}

/**
 * No model, bad credentials, a model that does not exist: nothing the caller can
 * do will fix this inside a retry window, and only an operator loading a model
 * or fixing a key will.
 */
export function noteTerminal(reason = '') {
    const consecutive = state.ok ? 1 : state.consecutive + 1;
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (consecutive - 1), BACKOFF_MAX_MS);
    state = {
        ok: false,
        since: Date.now(),
        reason: String(reason || ''),
        consecutive,
        // Jittered ONCE, here, rather than on every read: eight villagers who
        // failed together must not return together, but a window that is
        // re-rolled on each available() call is not a window at all.
        waitMs: Math.round(base * (0.75 + Math.random() * 0.5)),
    };
}

/**
 * A timeout, a reset, a saturated KV pool. Worth retrying immediately, so this
 * deliberately does NOT flip available() -- it only clears a stale terminal
 * verdict, since reaching the server at all disproves "there is no server".
 */
export function noteTransient() {
    if (!state.ok) state = { ...FRESH, consecutive: state.consecutive };
}

/** How long the current terminal failure suppresses attempts for. */
export function backoffMs() {
    return state.waitMs;
}

/** False only while a terminal failure is still inside its backoff window. */
export function available() {
    if (state.ok) return true;
    return Date.now() - state.since >= state.waitMs;
}

/** Why the last terminal failure happened, for a log line or an alert. */
export function lastReason() {
    return state.ok ? '' : state.reason;
}

/** Test seam. */
export function _resetForTests() {
    state = { ok: true, since: 0, reason: '', consecutive: 0 };
}
