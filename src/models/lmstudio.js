import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';

export class LMStudio {
    static prefix = 'lmstudio';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
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
    async sendToolRequest(turns, systemMessage, tools, { tool_choice = 'required', max_tokens = 768 } = {}) {
        const messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        const model = this.model_name || 'andy-4.1';

        const pack = {
            model,
            messages,
            tools,
            tool_choice,
            max_tokens,
            ...(this.params || {}),
        };

        try {
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion.choices[0];
            const calls = choice.message?.tool_calls ?? [];

            // A reasoning model that hits the cap without emitting a call has
            // run away thinking. Trimming history will not help -- the input was
            // never the problem -- so report it rather than silently retrying.
            if (choice.finish_reason === 'length' && calls.length === 0) {
                return {
                    tool_calls: [],
                    text: '',
                    usage: completion.usage,
                    error: `Model exhausted ${max_tokens} tokens without producing a tool call ` +
                           `(${completion.usage?.completion_tokens_details?.reasoning_tokens ?? '?'} spent reasoning).`,
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
        let model = this.model_name || 'andy-4.1';
        let res = null;

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

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
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
