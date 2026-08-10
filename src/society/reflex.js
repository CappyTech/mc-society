/**
 * When a reflex should NOT fire.
 *
 * Modes are the off-LLM layer: anything that must happen faster than one turn
 * (~3s at best) is a mode, everything else is prompt state. That split is right,
 * but it has a consequence nobody had accounted for -- modes keep running when
 * the LLM does not, and a villager made entirely of reflexes is not a simplified
 * villager. It is a thrashing one.
 *
 * MEASURED during the 2026-08-09 outage, sixteen hours with zero turns:
 *
 *     "Moved 24 away from enemies."   x865, always the same number
 *     deaths                          90, on DIFFICULTY=easy
 *     CPU                             ~31%, entirely reflexes
 *
 * Three separate faults compound there, and this module addresses the first two.
 *
 * 1. NOTHING BOUNDS THE LOOP. `cowardice` triggers on a hostile within 16 blocks
 *    and then calls avoidEnemies(bot, 24), whose loop only exits once nothing
 *    hostile is within TWENTY-FOUR. So a villager driven off by one zombie keeps
 *    walking into unexplored ground until it finds the next one, and the trigger
 *    radius is smaller than the flight radius, so arriving somewhere new starts
 *    the whole thing again. 865 identical log lines is one villager on a
 *    treadmill, not 865 decisions.
 *
 * 2. FLEEING WITHOUT COGNITION IS WORSE THAN STANDING STILL. A villager with no
 *    LLM cannot deliberately reach shelter, light or a bed -- every mechanism for
 *    actually becoming safe is a tool call. So flight only relocates it, at a
 *    third of a CPU, until something kills it. Ninety deaths on `easy` is the
 *    measurement of that. Standing still under whatever cover it already has is
 *    strictly better, and it is visibly inert, which is this codebase's stated
 *    preference: "a village that obviously cannot think is better than one that
 *    is subtly different" (society/modelResolver.js).
 *
 * 3. (Fixed in modes.js, not here.) avoidEnemies pauses `self_preservation` and
 *    never unpauses it, so a fleeing villager has no drowning or lava guard for
 *    the duration. The newest event in the Chronicle when this was written was
 *    `Nia was slain by Drowned`.
 *
 * WHAT STAYS ON, ALWAYS
 * ---------------------
 * VITAL_MODES run regardless. They are the ones whose absence is immediately
 * fatal and whose action is local: back away from a creeper, get out of the
 * water. Quiescing those would not be "obviously inert", it would be suicide.
 *
 * PURE, because modes.js pulls in mineflayer and cannot be imported by tests --
 * the same reason society/modeGuard.js exists. The rate-limit bookkeeping is
 * kept behind noteRun/shouldRun so the decision itself stays a function of its
 * arguments.
 */

/**
 * Reflexes that move the villager away from, or at, a threat. Rate-capped.
 *
 * `hunting` is deliberately NOT here. It is not flight, and capping it at three a
 * minute would quietly throttle how villagers get meat -- a food regression
 * dressed up as a safety fix. It still stands down without cognition, because
 * every non-vital mode does; it is simply not rate-limited.
 */
export const FLIGHT_MODES = Object.freeze(['cowardice', 'self_defense']);

/**
 * Reflexes that must never be suppressed.
 *
 * `self_preservation` is drowning, lava and low health. `creeper_awareness` has
 * a 1.5s fuse to beat. Neither has any alternative anywhere else in the system.
 */
export const VITAL_MODES = Object.freeze(['self_preservation', 'creeper_awareness']);

/**
 * A flight reflex may fire this many times per window.
 *
 * Three per minute. A villager that has fled three times in a minute is not
 * responding to three threats, it is on the treadmill described above, and a
 * fourth flight is not a plan. Past the cap, `self_preservation` and the survival
 * ladder's shelter rung take over -- both of which can actually end the
 * situation rather than relocate it.
 */
export const MAX_RUNS = 3;
export const WINDOW_MS = 60000;

/** name -> timestamps of recent runs. Per-process, like every other mode state. */
const runs = new Map();

export function isFlight(mode) { return FLIGHT_MODES.includes(mode); }
export function isVital(mode) { return VITAL_MODES.includes(mode); }

/**
 * Decide whether a mode may run.
 *
 * PURE given `now` and `recent`. The impure convenience wrapper is shouldRunNow.
 *
 * @param {string} mode mode name
 * @param {object} ctx
 * @param {boolean} ctx.cognitionAvailable whether the villager can take LLM turns
 * @param {number[]} ctx.recent timestamps of this mode's recent runs
 * @param {number} ctx.now
 * @returns {{run: boolean, reason: string}}
 */
export function shouldRun(mode, { cognitionAvailable = true, recent = [], now = Date.now() } = {}) {
    if (isVital(mode)) return { run: true, reason: 'vital' };

    if (!cognitionAvailable) {
        // Not a rate limit -- a statement that this reflex has no useful version
        // of itself without a mind attached to it.
        return { run: false, reason: 'no cognition: only vital reflexes run' };
    }

    if (isFlight(mode)) {
        const inWindow = recent.filter((t) => now - t < WINDOW_MS);
        if (inWindow.length >= MAX_RUNS) {
            return { run: false, reason: `${inWindow.length} flights in ${WINDOW_MS / 1000}s` };
        }
    }

    return { run: true, reason: 'ok' };
}

/** shouldRun against this process's own bookkeeping. */
export function shouldRunNow(mode, cognitionAvailable, now = Date.now()) {
    return shouldRun(mode, { cognitionAvailable, recent: runs.get(mode) ?? [], now });
}

/** Record that a mode ran. Only flight modes are tracked; nothing else is capped. */
export function noteRun(mode, now = Date.now()) {
    if (!isFlight(mode)) return;
    const recent = (runs.get(mode) ?? []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    runs.set(mode, recent);
}

/**
 * How far to flee.
 *
 * Matched to the TRIGGER radius rather than exceeding it. avoidEnemies exits only
 * when nothing hostile is within the distance it was given, so passing 24 to a
 * mode that triggers at 16 guarantees the villager keeps moving into ground it
 * has not seen -- which is how one zombie becomes an eight-hundred-line log.
 */
export const FLIGHT_DISTANCE = 16;

/**
 * Hard stop on a single flight.
 *
 * runAction already accepts a timeout and cowardice passed none, so a flight
 * could only end by succeeding. Fifteen seconds is several times the normal case
 * and still bounds the pathological one.
 */
export const FLIGHT_TIMEOUT_MS = 15000;

/** Test seam. */
export function _resetForTests() { runs.clear(); }
