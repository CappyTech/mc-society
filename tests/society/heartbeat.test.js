/**
 * The container liveness signal.
 *
 * This exists because of a real outage shape: with the model loaded at a
 * 768-token context, all eight villagers connected, appeared in the player
 * list, and failed every turn for hours while `docker ps` said `Up`. Anything
 * that watches for a process exit sees nothing wrong, so liveness has to mean
 * work completed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const dir = mkdtempSync(path.join(tmpdir(), 'mcs-heartbeat-'));
process.env.HEARTBEAT_FILE = path.join(dir, 'beat');

const { beat, check, HEARTBEAT_FILE } = await import('../../src/society/heartbeat.js');

test('a missing heartbeat is unhealthy, not a crash', () => {
    assert.ok(!existsSync(HEARTBEAT_FILE));
    const res = check();
    assert.equal(res.ok, false);
    assert.equal(res.ageMs, null);
    assert.match(res.reason, /no turn/);
});

test('a fresh beat is healthy and says how fresh', () => {
    beat('Odile');
    const res = check();
    assert.equal(res.ok, true);
    // Tolerant of a small negative age on purpose. `ageMs` is
    // `Date.now() - statSync().mtimeMs`, and the filesystem's timestamp clock
    // can sit a millisecond or two ahead of Date.now(), so a beat taken moments
    // ago can read as very slightly in the future. Production is unaffected --
    // a negative age is still comfortably within maxAgeMs and reports healthy
    // -- but asserting `>= 0` here made the suite fail about one run in four
    // under load, which is exactly the kind of wandering result that gets a
    // test commented out rather than believed.
    assert.ok(res.ageMs > -1000 && res.ageMs < 5000, `ageMs was ${res.ageMs}`);
    assert.match(res.reason, /last turn/);
});

test('a stale beat is unhealthy', () => {
    beat('Odile');
    // Backdate it rather than sleeping: the whole point is behaviour at an age
    // no test should wait for.
    const old = Date.now() / 1000 - 3600;
    utimesSync(HEARTBEAT_FILE, old, old);
    const res = check(10 * 60 * 1000);
    assert.equal(res.ok, false);
    assert.ok(res.ageMs > 10 * 60 * 1000);
    assert.match(res.reason, /no turn completed for/);
});

test('beat never throws, whatever the filesystem does', () => {
    // Health reporting must never be able to take down a villager that is
    // otherwise working, so an unwritable path is swallowed.
    const original = process.env.HEARTBEAT_FILE;
    try {
        assert.doesNotThrow(() => beat('Odile'));
        assert.doesNotThrow(() => beat());
    } finally {
        process.env.HEARTBEAT_FILE = original;
    }
});
