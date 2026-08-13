import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';
import { resolveModel, MIN_EMBED_CONTEXT, ROLE } from '../society/modelResolver.js';
import { NO_MODEL, LLMUnavailable } from '../society/memoryGuard.js';
import { withSlot } from '../society/inferenceSlots.js';

export class LMStudio {
    static prefix = 'lmstudio';
    /** Retries for a contended KV pool. See sendToolRequest. */
    static POOL_RETRIES = 3;
    static POOL_BACKOFF_MS = 1500;
    constructor(model_name, url, params) {
        this.model_name = model_name;
        // agent_name is ours, not OpenAI's. It has to come out of params before
        // they are spread into the request pack, or it goes over the wire as an
        // unknown field on every single call.
        const { agent_name, ...rest } = params ?? {};
        this.params = rest;
        this.agent_name = agent_name ?? '';
        // The id in a profile is a preference, not an instruction. It has been
        // wrong three ways in one afternoon -- a quantisation suffix, a second
        // instance nobody loaded, a sibling catalogue entry -- and every time
        // the villagers connected, looked healthy and took zero turns. Reconcile
        // against what LM Studio actually has. See society/modelResolver.js.
        // LM Studio DOES enforce this once "API key" is enabled in its server
        // settings -- a hardcoded placeholder gets a flat 401. Read it from the
        // environment so the key stays out of the repo and out of profiles.
        this.openai = new OpenAIApi({
            baseURL: url || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1',
            apiKey: process.env.LMSTUDIO_API_KEY || 'lm-studio',
        });
    }

    /**
     * Pull the assistant's visible text out of a completion.
     *
     * Reasoning models served by LM Studio put their chain of thought in a
     * separate `reasoning_content` field and leave `content` empty, so reading
     * `content` alone yields ''. We deliberately do NOT fall back to the
     * reasoning text -- it is not an answer, and surfacing it would put the
     * model's private deliberation into the game chat.
     */
    static extractText(message) {
        let res = message?.content ?? '';
        if (res && res.includes('</think>')) {
            if (!res.includes('<think>')) res = '<think>' + res;
            res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        }
        return res;
    }

    /**
     * The model id to actually send, resolved once against what is loaded.
     *
     * No hardcoded fallback id. There used to be one (`andy-4.1`), and by the
     * time anyone looked it was wrong by a minor version -- a stale literal is
     * precisely the failure modelResolver.js exists to remove, so leaving one in
     * the fallback position was self-defeating. An empty model_name resolves to
     * nothing and the caller declines, which is the honest outcome.
     */
    model() {
        // Deliberately NOT memoised here. resolveModel caches the list of
        // loaded models for a few seconds and re-decides against it every time;
        // holding the decision on the client would reintroduce the exact bug
        // that caching solved -- a villager pinned to an instance LM Studio has
        // since evicted, recreating it by name on every turn.
        return resolveModel(this.model_name, this.agent_name, { role: ROLE.CHAT });
    }

    /**
     * Nothing suitable is loaded, so send nothing.
     *
     * Sending anyway is not a neutral act -- LM Studio would load a model to
     * answer, at whatever context it felt like, evicting whatever was resident.
     * Declining leaves the villager visibly unable to think, which is a
     * five-second diagnosis and one deliberate `lms load` to fix.
     *
     * DEFINED IN src/society/memoryGuard.js, re-exported here for callers that
     * still reach for LMStudio.NO_MODEL. It has to be the same string as the one
     * the memory guard refuses to store -- when those two drifted apart, this
     * text became eight villagers' entire long-term memory.
     */
    static NO_MODEL = NO_MODEL;

