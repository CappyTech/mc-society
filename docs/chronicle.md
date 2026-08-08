# The Chronicle

The village's shared memory: who did what, to whom, and how everyone feels
about it afterwards.

## Why it exists

The villagers had no memory of each other at all.

`History.memory` — upstream's long-term memory — was a single 500-character
string produced by asking the model to summarise its own turns. That goes
through the prose path, which this reasoning model cannot terminate on, so it
returned the adapter's error string and `summarizeMemories` stored it verbatim.
**Seven of eight villagers' entire long-term memory was the literal text
`"My brain disconnected, try again."`**, rewritten identically on every
summarisation. That is fixed separately (`src/agent/history.js`), but it means
the Chronicle is not competing with a working memory — it is replacing one that
had never worked.

Nothing else recorded relationships in any form. A villager could be given food
every day for a week and have no way to know it.

## Shape

| Collection | What it is |
| --- | --- |
| `agents` | the roster, seeded idempotently from `src/society/roster.js` |
| `events` | append-only log of what happened |
| `relationships` | **directed**: `Bram->Nia` is Bram's view of Nia |
| `ledger` | open favours — who owes whom |
| `places` | remembered locations, shareable across the village |

`relationships` is materialised on write, so rendering a villager's memory is
one indexed lookup rather than an aggregation over the whole event log. That
matters because the brief is read on *every turn of every villager*, while
events are written once.

Relationships are directed because the asymmetry is the interesting part: one
villager can feel indebted while the other has forgotten the whole thing.

## Recording: derived, never asked

Nothing is asked of the model. Every event is read out of a command that
already ran, at `executeCommand` (`src/agent/commands/index.js`) — the single
funnel every command of every villager passes through, in both the tool path
and the text path.

A `remember(...)` tool was considered and rejected on three grounds:

- **Cost.** A tool schema is ~90 prompt tokens in every request, for all eight
  villagers, forever. Prompt size is the binding constraint on this project.
- **Competition.** The model reaches for the cheapest available call first and
  will loop on it. A free "record something" action competes with working.
- **Accuracy.** A self-report is *worse* than a derived record. `!givePlayer`
  returns `Failed to give oak_log to Nia, it was never received.` and a model
  asked to summarise its turn will still say it gave Nia the wood.

Success is detected from the skill's own result string, so a failed gift never
creates a debt. Those strings are upstream's and can change under a merge,
which is why `tests/society/recorder.test.js` pins them verbatim — otherwise
the village would silently stop remembering with no error anywhere.

Two events have no command behind them and are hooked directly: the *listener's*
side of a conversation (`conversation.js` — only the speaker passes through
`executeCommand`, so without it a conversation marks only one of the two
relationships) and deaths (`agent.js`).

### Perspective is the easy thing to get wrong

A relationship row is one villager's view **of the other**, and `lastReason` is
rendered straight after that person's name. So the event kind written into a
row must describe the *far* party:

```
row Nia->Bram   Bram gave her coal   -> kind 'gave'      "Bram: Gave you 3 coal."
row Bram->Nia   Nia took his coal    -> kind 'received'  "Nia: Took 3 coal from you."
```

Reversed, the text reads perfectly well and is exactly wrong — the villager who
has just been given coal is told the giver took it from them. This shipped
backwards and was caught only by reading real output.

## Getting it into the prompt

A `$VILLAGE` placeholder, resolved in `Prompter.replaceStrings`, present in
every village persona. It renders to `''` whenever the Chronicle is off, down
or slow, so no upstream profile is affected and an outage costs a little
context rather than a broken prompt.

```
VILLAGE
Bram: Owes you 3 coal. Gave you 3 coal. Warm.
Corin: You owe them a pickaxe. Refused you. Wary.
```

**Capped at 900 characters (~225 tokens, ~5% of a turn).** What gets dropped
first is the design:

1. Whoever the villager is currently dealing with — never dropped, however
   weakly they feel about them. A brief that omits the one relationship in play
   is worse than no brief.
2. Up to three more, ranked by *decayed* sentiment magnitude — a grudge is as
   memorable as a friendship, and indifference is not memorable at all.
3. One debt with someone not already named.
4. The shared project, last, because it is the only line a villager could
   reconstruct by asking someone.

**Decay is not optional.** Gifts add sentiment and nothing subtracts it, so
without a half-life every relationship walks to +100 within a day and the block
becomes 225 tokens a turn of "everyone is wonderful". Applied at read time,
never written; half-life 3 days.

## Degradation: the contract that matters most

**The village must keep running when Mongo is unreachable — not mostly, at
all.** Eight villagers take a turn every few seconds; if a single query can
block, one slow database becomes a village that has gone silent, and it looks
exactly like the inference server dying. That misdiagnosis has already cost
this project a session.

- Writes are buffered (200 max) and flushed on a timer. **No turn ever awaits a
  write.** A full buffer drops its oldest entries.
- Reads race a 250 ms timeout and fall back to a neutral value.
- `bufferCommands: false` is load-bearing: mongoose's default makes a query
  issued while disconnected *hang* until timeout instead of failing.
- `maxPoolSize: 3` — there are eight separate agent processes, and this host has
  already lost a MongoDB to file-descriptor exhaustion once.
- Logging is rate-limited to one line per minute per process.
- With `CHRONICLE_MONGO_URI` unset the whole module is inert and silent. That is
  a supported way to run the village.

Verified by stopping `mcs-mongo` outright: all eight villagers stayed online and
kept taking turns, with 16 log lines in three minutes across eight processes.

`tests/society/chronicle.test.js` runs with no database configured and asserts
every export is safe to call — it is the most important test in the feature.

## Where it runs

A **dedicated** `mongo:8.0` (`mcs-mongo`) on `society-net`, not the household
`hcs-mongo`. These are LLM-driven processes on a game server deliberately open
to the LAN, so anything typed in chat reaches them; putting them on `hcs-net`
would give that surface a route to nextcloud, paperless and the finance app. A
container costs almost nothing and keeps the blast radius inside this stack.

No published port. The village authenticates as `mcs_village`
(`readWrite` + `dbAdmin` on `mcs-village` only — `dbAdmin` because mongoose
creates the indexes); the root credential creates that user on first init and is
then used by nothing.

## Operating it

```bash
# what the village remembers
docker exec mcs-mongo mongosh --quiet -u mcs_village -p "$PW" \
  --authenticationDatabase mcs-village mcs-village --eval '
    db.relationships.find({}, {_id:1, sentiment:1, lastReason:1}).forEach(printjson)'

# render a villager's brief exactly as the prompt will see it
docker exec mcs-village node -e "
  import('./src/society/chronicle/chronicle.js').then(async c => {
    c.connect(); await new Promise(r => setTimeout(r, 2500));
    console.log(await c.brief('Nia', { focus: 'Bram' })); process.exit(0); })"
```
