import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guitarEntry, drumsEntry, vocalsEntry, vocalsTotals, onsetTime, drumsOverdrive, vocalsOverdrive, fiveFretEntry, drumsBonusEntry } from '../src/part-events.js';

test("guitar: only the default detector's counted judgments score", () => {
    const d = { isDefault: true, counted: true, hit: true, points: 100, multiplier: 2, streak: 12 };
    assert.deepEqual(guitarEntry(d, 5), { part: 'guitar', t: 5, kind: 'hit', points: 100, multiplier: 2, streak: 12, noteTime: null });
    assert.equal(guitarEntry({ ...d, isDefault: false }, 5), null);
    assert.equal(guitarEntry({ ...d, counted: false }, 5), null);
    assert.equal(guitarEntry(null, 5), null);
});

test('guitar: a miss scores nothing', () => {
    const m = guitarEntry({ isDefault: true, counted: true, hit: false, multiplier: 1, streak: 0 }, 6);
    assert.equal(m.kind, 'miss');
    assert.equal(m.points, 0);
});

test('guitar: non-finite fields fall back', () => {
    assert.deepEqual(guitarEntry({ isDefault: true, counted: true, hit: true, points: 'x' }, 1),
        { part: 'guitar', t: 1, kind: 'hit', points: 0, multiplier: 1, streak: 0, noteTime: null });
});

test("drums: only the band's canvas, only judgments", () => {
    const band = {}, other = {};
    const hit = { canvas: band, points: 50, multiplier: 2, combo: 14, stars: 1.5, spActive: false };
    assert.deepEqual(drumsEntry('hit', hit, 3, band),
        { part: 'drums', t: 3, kind: 'hit', points: 50, multiplier: 2, streak: 14, stars: 1.5 });
    assert.equal(drumsEntry('hit', { ...hit, canvas: other }, 3, band), null);
    assert.equal(drumsEntry('hit', hit, 3, null), null);
    assert.equal(drumsEntry('hit', null, 3, band), null);
    assert.equal(drumsEntry('sp-ready', hit, 3, band), null);
    const over = drumsEntry('overhit', { ...hit, points: 50 }, 3, band);
    assert.equal(over.kind, 'overhit');
    assert.equal(over.points, 0);
    const miss = drumsEntry('miss', { canvas: band, combo: 0 }, 3, band);
    assert.deepEqual(miss, { part: 'drums', t: 3, kind: 'miss', points: 0, multiplier: 1, streak: 0, stars: null });
});

test('drumsEntry with an id records that part; default stays drums', () => {
    const lane = {};
    const d = { canvas: lane, points: 40, multiplier: 2, combo: 3, stars: 2.5 };
    assert.deepEqual(drumsEntry('hit', d, 4, lane, 'ctl2'),
        { part: 'ctl2', t: 4, kind: 'hit', points: 40, multiplier: 2, streak: 3, stars: 2.5 });
    assert.equal(drumsEntry('miss', { canvas: lane }, 4, lane, 'ctl2').part, 'ctl2');
    assert.equal(drumsEntry('hit', d, 4, lane).part, 'drums');
    assert.equal(drumsEntry('hit', d, 4, {}, 'ctl2'), null, 'another canvas is not that lane');
});

test("drums: star power doesn't lift the band multiplier", () => {
    const band = {};
    assert.equal(drumsEntry('hit', { canvas: band, multiplier: 8, spActive: true }, 0, band).multiplier, 4);
});

test('vocals: totals are authoritative; pass is a running streak', () => {
    const d = { rating: 'Strong', accuracy: 0.8, points: 1600, multiplier: 3, streak: 2, stars: 2.4 };
    assert.deepEqual(vocalsEntry(d, 9), {
        part: 'vocals', t: 9, kind: 'phrase', points: 1600, multiplier: 3, streak: 2,
        stars: 2.4, accuracy: 0.8, rating: 'Strong', passed: true,
    });
    assert.equal(vocalsEntry({ ...d, streak: 0 }, 9).passed, false);
    assert.equal(vocalsEntry({ ...d, rating: 7 }, 9).rating, null);
    assert.equal(vocalsEntry({ rating: 'Strong' }, 9).accuracy, 0);
    assert.equal(vocalsEntry({ rating: 'Strong' }, 9).stars, null);
    assert.equal(vocalsEntry(null, 9), null);
    assert.equal(vocalsEntry('phrase', 9), null);
});

test('vocalsTotals reads a reset', () => {
    assert.equal(vocalsTotals(null), null);
    assert.deepEqual(vocalsTotals({ multiplier: 1, streak: 0, stars: 0 }), { multiplier: 1, streak: 0, stars: 0 });
    assert.deepEqual(vocalsTotals({ score: 10 }), { multiplier: 1, streak: 0, stars: null });
});

test('guitarEntry keeps noteTime', () => {
    const d = { isDefault: true, counted: true, hit: true, points: 100 };
    assert.equal(guitarEntry({ ...d, noteTime: 4.2 }, 5).noteTime, 4.2);
    assert.equal(guitarEntry(d, 5).noteTime, null);
    assert.equal(guitarEntry({ ...d, noteTime: NaN }, 5).noteTime, null);
});

test('onsetTime', () => {
    assert.equal(onsetTime({ isDefault: true, t: 3 }), 3);
    assert.equal(onsetTime({ isDefault: false, t: 3 }), null);
    assert.equal(onsetTime({ isDefault: true, t: NaN }), null);
    assert.equal(onsetTime({ t: 3 }), null);
    assert.equal(onsetTime(null), null);
});

