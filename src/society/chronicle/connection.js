/**
 * The Chronicle's database connection, and its promise never to break a turn.
 *
 * THE CONTRACT
 * ------------
 * The village must keep running when Mongo is unreachable. Not "mostly" -- at
 * all. Eight villagers each take a turn every few seconds; if a single query
 * can block, one slow database multiplies into a village that has gone silent,
 * and it looks exactly like the inference server dying. That misdiagnosis has
 * already cost this project a session.
 *
 * So: no write is ever awaited on a turn, every read races a short timeout, and
 * with no URI configured the whole module is inert.
 */

import mongoose from 'mongoose';
import { buildModels } from './models.js';

/** How long a read may take before the brief gives up and renders without it. */
export const READ_TIMEOUT_MS = 250;

let conn = null;
let models = null;
let state = 'off';        // off | connecting | up | down
let lastLogAt = 0;

/** Rate-limited, because eight agent processes failing every turn would bury the log. */
function note(msg) {
    const now = Date.now();
    if (now - lastLogAt < 60_000) return;
    lastLogAt = now;
    console.warn(`[chronicle] ${msg}`);
}

export function isUp() { return state === 'up'; }
export function getState() { return state; }
export function getModels() { return state === 'up' ? models : null; }

/**
 * Begin connecting. Returns immediately; never throws, never awaited by a turn.
 */
export function connect(uri = process.env.CHRONICLE_MONGO_URI) {
    if (!uri) { state = 'off'; return; }      // not configured: stay inert, silently
    if (conn) return;

    state = 'connecting';
    try {
        conn = mongoose.createConnection(uri, {
            serverSelectionTimeoutMS: 3000,
            // LOAD-BEARING. Mongoose's default (true) makes a query issued while
            // disconnected *hang* until it times out, instead of failing. That
            // is precisely the stall this module must not be able to cause.
            bufferCommands: false,
            // Eight separate agent processes each open their own pool. This host
            // has already lost a MongoDB to file-descriptor exhaustion once.
            maxPoolSize: 3,
        });

        models = buildModels(conn);

        conn.on('connected', () => { state = 'up'; console.log('[chronicle] connected'); });
        conn.on('disconnected', () => { state = 'down'; note('disconnected; village continues without it'); });
        conn.on('error', (e) => { state = 'down'; note(`connection error: ${e?.message || e}`); });
    } catch (e) {
        state = 'down';
        note(`could not initialise: ${e?.message || e}`);
    }
}

/**
 * Await a query, but never for long, and never fatally.
 * @returns the query's result, or `fallback`
 */
export async function read(fn, fallback) {
    if (state !== 'up' || !models) return fallback;
    try {
        return await Promise.race([
            fn(models),
            new Promise((resolve) => setTimeout(() => resolve(fallback), READ_TIMEOUT_MS)),
        ]);
    } catch (e) {
        note(`read failed: ${e?.message || e}`);
        return fallback;
    }
}

export async function close() {
    if (!conn) return;
    try { await conn.close(); } catch { /* shutting down anyway */ }
    conn = null; models = null; state = 'off';
}

/** Test seam: force a state without a database. */
export function _setStateForTests(s) { state = s; }
