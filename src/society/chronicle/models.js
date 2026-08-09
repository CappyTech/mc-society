/**
 * Chronicle schemas.
 *
 * Deliberately materialised rather than derived: `relationships` is updated on
 * write so that reading a villager's brief is one indexed lookup, not an
 * aggregation over the whole event log. A brief is read on *every turn of every
 * villager*, so its cost is the one that matters; events are written once.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Seeded from ROSTER. _id is the villager's name -- there is only ever one Bram. */
const agentSchema = new Schema({
    _id: String,
    role: String,
    blurb: String,
    disposition: String,
    goal: String,
    produces: [String],
    needs: [String],
    firstSeen: { type: Date, default: Date.now },
    lastSeen: Date,
    deaths: { type: Number, default: 0 },
}, { _id: false, versionKey: false });

/**
 * The append-only log of what happened. No TTL: a village that forgets its own
 * history is the thing this whole feature exists to fix. Volume is trivial --
 * a few thousand small documents a day.
 */
const eventSchema = new Schema({
    ts: { type: Date, default: Date.now },
    actor: String,
    subject: { type: String, default: null },
    kind: String,
    item: { type: String, default: null },
    qty: { type: Number, default: null },
    detail: { type: String, default: '' },
}, { versionKey: false });
eventSchema.index({ actor: 1, ts: -1 });
eventSchema.index({ subject: 1, ts: -1 });
eventSchema.index({ ts: -1 });

/**
 * Directed: "Bram->Nia" is what Bram thinks of Nia, which is not what Nia
 * thinks of Bram. Asymmetry is the point -- one villager can feel indebted
 * while the other has forgotten the whole thing.
 */
const relationshipSchema = new Schema({
    _id: String,               // "<from>-><to>"
    from: String,
    to: String,
    sentiment: { type: Number, default: 0 },
    trust: { type: Number, default: 0 },
    lastReason: { type: String, default: '' },
    counts: {
        gaveTo: { type: Number, default: 0 },
        receivedFrom: { type: Number, default: 0 },
        talks: { type: Number, default: 0 },
        refusals: { type: Number, default: 0 },
    },
    lastEventAt: { type: Date, default: Date.now },
}, { _id: false, versionKey: false });
relationshipSchema.index({ from: 1, sentiment: -1 });

/**
 * Favours owed. Social memory, deliberately not accounting: settlement is
 * FIFO and approximate, because "you still owe me for that pickaxe" is how
 * people actually keep score, and a villager arguing about part-quantities
 * would be worse company than one who is roughly right.
 */
const ledgerSchema = new Schema({
    creditor: String,
    debtor: String,
    item: String,
    qty: Number,
    openedAt: { type: Date, default: Date.now },
    settledAt: { type: Date, default: null },
}, { versionKey: false });
ledgerSchema.index({ creditor: 1, settledAt: 1 });
ledgerSchema.index({ debtor: 1, settledAt: 1 });

/**
 * Remembered locations, shared across the village.
 *
 * MemoryBank persists these per-agent already (see history.js), but only into
 * that agent's own file. Here they outlive a lost bots/ volume and can be
 * shared -- a build site should be a village landmark, not Odile's private note.
 */
const placeSchema = new Schema({
    owner: String,
    name: String,
    x: Number, y: Number, z: Number,
    shared: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });
placeSchema.index({ owner: 1, name: 1 }, { unique: true });

/**
 * A shared build the village has to agree on.
 *
 * `contributed` and `delivered` are plain objects rather than sub-documents:
 * item names are Minecraft ids and the shape is genuinely dynamic.
 */
const projectSchema = new Schema({
    name: String,                    // a schematic in src/agent/npc/construction
    proposer: String,
    builder: String,
    site: { x: Number, y: Number, z: Number },
    status: { type: String, default: 'proposed' },   // proposed|agreed|building|complete|abandoned
    votes: [{ voter: String, approve: Boolean, at: Date }],
    required: { type: Object, default: {} },
    delivered: { type: Object, default: {} },
    contributed: { type: Object, default: {} },      // villager -> {item: n}
    createdAt: { type: Date, default: Date.now },
    agreedAt: Date,
    completedAt: Date,
    lastBuildAt: Date,
}, { versionKey: false, minimize: false });

/**
 * At most one open proposal in the whole village.
 *
 * This is what lets `voteProject(approve)` take no project id: there is never
 * any ambiguity about which proposal a vote refers to. It also saves ~20 prompt
 * tokens per villager per turn and, more importantly, stops the model inventing
 * ObjectIds -- which it would.
 */
projectSchema.index(
    { status: 1 },
    { unique: true, partialFilterExpression: { status: 'proposed' } },
);
projectSchema.index({ status: 1, createdAt: -1 });

export const relKey = (from, to) => `${from}->${to}`;

export function buildModels(conn) {
    return {
        Agent: conn.model('Agent', agentSchema, 'agents'),
        Event: conn.model('Event', eventSchema, 'events'),
        Relationship: conn.model('Relationship', relationshipSchema, 'relationships'),
        Ledger: conn.model('Ledger', ledgerSchema, 'ledger'),
        Place: conn.model('Place', placeSchema, 'places'),
        Project: conn.model('Project', projectSchema, 'projects'),
    };
}
