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

/**
 * A settlement. The village's territory is a graph, and these are its nodes.
 *
 * `_id` IS THE NAME. It is a slug -- 'spawn', 'hearth', 'iron_ridge' -- and it
 * is the same string the villagers pass to `!goToRememberedPlace`, so it must
 * survive the tool->text->parser round trip byte-identically: lowercase, no
 * spaces, no punctuation (see toolCommandBridge.js, whose argument regex has no
 * unescaping).
 *
 * Making the name the primary key is also what makes this leaderless. Eight
 * independent processes have no coordinator and no startup order, so every
 * write here is a $setOnInsert upsert on a deterministic id: all eight may race
 * to found the same settlement and the result is identical. Anything requiring
 * an election would deadlock.
 */
const nodeSchema = new Schema({
    _id: String,
    kind: { type: String, default: 'outpost' },   // spawn|hearth|outpost
    label: String,
    centre: { x: Number, y: Number, z: Number },
    radius: { type: Number, default: 24 },
    purpose: String,                              // why this site: iron, wood, grass...
    // Safety is geometric, never measured. block.light and skyLight are bugged
    // in this version (see queries.js), so "is it safe here" is answered by
    // counting torches on a lattice rather than by asking the world how dark it
    // is. `safe` is litCells === cells.
    lit: {
        cells: { type: Number, default: 0 },
        litCells: { type: Number, default: 0 },
        safe: { type: Boolean, default: false },
        checkedBy: String,
        checkedAt: Date,
    },
    // Fences do NOT stop spawns -- spiders climb them and skeletons shoot over.
    // They keep villagers in, keep zombies and creepers from strolling through,
    // and make pathing predictable. Lighting is what does the safety work.
    fenced: {
        runs: { type: Number, default: 0 },
        doneRuns: { type: Number, default: 0 },
        checkedAt: Date,
    },
    chest: { x: Number, y: Number, z: Number },
    beds: [{ x: Number, y: Number, z: Number, claimedBy: String, at: Date }],
    foundedBy: String,
    projectId: String,
    foundedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
}, { _id: false, versionKey: false, minimize: false });

/**
 * A road between two settlements: the graph's edges.
 *
 * `_id` is the two endpoint names sorted and joined, so a road from the hearth
 * to spawn and one from spawn to the hearth are the same document and cannot
 * both be created. See `edgeKey`.
 */
const edgeSchema = new Schema({
    _id: String,
    a: String,
    b: String,
    segments: { type: Number, default: 0 },
    doneSegments: { type: Number, default: 0 },
    open: { type: Boolean, default: false },      // every segment built and lit
    checkedAt: Date,
    openedAt: Date,
    createdAt: { type: Date, default: Date.now },
}, { _id: false, versionKey: false });

/**
 * The village work board: one job, one villager, claimed atomically.
 *
 * This is how eight processes move as one organism without a leader. A claim
 * is a single findOneAndUpdate, first-writer-wins; there is no lock and no
 * coordinator.
 *
 * `_id` is deterministic ('road:spawn--hearth:seg:07') for the same reason the
 * nodes' are: all eight villagers may generate the same job list from the same
 * agreed project and the result is byte-identical, so generation needs no
 * coordination either.
 */
const jobSchema = new Schema({
    _id: String,
    kind: String,                    // road_segment|lattice_cell|fence_run|chest|bed
    ref: String,                     // the node or edge id this serves
    from: { x: Number, y: Number, z: Number },
    to: { x: Number, y: Number, z: Number },
    spec: { type: Object, default: {} },
    materials: { type: Object, default: {} },
    priority: { type: Number, default: 0 },
    roles: [String],                 // empty means anyone
    claimedBy: String,
    claimedAt: Date,
    // Claims expire. On hard difficulty a villager WILL die mid-job, and
    // without this that segment is orphaned for ever.
    attempts: { type: Number, default: 0 },
    doneAt: Date,
    doneBy: String,
    createdAt: { type: Date, default: Date.now },
}, { _id: false, versionKey: false, minimize: false });

jobSchema.index({ doneAt: 1, priority: -1 });
jobSchema.index({ claimedBy: 1, doneAt: 1 });

export const relKey = (from, to) => `${from}->${to}`;

/** Endpoint order must never create a second road. */
export const edgeKey = (a, b) => [a, b].sort().join('--');

export function buildModels(conn) {
    return {
        Agent: conn.model('Agent', agentSchema, 'agents'),
        Event: conn.model('Event', eventSchema, 'events'),
        Relationship: conn.model('Relationship', relationshipSchema, 'relationships'),
        Ledger: conn.model('Ledger', ledgerSchema, 'ledger'),
        Place: conn.model('Place', placeSchema, 'places'),
        Project: conn.model('Project', projectSchema, 'projects'),
        Node: conn.model('Node', nodeSchema, 'nodes'),
        Edge: conn.model('Edge', edgeSchema, 'edges'),
        Job: conn.model('Job', jobSchema, 'jobs'),
    };
}
