import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBandScore, BAND_BONUS_STEP, MAX_BAND_MULTIPLIER, CROWD } from '../src/band-score.js';

const e = (o) => ({ t: 0, points: 0, multiplier: 1, streak: 0, ...o });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const PARTS = ['guitar', 'drums', 'vocals'];

test('constants', () => {
    assert.equal(BAND_BONUS_STEP, 0.075);
    assert.equal(MAX_BAND_MULTIPLIER, 4);
    assert.deepEqual(CROWD, { start: 0.66, hit: 0.02, miss: -0.05, overhit: -0.03, phrasePass: 0.08, phraseFail: -0.10, rescue: 0.4 });
});

test('starts empty', () => {
    const s = createBandScore({ parts: PARTS }).snapshot();
    assert.equal(s.score, 0);
    assert.equal(s.bonus, 0);
    assert.equal(s.bandMultiplier, 1);
    assert.equal(s.stars, null);
    assert.deepEqual(Object.keys(s.parts), PARTS);
    for (const id of PARTS) {
        const p = s.parts[id];
        assert.equal(p.score, 0);
        assert.equal(p.crowd, 0.66);
        assert.equal(p.stars, null);
        assert.equal(p.accuracy, null);
        assert.deepEqual(p.phrases, []);
    }
});

test("part scores add up and the band multiplier is the lowest part's", () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'guitar', kind: 'hit', points: 100, multiplier: 2 }));
    b.record(e({ part: 'drums', kind: 'hit', points: 60, multiplier: 1 }));
    let s = b.snapshot();
    assert.equal(s.bandMultiplier, 1);
    assert.equal(s.score, 160);
    b.record(e({ part: 'drums', kind: 'hit', points: 0, multiplier: 2 }));
    s = b.snapshot();
    assert.equal(s.bandMultiplier, 2);
});

test('the band multiplier is capped at ×4', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'guitar', kind: 'hit', multiplier: 8 }));
    b.record(e({ part: 'drums', kind: 'hit', multiplier: 6 }));
    assert.equal(b.snapshot().bandMultiplier, 4);
});

test('bonus is 7.5 % per step above ×1', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'guitar', kind: 'hit', multiplier: 3 }));
    b.record(e({ part: 'drums', kind: 'hit', multiplier: 3 }));
    b.record(e({ part: 'guitar', kind: 'hit', points: 200, multiplier: 3 }));
    const s = b.snapshot();
    assert.equal(Math.round(200 * 0.075 * 2), 30);
    assert.equal(s.bonus, 30);
    assert.equal(s.parts.guitar.bonus, 30);
    assert.equal(s.parts.drums.bonus, 0);
    assert.equal(s.score, 200 + 30);
});

test('a miss earns no bonus and drops the band to ×1', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'guitar', kind: 'hit', multiplier: 3, streak: 30 }));
    b.record(e({ part: 'drums', kind: 'hit', multiplier: 3, streak: 30 }));
    b.record(e({ part: 'guitar', kind: 'miss', points: 0, multiplier: 1, streak: 0 }));
    const s = b.snapshot();
    assert.equal(s.bonus, 0);
    assert.equal(s.bandMultiplier, 1);
    assert.equal(s.parts.guitar.misses, 1);
    assert.equal(s.parts.guitar.streak, 0);
    assert.equal(s.parts.guitar.bestStreak, 30);
});

test('crowd moves by the R6 steps and clamps', () => {
    const b = createBandScore({ parts: PARTS });
    for (let i = 0; i < 20; i++) b.record(e({ part: 'guitar', kind: 'hit' }));
    assert.equal(b.snapshot().parts.guitar.crowd, 1);
    b.record(e({ part: 'guitar', kind: 'miss' }));
    near(b.snapshot().parts.guitar.crowd, 0.95);
    for (let i = 0; i < 30; i++) b.record(e({ part: 'drums', kind: 'miss' }));
    assert.equal(b.snapshot().parts.drums.crowd, 0);
    const c = createBandScore({ parts: PARTS });
    c.record(e({ part: 'drums', kind: 'overhit' }));
    const d = c.snapshot().parts.drums;
    near(d.crowd, 0.63);
    assert.equal(d.overhits, 1);
    assert.equal(d.hits, 0);
    assert.equal(d.misses, 0);
});

