/**
 * Turning executed commands into village history. Pure, no database.
 *
 * WHY DERIVE RATHER THAN ASK
 * --------------------------
 * The obvious design is a `remember(...)` tool the model calls when something
 * noteworthy happens. It was rejected on three grounds:
 *
 *   - Cost. A tool schema is ~90 prompt tokens in *every* request, for all
 *     eight villagers, forever. Prompt size is the binding constraint here.
 *   - Competition. The model reaches for the cheapest available call first and
 *     will loop on it; a free "record something" action competes with actually
 *     doing the job.
 *   - Accuracy. A self-reported record is worse than a derived one. The model
 *     narrates what it *meant* to do; the command result says what happened.
 *     `!givePlayer` reports "Failed to give oak_log to Nia, it was never
 *     received." and a model asked to summarise its turn will still say it
 *     gave Nia the wood.
 *
 * So nothing is asked of the model. Every event here is read out of a command
 * that already ran, at the single funnel every command passes through.
 */

/** Cap on any free-text field that reaches the database. */
const DETAIL_MAX = 120;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);

/**
 * Commands worth remembering, and how to read their outcome.
 *
 * An allowlist, not a denylist. Queries (`!stats`, `!inventory`,
 * `!nearbyBlocks`, ...) are the majority of all commands executed and carry no
 * information about the village -- recording them would be pure write volume
 * and would bury the events that matter.
 *
 * Success is detected from the skill's own result string. Those strings are
 * upstream's and can change under a merge, which is why they are pinned by
 * tests using the literal text from skills.js.
 */
const HANDLERS = {
    '!givePlayer': (args, result) => {
        const [to, item, qty] = args;
        // "<name> received <item>." on success; "Failed to give <item> to
        // <name>, too close." / "..., it was never received." on the two
        // failure paths. A failed gift must not create a debt or warm a
        // relationship -- that is the whole reason success is checked.
        if (!new RegExp(`${to} received`, 'i').test(result || '')) return null;
        return { kind: 'gave', subject: to, item, qty: Number(qty) || 1 };
    },
    '!startConversation': (args) => ({
        kind: 'spoke', subject: args[0], detail: clean(args[1]),
    }),
    '!endConversation': (args) => ({ kind: 'convo_ended', subject: args[0] }),
    '!collectBlocks': (args, result) => {
        const m = /Collected (\d+)/.exec(result || '');
        if (!m || Number(m[1]) === 0) return null;
        return { kind: 'collected', item: args[0], qty: Number(m[1]) };
    },
    '!craftRecipe': (args, result) => {
        if (!/Successfully crafted/.test(result || '')) return null;
        return { kind: 'crafted', item: args[0], qty: Number(args[1]) || 1 };
    },
    '!smeltItem': (args, result) => {
        if (!/Successfully smelted/.test(result || '')) return null;
        return { kind: 'smelted', item: args[0], qty: Number(args[1]) || 1 };
    },
    '!putInChest': (args, result) => {
        if (!/Successfully put/.test(result || '')) return null;
        return { kind: 'stored', item: args[0], qty: Number(args[1]) || 1 };
    },
    '!takeFromChest': (args, result) => {
        if (!/Successfully took/.test(result || '')) return null;
        return { kind: 'withdrew', item: args[0], qty: Number(args[1]) || 1 };
    },
    '!goal': (args) => ({ kind: 'goal_set', detail: clean(args[0]) }),
    '!build': (args, result) => {
        if (/is finished/.test(result || '')) return { kind: 'build_done', detail: clean(args[0]) };
        if (/I worked on/.test(result || '')) return { kind: 'build_progress', detail: clean(args[0]) };
        return null;   // blocked, interrupted, or no site -- not history
    },
};

/**
 * One executed command -> one event, or null.
 *
 * @param {string} commandName e.g. '!givePlayer'
 * @param {any[]} args parsed positional args
 * @param {string} result the command's return string
 * @param {string} actor the villager who ran it
 */
export function deriveEvent(commandName, args, result, actor) {
    const handler = HANDLERS[commandName];
    if (!handler) return null;

    let base;
    try {
        base = handler(args || [], result);
    } catch {
        // A malformed argument must never break the command that already
        // succeeded. History is a nice-to-have; the turn is not.
        return null;
    }
    if (!base) return null;

    return {
        ts: new Date(),
        actor,
        subject: base.subject ?? null,
        kind: base.kind,
        item: base.item ?? null,
        qty: base.qty ?? null,
        detail: base.detail ?? '',
    };
}

/** True for events that say something about a *relationship*, not just work. */
export function isSocial(event) {
    return !!event?.subject && event.subject !== event.actor;
}
