/**
 * The Chronicle: the village's shared memory.
 *
 * This is the only module the rest of the codebase imports. Every export here
 * is safe to call when Mongo is unreachable or unconfigured -- writes vanish,
 * reads return their neutral value, nothing throws, nothing blocks. That
 * property is what lets the recording hook sit inside the command path.
 *
 * Writes are buffered and flushed on a timer, so no turn ever waits on the
 * database. A full buffer drops its oldest entries: losing the memory of a
 * conversation is a much smaller problem than stalling the villager having it.
 */

import { connect, read, isUp, getState, getModels } from './connection.js';
import { relKey } from './models.js';
import { applyEvent } from './sentiment.js';
import { deriveEvent, isSocial } from './recorder.js';
import { renderBrief, BRIEF_MAX_CHARS } from './brief.js';

// Re-exported for src/society/projects, which needs the same guarded access
// and must not reach around this module to the connection directly.
export { connect, isUp, getState, getModels, read };

/** Bounded so a long outage cannot grow the heap. */
const BUFFER_MAX = 200;
const FLUSH_MS = 2000;

let buffer = [];
let flushTimer = null;
let briefCache = new Map();   // name -> {at, text}
const BRIEF_TTL_MS = 5000;

function scheduleFlush() {
    if (flushTimer || !isUp()) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_MS);
    // Never hold the process open for a pending flush.
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Push everything buffered. Failures are swallowed: the events are already
 * gone from the buffer, and retrying a broken connection on a timer is how you
 * turn a database outage into a log flood.
 */
export async function flush() {
    const models = getModels();
    if (!models || !buffer.length) return;

    const batch = buffer;
    buffer = [];

    try {
        // ordered:false so one bad document does not discard the rest.
        await models.Event.insertMany(batch.map((b) => b.event), { ordered: false });

        const ops = batch.flatMap((b) => b.relOps || []);
        if (ops.length) await models.Relationship.bulkWrite(ops, { ordered: false });

        const agentOps = batch.flatMap((b) => b.agentOps || []);
        if (agentOps.length) await models.Agent.bulkWrite(agentOps, { ordered: false });

        const ledgerOps = batch.flatMap((b) => b.ledgerOps || []);
        for (const op of ledgerOps) {
            if (op.open) await models.Ledger.create(op.open);
            if (op.settle) await models.Ledger.updateOne(op.settle.filter, op.settle.update);
        }
    } catch {
        // Deliberately silent: connection.js already rate-limits the shouting.
    }
}

/**
 * Record what a command did. Synchronous, non-throwing, no await.
 *
 * Called from executeCommand for every command every villager runs, so it must
 * cost effectively nothing on the commands it ignores -- which is most of them.
 */
export function observe(agent, commandName, args, result) {
    try {
        if (!isUp()) return;
        const event = deriveEvent(commandName, args, result, agent?.name);
        if (!event) return;

        const entry = { event };

        // Naming a place shares it with the whole village, and naming one
        // "village" founds the base. The position has to come from the live
        // bot: the command's own result string does not carry it, and the
        // villager is standing on the spot by definition.
        if (event.kind === 'named_place') {
            const pos = agent?.bot?.entity?.position;
            if (pos) {
                observePlace(agent.name, event.detail, pos, true);
                import('../territory.js')
                    .then((t) => t.notePlaceNamed(agent.name, event.detail, pos))
                    .catch(() => {});
            }
        }

        if (isSocial(event)) {
            // A relationship row is one villager's view OF THE OTHER, so the
            // event kind written into it must describe what the *other* person
            // did. Getting this backwards produces text that reads perfectly
            // well and is exactly wrong -- "Bram: took 3 coal from you" shown
            // to the villager Bram had just given coal to.
            if (event.kind === 'gave') {
                // Bram's view of Nia: she took something from him. Mild.
                entry.relOps = [relUpdate(event.actor, event.subject, { ...event, kind: 'received' })];
                // Nia's view of Bram: he gave her something. That is the one
                // that counts -- being given to and giving away are different
                // experiences and are weighted differently on purpose.
                entry.relOps.push(relUpdate(event.subject, event.actor, { ...event, kind: 'gave' }));
                entry.ledgerOps = [{
                    open: {
                        creditor: event.actor, debtor: event.subject,
                        item: event.item, qty: event.qty, openedAt: event.ts,
                    },
                }, {
                    // A gift in the other direction settles the oldest thing
                    // outstanding. FIFO and approximate on purpose.
                    settle: {
                        filter: { creditor: event.subject, debtor: event.actor, settledAt: null },
                        update: { $set: { settledAt: event.ts } },
                    },
                }];

                // A gift to the builder of an agreed project is a contribution
                // to it. This is why contributing needs NO new tool: !givePlayer
                // already exists, is already hooked, and handing over materials
                // is a far better signal of consent than a vote.
                import('../projects/projects.js')
                    .then((p) => p.credit(event.actor, event.subject, event.item, event.qty))
                    .catch(() => {});
            } else {
                // Everything else social is one-sided: the actor did it TO the
                // subject. `spoke_to` rather than `spoke` because the speaker's
                // own row must not read "talked to you" -- that is what the
                // listener records, via observeHeard.
                const kind = event.kind === 'spoke' ? 'spoke_to' : event.kind;
                entry.relOps = [relUpdate(event.actor, event.subject, { ...event, kind })];
            }
        }

        if (buffer.length >= BUFFER_MAX) buffer.shift();
        buffer.push(entry);
        scheduleFlush();
    } catch {
        // Recording must never be able to break the command that already ran.
    }
}

