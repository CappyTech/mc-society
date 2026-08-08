/**
 * Container healthcheck: has any villager completed a turn recently?
 *
 *   docker compose healthcheck -> node scripts/healthcheck.mjs
 *
 * Exit 0 healthy, 1 unhealthy. See src/society/heartbeat.js for why liveness is
 * measured in completed turns rather than in the process still existing.
 */
import { check } from '../src/society/heartbeat.js';

const res = check();
console.log(res.reason);
process.exit(res.ok ? 0 : 1);