    /**
     * Ask for a mandatory tool call.
     *
     * This is the only reliable way to bound a reasoning model's output: given
     * an open-ended request, Qwen 3.5 spends every permitted token thinking and
     * returns nothing. `tool_choice: 'required'` gives it a termination
     * condition it respects (measured: 176 reasoning tokens, then a correct
     * call). Six other suppression methods were tried and all failed --
     * enable_thinking:false, /no_think in system, /no_think in user, the
     * unquantised model id, reasoning:{enabled:false}, and json_schema
     * structured output.
     *
     * @returns {Promise<{tool_calls: object[], text: string, usage: object}>}
     */
    /*
     * OUTPUT BUDGET: 2048, raised from 1280 on 2026-08-10.
     *
     * `tool_choice: 'required'` bounds the model but does not make it brief, and
     * 1280 was cutting it off MID-THOUGHT on the turns that most needed thinking.
     * The failures all reported "spent all 1280 tokens", which looks like a model
     * that would fill any budget -- it is not. An easy turn emits a call in ~300
     * tokens; the ones that failed were the hard ones, and the logged reasoning
     * ends mid-sentence:
     *
     *   [tool-miss] Tobias said instead: "Okay, I need to figure out what Tobias
     *   should do next... First, looking at the NEEDS section: It's night, and
     *   Tobias is in the open with nothing"
     *
     * Deciding what to do at night while exposed is exactly when a villager should
     * be allowed to think, and exactly when it was being silenced.
     *
     * The budget is RESERVED IN THE KV POOL alongside the prompt, so this is not
     * free: 12,955 + 2,048 = 15,003, and 42,752 / 15,003 = 2.85, so it still fits
     * the cap of 2 in society/inferenceSlots.js with headroom. Raising it further
     * would cost a concurrent slot -- check that arithmetic before touching it.
     */
    async sendToolRequest(turns, systemMessage, tools, { tool_choice = 'required', max_tokens = 2048 } = {}) {
        const messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        const model = await this.model();
        if (!model) {
            // terminal: only an operator loading a model changes this, so the
            // turn loop must not spend its three retries on it.
            return { tool_calls: [], text: '', usage: null, error: NO_MODEL, terminal: true };
        }

        const pack = {
            model,
            messages,
            tools,
            tool_choice,
            max_tokens,
            ...(this.params || {}),
        };

        // "Context size has been exceeded" from a SHARED KV pool is contention,
        // not an oversized prompt: eight villagers against one instance's pool
        // means only two or three turns fit at once, and the rest are refused
        // outright. Refusing is transient -- the same prompt succeeds seconds
        // later -- so a short backoff recovers a turn that would otherwise be
        // thrown away. It is deliberately NOT a fix for a genuinely too-large
        // prompt, which fails identically every time and exhausts the retries.
        // The retries below recover a turn that lost a race. They cannot fix
        // being over capacity in the first place: eight villagers that fail
        // together back off together and collide again, which is how all three
        // attempts came to be consumed on every single turn. withSlot() is what
        // stops more than MAX_INFLIGHT of them being in flight at once, across
        // the eight separate villager processes. See society/inferenceSlots.js.
        let completion;
        try {
            completion = await withSlot(this.agent_name, async () => {
                for (let attempt = 0; ; attempt++) {
                    try {
                        return await this.openai.chat.completions.create(pack);
                    } catch (e) {
                        const contended = /context size has been exceeded/i.test(e?.message || '');
                        if (!contended || attempt >= LMStudio.POOL_RETRIES) throw e;
                        await new Promise((r) => setTimeout(r, LMStudio.POOL_BACKOFF_MS * (attempt + 1)));
                    }
                }
            });
            const choice = completion.choices[0];
            const calls = choice.message?.tool_calls ?? [];

            // A reasoning model that hits the cap without emitting a call has
            // run away thinking. Trimming history will not help -- the input was
            // never the problem -- so report it rather than silently retrying.
            if (choice.finish_reason === 'length' && calls.length === 0) {
                // Two distinct failures land here and they want different fixes,
                // so name them apart rather than blaming reasoning for both.
                const total = completion.usage?.completion_tokens ?? 0;
                const reasoning = completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
                const runaway = reasoning >= total * 0.9;

                // Log what it said instead. This was thrown away, and its absence
                // is what made the failure undiagnosable: `full response: ""` in
                // the logs, with no way to tell a model narrating its plan from
                // one emitting a malformed tool call the server could not parse.
                // Prompt size, tool-schema size and concurrency have all been ruled
                // out by measurement; what the prose actually SAYS is the remaining
                // evidence, so keep a bounded preview of it.
                //
                // This is the ONE place reasoning_content is read, and it goes to a
                // log rather than into the return value. extractText still never
                // surfaces it, so private deliberation cannot reach game chat or a
                // villager's memory -- which is the actual invariant. A diagnostic
                // line in the container log is not the same channel.
                const said = LMStudio.extractText(choice.message)
                    || String(choice.message?.reasoning_content ?? '');
                if (said) {
                    console.warn(`[tool-miss] ${this.agent_name ?? 'agent'} said instead: `
                        + JSON.stringify(said.slice(0, 400)));
                }

                return {
                    tool_calls: [],
                    text: '',
                    usage: completion.usage,
                    error: runaway
                        ? `Reasoning runaway: spent all ${total} tokens thinking, no tool call.`
                        : `Produced ${total - reasoning} tokens of prose instead of a tool call ` +
                          `(${reasoning} reasoning). Budget was ${max_tokens}.`,
                };
            }

            return {
                tool_calls: calls,
                text: LMStudio.extractText(choice.message),
                usage: completion.usage,
            };
        } catch (err) {
            console.error('LM Studio tool request failed:', err?.message || err);
            return {
                tool_calls: [], text: '', usage: null,
                error: err?.message || String(err), terminal: false,
            };
        }
    }