/** An upsert that applies the sentiment maths to whatever is currently stored. */
function relUpdate(from, to, event) {
    const next = applyEvent(undefined, { ...event, at: event.ts?.getTime?.() ?? Date.now() });
    return {
        updateOne: {
            filter: { _id: relKey(from, to) },
            update: {
                $setOnInsert: { _id: relKey(from, to), from, to },
                $inc: {
                    sentiment: next.sentiment,
                    trust: next.trust,
                    'counts.gaveTo': next.counts.gaveTo,
                    'counts.receivedFrom': next.counts.receivedFrom,
                    'counts.talks': next.counts.talks,
                    'counts.refusals': next.counts.refusals,
                },
                $set: { lastReason: next.lastReason, lastEventAt: event.ts ?? new Date() },
            },
            upsert: true,
        },
    };
}

/** Someone heard something. The listener's side of a conversation. */
export function observeHeard(listener, speaker, message) {
    try {
        if (!isUp() || !listener || !speaker) return;
        const event = {
            ts: new Date(), actor: listener, subject: speaker,
            kind: 'spoke', item: null, qty: null,
            detail: String(message ?? '').slice(0, 120),
        };
        if (buffer.length >= BUFFER_MAX) buffer.shift();
        buffer.push({ event, relOps: [relUpdate(listener, speaker, event)] });
        scheduleFlush();
    } catch { /* never break a conversation */ }
}

/** A villager died. The single most memorable thing that can happen to one. */
export function observeDeath(name, cause, pos) {
    try {
        if (!isUp() || !name) return;
        const event = {
            ts: new Date(), actor: name, subject: null, kind: 'died',
            item: null, qty: null,
            detail: `${String(cause ?? '').slice(0, 80)}${pos ? ` at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}` : ''}`,
        };
        if (buffer.length >= BUFFER_MAX) buffer.shift();
        // agentOps, because `deaths` on the agent document was declared, defaulted
        // to 0, and then never incremented by anything: 90 `died` events had
        // accumulated against eight agents all still reading 0, so every consumer
        // of that field (including the mcs-watch dashboard) showed zeros while
        // villagers died in a loop.
        buffer.push({
            event,
            agentOps: [{ updateOne: { filter: { _id: name }, update: { $inc: { deaths: 1 } } } }],
        });
        scheduleFlush();
    } catch { /* never break a respawn */ }
}

/** Remember a location village-wide. */
export function observePlace(owner, name, pos, shared = false) {
    try {
        if (!isUp() || !owner || !name || !pos) return;
        const models = getModels();
        void models?.Place.updateOne(
            { owner, name },
            { $set: { x: pos.x, y: pos.y, z: pos.z, shared, updatedAt: new Date() } },
            { upsert: true },
        ).catch(() => {});
    } catch { /* never break !rememberHere */ }
}

/**
 * The block injected into a villager's prompt.
 *
 * Cached briefly because agent.js may loop up to max_commands times on one
 * message, and nothing meaningful changes between those iterations.
 *
 * @returns {Promise<string>} '' whenever the Chronicle has nothing, is slow, or is down
 */
export async function brief(me, { focus = null, project = null, budget = BRIEF_MAX_CHARS } = {}) {
    if (!me || !isUp()) return '';

    // Budget is part of the cache key. It varies turn to turn now that $FOCUS
    // has first claim on the shared 900 (see models/prompter.js), so caching on
    // name and focus alone would serve a full-width brief back on a turn that
    // had already spent 300 characters on staying alive.
    const cached = briefCache.get(me);
    if (cached && Date.now() - cached.at < BRIEF_TTL_MS &&
        cached.focus === focus && cached.budget === budget) return cached.text;

    // The shared project, phrased for this villager: the builder is told what
    // is missing, a producer of a missing item is told to bring it, and anyone
    // with nothing to contribute is told nothing at all. Broadcasting the same
    // line to all eight would spend the budget on noise for six of them.
    let projectLine = project ?? '';
    if (project === null) {
        try {
            const { lineFor } = await import('../projects/projects.js');
            const { byName } = await import('../roster.js');
            projectLine = await lineFor(byName(me));
        } catch { projectLine = ''; }
    }

    const rows = await read(async (m) => {
        const [relationships, ledger] = await Promise.all([
            m.Relationship.find({ from: me }).sort({ sentiment: -1 }).limit(8).lean(),
            m.Ledger.find({ settledAt: null, $or: [{ creditor: me }, { debtor: me }] }).limit(8).lean(),
        ]);
        return { relationships, ledger };
    }, null);

    if (!rows) return '';

    const text = renderBrief({ me, ...rows, focus, project: projectLine, budget });
    briefCache.set(me, { at: Date.now(), text, focus, budget });
    return text;
}

/**
 * Seed the roster. Idempotent, so all eight processes may run it on connect
 * without coordination -- no leader election, no startup ordering.
 */
export async function seed(roster) {
    const models = getModels();
    if (!models || !Array.isArray(roster)) return;
    try {
        await models.Agent.bulkWrite(roster.map((a) => ({
            updateOne: {
                filter: { _id: a.name },
                update: {
                    $set: { role: a.role, blurb: a.blurb, disposition: a.disposition,
                            goal: a.goal, produces: a.produces, needs: a.needs, lastSeen: new Date() },
                    $setOnInsert: { firstSeen: new Date(), deaths: 0 },
                },
                upsert: true,
            },
        })), { ordered: false });
    } catch { /* seeding is best-effort */ }
}

/** Test seam. */
export function _resetForTests() { buffer = []; briefCache = new Map(); }
