/**
 * Command registry -> OpenAI tool schemas, and tool_call -> command execution.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream mindcraft asks the model for prose and parses `!command(args)` back
 * out of it. Against a reasoning model that never terminates on open-ended
 * output (measured: Qwen 3.5 9B spends every available token in
 * `reasoning_content` and returns an empty `content`), that loop hangs on every
 * turn. Forcing a tool call is the only method that bounds it -- see
 * `docs/reasoning-model.md`.
 *
 * So this module is a pure adapter. It does not reimplement any behaviour: the
 * 49 commands in ../agent/commands keep their definitions, their validation
 * rules and their `perform` functions. We only re-present them as tools and
 * route calls back.
 */

import { getBlockId, getItemId } from '../utils/mcdata.js';
import settings from '../agent/settings.js';

/**
 * The registry is loaded lazily, never at module evaluation.
 *
 * `actions.js` -> `conversation.js` -> `commands/index.js` -> `actions.js` is a
 * cycle. A static import here resolves into it mid-construction and dies with
 * "Cannot access 'actionsList' before initialization". Deferring the import
 * until first use lets the cycle settle first. (Same failure mode, same fix, as
 * the hcs-app model enumeration documented in CLAUDE.md.)
 */
let _registry = null;

export async function loadRegistry() {
    if (_registry) return _registry;

    // Order is load-bearing, and sequential on purpose.
    //
    // `commands/index.js` is the only member of the cycle that can safely start
    // it: entering through it evaluates actions.js and queries.js to completion
    // before line 7 concatenates them. Entering through actions.js instead
    // (directly, or via Promise.all racing both) re-enters index.js while
    // actions.js is still initialising, and its concat hits the TDZ.
    await import('../agent/commands/index.js');

    // Safe now -- both are fully evaluated and module-cached.
    const { actionsList } = await import('../agent/commands/actions.js');
    const { queryList } = await import('../agent/commands/queries.js');

    _registry = { actionsList, queryList };
    return _registry;
}

function registry() {
    if (!_registry)
        throw new Error('Command registry not loaded. Await loadRegistry() once during agent startup.');
    return _registry;
}

/** Upstream's param types -> JSON Schema types. */
const TYPE_MAP = {
    int:             { type: 'integer' },
    float:           { type: 'number'  },
    string:          { type: 'string'  },
    boolean:         { type: 'boolean' },
    // These three are strings to the model but are validated against
    // minecraft-data on the way back in.
    ItemName:        { type: 'string'  },
    BlockName:       { type: 'string'  },
    BlockOrItemName: { type: 'string'  },
};

/** Extra guidance appended to a param description, by type. */
const TYPE_HINT = {
    ItemName:        'Exact Minecraft item id, snake_case (e.g. "iron_ingot").',
    BlockName:       'Exact Minecraft block id, snake_case (e.g. "oak_log").',
    BlockOrItemName: 'Exact Minecraft block or item id, snake_case.',
};

/** `!goToPlayer` -> `goToPlayer`. Tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function toolNameFor(commandName) {
    return commandName.replace(/^!/, '');
}

/** `goToPlayer` -> `!goToPlayer`. */
export function commandNameFor(toolName) {
    return toolName.startsWith('!') ? toolName : '!' + toolName;
}

/**
 * Domain bounds are written as JS numbers and several are `Infinity` or
 * `Number.MAX_SAFE_INTEGER`. JSON.stringify turns Infinity into `null`, which
 * would emit a schema the server rejects -- so only finite, meaningful bounds
 * are carried over.
 */
function applyDomain(schema, domain) {
    if (!Array.isArray(domain)) return schema;
    const [lo, hi, endpoints = '[)'] = domain;
    if (Number.isFinite(lo) && lo !== Number.MIN_SAFE_INTEGER) {
        if (endpoints[0] === '[') schema.minimum = lo;
        else schema.exclusiveMinimum = lo;
    }
    if (Number.isFinite(hi) && hi !== Number.MAX_SAFE_INTEGER) {
        if (endpoints[1] === ']') schema.maximum = hi;
        else schema.exclusiveMaximum = hi;
    }
    return schema;
}