test('vocals phrases: pass/fail crowd, ratings tallied as given, accuracy is the mean', () => {
    const b = createBandScore({ parts: PARTS });
    b.record(e({ part: 'vocals', kind: 'phrase', passed: true, rating: 'Awesome', accuracy: 0.9 }));
    near(b.snapshot().parts.vocals.crowd, 0.74);
    b.record(e({ part: 'vocals', kind: 'phrase', passed: true, rating: 'Grade A', accuracy: 0.8 }));
    b.record(e({ part: 'vocals', kind: 'phrase', passed: false, rating: 'Awesome', accuracy: 0.5 }));
    const v = b.snapshot().parts.vocals;
    near(v.accuracy, (0.9 + 0.8 + 0.5) / 3);
    assert.ok(Math.abs(v.accuracy - 0.733) < 1e-3);
    near(v.crowd, 0.66 + 0.08 + 0.08 - 0.10);
    assert.equal(v.hits, 2);
    assert.equal(v.misses, 1);
    assert.deepEqual(v.phrases, [
        { rating: 'Grade A', count: 1, meanAccuracy: 0.8 },
        { rating: 'Awesome', count: 2, meanAccuracy: 0.7 },
    ]);
});

test('accuracy for guitar and drums is hits / (hits + misses)', () => {
    const b = createBandScore({ parts: PARTS });
    b.record(e({ part: 'drums', kind: 'hit' }));
    b.record(e({ part: 'drums', kind: 'hit' }));
    b.record(e({ part: 'drums', kind: 'hit' }));
    b.record(e({ part: 'drums', kind: 'miss' }));
    b.record(e({ part: 'drums', kind: 'overhit' }));
    assert.equal(b.snapshot().parts.drums.accuracy, 0.75);
});

test('stars: drums and vocals from the entries, guitar from thresholds', () => {
    const b = createBandScore({ parts: PARTS });
    b.record(e({ part: 'drums', kind: 'hit', stars: 2.5 }));
    assert.equal(b.snapshot().parts.drums.stars, 2.5);
    b.record(e({ part: 'vocals', kind: 'phrase', passed: true, accuracy: 1, stars: 9 }));
    assert.equal(b.snapshot().parts.vocals.stars, 6);
    b.record(e({ part: 'guitar', kind: 'hit', points: 30 }));
    assert.equal(b.snapshot().parts.guitar.stars, null);
    b.setStarThresholds('guitar', [60, 120, 200, 470, 780, 1150]);
    let s = b.snapshot();
    assert.equal(s.parts.guitar.stars, 0.5);
    near(s.stars, (2.5 + 6 + 0.5) / 3);
    // Guitar stars follow its score once thresholds are set.
    b.record(e({ part: 'guitar', kind: 'hit', points: 30 }));
    s = b.snapshot();
    assert.equal(s.parts.guitar.stars, 1);
    b.setStarThresholds('guitar', null);
    assert.equal(b.snapshot().parts.guitar.stars, null);
});

test('factor scales points (plan 5 hook)', () => {
    const b = createBandScore({ parts: ['guitar'] });
    b.record(e({ part: 'guitar', kind: 'hit', points: 100, factor: 2 }));
    assert.equal(b.snapshot().parts.guitar.score, 200);
    const c = createBandScore({ parts: ['guitar', 'drums'] });
    c.record(e({ part: 'drums', kind: 'hit', multiplier: 4 }));
    c.record(e({ part: 'guitar', kind: 'hit', points: 100, multiplier: 4, factor: 0 }));
    const s = c.snapshot();
    assert.equal(s.parts.guitar.score, 0);
    assert.equal(s.bonus, 0);
    c.record(e({ part: 'guitar', kind: 'hit', points: 100, multiplier: 4, factor: 2 }));
    assert.equal(c.snapshot().bonus, Math.round(200 * 0.075 * 3));
});

