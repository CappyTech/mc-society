import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';
import { resolveModel } from '../society/modelResolver.js';

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
        this._resolved = null;
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
     * Falls back to the configured name on any failure, so an unreachable
     * inference server stays one problem rather than two.
     */
    async model() {
        if (this._resolved) return this._resolved;
        const preferred = this.model_name || 'andy-4.1';
        this._resolved = await resolveModel(preferred, this.agent_name);
        return this._resolved;
    }

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
    async sendToolRequest(turns, systemMessage, tools, { tool_choice = 'required', max_tokens = 1280 } = {}) {
        const messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        const model = await this.model();

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
        let completion;
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    completion = await this.openai.chat.completions.create(pack);
                    break;
                } catch (e) {
                    const contended = /context size has been exceeded/i.test(e?.message || '');
                    if (!contended || attempt >= LMStudio.POOL_RETRIES) throw e;
                    await new Promise((r) => setTimeout(r, LMStudio.POOL_BACKOFF_MS * (attempt + 1)));
                }
            }
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
            return { tool_calls: [], text: '', usage: null, error: err?.message || String(err) };
        }
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        let model = await this.model();
        let res;

        try {
            console.log('Awaiting LM Studio response from model', model);
            const pack = {
                model,
                messages,
                stop: stop_seq,
                ...(this.params || {})
            };
            const completion = await this.openai.chat.completions.create(pack);
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
                    return '';
                }
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = LMStudio.extractText(choice.message);
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
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

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'text-embedding-nomic-embed-text-v1.5',
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}
