# Driving a reasoning model: why every turn is a tool call

Measured 2026-08-08 against LM Studio serving `qwen/qwen3.5-9b-Q4_K_M`.

## The problem

Asked an open-ended question, this model does not stop thinking.

A plain social prompt — *"Nia asks to borrow your pickaxe and you owe her 3
bread. Reply."* — returned an **empty** `message.content`. Not truncated:
empty. All 700 permitted output tokens went into `reasoning_content`, and
`finish_reason` came back `length`. Raising the ceiling does not help; it just
thinks for longer.

This breaks upstream mindcraft's design outright. Upstream asks the model for
prose and parses `!command(args)` back out of it. Against this model that loop
produces nothing, on every turn.

## What was tried

| Attempt | Result |
| --- | --- |
| `enable_thinking: false` | Ignored. 700 reasoning tokens, empty reply. |
| `/no_think` in the system prompt | Ignored. Empty reply. |
| `/no_think` in the user turn | Ignored. Empty reply. |
| Unquantised model id (`qwen/qwen3.5-9b`) | Same behaviour. Empty reply. |
| `reasoning: { enabled: false }` | Ignored. Empty reply. |
| `response_format: json_schema` | Ignored — structured output alone does **not** bound it. Empty reply. |
| **`tool_choice: "required"`** | **Works.** Reasoning stopped at 176 tokens and produced a correct call. |

Forcing a tool call gives the model a termination condition it respects.
Nothing else does.

## The rule

**Every agent turn is a mandatory tool call, never free text.** Speech included
— an agent talks by calling `startConversation()`, the same way it mines by
calling `collectBlocks()`. Budget at least 512 output tokens per turn; the
adapter defaults to 768.

Verified across the full 54-tool surface (`src/society/verify-tools.mjs`):
reasoning stays bounded at **60–224 tokens**, turns take **2.0–5.9 s**, and the
model picks correct tools with correct arguments.

## Two behaviours to design around

**It reaches for cheap queries first.** On an open-ended "go do X", successive
runs picked `inventory`, then `stats`, rather than acting. That is reasonable
orientation, not a fault — but a turn loop that lets it repeat is a loop that
stalls in reconnaissance. Once the query is answered it commits immediately
(measured: `searchForBlock(oak_log, 32)` in 2.6 s). Feed query results back
explicitly and say they are already known.

**`finish_reason === 'length'` has two very different causes.** Upstream treats
it as context overflow and retries with the oldest turn dropped. When the real
cause is reasoning overflow, the input was never the problem — trimming
destroys the agent's memory of the conversation and changes nothing.
`src/models/lmstudio.js` now separates the two by checking whether reasoning
dominated the output.

## Related fixes in this fork

- `apiKey` is read from `LMSTUDIO_API_KEY`. Upstream hardcodes `'lm-studio'`
  with a comment that LM Studio ignores it — untrue once the server's API-key
  option is on, and it returns a flat **401**.
- Text is extracted via `LMStudio.extractText()`, which reads `content` and
  strips inline `<think>` blocks. It deliberately does **not** fall back to
  `reasoning_content`: that is private deliberation, not an answer, and it
  should never reach game chat.
