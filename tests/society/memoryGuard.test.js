/**
 * A villager must never remember an error message.
 *
 * THIS BUG HAS SHIPPED TWICE. In 2026-07 seven of eight villagers' entire
 * long-term memory was the literal text "My brain disconnected, try again."; a
 * guard was written for it. In 2026-08 all eight read "No suitable model is
 * loaded on the inference server..." -- a sentinel added later by unrelated
 * work, which the guard did not know about.
 *
 * So the interesting assertion is not "these two strings are rejected". It is
 * that the rejection is DRIVEN BY THE REGISTRY: every test below iterates
 * KNOWN_FAILURE_TEXT rather than naming a string, so a sentinel added to that
 * array is automatically covered here, and a sentinel added anywhere ELSE has
 * nowhere to hide. The defect was a hand-maintained second list; a test that
 * hand-maintained a third would have reproduced it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
    KNOWN_FAILURE_TEXT, NO_MODEL, isUsableMemory, scrubMemory, LLMUnavailable,
} from '../../src/society/memoryGuard.js';

test('the registry is not empty, and holds both sentinels seen in the wild', () => {
    // Not a tautology: an empty registry would make every test below vacuous
    // and the guard inert, which is exactly the state that shipped twice.
    assert.ok(KNOWN_FAILURE_TEXT.length >= 2);
    assert.ok(KNOWN_FAILURE_TEXT.includes(NO_MODEL), 'the 2026-08 sentinel');
    assert.ok(KNOWN_FAILURE_TEXT.includes('My brain disconnected, try again.'), 'the 2026-07 one');
});

test('every registered failure string is refused as a memory', () => {
    for (const bad of KNOWN_FAILURE_TEXT) {
        assert.equal(isUsableMemory(bad), false, `accepted: ${bad.slice(0, 40)}`);
        assert.equal(scrubMemory(bad), '', `not scrubbed: ${bad.slice(0, 40)}`);
    }
});

test('a failure string QUOTED INSIDE a longer summary is still refused', () => {
    // The summariser is asked to compress, and a model handed an error string in
    // its input has been observed quoting it back mid-sentence. Equality would
    // pass that straight through, which is why the check is substring-based.
    for (const bad of KNOWN_FAILURE_TEXT) {
        const quoted = `Goal: mine iron. Note: the server said "${bad}" so I waited.`;
        assert.equal(isUsableMemory(quoted), false, `accepted quoted: ${bad.slice(0, 30)}`);
    }
});

test('real memories, and only real memories, survive', () => {
    // Taken verbatim from the last clean backup, so a future change that makes
    // the guard too aggressive fails here rather than in production.
    const real = [
        'Corin has iron, timed out x4 (urgent). Odile needs cobble/shelters (trade active). Stone wall @16,64,95',
        'Loc: Village. Goal: Forester - fell/replant oaks for stockpile. Ensure regrowth while gathering.',
        'Role: Builder/Housing. Team: Bram(miner-busy), Nia(farmer), Corin(smith).',
    ];
    for (const m of real) {
        assert.equal(isUsableMemory(m), true, `wrongly refused: ${m.slice(0, 40)}`);
        assert.equal(scrubMemory(m), m);
    }
});

test('empty, blank and non-string memories are refused', () => {
    for (const junk of ['', '   ', '\n', null, undefined, 42, {}, []]) {
        assert.equal(isUsableMemory(junk), false, `accepted: ${JSON.stringify(junk)}`);
        assert.equal(scrubMemory(junk), '');
    }
});

test('LLMUnavailable carries whether retrying could ever help', () => {
    const terminal = new LLMUnavailable(NO_MODEL, { terminal: true });
    assert.equal(terminal.terminal, true);
    assert.ok(terminal instanceof Error, 'must be catchable as an ordinary Error');
    // Default is the cautious direction: a caller that forgets to say assumes
    // the failure might pass, and retries rather than declaring cognition dead.
    assert.equal(new LLMUnavailable('timeout').terminal, false);
});

/**
 * The end-to-end invariant, against the real History class.
 *
 * This is the test whose absence let the bug ship twice: modelResolver had 24
 * tests and history.js had none, so nothing connected "the adapter returns a
 * sentinel" to "the sentinel is on disk for ever".
 */
