/**
 * Knowing whether thinking is possible at all.
 *
 * The turn loop could not tell "the model refused this prompt" from "there is no
 * model", so it treated a sixteen-hour outage as something worth retrying three
 * times per turn -- and, worse, counted those refusals toward the self-prompt
 * loop's give-up threshold, which STOPPED IT PERMANENTLY after three. Loading a
 * model would not have revived the village; only a container restart would.
 *
 * The most important property here is the direction of failure: this module
 * fails OPEN. A bug in it can waste requests, but it must never be able to
 * silence a village that could think -- silence is what cost sixteen hours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cognition from '../../src/society/cognition.js';

test('a fresh process assumes it can think', (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    assert.equal(cognition.available(), true);
    assert.equal(cognition.lastReason(), '');
});

test('a terminal failure suppresses attempts, and says why', (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTerminal('no suitable model is loaded');
    assert.equal(cognition.available(), false);
    assert.match(cognition.lastReason(), /no suitable model/);
});

test('a transient failure does NOT suppress attempts', (t) => {
    // A timeout or a reset says nothing about whether a model is loaded, and the
    // right response is to try again -- so this must not look like an outage.
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTransient();
    assert.equal(cognition.available(), true);
});

test('reaching the server again clears a stale terminal verdict', (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTerminal('no model');
    assert.equal(cognition.available(), false);
    cognition.noteTransient();      // we got far enough to time out, so it is up
    assert.equal(cognition.available(), true);
});

test('a completed turn clears everything', (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTerminal('no model');
    cognition.noteOk();
    assert.equal(cognition.available(), true);
    assert.equal(cognition.lastReason(), '');
});

test('backoff grows with consecutive failures and is capped', (t) => {
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();

    cognition.noteTerminal('x');
    const first = cognition.backoffMs();
    cognition.noteTerminal('x');
    cognition.noteTerminal('x');
    const later = cognition.backoffMs();
    assert.ok(later > first, `backoff did not grow: ${first} -> ${later}`);

    for (let i = 0; i < 40; i++) cognition.noteTerminal('x');
    // 60s ceiling plus the +/-25% jitter band.
    assert.ok(cognition.backoffMs() <= 60000 * 1.25, `uncapped: ${cognition.backoffMs()}`);
});

test('the backoff window is fixed when the failure is recorded, not re-rolled', (t) => {
    // Jitter spreads eight villagers out so they do not all return at once. But
    // a window re-rolled on every available() call is not a window: the same
    // instant would read as expired or not depending on the die.
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTerminal('x');
    const readings = new Set();
    for (let i = 0; i < 50; i++) readings.add(cognition.backoffMs());
    assert.equal(readings.size, 1, `window wobbled across ${readings.size} values`);
});

test('the suppression expires on its own', (t) => {
    // The village must resume without anyone restarting anything, which is the
    // whole point -- a permanent stop is the bug this replaces.
    t.after(() => cognition._resetForTests());
    cognition._resetForTests();
    cognition.noteTerminal('x');
    assert.equal(cognition.available(), false);

    // Rather than sleeping 5s, verify the expiry is time-based by advancing the
    // clock the module reads.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000;
    try {
        assert.equal(cognition.available(), true);
    } finally {
        Date.now = realNow;
    }
});
