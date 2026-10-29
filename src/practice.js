// Practice (drums & controllers plan, phase 7): loop one section with core's
// A-B loop, optionally slowed down, optionally as a drill ("loop until N%,
// three times", after note detect's drill ramp). Pure: returns the next state
// and the effects the runtime runs (setLoop, clearLoop, setSpeed, toast).
//
// A session that looped or slowed down is practice (contract §3
// play:result.practice): `practiced` latches on the first loop wrap, slowed
// rate or started practice, and stays on to the results.

// Playback speed steps, full speed first. A drill climbs them back to 1.
export const PRACTICE_SPEEDS = Object.freeze([1, 0.9, 0.8, 0.7]);
// The drill's default goal (pass accuracy, 0..1) and clears in a row at full speed.
export const DRILL_GOAL = 0.9;
export const DRILL_REPS = 3;

const finite = Number.isFinite;
const pct = (v) => Math.round(v * 100) + '%';
const TIMES = ['zero times', 'once', 'two times', 'three times', 'four times', 'five times'];
const times = (n) => TIMES[n] || n + ' times';

export function initialPractice() {
    return { mode: 'off', section: null, speed: 1, goal: DRILL_GOAL, reps: DRILL_REPS, clears: 0, practiced: false, done: false };
}

// True once the session looped, slowed down or practiced: never scored.
export function isPractice(state) {
    return !!(state && state.practiced);
}

// The nearest step at or below a rate (the slowest step under it all).
function snapSpeed(rate) {
    if (!finite(rate)) return 1;
    for (const s of PRACTICE_SPEEDS) if (rate >= s - 1e-9) return s;
    return PRACTICE_SPEEDS[PRACTICE_SPEEDS.length - 1];
}

export function slowerSpeed(rate) {
    const i = PRACTICE_SPEEDS.indexOf(snapSpeed(rate));
    return PRACTICE_SPEEDS[Math.min(i + 1, PRACTICE_SPEEDS.length - 1)];
}

// The next step up from a rate (a rate between steps goes to the one above it).
export function fasterSpeed(rate) {
    if (!finite(rate)) return 1;
    for (let i = PRACTICE_SPEEDS.length - 1; i >= 0; i--) if (PRACTICE_SPEEDS[i] > rate + 1e-9) return PRACTICE_SPEEDS[i];
    return 1;
}

function validSection(s) {
    return !!s && finite(s.start) && finite(s.end) && s.end > s.start;
}

function drillOptions(drill) {
    const o = drill && typeof drill === 'object' ? drill : {};
    const goal = finite(o.goal) && o.goal > 0 && o.goal <= 1 ? o.goal : DRILL_GOAL;
    const reps = Number.isInteger(o.reps) && o.reps > 0 ? o.reps : DRILL_REPS;
    return { goal, reps };
}

function onPass(state, accuracy) {
    if (state.mode === 'off' || !finite(accuracy)) return [state, []];
    const name = state.section.name || 'Section';
    if (state.mode === 'loop') return [state, [{ type: 'toast', text: name + ': ' + pct(accuracy) }]];
    // The drill (note detect's _ndDrillRampDecision): miss the goal -> hold (and
    // the clears in a row start over); clear it below full speed -> one step
    // faster; clear it at full speed -> bank it, done after `reps` in a row.
    if (accuracy < state.goal - 1e-9) {
        const next = { ...state, clears: 0 };
        return [next, [{ type: 'toast', text: `${name}: ${pct(accuracy)}, need ${pct(state.goal)} (0 of ${state.reps})` }]];
    }
    if (state.speed < 1) {
        const speed = fasterSpeed(state.speed);
        return [{ ...state, speed, clears: 0 }, [
            { type: 'setSpeed', rate: speed },
            { type: 'toast', text: `${name}: ${pct(accuracy)}, speeding up to ${pct(speed)}` },
        ]];
    }
    const clears = state.clears + 1;
    if (clears >= state.reps) {
        return [{ ...state, mode: 'off', clears, done: true }, [
            { type: 'clearLoop' },
            { type: 'toast', text: `Drill done: ${name} at ${pct(state.goal)} ${times(state.reps)}` },
        ]];
    }
    return [{ ...state, clears }, [{ type: 'toast', text: `${name}: ${pct(accuracy)} (${clears} of ${state.reps})` }]];
}

// reducePractice(state, action) -> { state, effects }
//   { type: 'start', section: { name, start, end }, speed?, drill?: true | { goal, reps } }
//   { type: 'pass', accuracy }   one loop pass finished (null: nothing judged)
//   { type: 'wrap' }             core's loop wrapped (any loop, ours or the player's)
//   { type: 'rate', rate }       the playback rate seen now
//   { type: 'stop' }             leave practice: loop cleared, full speed
export function reducePractice(state, action) {
    const s = state || initialPractice();
    const a = action || {};
    let next = s;
    let effects = [];
    switch (a.type) {
    case 'start': {
        if (!validSection(a.section)) break;
        const speed = snapSpeed(finite(a.speed) ? a.speed : 1);
        const drill = a.drill ? drillOptions(a.drill) : null;
        next = {
            ...s, mode: drill ? 'drill' : 'loop',
            section: { name: typeof a.section.name === 'string' ? a.section.name : '', start: a.section.start, end: a.section.end },
            speed, goal: drill ? drill.goal : DRILL_GOAL, reps: drill ? drill.reps : DRILL_REPS,
            clears: 0, practiced: true, done: false,
        };
        effects = [{ type: 'setLoop', start: a.section.start, end: a.section.end }];
        if (speed !== 1) effects.push({ type: 'setSpeed', rate: speed });
        break;
    }
    case 'pass':
        [next, effects] = onPass(s, a.accuracy);
        break;
    case 'wrap':
        if (!s.practiced) next = { ...s, practiced: true };
        break;
    case 'rate':
        if (finite(a.rate) && a.rate < 1 - 1e-6 && !s.practiced) next = { ...s, practiced: true };
        break;
    case 'stop':
        if (s.mode === 'off') break;
        next = { ...s, mode: 'off', clears: 0 };
        effects = [{ type: 'clearLoop' }];
        if (s.speed !== 1) {
            effects.push({ type: 'setSpeed', rate: 1 });
            next.speed = 1;
        }
        break;
    default:
        break;
    }
    return { state: next, effects };
}