test('rewindTo drops later entries and replays everything', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'drums', t: 0.5, kind: 'hit', multiplier: 2 }));
    b.record(e({ part: 'guitar', t: 1, kind: 'hit', points: 100, multiplier: 2, streak: 1 }));
    const after1 = b.snapshot();
    b.record(e({ part: 'guitar', t: 2, kind: 'hit', points: 100, multiplier: 2, streak: 2 }));
    b.record(e({ part: 'guitar', t: 3, kind: 'hit', points: 100, multiplier: 2, streak: 3 }));
    assert.equal(b.snapshot().parts.guitar.bestStreak, 3);
    b.rewindTo(1.5);
    const s = b.snapshot();
    assert.deepEqual(s, after1);
    assert.equal(s.parts.guitar.score, 100);
    assert.equal(s.parts.guitar.bestStreak, 1);
    near(s.parts.guitar.crowd, 0.68);
    assert.equal(s.bonus, Math.round(100 * 0.075));
    b.record(e({ part: 'guitar', t: 2, kind: 'hit', points: 50, multiplier: 2, streak: 2 }));
    const r = b.snapshot();
    assert.equal(r.parts.guitar.score, 150);
    assert.equal(r.parts.guitar.bestStreak, 2);
    assert.equal(r.parts.guitar.hits, 2);
});

test('rewindTo keeps guitar stars on its thresholds', () => {
    const b = createBandScore({ parts: ['guitar'] });
    b.setStarThresholds('guitar', [60, 120, 200, 470, 780, 1150]);
    b.record(e({ part: 'guitar', t: 1, kind: 'hit', points: 30 }));
    b.record(e({ part: 'guitar', t: 2, kind: 'hit', points: 90 }));
    assert.equal(b.snapshot().parts.guitar.stars, 2);
    b.rewindTo(1);
    assert.equal(b.snapshot().parts.guitar.stars, 0.5);
});

test('syncTotals resets the vocals multiplier without touching score', () => {
    const b = createBandScore({ parts: PARTS });
    b.record(e({ part: 'vocals', kind: 'phrase', passed: true, accuracy: 1, points: 900, multiplier: 3, streak: 4, stars: 2 }));
    b.syncTotals('vocals', { multiplier: 2, streak: 1, stars: 1.5 });
    let v = b.snapshot().parts.vocals;
    assert.equal(v.multiplier, 2);
    assert.equal(v.streak, 1);
    assert.equal(v.stars, 1.5);
    assert.equal(v.score, 900);
    assert.equal(v.bestStreak, 4);
    b.syncTotals('vocals', null);
    v = b.snapshot().parts.vocals;
    assert.equal(v.multiplier, 1);
    assert.equal(v.streak, 0);
    assert.equal(v.stars, null);
    assert.equal(v.score, 900);
});

test('entries for parts not playing are ignored', () => {
    const b = createBandScore({ parts: ['guitar'] });
    b.record(e({ part: 'drums', kind: 'hit', points: 100 }));
    const s = b.snapshot();
    assert.equal(s.score, 0);
    assert.deepEqual(Object.keys(s.parts), ['guitar']);
});

test('dropPart: the band multiplier ignores the dropped part, and its bonus is replayed', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'guitar', kind: 'hit', t: 1, points: 100, multiplier: 3, streak: 20 }));
    assert.equal(b.snapshot().bandMultiplier, 1, 'drums never judged: pinned at x1');
    assert.equal(b.snapshot().bonus, 0);
    b.dropPart('drums');
    const s = b.snapshot();
    assert.equal(s.bandMultiplier, 3);
    assert.equal(s.bonus, Math.round(100 * BAND_BONUS_STEP * 2), 'replayed without drums');
    b.record(e({ part: 'guitar', kind: 'hit', t: 2, points: 100, multiplier: 3, streak: 21 }));
    assert.equal(b.snapshot().parts.guitar.score, 200);
    b.record(e({ part: 'drums', kind: 'hit', t: 3, points: 50 }));
    assert.equal(b.snapshot().score, 200 + 2 * Math.round(100 * BAND_BONUS_STEP * 2), 'a dropped part no longer records');
});

