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

**`loaded_context_length` is a pool shared by all slots, not an allowance per
slot.** This is the single most important fact on this page and it was got wrong
here for a long time. More slots do not add capacity; they only divide the same
pool more ways.

Measured 2026-08-10 against `andy-4.2` at `loaded_context_length: 42752`, using
the real 36-tool schema and a villager-sized prompt (12,955 tokens) plus the
adapter's 1,280-token output budget — which is reserved in the pool alongside the
prompt, so a turn costs ~14,235:

| Concurrent turns | Result |
| --- | --- |
| 1 | 1/1 emits a tool call |
| 2 | 2/2 emit a tool call |
| 3 | **0/3, all HTTP 400** |

42,752 / 14,235 = 3.00, which is exactly where the cliff falls.

**Measure with the real tool schema.** An earlier pass used synthetic
9,558-token prompts, concluded four fitted, and shipped three — a real villager
prompt is a third larger than that guess, and a third of turns kept failing.

**Note the shape of that cliff: over capacity, EVERY request fails**, including
the ones that would have fitted. So eight villagers thinking at once do not get
eight slow turns or four fast ones — they get *nothing*, all of them, for as long
as they keep trying together. On 2026-08-10 the revived village produced zero
turns for this reason against a completely healthy inference server, with
`Context size has been exceeded` on every one.

Retries cannot fix it. Eight processes that fail together back off together and
collide again; `LMStudio.POOL_RETRIES` existed already and all three attempts
were consumed on every turn.

### What actually bounds it

`src/society/inferenceSlots.js` caps concurrent requests village-wide at
**`LMSTUDIO_MAX_INFLIGHT`, default 2** — below the measured edge of three rather
than on it, because villagers carry histories of different lengths and one long
one tips the total over on its own.

**Over-subscription does not always announce itself as a context error.** At a cap
of three there were no context errors at all; instead 14 turns "produced prose
instead of a tool call" against 7 that worked. That reads like a model-quality
problem and is not one — every one of those failures had spent *exactly* the full
1,280-token budget, and the same model with the same schema emits a clean tool
call in ~300 tokens at concurrency 2. It was pool pressure truncating generation.
If the villagers suddenly seem stupid, check the cap before blaming the model.

A turn that cannot get a slot within two minutes **skips and retries later; it
never proceeds unslotted.** Barging was tried and cost 42 context errors for 8
completed turns — a skipped turn costs one villager one turn, a barge costs
everyone theirs.

The gate is a lock directory rather than module state because the eight villagers
are eight separate OS processes (`src/process/agent_process.js`) — in-process
counting would cap each villager at 2 and the village at 16.

The per-agent `cooldown` in each profile is the throttle on the other side of
this, and it must be sized against the same arithmetic: a turn takes 20–30s and
two run at once, so the village finishes roughly five turns a minute between all
eight villagers — about one each per 100s. At 3000ms, eight villagers asked for an
order of magnitude more than the GPU could serve, and the surplus was not free: it
assembled a full ~13,000-token prompt, queued for a slot, timed out and was thrown
away. **It is 20000ms** (`src/society/roster.js` — regenerate the profiles after
changing it).

If you want the village to think faster, the levers in order are: load a second
instance (then raise `LMSTUDIO_MAX_INFLIGHT`), raise `loaded_context_length`, or
shrink the prompt. Raising the cap alone just moves the cliff closer.

## Quantisation, and the interaction between the two

Context consumes VRAM through the KV cache. On a 12 GB card:

- `Q4_K_M` is ~6.55 GB and leaves room for a large pool.
- `Q8_0` is ~9.5 GB and does not. Loading it is a plausible way to end up with
  a 768-token context, or with the server dying outright — a `Channel Error`
  in LM Studio's log is often this.

**Spend VRAM on context, not on slots.** Since the pool is shared (above), slots
beyond what the pool can actually hold concurrently buy nothing and merely let
more requests in to fail together. `loaded_context_length` is what decides how
many villagers can think at once; the client-side cap should then be set from it.

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
