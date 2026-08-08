/**
 * Liveness signal for the village container.
 *
 * WHY
 * ---
 * `mcs-village` had no healthcheck, and the failure it needs to catch is not a
 * crash. When the inference server was loaded with a 768-token context, all
 * eight villagers connected, appeared in the player list, and failed every
 * single turn -- for hours -- while `docker ps` reported `Up` and the process
 * stayed perfectly alive. A supervisor watching for exits sees nothing wrong.
 *
 * So liveness is defined as work completed, not as a process existing: a beat
 * is written only when a villager actually finishes a turn.
 *
 * Deliberately NOT a restart trigger. A compose healthcheck marks the container
 * unhealthy and leaves it running, which is what we want -- when the cause is
 * the inference server being down, restarting the village fixes nothing and a
 * restart loop would bury the real signal.
 */

import { writeFileSync, statSync } from 'fs';

export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/mcs-village-heartbeat';

/** Default staleness threshold. Turns normally land every few seconds. */
export const MAX_AGE_MS = Number(process.env.HEARTBEAT_MAX_AGE_MS || 10 * 60 * 1000);

/**
 * Record that a villager completed a turn.
 *
 * Never throws: a full or read-only /tmp must not take down an agent that is
 * otherwise working. Health reporting is not worth a villager.
 */
export function beat(who = '') {
    try {
        writeFileSync(HEARTBEAT_FILE, `${Date.now()} ${who}\n`);
    } catch { /* health reporting is best-effort */ }
}

/**
 * @returns {{ok: boolean, ageMs: number|null, reason: string}}
 */
export function check(maxAgeMs = MAX_AGE_MS) {
    let mtime;
    try {
        mtime = statSync(HEARTBEAT_FILE).mtimeMs;
    } catch {
        // Before the first completed turn there is no file. That is the
        // start-up state, and it is why the compose healthcheck needs a
        // start_period long enough for eight agents to connect and think.
        return { ok: false, ageMs: null, reason: 'no turn has completed yet' };
    }
    const ageMs = Date.now() - mtime;
    return ageMs <= maxAgeMs
        ? { ok: true, ageMs, reason: `last turn ${Math.round(ageMs / 1000)}s ago` }
        : { ok: false, ageMs, reason: `no turn completed for ${Math.round(ageMs / 1000)}s` };
}
