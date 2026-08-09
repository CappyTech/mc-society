/**
 * Which modes may switch a villager off.
 *
 * The failure this guards is specific and was expensive: `modes.js` `execute()`
 * stopped the self-prompt loop on EVERY mode execution, so `torch_placing`
 * retrying on a 5-second timer against a spot that could not take a torch left
 * eight villagers standing still -- 28 failures in 25 minutes. The mode was
 * switched off to recover, which treated the symptom rather than the cause.
 *
 * Two halves are pinned here, because they live in different files and cannot
 * see each other: the rule itself, and the fact that `modes.js` actually calls
 * it. Either half alone can regress silently -- the villagers simply stop
 * acting, and nothing is logged above info.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { preemptsGoal } from '../../src/society/modeGuard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// modes.js pulls in mineflayer, so it is read as text rather than imported.
// That is also the honest way to pin a declaration: it is the literal source
// somebody would edit.
const modesSrc = readFileSync(path.join(root, 'src/agent/modes.js'), 'utf8');

/** The literal `interrupts` array declared for a mode in modes.js. */
function declaredInterrupts(name) {
    const block = modesSrc.split(`name: '${name}'`)[1];
    assert.ok(block, `mode ${name} not found in modes.js`);
    const m = block.match(/interrupts:\s*\[([^\]]*)\]/);
    assert.ok(m, `mode ${name} declares no interrupts`);
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('a mode that interrupts everything may stop the goal loop', () => {
    // These are the modes whose whole purpose is to override what the villager
    // was doing. Drowning must be able to end a turn.
    for (const name of ['self_preservation', 'unstuck', 'cowardice', 'self_defense']) {
        const interrupts = declaredInterrupts(name);
        assert.ok(interrupts.includes('all'), `${name} should interrupt all`);
        assert.equal(preemptsGoal({ interrupts }), true, `${name} should preempt`);
    }
});

test('a cosmetic mode may not stop the goal loop', () => {
    // torch_placing is the one that found the bug. If somebody ever promotes it
    // to interrupts:['all'], this fails loudly instead of the village quietly
    // going still again.
    const interrupts = declaredInterrupts('torch_placing');
    assert.deepEqual(interrupts, ['action:followPlayer']);
    assert.equal(preemptsGoal({ interrupts }), false);

    for (const name of ['item_collecting', 'elbow_room', 'idle_staring']) {
        assert.equal(preemptsGoal({ interrupts: declaredInterrupts(name) }), false, name);
    }
});

test('an explicit preempt_goal overrides what the mode interrupts', () => {
    // The escape hatch, so a future mode can opt in or out without having to
    // lie about what it interrupts.
    assert.equal(preemptsGoal({ interrupts: ['all'], preempt_goal: false }), false);
    assert.equal(preemptsGoal({ interrupts: [], preempt_goal: true }), true);
});

test('a malformed mode is not allowed to preempt, and does not throw', () => {
    // Called from upstream code that CI does not lint. An exception here would
    // reproduce the exact failure being fixed: villagers standing still.
    for (const bad of [undefined, null, {}, { interrupts: null }, { interrupts: 'all' }]) {
        assert.doesNotThrow(() => preemptsGoal(bad));
        assert.equal(preemptsGoal(bad), false);
    }
});

test('modes.js actually guards its stopLoop call', () => {
    // The other half of the fix, in a file the tests cannot import. Without
    // this line the rule above is dead code and nothing else would notice.
    assert.match(modesSrc, /import \{ preemptsGoal \} from '\.\.\/society\/modeGuard\.js'/);
    assert.match(modesSrc, /if \(preemptsGoal\(mode\) && agent\.self_prompter\.isActive\(\)\)\s*\n\s*agent\.self_prompter\.stopLoop\(\);/);
});

test('torch_placing backs off instead of retrying forever', () => {
    // A spot that cannot take a torch does not become placeable by asking again
    // five seconds later. placeBlock returns a boolean; the mode must use it.
    const block = modesSrc.split("name: 'torch_placing'")[1].split('},')[0];
    assert.match(block, /backoff:\s*1/);
    assert.match(block, /max_backoff:\s*64/);
    assert.match(block, /this\.cooldown \* this\.backoff \* 1000/);
    assert.match(block, /this\.backoff = placed \? 1 : Math\.min\(this\.backoff \* 2, this\.max_backoff\)/);
});
