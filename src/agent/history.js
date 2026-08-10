import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { isUsableMemory, scrubMemory } from '../society/memoryGuard.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        const result = await this.agent.prompter.promptMemSaving(turns);

        // Keep the previous memory rather than overwriting it with a failure.
        //
        // TWO independent checks, because this has been got wrong twice. `ok`
        // is the real contract -- promptMemSaving now reports failure out of
        // band, so a failure is not a string and cannot be stored by accident.
        // isUsableMemory is the backstop for text that arrived looking fine and
        // is in fact a known adapter error string; the single definition site
        // for those lives in src/society/memoryGuard.js, because the previous
        // version of this guard was a literal compared in two places and they
        // drifted the moment a new sentinel was introduced.
        //
        // A bad summary is worse than a stale one, so on failure we keep what
        // we had. See docs/reasoning-model.md for why the prose path is unfixed.
        if (!result?.ok || !isUsableMemory(result.text)) {
            console.warn('Memory summarisation produced nothing usable; keeping the previous memory.');
            return;
        }
        this.memory = result.text;

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                // Last line of defence. summarizeMemories should never have set
                // an unusable memory, and load() scrubs anything already on
                // disk -- but this is the only function that WRITES the file, so
                // enforcing it here is what makes "a stored failure" impossible
                // rather than merely unlikely. It also means a poisoned file
                // repairs itself on the next save with no migration.
                memory: scrubMemory(this.memory),
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                // MemoryBank had getJson()/loadJson() defined but called from
                // nowhere, so every !rememberHere -- and the automatically
                // saved last_death_position -- was lost on restart, while
                // !rememberHere sits in every villager's core tool set.
                memory_bank: this.agent.memory_bank?.getJson?.() ?? {}
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            // Discard a memory file already poisoned by the bug above. Guarding
            // only the write stops new corruption but never repairs the files
            // it already wrote: load() reads the error string back and save()
            // writes it out again, so a villager keeps it forever. Five of eight
            // were in that state in 2026-07, and eight of eight in 2026-08 with
            // a different sentinel -- which is why the list is now in one place.
            this.memory = scrubMemory(data.memory || '');
            this.turns = data.turns || [];
            // Absent in every memory file written before this was fixed, so it
            // must stay optional -- those files are in production right now.
            if (data.memory_bank) this.agent.memory_bank?.loadJson(data.memory_bank);
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}