test('dropPart filters out the part\'s entries, survives a rewind, and is idempotent', () => {
    const b = createBandScore({ parts: PARTS });
    b.setStarThresholds('guitar', [10, 20, 30, 40, 50, 60]);
    b.record(e({ part: 'drums', kind: 'hit', t: 1, points: 30, multiplier: 2, streak: 5 }));
    b.record(e({ part: 'guitar', kind: 'hit', t: 2, points: 50, multiplier: 1, streak: 1 }));
    b.record(e({ part: 'vocals', kind: 'phrase', t: 3, points: 200, multiplier: 1, streak: 1, passed: true, accuracy: 0.9, rating: 'Great' }));
    b.dropPart('drums');
    const once = b.snapshot();
    assert.deepEqual(Object.keys(once.parts), ['guitar', 'vocals']);
    assert.equal(once.score, 250);
    b.dropPart('drums');
    b.dropPart('nope');
    assert.deepEqual(b.snapshot(), once);
    b.rewindTo(2.5);
    assert.deepEqual(Object.keys(b.snapshot().parts), ['guitar', 'vocals'], 'a rewind does not bring it back');
    assert.equal(b.snapshot().score, 50);
    assert.ok(Number.isFinite(b.snapshot().parts.guitar.stars), 'other parts keep their thresholds');
});

test('dropPart: the results snapshot lists no card for the dropped part', async () => {
    const { resultsModel } = await import('../src/results.js');
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    b.record(e({ part: 'guitar', kind: 'hit', t: 1, points: 50 }));
    b.dropPart('drums');
    const prefs = { parts: { guitar: { on: true, difficulty: 'medium' }, drums: { on: true, difficulty: 'medium' } } };
    const model = resultsModel({ snapshot: b.snapshot(), prefs, song: {}, oneLevel: false, drumsExtra: null });
    assert.deepEqual(model.cards.map((c) => c.part), ['guitar']);
});

// Plan 5 R12: fail mode and rescue, derived during the replay.
const misses = (b, n, part = 'guitar', t0 = 1) => {
    for (let i = 0; i < n; i++) b.record(e({ part, t: t0 + i, kind: 'miss' }));
};

test('no fail: an empty crowd is only for show', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    misses(b, 30);
    const s = b.snapshot();
    assert.equal(s.parts.guitar.crowd, 0);
    assert.equal(s.parts.guitar.failed, false);
    assert.equal(s.parts.guitar.drops, 0);
    assert.equal(s.bandFailed, false);
});

test('fail on: an empty crowd drops the part; its notes stop scoring', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 13);
    assert.equal(b.snapshot().parts.guitar.failed, false);
    b.record(e({ part: 'guitar', t: 14, kind: 'miss' }));
    let s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.parts.guitar.drops, 1);
    assert.equal(s.parts.guitar.misses, 14);
    b.record(e({ part: 'guitar', t: 15, kind: 'hit', points: 100, multiplier: 1, streak: 1 }));
    s = b.snapshot();
    assert.equal(s.parts.guitar.score, 0);
    assert.equal(s.parts.guitar.hits, 0);
    assert.equal(s.parts.guitar.crowd, 0);
    assert.equal(s.parts.guitar.streak, 0);
    assert.equal(s.bandFailed, false);
    b.record(e({ part: 'drums', t: 16, kind: 'hit', points: 10, multiplier: 3, streak: 30 }));
    assert.equal(b.snapshot().bandMultiplier, 3);
});

