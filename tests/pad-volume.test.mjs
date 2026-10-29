// The pad volume slider (contract §4: feedBackDrums.getPadSound / setPadSound).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPadVolume, padSoundApi, volumePct } from '../src/pad-volume.js';
import { makeDoc } from './fake-dom.mjs';

const drums = (volume = 0.8) => {
    const sets = [];
    const api = {
        getPadSound: () => ({ muted: false, volume }),
        setPadSound: (o) => { sets.push(o); if (typeof o.volume === 'number') volume = o.volume; return { muted: false, volume }; },
    };
    return { api, sets };
};

test('padSoundApi needs both calls; get clamps and survives a throw', () => {
    assert.equal(padSoundApi({}), null);
    assert.equal(padSoundApi({ feedBackDrums: { getPadSound: () => ({}) } }), null);
    assert.equal(padSoundApi({ feedBackDrums: { getPadSound: () => ({ volume: 3 }), setPadSound() {} } }).get(), 1);
    assert.equal(padSoundApi({ feedBackDrums: { getPadSound: () => ({ volume: 'x' }), setPadSound() {} } }).get(), null);
    assert.equal(padSoundApi({ feedBackDrums: { getPadSound: () => { throw new Error('x'); }, setPadSound() {} } }).get(), null);
    assert.deepEqual([volumePct(0.355), volumePct(-1), volumePct(2)], [36, 0, 100]);
});

test('the slider shows the plugin volume and sets it as you drag', () => {
    const doc = makeDoc();
    const { api, sets } = drums(0.6);
    const pv = createPadVolume({ doc, win: { feedBackDrums: api } });
    doc.body.appendChild(pv.field);
    assert.equal(pv.field.hidden, false);
    assert.equal(pv.input.value, '60');
    assert.equal(pv.field.querySelector('.rhs-padvol-val').textContent, '60%');
    assert.equal(pv.field.querySelector('.rhs-label').textContent, 'Pad volume');
    pv.input.value = '35';
    pv.input.fire('input');
    assert.deepEqual(sets, [{ volume: 0.35 }]);
    assert.equal(pv.field.querySelector('.rhs-padvol-val').textContent, '35%');
    // A render while the slider has focus leaves the drag alone.
    pv.input.focus();
    pv.input.value = '40';
    pv.render();
    assert.equal(pv.input.value, '40');
});

test('no API: the field hides, and appears once the drums plugin has it', () => {
    const doc = makeDoc();
    const win = {};
    const pv = createPadVolume({ doc, win });
    assert.equal(pv.field.hidden, true);
    pv.input.value = '50';
    pv.input.fire('input');
    win.feedBackDrums = drums(0.25).api;
    pv.render();
    assert.equal(pv.field.hidden, false);
    assert.equal(pv.input.value, '25');
});
