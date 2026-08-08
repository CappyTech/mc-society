/**
 * Send a message to a villager as if a player had said it.
 *
 *   node scripts/say.mjs Odile '!build("small_wood_house")'
 *   node scripts/say.mjs Odile 'what are you working on?'
 *
 * Why this exists: a message containing a command is executed directly by the
 * agent, without an LLM turn (see Agent.handleMessage). That makes this the
 * only way to exercise a command end-to-end when the inference server is
 * unavailable or misconfigured -- which is exactly when you most want to know
 * whether the rest of the system works.
 *
 * Run it inside the village container, where the MindServer is listening:
 *   docker exec mcs-village node scripts/say.mjs Odile '!stats'
 */
import { io } from 'socket.io-client';

const [name, ...rest] = process.argv.slice(2);
const message = rest.join(' ');

if (!name || !message) {
    console.error('usage: node scripts/say.mjs <AgentName> <message>');
    process.exit(2);
}

const port = process.env.MINDSERVER_PORT || 8080;
const socket = io(`http://localhost:${port}`);

const fail = (why) => { console.error(why); process.exit(1); };

const timer = setTimeout(() => fail(`No response from the MindServer on :${port} after 10s.`), 10000);

socket.on('connect_error', (e) => { clearTimeout(timer); fail(`Cannot reach the MindServer: ${e.message}`); });

// The server pushes the roster to every client on connect. It drops a message
// for an unknown agent with only a server-side console warning, so check here
// and say so plainly rather than exiting 0 having done nothing.
// The server re-broadcasts the roster whenever any agent connects or leaves,
// so this fires repeatedly. Act on the first one only -- otherwise a later
// broadcast (taken while some agent is mid-restart) reports the target as
// absent and prints a contradiction after the message has already been sent.
let sent = false;
socket.on('agents-status', (agents) => {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    const inGame = (agents || []).filter((a) => a.in_game).map((a) => a.name);

    if (!inGame.includes(name))
        fail(`${name} is not in game. Currently in game: ${inGame.join(', ') || '(none)'}`);

    socket.emit('send-message', name, { from: 'player', message });
    console.log(`-> ${name}: ${message}`);
    // The send is fire-and-forget; give it a moment to flush before exiting.
    setTimeout(() => process.exit(0), 500);
});
