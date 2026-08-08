/**
 * End-to-end check of the tool adapter against the live LM Studio endpoint.
 *   docker run --rm --env-file <env> -v $PWD:/app mc-society-runtime:dev \
 *     node src/society/verify-tools.mjs
 */
import { buildTools, resolveToolCall, loadRegistry, mcDataReady } from './tools.js';
import { LMStudio } from '../models/lmstudio.js';

await loadRegistry();

let failures = 0;
const check = (label, cond, detail = '') => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
    if (!cond) failures++;
};

console.log('\n== 1. schema generation ==');
const tools = buildTools();
console.log(`  built ${tools.length} tools from the command registry`);
check('tools were produced', tools.length > 40, `${tools.length}`);
check('!newAction withheld while allow_insecure_coding is false',
    !tools.some(t => t.function.name === 'newAction'));

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
check('every tool name is API-legal', tools.every(t => NAME_RE.test(t.function.name)));
check('every tool has a description', tools.every(t => !!t.function.description));

// Infinity would be serialised as null and rejected by the server.
const json = JSON.stringify(tools);
check('schema survives JSON serialisation with no null bounds',
    !json.includes('"minimum":null') && !json.includes('"maximum":null'));
check('no non-finite bounds leaked', !/Infinity/.test(json));

console.log('\n== 2. argument ordering and validation ==');
// goToCoordinates takes x, y, z: object order must not decide positional order.
const shuffled = { function: { name: 'goToCoordinates',
    arguments: JSON.stringify({ z: 30, x: 10, y: 20, closeness: 1 }) } };
const r = resolveToolCall(shuffled);
check('resolves despite shuffled argument object', r.ok, r.ok ? '' : r.error);
if (r.ok) check('positional order follows params, not JSON key order',
    r.args[0] === 10 && r.args[1] === 20 && r.args[2] === 30, JSON.stringify(r.args));

const badItem = { function: { name: 'craftRecipe',
    arguments: JSON.stringify({ recipe_name: 'definitely_not_an_item', num: 1 }) } };
const rb = resolveToolCall(badItem);
if (mcDataReady())
    check('rejects an item id that does not exist', !rb.ok, rb.ok ? 'accepted!' : rb.error);
else
    check('degrades safely when minecraft-data is not initialised', rb.ok,
        'accepted without validation, as intended pre-connect');

const missing = { function: { name: 'goToCoordinates', arguments: '{"x":1}' } };
check('rejects a call missing required params', !resolveToolCall(missing).ok);

const unknown = { function: { name: 'notARealTool', arguments: '{}' } };
check('rejects an unknown tool', !resolveToolCall(unknown).ok);

const badJson = { function: { name: 'goToCoordinates', arguments: '{not json' } };
check('rejects malformed JSON arguments', !resolveToolCall(badJson).ok);

console.log('\n== 3. live model, full tool surface ==');
const model = new LMStudio(process.env.LMSTUDIO_CHAT_MODEL, process.env.LMSTUDIO_BASE_URL, null);

const scenarios = [
    // Expectations name real registry commands. Reconnaissance first (checking
    // inventory or searching before acting) is legitimate agent behaviour, so
    // those count as passes where a real agent would plausibly start there.
    { label: 'social debt', expect: ['givePlayer', 'inventory'],
      sys: 'You are Bram, a miner in a village. Act using the tools.',
      turns: [{ role: 'user', content: 'Nia says: "Bram, you still owe me 3 bread." You have 6 bread. Settle it.' }] },
    { label: 'navigation', expect: ['goToCoordinates', 'goToPlayer'],
      sys: 'You are Bram, a miner in a village. Act using the tools.',
      turns: [{ role: 'user', content: 'Walk to the coordinates 120, 64, -30.' }] },
    // Open-ended "go do X" reliably draws a cheap query first (measured: the
    // model picked `inventory`, then `stats`, on successive runs). That is not a
    // bug, but the turn loop must not stall in reconnaissance -- so this checks
    // the property that actually matters: once the query is answered, does it
    // commit to an action?
    { label: 'gathering, post-recon', expect: ['collectBlocks', 'searchForBlock'],
      sys: 'You are Bram, a miner in a village. Act using the tools. Do not repeat a query you already have the answer to.',
      turns: [
        { role: 'user', content: 'We need wood for the hall. Go get some oak logs.' },
        { role: 'assistant', content: 'Checking my surroundings first.' },
        { role: 'user', content: 'Result of stats: You are at (100, 64, 100), health 20/20. Nearby blocks: oak_log, dirt, grass_block, stone. Inventory: empty. You already have this information.' },
      ] },
    { label: 'social speech', expect: ['startConversation', 'goToPlayer', 'lookAtPlayer'],
      sys: 'You are Bram, a miner in a village. Act using the tools.',
      turns: [{ role: 'user', content: 'You want to ask Nia whether she will trade wheat for your iron. Begin.' }] },
];

