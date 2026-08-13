/**
 * How many villagers may be mid-request at once.
 *
 * WHY THIS EXISTS
 * ---------------
 * An LM Studio instance serves parallel requests out of ONE KV pool, and when
 * that pool is oversubscribed it does not queue and it does not degrade -- it
 * rejects. Measured against the resident `andy-4.2` (42,752 tokens), village
 * stopped so nothing else was competing, using the REAL 36-tool schema and a
 * villager-sized prompt (12,955 tokens) plus the adapter's 1,280-token output
 * budget, which is reserved in the pool alongside the prompt:
 *
 *     concurrency 1  ->  1/1 emit a tool call
 *     concurrency 2  ->  2/2 emit a tool call
 *     concurrency 3  ->  0/3, all HTTP 400
 *
 * 42,752 / (12,955 + 1,280) = 3.00, so three is exactly the edge and falls off it.
 *
 * Measure with the real schema. An earlier pass used synthetic 9,558-token
 * prompts, concluded four fitted, shipped three, and still saw a third of turns
 * fail -- because an actual villager prompt is a third larger than the guess.
 *
 * Note the shape of that cliff. At six, every request fails, including the ones
 * that would have fitted. So eight villagers thinking at once do not get eight
 * slow turns or four fast ones; they get NOTHING, all of them, for as long as
 * they keep trying together. That is what the village did on first revival:
 * every turn ended in `Context size has been exceeded` after exhausting its
 * retries, with a perfectly healthy inference server.
 *
 * Retries alone cannot fix it. Eight processes that failed together back off
 * together and collide again -- POOL_RETRIES existed already and all three
 * attempts were consumed on every turn.
 *
 * WHY A FILE
 * ----------
 * The eight villagers are eight separate OS processes (src/process/agent_process.js
 * forks one per profile), so a semaphore held in module state would limit each
 * villager to N requests and the village to 8N -- exactly the bug it was meant to
 * fix. They do share a filesystem, and society/heartbeat.js already coordinates
 * through /tmp for the same reason, so a lock directory is the established
 * mechanism here rather than a new one.
 *
 * O_EXCL file creation is the lock: it is atomic on a local filesystem, needs no
 * dependency, and leaves a readable artefact (`ls /tmp/mcs-inference-slots`
 * tells you who is thinking).
 *
 * ON TIMEOUT IT SKIPS THE TURN. IT DOES NOT BARGE.
 * ------------------------------------------------
 * This was built the other way round first -- proceed anyway after 45s, on the
 * reasoning that a gate able to silence the village is the sixteen-hour outage
 * in a different costume. That was wrong, and measurably so: demand here exceeds
 * capacity permanently (eight villagers wanting a turn every few seconds against
 * roughly seven turns a minute), so the queue is always full, the timeout always
 * expires, and every barging request took the pool over the cliff and failed
 * ALL the in-flight ones with it. 12 barges produced 42 context errors and 8
 * successful turns.
 *
 * Skipping is safe in a way barging is not: a skipped turn is reported as a
 * TRANSIENT failure, the villager keeps its self-prompt loop, and it tries again
 * shortly. Nothing is permanently lost, and the requests that did get slots
 * complete. Backpressure, rather than a stampede.
 *
 * The village therefore thinks at the rate the GPU allows. If that rate is too
 * slow, the fix is capacity or a smaller prompt -- not a bigger cap.
 *
 * Genuine faults still fail open: an unusable lock directory returns a no-op
 * release rather than blocking, because that failure says nothing about the pool.
 */

