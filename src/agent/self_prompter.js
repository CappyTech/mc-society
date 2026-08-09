const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    /**
     * How long a pause may persist with no conversation before it is treated
     * as lost. Generous, because a real conversation can have long gaps while
     * the other side is mid-action.
     */
    static RESUME_AFTER_MS = 60000;

    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.paused_idle_time = 0;
        this.cooldown = 2000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    break;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    /**
     * @param {number} delta ms since the last update
     * @param {boolean} inConversation whether a conversation is actually in
     *   progress. Passed in rather than imported: conversation.js reaches this
     *   class through `agent`, so importing it back would create a cycle
     *   through commands/index.js for no benefit.
     */
    update(delta, inConversation = false) {
        // A pause with nothing left to pause for.
        //
        // Conversation pauses self-prompting and relies on endConversation to
        // resume it. When a conversation never formally ends -- the partner
        // restarted, the other side stopped replying, a talk simply trailed off
        // -- the villager stays PAUSED for ever. They stay logged in, look
        // perfectly healthy, and never take another action.
        //
        // Measured in an unprompted run: four of eight villagers sat PAUSED and
        // the whole village produced three actions in twenty-five minutes.
        //
        // So: if we are paused and no conversation is actually in progress,
        // resume. Deliberately not a fix inside conversation.js -- the loss
        // happens in several places and this is the one that can observe the
        // end state rather than every route into it.
        if (this.state === PAUSED) {
            // Not stuck if a conversation is live, or if the villager is still
            // busy finishing an action.
            if (inConversation || !this.agent.isIdle?.()) {
                this.paused_idle_time = 0;
            } else {
                this.paused_idle_time = (this.paused_idle_time || 0) + delta;
                if (this.paused_idle_time >= SelfPrompter.RESUME_AFTER_MS) {
                    console.warn(`${this.agent.name}: self-prompting was left paused with no conversation; resuming.`);
                    this.paused_idle_time = 0;
                    this.state = ACTIVE;
                    this.startLoop();
                    return;
                }
            }
        }

        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}