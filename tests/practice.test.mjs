// Practice (plan phase 7): the loop / slow-down / drill state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPractice, reducePractice, isPractice, slowerSpeed, fasterSpeed, PRACTICE_SPEEDS, DRILL_GOAL, DRILL_REPS } from '../src/practice.js';

const VERSE = { name: 'Verse 1', start: 10, end: 20 };
const run = (state, ...actions) => actions.reduce((acc, a) => {
    const r = reducePractice(acc.state, a);
    return { state: r.state, effects: [...acc.effects, ...r.effects] };
}, { state, effects: [] });
const types = (effects) => effects.map((e) => e.type);

test('defaults: off, not practice; speeds and drill constants', () => {
    const s = initialPractice();
    assert.equal(s.mode, 'off');
    assert.equal(isPractice(s), false);
    assert.equal(isPractice(null), false);
    assert.deepEqual(PRACTICE_SPEEDS, [1, 0.9, 0.8, 0.7]);
    assert.equal(DRILL_GOAL, 0.9);
    assert.equal(DRILL_REPS, 3);
    assert.equal(slowerSpeed(1), 0.9);
    assert.equal(slowerSpeed(0.7), 0.7);
    assert.equal(fasterSpeed(0.8), 0.9);
    assert.equal(fasterSpeed(1), 1);
    assert.equal(fasterSpeed(0.75), 0.8);
});

test('start loops the section at full speed: setLoop only, and it is practice', () => {
    const { state, effects } = reducePractice(initialPractice(), { type: 'start', section: VERSE });
    assert.equal(state.mode, 'loop');
    assert.deepEqual(state.section, VERSE);
    assert.equal(isPractice(state), true);
    assert.deepEqual(effects, [{ type: 'setLoop', start: 10, end: 20 }]);
});

test('start with a slow-down sets the speed too; unknown speeds snap to the steps', () => {
    let r = reducePractice(initialPractice(), { type: 'start', section: VERSE, speed: 0.8 });
    assert.deepEqual(r.effects, [{ type: 'setLoop', start: 10, end: 20 }, { type: 'setSpeed', rate: 0.8 }]);
    assert.equal(r.state.speed, 0.8);
    r = reducePractice(initialPractice(), { type: 'start', section: VERSE, speed: 0.3 });
    assert.equal(r.state.speed, 0.7);
    r = reducePractice(initialPractice(), { type: 'start', section: VERSE, speed: 'x' });
    assert.equal(r.state.speed, 1);
});

test('a start with a bad section does nothing', () => {
    for (const section of [null, { start: 5, end: 5 }, { start: 'a', end: 9 }]) {
        const r = reducePractice(initialPractice(), { type: 'start', section });
        assert.equal(r.state.mode, 'off');
        assert.deepEqual(r.effects, []);
    }
});

test('a loop wrap or a slowed rate marks practice without starting anything', () => {
    let r = reducePractice(initialPractice(), { type: 'wrap' });
    assert.equal(isPractice(r.state), true);
    assert.equal(r.state.mode, 'off');
    assert.deepEqual(r.effects, []);
    r = reducePractice(initialPractice(), { type: 'rate', rate: 1 });
    assert.equal(isPractice(r.state), false);
    r = reducePractice(initialPractice(), { type: 'rate', rate: 0.75 });
    assert.equal(isPractice(r.state), true);
    r = reducePractice(initialPractice(), { type: 'rate', rate: NaN });
    assert.equal(isPractice(r.state), false);
});

test('loop mode: each pass shows its accuracy; a pass with nothing judged says nothing', () => {
    const start = reducePractice(initialPractice(), { type: 'start', section: VERSE }).state;
    let r = reducePractice(start, { type: 'pass', accuracy: 0.834 });
    assert.deepEqual(r.effects, [{ type: 'toast', text: 'Verse 1: 83%' }]);
    r = reducePractice(start, { type: 'pass', accuracy: null });
    assert.deepEqual(r.effects, []);
    r = reducePractice(initialPractice(), { type: 'pass', accuracy: 0.5 });
    assert.deepEqual(r.effects, [], 'no practice running: a pass is nobody\'s');
});

