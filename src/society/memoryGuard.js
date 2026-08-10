/**
 * What a villager is allowed to remember about themselves.
 *
 * WHY THIS EXISTS
 * ---------------
 * Long-term memory is written by asking the model to summarise recent turns and
 * storing whatever comes back. The prose path returns a plain string on failure
 * too, so a failure IS a valid summary as far as the caller can tell, and it
 * gets stored -- then read back on load and stored again, permanently.
 *
 * This has now destroyed every villager's memory TWICE.
 *
 *   2026-07  Seven of eight villagers' entire long-term memory was the literal
 *            text "My brain disconnected, try again." A guard was added for it.
 *   2026-08  All eight read "No suitable model is loaded on the inference
 *            server..." -- LMStudio.NO_MODEL, a sentinel added later by
 *            unrelated work, which the guard did not know about.
 *
 * The guard was not wrong; it was a hand-maintained list of error literals in
 * two functions, plus a third definition of the sentinel in the adapter, and
 * they drifted. That is the defect. Adding NO_MODEL to the list would fix this
 * incident and schedule the next one.
 *
 * SO THERE ARE TWO LAYERS, AND THE FIRST ONE IS THE REAL FIX
 * ----------------------------------------------------------
 * 1. Failure leaves the string channel entirely. lmstudio.js exposes chat(),
 *    which reports {ok, text, error}, and sendRequest() THROWS LLMUnavailable
 *    rather than returning prose. A failure can no longer be mistaken for a
 *    summary, because it is not a string.
 *
 * 2. This module is the single definition site for the sentinels that already
 *    exist in the wild -- on disk right now, and in seventeen other model
 *    adapters this deployment does not run but which upstream still owns. The
 *    producer imports its sentinel FROM here, and both the write guard and the
 *    load scrub read the same array. The list is not gone; there is just only
 *    one of it, and nowhere else to define a new one.
 *
 * A stale memory is much better than a false one, so the failure behaviour
 * everywhere is "keep what we had".
 */

/**
 * Nothing suitable is loaded, so send nothing.
 *
 * Lives here rather than in lmstudio.js so that the thing that PRODUCES this
 * text and the thing that REFUSES TO STORE it cannot disagree about what it is.
 */
export const NO_MODEL = 'No suitable model is loaded on the inference server, and nothing '
    + 'will be loaded automatically. Load one and the villagers resume.';

/**
 * Every string a model adapter is known to return in place of real output.
 *
 * ADD TO THIS ARRAY, never to a comparison somewhere else. Everything that
 * decides whether a memory is real reads this, and the tests iterate it -- so a
 * new entry is covered the moment it appears, which is the only reason this
 * list is safe to have at all.
 */
export const KNOWN_FAILURE_TEXT = Object.freeze([
    NO_MODEL,
    // Upstream's error string, shared by all seventeen other adapters in
    // src/models/. This deployment does not run them; the files are still here.
    'My brain disconnected, try again.',
]);

/**
 * Thrown instead of returning failure prose. Carries `terminal` so the turn loop
 * can tell "retry might help" from "an operator has to do something".
 */
export class LLMUnavailable extends Error {
    constructor(message, { terminal = false } = {}) {
        super(message);
        this.name = 'LLMUnavailable';
        this.terminal = terminal;
    }
}

/**
 * Is this text worth keeping as a villager's memory?
 *
 * Substring rather than equality: the summariser is asked to compress, and a
 * model handed an error string in its input has been observed quoting it back
 * inside a longer sentence. Equality would pass that straight through.
 */
export function isUsableMemory(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    return !KNOWN_FAILURE_TEXT.some((bad) => trimmed.includes(bad));
}

/**
 * A memory to load, or '' if what is on disk is a stored failure.
 *
 * This is what repairs the files the bug already wrote. Guarding only the write
 * path stops new corruption but never heals the old: load() reads the error
 * string back and the next save() writes it out again, so a villager keeps it
 * forever. Eight of eight were in exactly that state on 2026-08-10.
 */
export function scrubMemory(text) {
    return isUsableMemory(text) ? text : '';
}