test("a bandmate's deploy rescues with a partly refilled meter", () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    b.record({ part: 'drums', t: 15, kind: 'deploy' });
    const s = b.snapshot();
    assert.equal(s.parts.guitar.failed, false);
    assert.equal(s.parts.guitar.crowd, 0.4);
    assert.equal(s.parts.guitar.saves, 1);
    assert.equal(s.parts.guitar.drops, 1);
    assert.equal(s.parts.drums.deploys, 1);
    assert.equal(s.parts.drums.saves, 0);
    assert.equal(s.parts.drums.score, 0);
    b.record(e({ part: 'guitar', t: 20, kind: 'hit', points: 100 }));
    assert.equal(b.snapshot().parts.guitar.score, 100);
});

test("a failed part's deploy rescues nobody", () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    misses(b, 14, 'drums', 1);
    b.record({ part: 'guitar', t: 20, kind: 'deploy' });
    const s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.parts.drums.failed, true);
    assert.equal(s.parts.guitar.deploys, 0, "a failed part's deploy is ignored entirely");
    assert.equal(s.parts.guitar.saves, 0);
    assert.equal(s.parts.drums.saves, 0);
    assert.equal(s.bandFailed, true);
});

test('no fail: a deploy counts but rescues nothing', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    misses(b, 14);
    b.record({ part: 'drums', t: 20, kind: 'deploy' });
    const s = b.snapshot();
    assert.equal(s.parts.drums.deploys, 1);
    assert.equal(s.parts.guitar.crowd, 0);
    assert.equal(s.parts.guitar.saves, 0);
});

test('everyone out is band failed', () => {
    const b = createBandScore({ parts: ['guitar'], failMode: 'fail' });
    misses(b, 13);
    assert.equal(b.snapshot().bandFailed, false);
    b.record(e({ part: 'guitar', t: 14, kind: 'miss' }));
    const s = b.snapshot();
    assert.equal(s.parts.guitar.crowd, 0);
    assert.equal(s.bandFailed, true);
    assert.equal(createBandScore({ parts: [], failMode: 'fail' }).snapshot().bandFailed, false);
});

test('rewinding replays drops and rescues', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    b.record({ part: 'drums', t: 20, kind: 'deploy' });
    assert.equal(b.snapshot().parts.guitar.failed, false);
    b.rewindTo(15);
    let s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.parts.guitar.saves, 0);
    assert.equal(s.parts.guitar.drops, 1);
    assert.equal(s.parts.drums.deploys, 0);
    b.rewindTo(10);
    s = b.snapshot();
    assert.equal(s.parts.guitar.failed, false);
    assert.equal(s.parts.guitar.drops, 0);
});

test('dropPart replays fail state: dropping the only survivor leaves the band failed', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    assert.equal(b.snapshot().bandFailed, false);
    b.dropPart('drums');
    const s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.parts.guitar.drops, 1);
    assert.equal(s.bandFailed, true);
});

test('a failed part loses its streak and multiplier, so a rescue restarts it at ×1', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    b.record(e({ part: 'drums', t: 0, kind: 'hit', points: 10, multiplier: 4, streak: 40 }));
    for (let i = 0; i < 14; i++) b.record(e({ part: 'guitar', t: 1 + i, kind: 'miss', multiplier: 2, streak: 50 }));
    let s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.parts.guitar.streak, 0);
    assert.equal(s.parts.guitar.multiplier, 1);
    assert.equal(s.parts.guitar.bestStreak, 50);
    b.syncTotals('guitar', { multiplier: 3, streak: 30, stars: null });
    s = b.snapshot();
    assert.equal(s.parts.guitar.streak, 0, 'syncTotals keeps a failed part at streak 0');
    assert.equal(s.parts.guitar.multiplier, 1, 'and ×1');
    b.record({ part: 'drums', t: 15, kind: 'deploy' });
    s = b.snapshot();
    assert.equal(s.parts.guitar.failed, false);
    assert.equal(s.parts.guitar.streak, 0);
    assert.equal(s.parts.guitar.multiplier, 1);
    assert.equal(s.bandMultiplier, 1);
    b.rewindTo(15);
    s = b.snapshot();
    assert.equal(s.parts.guitar.streak, 0);
    assert.equal(s.parts.guitar.multiplier, 1);
});