test('drumsOverdrive / vocalsOverdrive', () => {
    assert.deepEqual(drumsOverdrive({ starPower: { amount: 0.75, active: true } }), { fill: 0.75, active: true });
    assert.deepEqual(drumsOverdrive({ starPower: { amount: 3, active: 0 } }), { fill: 1, active: false });
    assert.equal(drumsOverdrive(null), null);
    assert.equal(drumsOverdrive({}), null);
    assert.deepEqual(vocalsOverdrive({ fill: 2, active: false, ready: true }), { fill: 1, active: false, ready: true });
    assert.deepEqual(vocalsOverdrive({ fill: -1, active: true, ready: false }), { fill: 0, active: true, ready: false });
    assert.equal(vocalsOverdrive(null), null);
});

test('drumsOverdrive keeps canActivate', () => {
    assert.deepEqual(drumsOverdrive({ starPower: { amount: 0.5, active: false, canActivate: false } }),
        { fill: 0.5, active: false, canActivate: false });
    assert.deepEqual(drumsOverdrive({ starPower: { amount: 0.3, active: false, canActivate: true } }),
        { fill: 0.3, active: false, canActivate: true });
    // Not a boolean: left out, so the session falls back to the fill rule.
    assert.deepEqual(drumsOverdrive({ starPower: { amount: 0.3, active: false, canActivate: 1 } }),
        { fill: 0.3, active: false });
});

test('fiveFretEntry maps types, score deltas and resets (by the resets count), halves the multiplier under star power', () => {
    const d = (extra) => ({ canvas: {}, score: 0, combo: 0, multiplier: 1, spActive: false, resets: 1, ...extra });
    // The lane's first event: its score counts from 0, whatever its resets count.
    assert.deepEqual(fiveFretEntry('hit', d({ score: 50, combo: 1, noteTime: 1.5 }), 2, 'ctl1', null),
        { part: 'ctl1', t: 2, kind: 'hit', points: 50, multiplier: 1, streak: 1, noteTime: 1.5 });
    const last = { score: 50, resets: 1 };
    assert.equal(fiveFretEntry('hit', d({ score: 150, combo: 2 }), 3, 'ctl1', last).points, 100);
    assert.equal(fiveFretEntry('miss', d({ score: 150 }), 3, 'ctl1', { score: 150, resets: 1 }).kind, 'miss');
    assert.equal(fiveFretEntry('miss', d({ score: 150 }), 3, 'ctl1', { score: 150, resets: 1 }).points, 0);
    assert.equal(fiveFretEntry('overstrum', d({ score: 150 }), 3, 'ctl1', { score: 150, resets: 1 }).kind, 'overhit');
    const sus = fiveFretEntry('sustain-end', d({ score: 180 }), 3, 'ctl1', { score: 150, resets: 1 });
    assert.equal(sus.kind, 'sustain');
    assert.equal(sus.points, 30);
    assert.equal(sus.noteTime, null);
    // A reset (the resets count moved): points count from the reset, even when the score went up.
    assert.equal(fiveFretEntry('hit', d({ score: 40, resets: 2 }), 4, 'ctl1', { score: 150, resets: 1 }).points, 40);
    assert.equal(fiveFretEntry('hit', d({ score: 400, resets: 2 }), 4, 'ctl1', { score: 150, resets: 1 }).points, 400);
    // No reset, but a lower score: never negative.
    assert.equal(fiveFretEntry('hit', d({ score: 40 }), 4, 'ctl1', { score: 150, resets: 1 }).points, 0);
    // Star power doubles the lane multiplier; the band reads it without.
    assert.equal(fiveFretEntry('hit', d({ score: 60, multiplier: 8, spActive: true }), 5, 'ctl2', null).multiplier, 4);
    assert.equal(fiveFretEntry('hit', d({ score: 60, multiplier: 0 }), 5, 'ctl2', null).multiplier, 1);
    // Not a judgment, or no detail.
    for (const type of ['sp-phrase', 'sp-activate', 'band-pause', 'combo-reset']) assert.equal(fiveFretEntry(type, d(), 1, 'ctl1', null), null);
    assert.equal(fiveFretEntry('hit', null, 1, 'ctl1', null), null);
});

// Play layer contract §4: drums:bonus (a drum solo's bonus) is a points-only ledger entry.
test('drumsBonusEntry: the lane canvas only, positive finite points only', () => {
    const canvas = {};
    assert.deepEqual(drumsBonusEntry({ canvas, points: 1500, reason: 'solo' }, 12.5, canvas),
        { part: 'drums', t: 12.5, kind: 'bonus', points: 1500, reason: 'solo' });
    assert.equal(drumsBonusEntry({ canvas, points: 10 }, 1, canvas, 'ctl2').part, 'ctl2');
    assert.equal(drumsBonusEntry({ canvas: {}, points: 10 }, 1, canvas), null);
    assert.equal(drumsBonusEntry({ canvas, points: 0 }, 1, canvas), null);
    assert.equal(drumsBonusEntry({ canvas, points: 'x' }, 1, canvas), null);
    assert.equal(drumsBonusEntry(null, 1, canvas), null);
    assert.equal(drumsBonusEntry({ canvas, points: 5 }, 1, null), null);
    assert.equal(drumsBonusEntry({ canvas, points: 5, reason: 7 }, 1, canvas).reason, null);
});