import { openSync, closeSync, writeSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Concurrent requests permitted village-wide.
 *
 * TWO. Three is where the measurement above falls off the cliff, and a villager
 * whose history has grown longer than its neighbours' is over the edge on its
 * own, so the cap has to sit below the arithmetic rather than on it.
 *
 * Both larger values were tried live and both failed, in ways worth recording
 * because neither looked like a capacity problem from the logs:
 *
 *   4  ->  ~3 turns in 7 failed with `Context size has been exceeded`
 *   3  ->  no context errors, but 14 turns "produced prose instead of a tool
 *          call" against 7 that worked. That reads like a model-quality problem
 *          and is not one: every failure had spent EXACTLY the full 1,280-token
 *          budget, and the same model with the same 36-tool schema emits a clean
 *          call in ~300 tokens at concurrency 1 or 2. It was pool pressure
 *          truncating the generation.
 *
 * That second failure is the one to remember: over-subscription does not always
 * announce itself as a context error. It can come back as the model apparently
 * being bad at its job.
 *
 * Deliberately NOT derived from loaded_context_length at runtime: the arithmetic
 * needs a real turn size, which varies with history and role, and a wrong guess
 * here fails the entire village at once. Raise it with LMSTUDIO_MAX_INFLIGHT when
 * more capacity is loaded -- the same deliberate operator act as `lms load`.
 */
export const MAX_INFLIGHT = Math.max(1, Number(process.env.LMSTUDIO_MAX_INFLIGHT) || 2);

const SLOT_DIR = process.env.LMSTUDIO_SLOT_DIR || path.join(os.tmpdir(), 'mcs-inference-slots');

/**
 * When a held slot is presumed abandoned.
 *
 * A villager killed mid-request cannot clean up after itself, and a leaked slot
 * is permanent: it would silently reduce the village's capacity by one, for ever,
 * with nothing in any log.
 *
 * Five minutes, because stealing a LIVE slot re-creates the exact over-capacity
 * failure this module exists to prevent, and measured turns here run 20-30s with
 * a long tail. 180s was tried and reclaimed two slots that were still in use.
 */
const STALE_MS = 300000;

/**
 * How long to queue for a slot before giving up on this turn.
 *
 * Generous, because waiting is the correct behaviour when the pool is busy --
 * this is a queue, not a probe. On expiry the caller SKIPS (see the header); it
 * does not proceed.
 */
const ACQUIRE_TIMEOUT_MS = Math.max(1, Number(process.env.LMSTUDIO_SLOT_TIMEOUT_MS) || 120000);

/** Thrown when a turn could not get a slot. Transient by nature: try later. */
export class NoSlot extends Error {
    constructor(who, waitedMs) {
        super(`no inference slot for ${who} after ${waitedMs}ms; skipping this turn`);
        this.name = 'NoSlot';
        this.transient = true;
    }
}
const POLL_MIN_MS = 150;
const POLL_MAX_MS = 600;

const slotPath = (i) => path.join(SLOT_DIR, `slot-${i}.lock`);

function tryTake(i, who) {
    try {
        const fd = openSync(slotPath(i), 'wx');
        try {
            writeSync(fd, `${process.pid} ${who} ${new Date().toISOString()}\n`);
        } finally {
            closeSync(fd);
        }
        return true;
    } catch (err) {
        if (err?.code === 'EEXIST') return false;
        // A filesystem we cannot write to must not stop the village thinking.
        throw err;
    }
}

/** Remove locks whose holder is presumably gone. */
function reapStale() {
    let reaped = 0;
    let names;
    try {
        names = readdirSync(SLOT_DIR);
    } catch {
        return 0;
    }
    for (const name of names) {
        const p = path.join(SLOT_DIR, name);
        try {
            if (Date.now() - statSync(p).mtimeMs > STALE_MS) {
                unlinkSync(p);
                reaped++;
            }
        } catch {
            // Someone else released or reaped it first, which is the desired end
            // state either way.
        }
    }
    return reaped;
}

/**
 * Wait for permission to make one inference request.
 *
 * @param {string} who villager name, recorded in the lock for diagnosis
 * @returns {Promise<() => void>} release. ALWAYS call it, from a finally.
 */
export async function acquire(who = 'agent') {
    try {
        mkdirSync(SLOT_DIR, { recursive: true });
    } catch {
        return () => {};                       // fail open: no directory, no gate
    }

    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    let warnedStale = false;

    for (;;) {
        for (let i = 0; i < MAX_INFLIGHT; i++) {
            try {
                if (tryTake(i, who)) {
                    let released = false;
                    return () => {
                        if (released) return;   // idempotent: a double release
                        released = true;        // would free someone else's slot
                        try { unlinkSync(slotPath(i)); } catch { /* already gone */ }
                    };
                }
            } catch {
                return () => {};               // fail open on any fs error
            }
        }

        if (Date.now() >= deadline) {
            // Skip, do NOT proceed. An unslotted request takes the pool over its
            // cliff and fails every turn already in flight along with its own.
            throw new NoSlot(who, ACQUIRE_TIMEOUT_MS);
        }

        if (!warnedStale) {
            warnedStale = true;
            const reaped = reapStale();
            if (reaped) console.warn(`[slots] reclaimed ${reaped} abandoned slot(s)`);
        }

        // Jittered, so eight villagers who queued together do not wake together
        // and race for the same slot index.
        const wait = POLL_MIN_MS + Math.random() * (POLL_MAX_MS - POLL_MIN_MS);
        await new Promise((r) => setTimeout(r, wait));
    }
}

/** Run one inference request holding a slot. */
export async function withSlot(who, fn) {
    const release = await acquire(who);
    try {
        return await fn();
    } finally {
        release();
    }
}

/** Test seam. */
export function _clearForTests() {
    try {
        for (const name of readdirSync(SLOT_DIR)) unlinkSync(path.join(SLOT_DIR, name));
    } catch { /* nothing to clear */ }
}
