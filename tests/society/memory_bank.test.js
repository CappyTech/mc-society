/**
 * Memory persistence.
 *
 * Two bugs are pinned here, both of which failed silently in production:
 *
 * 1. MemoryBank.getJson()/loadJson() existed but were called from nowhere, so
 *    every !rememberHere and the automatic last_death_position were lost on
 *    restart -- while !rememberHere sits in every villager's core tool set.
 * 2. summarizeMemories stored whatever the model adapter returned, so seven of
 *    eight villagers' entire long-term memory was the literal string
 *    'My brain disconnected, try again.', rewritten on every summarisation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { History } from '../../src/agent/history.js';
import { MemoryBank } from '../../src/agent/memory_bank.js';

// History writes to ./bots/<name>/, relative to the working directory.
process.chdir(mkdtempSync(path.join(tmpdir(), 'mcs-memory-')));

function fakeAgent(name, { memory_bank = new MemoryBank(), summary = null } = {}) {
    return {
        name,
        memory_bank,
        last_sender: null,
        self_prompter: { state: 'stopped', isStopped: () => true, prompt: null },
        task: { taskStartTime: 0 },
        prompter: { promptMemSaving: async () => summary },
    };
}

test('a remembered place survives a save/load cycle', () => {
    const agent = fakeAgent('Odile');
    agent.memory_bank.rememberPlace('build_small_wood_house', 122, 64, -310);
    new History(agent).save();

    const reloaded = fakeAgent('Odile');
    new History(reloaded).load();
    assert.deepEqual(reloaded.memory_bank.recallPlace('build_small_wood_house'), [122, 64, -310]);
});

test('a memory file written before the fix still loads', () => {
    // Every file in production today has no memory_bank key. Loading one must
    // not throw, or the whole village fails to start.
    const name = 'Legacy';
    mkdirSync(`./bots/${name}/histories`, { recursive: true });
    writeFileSync(`./bots/${name}/memory.json`, JSON.stringify({
        memory: 'something old', turns: [{ role: 'user', content: 'hi' }],
    }));

    const agent = fakeAgent(name);
    const h = new History(agent);
    assert.doesNotThrow(() => h.load());
    assert.equal(h.memory, 'something old');
    assert.equal(h.turns.length, 1);
    assert.deepEqual(agent.memory_bank.getJson(), {});
});

test('an agent with no places saves an empty bank, not a crash', () => {
    const agent = fakeAgent('Bram');
    new History(agent).save();
    const saved = JSON.parse(readFileSync('./bots/Bram/memory.json', 'utf8'));
    assert.deepEqual(saved.memory_bank, {});
});

test('a failed summarisation keeps the previous memory', async () => {
    const agent = fakeAgent('Wren', { summary: 'My brain disconnected, try again.' });
    const h = new History(agent);
    h.memory = 'Corin still owes me a pickaxe.';
    await h.summarizeMemories([]);
    assert.equal(h.memory, 'Corin still owes me a pickaxe.',
        'the adapter error string overwrote a real memory');
});

test('an empty summarisation keeps the previous memory', async () => {
    const agent = fakeAgent('Nia', { summary: '' });
    const h = new History(agent);
    h.memory = 'Tobias took my wheat and gave nothing back.';
    await h.summarizeMemories([]);
    assert.equal(h.memory, 'Tobias took my wheat and gave nothing back.');
});

test('a good summarisation still replaces the memory, and still truncates', async () => {
    const agent = fakeAgent('Sable', { summary: 'x'.repeat(600) });
    const h = new History(agent);
    h.memory = 'old';
    await h.summarizeMemories([]);
    assert.notEqual(h.memory, 'old', 'a usable summary must be stored');
    assert.ok(h.memory.startsWith('x'));
    // Upstream's 500-char cap plus its suffix; unchanged by this fix.
    assert.ok(h.memory.includes('Memory truncated to 500 chars'));
});

test('a memory file already poisoned by the bug heals on load', async () => {
    // Guarding the write alone never repairs what the bug already wrote: load()
    // reads the error string back and save() writes it out again, so a villager
    // keeps it permanently. Five of eight were in that state.
    const name = 'Poisoned';
    mkdirSync(`./bots/${name}/histories`, { recursive: true });
    writeFileSync(`./bots/${name}/memory.json`, JSON.stringify({
        memory: 'My brain disconnected, try again.', turns: [],
    }));
    const h = new History(fakeAgent(name));
    h.load();
    assert.equal(h.memory, '', 'the poisoned memory survived a reload');
});
