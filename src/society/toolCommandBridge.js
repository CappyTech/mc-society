/**
 * Render a tool call back into upstream's `!command(args)` text form.
 *
 * WHY GO BACK TO TEXT
 * -------------------
 * The model has to be driven with mandatory tool calls (see
 * docs/reasoning-model.md), but everything downstream of the prompter --
 * history, chat routing, interrupt handling, self-prompting, the executor --
 * already speaks the `!command(args)` dialect and works. Rendering the call back
 * into that dialect means the entire agent loop is untouched, so this fork stays
 * mergeable and we inherit upstream's behaviour rather than reimplementing it.
 *
 * The output MUST satisfy the regexes in agent/commands/index.js:
 *   commandRegex: !(\w+)(?:\((<arg>(?:\s*,\s*<arg>)*)\))?
 *   argRegex:     -?\d+(?:\.\d+)?  |  true  |  false  |  "[^"]*"
 *
 * Note the string form: double quotes, and `[^"]*` means a literal double quote
 * inside the value terminates it early and corrupts the parse. Escaping is not
 * an option because the parser does not unescape.
 */

/**
 * Format one argument as an argRegex-legal literal.
 * @param {any} value
 * @returns {string}
 */
export function formatArg(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';

    if (typeof value === 'number') {
        // argRegex accepts no exponent, Infinity or NaN.
        if (!Number.isFinite(value)) return '0';
        return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
    }

    return `"${sanitizeString(String(value ?? ''))}"`;
}

/**
 * Make a string safe to sit inside "..." in a command.
 *
 * A double quote would end the literal early, and a newline would split the
 * rendered command across lines where later parsing gets confused about where
 * the message ended. Both are replaced rather than escaped, because the parser
 * has no unescaping step -- what it reads is what the command receives.
 */
export function sanitizeString(s) {
    return s
        .replace(/"/g, "'")      // a literal " would terminate the argument
        .replace(/[\r\n]+/g, ' ') // keep the command on one line
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Render a resolved command + positional args as command text.
 * @param {object} command - registry entry (its `name` already carries the '!')
 * @param {any[]} args - positional, in params order
 * @returns {string}
 */
export function renderCommand(command, args) {
    if (!args || args.length === 0) return command.name;
    return `${command.name}(${args.map(formatArg).join(', ')})`;
}

/**
 * Some tools carry speech the player should actually see. Where a command has a
 * message-ish parameter, surface it as the spoken part so chat reads naturally
 * instead of showing bare command syntax.
 *
 * Returns '' when the command has nothing to say, in which case upstream's
 * show_command_syntax setting decides what (if anything) is shown.
 */
const SPEECH_PARAM = { '!startConversation': 'message', '!endConversation': null };

export function speechFor(command, args) {
    const key = SPEECH_PARAM[command.name];
    if (!key) return '';
    const idx = Object.keys(command.params || {}).indexOf(key);
    if (idx < 0) return '';
    const value = args[idx];
    return typeof value === 'string' ? value : '';
}

/**
 * Full render: leading speech (if any) followed by the command.
 *
 * agent.js reads everything before the command as the chat message and
 * everything from the command onward as the instruction, so this ordering is
 * what makes a spoken line and its action arrive together.
 */
export function renderTurn(command, args) {
    // Sanitize the spoken part too. It is not inside quotes so it cannot corrupt
    // the parse, but Minecraft chat is single-line -- an unsanitized newline
    // splits one utterance into two messages, and the second may look like it
    // came from nowhere.
    const speech = sanitizeString(speechFor(command, args));
    const cmd = renderCommand(command, args);
    return speech ? `${speech} ${cmd}` : cmd;
}

/**
 * The arguments a rendered command will actually execute with.
 *
 * Rendering is deliberately lossy for strings (see sanitizeString), so this is
 * the honest expectation to assert a round-trip against -- not the pre-render
 * values.
 */
export function executedArgs(command, args) {
    return args.map((v) => (typeof v === 'string' ? sanitizeString(v) : v));
}
