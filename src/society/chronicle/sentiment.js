/**
 * How villagers come to feel about each other. Pure functions, no database.
 *
 * The village needs opinions that are *earned* -- Nia is warm towards Bram
 * because he actually brought her coal, not because a prompt said she was.
 * Every number here comes from something that happened and was recorded.
 */

/** Sentiment and trust are both clamped to these. */
export const SENTIMENT_MIN = -100;
export const SENTIMENT_MAX = 100;

/**
 * No single event may move a relationship more than this.
 *
 * Without it one generous villager handing over a stack of 64 bread would
 * saturate a relationship in a single turn, and everything that happened
 * afterwards -- months of it -- would be invisible.
 */
export const MAX_WEIGHT = 15;

/**
 * Half-life of a feeling, in days.
 *
 * Applied at read time, never written. Without decay every relationship walks
 * monotonically to +100 and stays there: gifts add, nothing subtracts, and
 * within a day the whole village likes everyone equally. At that point the
 * memory block costs its tokens every turn and says nothing. Decay is what
 * makes "she helped me last week" weigh less than "he refused me an hour ago".
 */
export const HALF_LIFE_DAYS = 3;

const clamp = (n, lo = SENTIMENT_MIN, hi = SENTIMENT_MAX) => Math.max(lo, Math.min(hi, n));

/**
 * What each kind of event is worth, and how it reads back in a brief.
 *
 * `weight` is sentiment; `trust` moves separately and more slowly, because
 * liking someone and relying on them are different things -- a villager can be
 * charming and still never deliver.
 */
/**
 * IMPORTANT: every entry describes what the OTHER PERSON did.
 *
 * A relationship row is one villager's view of another, and its `lastReason` is
 * rendered straight after that person's name -- "Nia: Gave you 3 coal." So the
 * kind written into a row must describe the far party, not the actor. Get it
 * backwards and the text reads perfectly well and is exactly wrong: the
 * villager who has just been given coal is told the giver took it from them.
 */
export const EVENT_WEIGHTS = {
    // They gave to you. The one that really moves a relationship.
    gave:        { weight: 8,  trust: 5,  reason: (e) => `gave you ${e.qty ?? ''} ${e.item}`.replace('  ', ' ') },
    // You gave to them -- your view of the person who took it. Mild: parting
    // with something is a smaller event than being given it.
    received:    { weight: 2,  trust: 0,  reason: (e) => `took ${e.qty ?? ''} ${e.item} from you`.replace('  ', ' ') },
    // They spoke to you.
    spoke:       { weight: 1,  trust: 0,  reason: () => 'talked to you' },
    // You spoke to them. Counts as contact, but says nothing about them, so it
    // must not overwrite a real reason with a misleading one.
    spoke_to:    { weight: 1,  trust: 0,  reason: () => '' },
    convo_ended: { weight: 0,  trust: 0,  reason: () => '' },
    refused:     { weight: -6, trust: -6, reason: () => 'refused you' },
    ignored:     { weight: -3, trust: -4, reason: () => 'did not answer you' },
    helped_build:{ weight: 10, trust: 8,  reason: (e) => `helped build the ${e.detail || 'village'}` },
    attacked:    { weight: -25, trust: -20, reason: () => 'attacked you' },
};

/** Sentiment as it reads *now*, given when it was last touched. */
export function decay(sentiment, sinceMs, halfLifeDays = HALF_LIFE_DAYS) {
    if (!sentiment) return 0;
    if (!Number.isFinite(sinceMs) || sinceMs <= 0) return sentiment;
    const days = sinceMs / 86_400_000;
    return sentiment * Math.pow(0.5, days / halfLifeDays);
}

/**
 * Apply one event to one directed relationship.
 *
 * @param {object} rel  current row (may be undefined for a first meeting)
 * @param {object} event  {kind, item, qty, detail, at}
 * @returns {object} the new row -- never mutates its input
 */
export function applyEvent(rel, event) {
    const spec = EVENT_WEIGHTS[event?.kind];
    const now = event?.at ?? Date.now();
    const base = rel ?? {
        sentiment: 0, trust: 0, lastReason: '',
        counts: { gaveTo: 0, receivedFrom: 0, talks: 0, refusals: 0 },
        lastEventAt: now,
    };
    if (!spec) return base;

    // Decay what is already there before adding to it, so an old feeling does
    // not get topped up as though it were fresh.
    const aged = decay(base.sentiment, now - (base.lastEventAt ?? now));

    const counts = { ...base.counts };
    if (event.kind === 'gave') counts.gaveTo = (counts.gaveTo || 0) + 1;
    if (event.kind === 'received') counts.receivedFrom = (counts.receivedFrom || 0) + 1;
    if (event.kind === 'spoke') counts.talks = (counts.talks || 0) + 1;
    if (event.kind === 'refused' || event.kind === 'ignored') counts.refusals = (counts.refusals || 0) + 1;

    const reason = spec.reason(event) || base.lastReason;

    return {
        ...base,
        sentiment: clamp(aged + clamp(spec.weight, -MAX_WEIGHT, MAX_WEIGHT)),
        trust: clamp((base.trust || 0) + clamp(spec.trust, -MAX_WEIGHT, MAX_WEIGHT), 0, SENTIMENT_MAX),
        lastReason: String(reason).slice(0, 80),
        counts,
        lastEventAt: now,
    };
}

/** A word a villager would actually use, from a decayed sentiment. */
export function describeSentiment(s) {
    if (s >= 45) return 'close';
    if (s >= 15) return 'warm';
    if (s > -15) return 'neutral';
    if (s > -45) return 'wary';
    return 'hostile';
}