test('drill at full speed: three clears in a row finish it; a miss of the goal resets the count', () => {
    const s0 = reducePractice(initialPractice(), { type: 'start', section: VERSE, drill: true }).state;
    assert.equal(s0.mode, 'drill');
    let r = run(s0, { type: 'pass', accuracy: 0.95 });
    assert.equal(r.state.clears, 1);
    assert.deepEqual(r.effects, [{ type: 'toast', text: 'Verse 1: 95% (1 of 3)' }]);
    r = run(r.state, { type: 'pass', accuracy: 0.8 });
    assert.equal(r.state.clears, 0);
    assert.deepEqual(r.effects, [{ type: 'toast', text: 'Verse 1: 80%, need 90% (0 of 3)' }]);
    r = run(r.state, { type: 'pass', accuracy: 0.9 }, { type: 'pass', accuracy: 1 });
    assert.equal(r.state.clears, 2);
    r = run(r.state, { type: 'pass', accuracy: 0.92 });
    assert.equal(r.state.mode, 'off');
    assert.equal(r.state.done, true);
    assert.equal(isPractice(r.state), true, 'a finished drill still was practice');
    assert.deepEqual(r.effects, [{ type: 'clearLoop' }, { type: 'toast', text: 'Drill done: Verse 1 at 90% three times' }]);
});

test('drill from a slow-down: a clear steps the speed up, and only full-speed clears count', () => {
    const s0 = reducePractice(initialPractice(), { type: 'start', section: VERSE, speed: 0.8, drill: { goal: 0.85, reps: 2 } }).state;
    let r = run(s0, { type: 'pass', accuracy: 0.86 });
    assert.equal(r.state.speed, 0.9);
    assert.equal(r.state.clears, 0);
    assert.deepEqual(r.effects, [{ type: 'setSpeed', rate: 0.9 }, { type: 'toast', text: 'Verse 1: 86%, speeding up to 90%' }]);
    r = run(r.state, { type: 'pass', accuracy: 0.5 });
    assert.equal(r.state.speed, 0.9, 'a miss holds the speed');
    r = run(r.state, { type: 'pass', accuracy: 0.9 });
    assert.equal(r.state.speed, 1);
    assert.deepEqual(types(r.effects), ['setSpeed', 'toast']);
    r = run(r.state, { type: 'pass', accuracy: 0.9 }, { type: 'pass', accuracy: 0.9 });
    assert.equal(r.state.mode, 'off');
    assert.deepEqual(r.effects.slice(-2), [{ type: 'clearLoop' }, { type: 'toast', text: 'Drill done: Verse 1 at 85% two times' }]);
});

test('drill: a pass with nothing judged is skipped', () => {
    const s0 = reducePractice(initialPractice(), { type: 'start', section: VERSE, drill: true }).state;
    const r = reducePractice(s0, { type: 'pass', accuracy: null });
    assert.equal(r.state, s0);
    assert.deepEqual(r.effects, []);
});

test('stop clears the loop and puts the speed back', () => {
    let s = reducePractice(initialPractice(), { type: 'start', section: VERSE, speed: 0.7 }).state;
    let r = reducePractice(s, { type: 'stop' });
    assert.equal(r.state.mode, 'off');
    assert.equal(isPractice(r.state), true);
    assert.deepEqual(r.effects, [{ type: 'clearLoop' }, { type: 'setSpeed', rate: 1 }]);
    s = reducePractice(initialPractice(), { type: 'start', section: VERSE }).state;
    assert.deepEqual(reducePractice(s, { type: 'stop' }).effects, [{ type: 'clearLoop' }]);
    assert.deepEqual(reducePractice(initialPractice(), { type: 'stop' }).effects, []);
});

test('never mutates its input; unknown actions are no-ops', () => {
    const s = Object.freeze(initialPractice());
    assert.doesNotThrow(() => reducePractice(s, { type: 'start', section: VERSE, drill: true }));
    const r = reducePractice(s, { type: 'nope' });
    assert.equal(r.state, s);
    assert.deepEqual(r.effects, []);
    assert.deepEqual(reducePractice(s, null).effects, []);
});