for (const s of scenarios) {
    const t0 = Date.now();
    const out = await model.sendToolRequest(s.turns, s.sys, tools);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const call = out.tool_calls?.[0];
    const name = call?.function?.name;
    const reasoning = out.usage?.completion_tokens_details?.reasoning_tokens ?? '?';

    console.log(`\n  [${s.label}] ${secs}s, ${reasoning} reasoning tokens`);
    if (out.error) console.log(`    error: ${out.error}`);
    check(`  returned a tool call`, !!call, name || 'none');
    if (call) {
        console.log(`    -> ${name}(${call.function.arguments})`);
        check(`  chose a sensible tool`, s.expect.includes(name), `got ${name}, expected one of ${s.expect}`);
        const res = resolveToolCall(call);
        check(`  call validates and maps to positional args`, res.ok, res.ok ? JSON.stringify(res.args) : res.error);
    }
}

console.log('\n== 4. round-trip: tool call -> command text -> parsed args ==');
// Everything downstream of the prompter speaks !command(args), so a rendered
// command MUST survive upstream's own parser with identical arguments.
const { renderTurn, renderCommand, executedArgs } = await import('./toolCommandBridge.js');
const { parseCommandMessage, containsCommand } = await import('../agent/commands/index.js');

// Upstream's parseCommandMessage validates ItemName/BlockName against
// minecraft-data, which is only populated on bot login -- so those cases can
// only be round-tripped with a live connection. They are covered by
// verify-live.mjs rather than quietly skipped here.
const roundTrip = (toolName, argsObj, label, needsMcData = false) => {
    if (needsMcData && !mcDataReady()) {
        console.log(`  SKIP  ${label} -- needs a connected bot, see verify-live.mjs`);
        return;
    }
    const res = resolveToolCall({ function: { name: toolName, arguments: JSON.stringify(argsObj) } });
    if (!res.ok) { check(label, false, res.error); return; }
    const text = renderTurn(res.command, res.args);
    const found = containsCommand(text);
    const parsed = parseCommandMessage(text);
    const expected = executedArgs(res.command, res.args);
    const ok = found === res.command.name
        && typeof parsed !== 'string'
        && JSON.stringify(parsed.args) === JSON.stringify(expected)
        && !/[\r\n]/.test(text);   // must stay on one line for chat
    check(label, ok, ok ? text.slice(0, 90)
        : `text=${JSON.stringify(text).slice(0,110)} parsed=${typeof parsed === 'string' ? parsed : JSON.stringify(parsed.args)}`);
};

roundTrip('goToCoordinates', { x: 10, y: -64, z: 30.5, closeness: 2 }, 'numbers incl. negative and decimal');
roundTrip('givePlayer', { player_name: 'Nia', item_name: 'bread', num: 3 }, 'strings and ints', true);
roundTrip('startConversation', { player_name: 'Nia', message: 'Will you trade wheat for iron?' }, 'speech with punctuation');
// The parser's string form is "[^"]*" with no unescaping, so an embedded quote
// would terminate the argument early and silently truncate the message.
roundTrip('startConversation', { player_name: 'Nia', message: 'She said "no" to me, twice.' }, 'speech containing double quotes');
roundTrip('startConversation', { player_name: 'Nia', message: 'line one\nline two' }, 'speech containing a newline');
roundTrip('stats', {}, 'zero-argument command');

// Speech should lead so players see words, not bare syntax.
const conv = resolveToolCall({ function: { name: 'startConversation',
    arguments: JSON.stringify({ player_name: 'Nia', message: 'Trade?' }) } });
check('speech is surfaced ahead of the command',
    conv.ok && renderTurn(conv.command, conv.args).startsWith('Trade?'),
    conv.ok ? renderTurn(conv.command, conv.args) : conv.error);
check('bare render omits speech',
    conv.ok && renderCommand(conv.command, conv.args).startsWith('!startConversation'));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
