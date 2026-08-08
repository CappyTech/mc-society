# Sizing the inference server

The village is eight agents sharing one local LM Studio instance. Two of its
settings decide whether the village works at all, and both fail in ways that
look like something else.

## Context length

**Set the loaded context length to at least 8192. 16384 is the comfortable
figure.** This is a property of the *loaded model*, not of the request, and
LM Studio's default for a freshly loaded model can be far smaller.

A turn is roughly:

| Term | Tokens |
| --- | --- |
| Tool schemas, role-scoped (~31 tools) | ~2,950 |
| Persona, stats, inventory | ~500 |
| Conversation history and loaded memory | grows with the run |

Unscoped, the tool surface alone is ~4,960 tokens, and a persona carrying
`$COMMAND_DOCS` adds another ~2,177 of prose duplicating it — which is why
both were removed. See `src/society/tools.js` and `src/society/roster.js`.

History is the term that grows, so pick the context for where a run ends up,
not where it starts.

### The symptom

An undersized context does **not** look like a context problem. Agents connect
normally, appear in `list`, stand in the world, and take zero turns. The
failure is server-side and per-request:

```
request (7467 tokens) exceeds the available context size (768 tokens), try increasing it
"type":"exceed_context_size_error","n_prompt_tokens":7467,"n_ctx":768
```

Check the loaded value directly rather than trusting the GUI slider — the
setting shown is the one that *will* apply at next load, not the one in force:

```bash
curl -s -H "Authorization: Bearer $LMSTUDIO_API_KEY" \
  "${LMSTUDIO_BASE_URL%/v1}/api/v0/models" |
  grep -E '"id"|loaded_context_length|"state"'
```

`loaded_context_length` is the number that matters. Reloading the model is the
only way to change it.

## Parallelism

**Set parallel slots to the number of agents (8).** Fewer starves the village,
and the shortfall compounds rather than merely slowing things down: every
`startConversation` obliges the recipient to reply, which prompts a reply back,
so demand grows with the square of village size while supply stays fixed.

Measured at 4 slots with 8 agents: 14 requests in flight, turns 31 seconds
apart, and an external probe timing out after 300 seconds. The per-agent
`cooldown` in each profile (3000ms) is the throttle on the other side of this.

## Quantisation, and the interaction between the two

Context and parallelism both consume VRAM through the KV cache, which scales
with *context × slots*. On a 12 GB card:

- `Q4_K_M` is ~6.55 GB and leaves room for 16384 × 8.
- `Q8_0` is ~9.5 GB and does not. Loading it is a plausible way to end up with
  a 768-token context, or with the server dying outright — a `Channel Error`
  in LM Studio's log is often this.

If the model will not load at 16384 × 8, reduce **context to 8192 before
reducing parallelism**: 8192 is still comfortably above a full turn, whereas
dropping slots below 8 reintroduces the starvation above.

Note that requesting a quantisation-suffixed model id (`qwen/qwen3.5-9b-Q4_K_M`)
does **not** select a quantisation — LM Studio resolves it to whichever build is
loaded and reports the real id in the response. Check `/api/v0/models` for
`quantization` rather than inferring it from the id you asked for.

## Why a reasoning model needs any of this

Qwen 3.5 asked for open-ended prose never terminates: it spends the entire
token budget in `reasoning_content` and returns an empty `content`. Forcing a
tool call is the only bound that works, which is what puts several thousand
tokens of tool schema in every single request. See
[reasoning-model.md](reasoning-model.md).