/** One command -> one OpenAI tool definition. */
export function toolFromCommand(command) {
    const properties = {};
    const required = [];

    for (const [paramName, param] of Object.entries(command.params || {})) {
        const base = TYPE_MAP[param.type];
        if (!base) {
            throw new Error(
                `Command '${command.name}' param '${paramName}' has unmapped type '${param.type}'. ` +
                `Add it to TYPE_MAP in src/society/tools.js.`
            );
        }
        const schema = { ...base };
        const hint = TYPE_HINT[param.type];
        schema.description = hint ? `${param.description} ${hint}` : param.description;
        applyDomain(schema, param.domain);

        // A closed set of valid values, when the command has one. Worth the few
        // tokens: it is the difference between the model picking a plan that
        // exists and inventing a plausible-sounding one that does not, which
        // would otherwise cost a whole wasted turn to discover.
        if (Array.isArray(param.enum) && param.enum.length) schema.enum = [...param.enum];

        properties[paramName] = schema;
        // Upstream's executor requires every declared param, so all are required.
        required.push(paramName);
    }

    return {
        type: 'function',
        function: {
            name: toolNameFor(command.name),
            description: command.description,
            parameters: {
                type: 'object',
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

/**
 * Tools every villager gets, whatever they do for a living.
 *
 * Enough to perceive, move, carry, trade with each other, work a little, and
 * speak. A villager missing any of these stops being able to participate in the
 * village at all, so nothing here is role-specific.
 */
export const CORE_TOOLS = [
    // perceive
    'stats', 'inventory', 'nearbyBlocks', 'craftable', 'entities', 'savedPlaces',
    // move
    'goToPlayer', 'goToCoordinates', 'searchForBlock', 'moveAway',
    'rememberHere', 'goToRememberedPlace',
    // carry and exchange -- the economy runs on these
    'givePlayer', 'consume', 'equip', 'putInChest', 'takeFromChest', 'viewChest', 'discard',
    // work
    'collectBlocks', 'craftRecipe', 'placeHere',
    // survive. shelterHere is the only answer to nightfall that does not
    // require already being somewhere -- and a turn is one tool call, so it
    // has to be one tool. Zero parameters, ~40 tokens.
    'shelterHere',
    // speak
    'startConversation', 'endConversation',
    // control. `stay` is load-bearing: under forced tool calls there is no way
    // to emit nothing, so it is the only way to do nothing.
    'stay', 'stop', 'goal', 'endGoal', 'goToBed',
    // governance. The ONLY project tool every villager carries -- proposing and
    // building are scoped to the trades that do them. A village where nobody
    // can vote is not a village, and the schema is deliberately tiny (one
    // boolean, no project id) because this one is paid for eight times a turn.
    'voteProject',
];

/**
 * Extra tools by role, on top of CORE_TOOLS.
 *
 * Keyed to `society.role` in the generated profiles (see roster.js).
 */
export const ROLE_TOOLS = {
    miner:    ['digDown', 'goToSurface', 'smeltItem', 'clearFurnace'],
    // tillAndSow is the farmer's whole job and was unexposed: her standing
    // goal is to keep the fields planted and she had no way to plant.
    farmer:   ['useOn', 'attack', 'tillAndSow'],
    smith:    ['smeltItem', 'clearFurnace', 'getCraftingPlan'],
    forester: ['smeltItem', 'clearFurnace'],           // charcoal
    builder:  ['build', 'proposeProject', 'workOnProject', 'getCraftingPlan', 'digDown'],
    cook:     ['smeltItem', 'clearFurnace'],
    scout:    ['attack', 'searchForEntity', 'followPlayer', 'goToSurface'],
    keeper:   ['proposeProject', 'showVillagerTrades', 'tradeWithVillager', 'getCraftingPlan'],
};

/**
 * The tool surface offered to one villager.
 *
 * `!newAction` executes model-written code. It self-guards on
 * allow_insecure_coding, but we omit it from the surface entirely when disabled
 * so the model is never invited to try -- one less injection avenue, and it
 * saves the prompt tokens.
 *
 * WHY THE SURFACE IS SCOPED BY ROLE
 * ---------------------------------
 * Every tool schema is sent on every request, and all 54 of them cost ~4,960
 * tokens -- two thirds of a ~7,500-token turn, and the single largest term in
 * it. The unscoped surface also asked a miner to consider `showVillagerTrades`
 * and a cook to consider `attackPlayer` on every decision.
 *
 * Passing a `role` cuts this to ~30 tools. It is a prompt-size measure, not a
 * safety boundary: everything withheld is withheld because that villager has no
 * use for it, and `blocked` remains the mechanism for anything that must not be
 * callable. An unknown or absent role falls back to the full surface rather
 * than to an arbitrary subset -- a typo'd role should make a villager verbose,
 * never mute.
 */
export function buildTools({ blocked = null, includeQueries = true, role = null } = {}) {
    const { actionsList, queryList } = registry();
    const blockedSet = new Set(blocked ?? settings.blocked_actions ?? []);
    if (!settings.allow_insecure_coding) blockedSet.add('!newAction');

    let allowed = null;
    if (role && ROLE_TOOLS[role]) {
        allowed = new Set([...CORE_TOOLS, ...ROLE_TOOLS[role]]);
    } else if (role) {
        console.warn(`buildTools: unknown role "${role}"; offering the full tool surface.`);
    }

    const commands = includeQueries ? [...queryList, ...actionsList] : [...actionsList];
    return commands
        .filter((c) => !blockedSet.has(c.name) && !blockedSet.has(toolNameFor(c.name)))
        .filter((c) => !allowed || allowed.has(toolNameFor(c.name)))
        .map(toolFromCommand);
}

/** name -> command, over the same list buildTools draws from. */
function commandIndex() {
    const { actionsList, queryList } = registry();
    const map = new Map();
    for (const c of [...queryList, ...actionsList]) map.set(c.name, c);
    return map;
}

/**
 * Run a minecraft-data lookup, distinguishing "not found" from "tables absent".
 * @returns {number|null|undefined} id, `null` if genuinely unknown,
 *          `undefined` if minecraft-data has not been initialised yet.
 */
function safeLookup(fn, value) {
    try {
        return fn(value) ?? null;
    } catch {
        return undefined;
    }
}

/** True once initBot() has populated the version-scoped minecraft-data tables. */
export function mcDataReady() {
    return safeLookup(getItemId, 'bread') !== undefined;
}

/**
 * Validate one argument against its param spec.
 * Mirrors the checks in agent/commands/index.js so that tool-call arguments get
 * exactly the same treatment parsed-text arguments always did.
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function coerceArg(paramName, param, raw) {
    let value = raw;

    switch (param.type) {
        case 'int':
            value = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(value, 10);
            break;
        case 'float':
            value = Number.parseFloat(value);
            break;
        case 'boolean':
            if (typeof value === 'string') {
                const s = value.toLowerCase();
                if (['true', 't', '1', 'on'].includes(s)) value = true;
                else if (['false', 'f', '0', 'off'].includes(s)) value = false;
                else return { ok: false, error: `Param '${paramName}' must be a boolean.` };
            }
            if (typeof value !== 'boolean')
                return { ok: false, error: `Param '${paramName}' must be a boolean.` };
            break;
        case 'BlockName':
        case 'BlockOrItemName':
        case 'ItemName':
            if (typeof value !== 'string')
                return { ok: false, error: `Param '${paramName}' must be a string.` };
            value = value.trim();
            // Same forgiveness upstream extends to "oak_plank" / "wheat_seed".
            if (value.endsWith('plank') || value.endsWith('seed')) value += 's';
            break;
        case 'string':
            if (typeof value !== 'string') value = String(value);
            break;
        default:
            return { ok: false, error: `Param '${paramName}' has unknown type ${param.type}.` };
    }

    if (typeof value === 'number' && !Number.isFinite(value))
        return { ok: false, error: `Param '${paramName}' must be a finite ${param.type}.` };

    if (typeof value === 'number' && Array.isArray(param.domain)) {
        const [lo, hi, endpoints = '[)'] = param.domain;
        const lowOk  = endpoints[0] === '[' ? value >= lo : value > lo;
        const highOk = endpoints[1] === ']' ? value <= hi : value < hi;
        if (!lowOk || !highOk)
            return { ok: false, error: `Param '${paramName}' must be in ${endpoints[0]}${lo}, ${hi}${endpoints[1]}.` };
    }

    // minecraft-data is version-scoped and only populated by initBot(), so these
    // lookups throw before any bot has connected. A validation helper must never
    // be the thing that kills a turn -- when the tables are not up yet we accept
    // the name and let the command's own error handling deal with it.
    if (param.type === 'BlockName') {
        const id = safeLookup(getBlockId, value);
        if (id === null) return { ok: false, error: `Invalid block type: ${value}.` };
    }
    if (param.type === 'ItemName') {
        const id = safeLookup(getItemId, value);
        if (id === null) return { ok: false, error: `Invalid item type: ${value}.` };
    }
    if (param.type === 'BlockOrItemName') {
        const b = safeLookup(getBlockId, value);
        const i = safeLookup(getItemId, value);
        if (b === null && i === null)
            return { ok: false, error: `Invalid block or item type: ${value}.` };
    }

    return { ok: true, value };
}

/**
 * Turn a tool_call into ordered positional args for `command.perform`.
 *
 * The ordering matters and is easy to get wrong: `perform` is positional
 * (`perform(agent, ...args)`) while tool arguments arrive as an unordered
 * object. Object.keys(command.params) is the authority on order.
 *
 * @returns {{ok: true, command: object, args: any[]} | {ok: false, error: string}}
 */
export function resolveToolCall(toolCall, index = commandIndex()) {
    const fn = toolCall?.function;
    if (!fn?.name) return { ok: false, error: 'Malformed tool call: no function name.' };

    const command = index.get(commandNameFor(fn.name));
    if (!command) return { ok: false, error: `${fn.name} is not a command.` };

    let parsed = {};
    if (fn.arguments) {
        if (typeof fn.arguments === 'object') parsed = fn.arguments;
        else {
            try { parsed = JSON.parse(fn.arguments); }
            catch { return { ok: false, error: `Arguments for ${fn.name} were not valid JSON.` }; }
        }
    }

    const specs = Object.entries(command.params || {});
    const args = [];
    for (const [paramName, param] of specs) {
        if (!(paramName in parsed))
            return { ok: false, error: `Command ${command.name} is missing required param '${paramName}'.` };
        const res = coerceArg(paramName, param, parsed[paramName]);
        if (!res.ok) return { ok: false, error: `Error: ${res.error}` };
        args.push(res.value);
    }

    return { ok: true, command, args };
}

/**
 * Resolve and run a tool call. Never throws: a failure comes back as a string
 * so it can be fed to the model as the tool result and retried in-conversation,
 * which is how upstream handles bad commands too.
 * @returns {Promise<string>}
 */
export async function executeToolCall(agent, toolCall, index = commandIndex()) {
    const resolved = resolveToolCall(toolCall, index);
    if (!resolved.ok) return resolved.error;
    try {
        const result = await resolved.command.perform(agent, ...resolved.args);
        return result ?? `${resolved.command.name} completed.`;
    } catch (err) {
        return `${resolved.command.name} failed: ${err?.message || String(err)}`;
    }
}

export { commandIndex };
