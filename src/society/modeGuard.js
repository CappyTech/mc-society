/**
 * Which modes are allowed to stop the self-prompt loop. Pure, no database.
 *
 * WHY THIS EXISTS
 * ---------------
 * `modes.js` `execute()` called `agent.self_prompter.stopLoop()` on EVERY mode
 * execution, unconditionally. The self-prompt loop is the only thing that makes
 * a villager act when nobody is talking to them, so that one line meant any
 * mode firing on a timer could switch a villager off.
 *
 * `torch_placing` is the mode that found it. It retries every 5 seconds, and
 * placing a torch at your own feet with `placeOn: 'bottom'` frequently has
 * nothing to place against -- 28 failures in 25 minutes, and eight villagers
 * standing still. The mode was disabled to get the village moving again, which
 * treated the symptom: any other cosmetic mode on a timer would have done the
 * same thing.
 *
 * THE RULE
 * --------
 * A mode may stop the goal loop only if it already claims the right to
 * interrupt every action. Placing a torch does not. Drowning does.
 *
 * That is not a new taxonomy invented here -- `interrupts: ['all']` is an
 * existing declaration in `modes_list`, and the modes that carry it are exactly
 * the ones whose whole purpose is to override what the villager was doing:
 * self_preservation, unstuck, cowardice, self_defense. The modes that do not
 * carry it -- torch_placing, item_collecting, elbow_room, idle_staring -- are
 * opportunistic housekeeping that should never have been able to end a turn.
 *
 * A FREE SECOND FIX
 * -----------------
 * `should_reprompt` in the same function already requires
 * `!agent.self_prompter.isActive()`. While every mode stopped the loop, every
 * mode also satisfied that clause and generated an `(AUTO MESSAGE)` turn --
 * a second wasted LLM turn per torch, on an inference server that already
 * starves at eight agents. Guarding the `stopLoop` call removes both.
 */

/**
 * May this mode preempt the self-prompt loop?
 *
 * Defensive about its input on purpose: it is called from `modes.js`, which is
 * upstream code that CI does not lint and the tests cannot import (it pulls in
 * mineflayer). A malformed or missing mode must read as "not allowed to
 * preempt" rather than throw -- the failure we are fixing was villagers
 * standing still, and an exception here would reproduce it exactly.
 *
 * @param {{interrupts?: string[], preempt_goal?: boolean}} mode
 * @returns {boolean}
 */
export function preemptsGoal(mode) {
    // An explicit declaration wins, so a future mode can opt in or out without
    // having to lie about what it interrupts.
    if (typeof mode?.preempt_goal === 'boolean') return mode.preempt_goal;
    return Array.isArray(mode?.interrupts) && mode.interrupts.includes('all');
}