    /**
     * The prose path, reporting failure OUT OF BAND.
     *
     * Returns {ok, text, error, terminal} -- the same envelope sendToolRequest
     * already uses. This exists because the old contract ("returns a string, and
     * on failure returns a different string") destroyed every villager's
     * long-term memory twice: the summariser stores what it gets, and a failure
     * was indistinguishable from a summary. See src/society/memoryGuard.js.
     *
     * `terminal` means no amount of retrying inside a turn will help -- there is
     * no model loaded, or the credentials are wrong. Only an operator can fix it.
     */
    async chat(turns, systemMessage, stop_seq='***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        let model = await this.model();
        if (!model) return { ok: false, text: '', error: NO_MODEL, terminal: true };
        let res;

        try {
            console.log('Awaiting LM Studio response from model', model);
            const pack = {
                model,
                messages,
                stop: stop_seq,
                ...(this.params || {})
            };
            // Slotted like the tool path. This path is only memory summaries and
            // should-I-reply checks, but it competes for the same KV pool -- and
            // being the unslotted one would make it the thing that pushes the
            // village over the cliff while looking innocent.
            const completion = await withSlot(this.agent_name,
                () => this.openai.chat.completions.create(pack));
            const choice = completion.choices[0];
            if (choice.finish_reason === 'length') {
                // Distinguish the two very different causes of a length stop.
                // If the model burned its budget on `reasoning_content`, the
                // input was never too long -- dropping the oldest turn would
                // destroy the agent's memory of the conversation and change
                // nothing. Only treat this as context pressure when the output
                // was NOT dominated by reasoning.
                const reasoning = completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
                const produced = completion.usage?.completion_tokens ?? 0;
                if (reasoning > 0 && reasoning >= produced * 0.9) {
                    console.warn(`LM Studio: model spent ${reasoning}/${produced} output tokens reasoning and never answered. ` +
                                 `Use sendToolRequest() with tool_choice:'required' for bounded turns.`);
                    return {
                        ok: false, text: '', terminal: false,
                        error: `produced ${produced} tokens of reasoning instead of an answer`,
                    };
                }
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = LMStudio.extractText(choice.message);
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.chat(turns.slice(1), systemMessage, stop_seq);
            }
            console.log(err);
            // A transport or server error. Not terminal: a timeout or a reset
            // says nothing about whether a model is loaded.
            return { ok: false, text: '', error: err?.message || String(err), terminal: false };
        }
        return { ok: true, text: res, error: null, terminal: false };
    }

    /**
     * Back-compatible string wrapper. THROWS on failure rather than returning
     * prose -- that substitution is what poisoned eight villagers' memories.
     */
    async sendRequest(turns, systemMessage, stop_seq='***') {
        const out = await this.chat(turns, systemMessage, stop_seq);
        if (!out.ok) throw new LLMUnavailable(out.error, { terminal: out.terminal });
        return out.text;
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    /**
     * Embeddings, but only against a model that is already loaded.
     *
     * This path is the one that caused the eviction worth remembering: asking
     * for the embedding model while the chat model was resident made LM Studio
     * load it, and the chat model went out to make room. The villagers' actual
     * thinking was displaced by a nicety -- embeddings here only rank example
     * conversations, and callers already fall back to word-overlap when this
     * throws.
     *
     * So the same rule as everywhere else: choose from what is loaded, and
     * decline rather than cause a load.
     */
    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const preferred = this.model_name || 'text-embedding-nomic-embed-text-v1.5';
        // role matters more than minContext here. A 512 floor does not exclude a
        // 42,752-context chat model, so without the role a missing embedder would
        // be "substituted" with a reasoning model and asked for sentence vectors.
        const model = await resolveModel(preferred, this.agent_name, {
            minContext: MIN_EMBED_CONTEXT, role: ROLE.EMBED,
        });
        if (!model) throw new Error(LMStudio.NO_MODEL);
        const embedding = await this.openai.embeddings.create({
            model,
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}
