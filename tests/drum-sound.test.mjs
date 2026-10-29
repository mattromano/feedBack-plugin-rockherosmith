// Drum sound modes (plan 6 R2, R16): a pure state machine, nothing plays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrumSound, dropoutStep, DRUM_SOUND_MODES, DRUM_SOUND_MODE_LABELS, padsMuted } from '../src/drum-sound.js';

test('song drums never mute', () => {
    const d = createDrumSound('song');
    assert.equal(d.mode, 'song');
    assert.equal(d.muted(), false);
    assert.equal(d.judge('miss'), false);
    assert.equal(d.muted(), false);
    assert.equal(d.seek(), false);
});

test('my kit only is muted for the whole song', () => {
    const d = createDrumSound('kit');
    assert.equal(d.muted(), true);
    assert.equal(d.judge('hit'), false);
    assert.equal(d.seek(), false);
    assert.equal(d.muted(), true);
});

test('rock band: a miss or overhit drops out, the next hit comes back', () => {
    const d = createDrumSound('rockband');
    assert.equal(d.muted(), false);
    assert.equal(d.judge('miss'), true);
    assert.equal(d.muted(), true);
    assert.equal(d.judge('overhit'), false);
    assert.equal(d.judge('miss'), false);
    assert.equal(d.muted(), true);
    assert.equal(d.judge('hit'), true);
    assert.equal(d.muted(), false);
    assert.equal(d.judge('hit'), false);
    assert.equal(d.judge('overhit'), true);
    assert.equal(d.muted(), true);
});

test('rock band: a seek brings the drums back', () => {
    const d = createDrumSound('rockband');
    d.judge('miss');
    assert.equal(d.seek(), true);
    assert.equal(d.muted(), false);
    assert.equal(d.seek(), false);
});

test('unknown modes and judgments', () => {
    assert.equal(createDrumSound('loud').mode, 'song');
    assert.equal(createDrumSound(undefined).mode, 'song');
    const d = createDrumSound('rockband');
    assert.equal(d.judge('sp-activate'), false);
    assert.equal(d.muted(), false);
});

test('dropoutStep: the drop-out rule the stem sound shares', () => {
    for (const kind of ['miss', 'overhit', 'overstrum']) assert.equal(dropoutStep(false, kind), true, kind);
    assert.equal(dropoutStep(true, 'hit'), false);
    for (const kind of ['sustain-end', 'sp-activate', undefined]) {
        assert.equal(dropoutStep(true, kind), true, String(kind));
        assert.equal(dropoutStep(false, kind), false, String(kind));
    }
});

// Play layer contract §6: the labels, and when the pads go silent.
test('DRUM_SOUND_MODE_LABELS: one label per mode id', () => {
    assert.deepEqual(DRUM_SOUND_MODE_LABELS, { rockband: 'Rock Band', song: 'Song + pads', kit: 'Kit only' });
    for (const id of DRUM_SOUND_MODES) assert.equal(typeof DRUM_SOUND_MODE_LABELS[id], 'string');
});

test('padsMuted: only when every drums player plays Rock Band', () => {
    assert.equal(padsMuted(['rockband']), true);
    assert.equal(padsMuted(['rockband', 'rockband']), true);
    assert.equal(padsMuted(['rockband', 'song']), false);
    assert.equal(padsMuted(['kit']), false);
    assert.equal(padsMuted([]), false);
    assert.equal(padsMuted(null), false);
});