test("dropPart keeps a dropped part's rescues: the rescued part keeps its score", () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    b.record({ part: 'drums', t: 15, kind: 'deploy' });
    for (let i = 0; i < 5; i++) b.record(e({ part: 'guitar', t: 16 + i, kind: 'hit', points: 100 }));
    assert.equal(b.snapshot().parts.guitar.score, 500);
    b.dropPart('drums');
    let s = b.snapshot();
    assert.deepEqual(Object.keys(s.parts), ['guitar']);
    assert.equal(s.parts.guitar.failed, false);
    assert.equal(s.parts.guitar.score, 500);
    assert.equal(s.parts.guitar.saves, 1);
    assert.equal(s.parts.guitar.deploys, 0, "the dropped part's deploy counts for nobody");
    assert.equal(s.bandFailed, false);
    b.rewindTo(19);
    s = b.snapshot();
    assert.equal(s.parts.guitar.failed, false);
    assert.equal(s.parts.guitar.score, 400);
});

test("no fail: a dropped part's deploy rescues nothing and counts for nobody", () => {
    const b = createBandScore({ parts: ['guitar', 'drums'] });
    misses(b, 14);
    b.record({ part: 'drums', t: 15, kind: 'deploy' });
    b.dropPart('drums');
    const s = b.snapshot();
    assert.equal(s.parts.guitar.crowd, 0);
    assert.equal(s.parts.guitar.saves, 0);
    assert.equal(s.parts.guitar.deploys, 0);
});

test('bandFailed is false once dropPart removes every part', () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    misses(b, 14, 'drums', 1);
    assert.equal(b.snapshot().bandFailed, true);
    b.dropPart('guitar');
    b.dropPart('drums');
    const s = b.snapshot();
    assert.deepEqual(s.parts, {});
    assert.equal(s.bandFailed, false);
});

test("dropPart doesn't turn a failed part's ignored deploy into a rescue", () => {
    const b = createBandScore({ parts: ['guitar', 'drums'], failMode: 'fail' });
    misses(b, 14);
    misses(b, 14, 'drums', 1);
    b.record({ part: 'drums', t: 15, kind: 'deploy' });
    assert.equal(b.snapshot().parts.guitar.failed, true);
    b.dropPart('drums');
    let s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.parts.guitar.saves, 0);
    assert.equal(s.bandFailed, true);
    b.rewindTo(15);
    s = b.snapshot();
    assert.equal(s.parts.guitar.failed, true);
    assert.equal(s.bandFailed, true);
});

// Play layer contract §4: a bonus adds points only (no streak, multiplier, hit or crowd change).
test('a bonus entry adds points only', () => {
    const b = createBandScore({ parts: ['drums'] });
    b.record({ part: 'drums', t: 1, kind: 'hit', points: 100, multiplier: 2, streak: 12 });
    const before = b.snapshot().parts.drums;
    b.record({ part: 'drums', t: 2, kind: 'bonus', points: 1000 });
    const after = b.snapshot().parts.drums;
    assert.equal(after.score, before.score + 1000);
    for (const k of ['multiplier', 'streak', 'bestStreak', 'hits', 'misses', 'overhits', 'crowd', 'bonus']) {
        assert.equal(after[k], before[k], k);
    }
    assert.equal(b.snapshot().bonus, before.bonus);
});

test('a bonus rewinds with the ledger and is ignored for a failed part', () => {
    const b = createBandScore({ parts: ['drums'] });
    b.record({ part: 'drums', t: 5, kind: 'bonus', points: 500 });
    b.rewindTo(4);
    assert.equal(b.snapshot().parts.drums.score, 0);
    const f = createBandScore({ parts: ['drums'], failMode: 'fail' });
    for (let i = 0; i < 20; i++) f.record({ part: 'drums', t: i, kind: 'miss', points: 0 });
    assert.equal(f.snapshot().parts.drums.failed, true);
    f.record({ part: 'drums', t: 30, kind: 'bonus', points: 500 });
    assert.equal(f.snapshot().parts.drums.score, 0);
});
