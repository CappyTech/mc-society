/**
 * Reflexes that stop instead of thrashing.
 *
 * MEASURED over the sixteen-hour outage of 2026-08-09, during which no villager
 * took a single LLM turn but every mode kept running:
 *
 *     "Moved 24 away from enemies."   x865, always the same number
 *     deaths                          90, on DIFFICULTY=easy
 *     CPU                             ~31%, all of it reflexes
 *
 * A villager made only of reflexes is not a simplified villager, it is a
 * thrashing one -- every way of actually BECOMING safe (shelter, light, a bed) is
 * a tool call, so flight without cognition just relocates it until something
 * kills it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    shouldRun, shouldRunNow, noteRun, isFlight, isVital,
    FLIGHT_MODES, VITAL_MODES, MAX_RUNS, WINDOW_MS, FLIGHT_DISTANCE, FLIGHT_TIMEOUT_MS,
    _resetForTests,
} from '../../src/society/reflex.js';

test('vital reflexes run even with no cognition', () => {
    // Drowning and creepers. Quiescing these would not be "obviously inert",
    // it would be suicide -- and the newest Chronicle event when this was written
    // was `Nia was slain by Drowned`.
    for (const mode of VITAL_MODES) {
        assert.equal(shouldRun(mode, { cognitionAvailable: false }).run, true, mode);
    }
});

test('vital reflexes are never rate-capped either', () => {
    // A creeper fuse is 1.5s and does not care how many times it has already
    // happened this minute.
    const now = Date.now();
    const recent = Array.from({ length: 50 }, (_, i) => now - i * 100);
    for (const mode of VITAL_MODES) {
        assert.equal(shouldRun(mode, { recent, now }).run, true, mode);
    }
});

test('flight reflexes stand down when there is no cognition', () => {
    for (const mode of FLIGHT_MODES) {
        const r = shouldRun(mode, { cognitionAvailable: false });
        assert.equal(r.run, false, mode);
        assert.match(r.reason, /no cognition/);
    }
});

test('every non-vital mode stands down without cognition, not just flight ones', () => {
    // The rule is about what a reflex can achieve alone, not a hand-listed set.
    // hunting, torch_placing, item_collecting and the rest all need a mind to be
    // worth anything.
    for (const mode of ['hunting', 'torch_placing', 'item_collecting', 'elbow_room', 'idle_staring']) {
        assert.equal(shouldRun(mode, { cognitionAvailable: false }).run, false, mode);
    }
});

test('hunting is NOT rate-capped -- that would throttle how they eat', () => {
    // It stands down without cognition like everything else, but capping it at
    // three a minute would be a food regression dressed up as a safety fix.
    assert.equal(isFlight('hunting'), false);
    const now = Date.now();
    const recent = Array.from({ length: 20 }, (_, i) => now - i * 500);
    assert.equal(shouldRun('hunting', { recent, now }).run, true);
});

test('a flight reflex is capped after MAX_RUNS in the window', () => {
    // Three flights in a minute is a treadmill, not three threats.
    const now = Date.now();
    const recent = Array.from({ length: MAX_RUNS }, (_, i) => now - i * 1000);
    const r = shouldRun('cowardice', { recent, now });
    assert.equal(r.run, false);
    assert.match(r.reason, /flights in 60s/);

    // Under the cap it still fires -- a real threat must not be ignored.
    assert.equal(shouldRun('cowardice', { recent: recent.slice(1), now }).run, true);
});

test('the cap is a sliding window, not a permanent ban', () => {
    // A villager attacked three times an hour ago must still be able to flee.
    const now = Date.now();
    const old = Array.from({ length: 10 }, (_, i) => now - WINDOW_MS - i * 1000);
    assert.equal(shouldRun('cowardice', { recent: old, now }).run, true);
});

test('noteRun feeds the cap, and only tracks flight modes', (t) => {
    t.after(() => _resetForTests());
    _resetForTests();

    for (let i = 0; i < MAX_RUNS; i++) {
        assert.equal(shouldRunNow('cowardice', true).run, true, `run ${i} should be allowed`);
        noteRun('cowardice');
    }
    assert.equal(shouldRunNow('cowardice', true).run, false, 'the cap did not engage');

    // A different flight mode has its own budget -- fleeing is not fighting.
    assert.equal(shouldRunNow('self_defense', true).run, true);

    // And an untracked mode is unaffected by the flight bookkeeping.
    for (let i = 0; i < 10; i++) noteRun('torch_placing');
    assert.equal(shouldRunNow('torch_placing', true).run, true);
});

test('flight distance matches the trigger radius, and is bounded in time', () => {
    // cowardice triggers at 16 and used to flee 24. avoidEnemies only exits once
    // nothing hostile is within the distance it was GIVEN, so 24 guaranteed the
    // villager kept walking into unexplored ground and met something new: the
    // trigger radius was smaller than the flight radius, which is a loop.
    assert.equal(FLIGHT_DISTANCE, 16, 'flight distance must not exceed the 16-block trigger');
    assert.ok(FLIGHT_TIMEOUT_MS > 0, 'a flight with no timeout can only end by succeeding');
    assert.ok(FLIGHT_TIMEOUT_MS <= 30000, 'a 30s+ flight is the treadmill again');
});

test('classification is exclusive: nothing is both vital and rate-capped', () => {
    for (const mode of FLIGHT_MODES) assert.equal(isVital(mode), false, mode);
    for (const mode of VITAL_MODES) assert.equal(isFlight(mode), false, mode);
});

test('with cognition and a clear window, everything is allowed', () => {
    // The default must be permissive. This module suppresses; it does not drive.
    for (const mode of [...FLIGHT_MODES, ...VITAL_MODES, 'hunting', 'unknown_mode']) {
        assert.equal(shouldRun(mode, { cognitionAvailable: true, recent: [] }).run, true, mode);
    }
});