async function historyIn(dir, prompterResult) {
    const { History } = await import('../../src/agent/history.js');
    mkdirSync(path.join(dir, 'bots'), { recursive: true });
    process.chdir(dir);
    const agent = {
        name: 'Testling',
        prompter: { promptMemSaving: () => Promise.resolve(prompterResult) },
        memory_bank: { getJson: () => ({}), loadJson: () => {} },
        self_prompter: { state: 0, isStopped: () => true, prompt: null },
        task: { taskStartTime: 0 },
        last_sender: null,
    };
    const h = new History(agent);
    return h;
}

test('a failed summarisation keeps the previous memory, for every sentinel', async (t) => {
    const cwd = process.cwd();
    t.after(() => process.chdir(cwd));

    // Both shapes that have caused this: the out-of-band failure report, and a
    // superficially successful call whose text is a known sentinel.
    const failures = [
        { ok: false, text: '', error: 'no model' },
        ...KNOWN_FAILURE_TEXT.map((bad) => ({ ok: true, text: bad })),
    ];

    for (const result of failures) {
        const dir = mkdtempSync(path.join(tmpdir(), 'mcs-mem-'));
        const h = await historyIn(dir, result);
        h.memory = 'Goal: mine iron with Corin. Village @-30,62,81.';
        await h.summarizeMemories([{ role: 'user', content: 'hi' }]);
        assert.equal(h.memory, 'Goal: mine iron with Corin. Village @-30,62,81.',
            `memory was overwritten by ${JSON.stringify(result).slice(0, 60)}`);
    }
});

test('a good summarisation does replace the memory', async (t) => {
    const cwd = process.cwd();
    t.after(() => process.chdir(cwd));
    const dir = mkdtempSync(path.join(tmpdir(), 'mcs-mem-'));
    const h = await historyIn(dir, { ok: true, text: 'Goal: fell oaks. Wren has the axe.' });
    h.memory = 'old';
    await h.summarizeMemories([{ role: 'user', content: 'hi' }]);
    assert.equal(h.memory, 'Goal: fell oaks. Wren has the axe.');
});

test('a memory file already poisoned heals on load, and cannot be re-saved', async (t) => {
    // Guarding only the write path stops new corruption but never repairs what it
    // already wrote -- load() reads the string back and save() writes it out
    // again, so a villager keeps it for ever. Eight of eight were in that state.
    const cwd = process.cwd();
    t.after(() => process.chdir(cwd));

    for (const bad of KNOWN_FAILURE_TEXT) {
        const dir = mkdtempSync(path.join(tmpdir(), 'mcs-mem-'));
        const h = await historyIn(dir, { ok: false });
        mkdirSync(path.dirname(h.memory_fp), { recursive: true });
        writeFileSync(h.memory_fp, JSON.stringify({ memory: bad, turns: [] }));

        h.load();
        assert.equal(h.memory, '', `load() kept a poisoned memory: ${bad.slice(0, 40)}`);

        // And the write path refuses it even if it arrives from somewhere else.
        h.memory = bad;
        await h.save();
        assert.equal(JSON.parse(readFileSync(h.memory_fp, 'utf8')).memory, '',
            `save() persisted a sentinel: ${bad.slice(0, 40)}`);
    }
});

test('a real memory round-trips through save and load untouched', async (t) => {
    const cwd = process.cwd();
    t.after(() => process.chdir(cwd));
    const dir = mkdtempSync(path.join(tmpdir(), 'mcs-mem-'));
    const h = await historyIn(dir, { ok: false });
    mkdirSync(path.dirname(h.memory_fp), { recursive: true });
    h.memory = 'Loc: Village. Goal: Smelt iron, craft tools for the village.';
    await h.save();
    h.memory = 'clobbered';
    h.load();
    assert.equal(h.memory, 'Loc: Village. Goal: Smelt iron, craft tools for the village.');
});
