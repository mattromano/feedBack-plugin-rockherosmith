// The play layer's events out (contract §3): play:judgment / play:result payloads, pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerInfo, judgmentEvent, resultEvent, sessionIdFor, hitTiming, sessionStartEvent, PERFECT_MS } from '../src/play-events.js';
import { createBandScore } from '../src/band-score.js';
import { normalizePrefs } from '../src/prefs.js';

const prefs = normalizePrefs({
    parts: { guitar: { arrangement: 'Bass', difficulty: 'hard' }, drums: { difficulty: 'expert' }, vocals: { difficulty: 'easy' } },
    controllers: [
        { key: 'Pad#1', id: 'ctl1', playsAs: 'five_fret', part: 'rhythm', difficulty: 'medium' },
        { key: 'Kit#1', id: 'ctl2', playsAs: 'drums', part: 'drums', difficulty: 'easy' },
    ],
});

test('playerInfo: who each player is', () => {
    assert.deepEqual(playerInfo('drums', prefs), { player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert' });
    assert.deepEqual(playerInfo('guitar', prefs), { player: 'guitar', instrument: 'guitar', part: 'bass', input: 'audio', difficulty: 'hard' });
    assert.deepEqual(playerInfo('vocals', prefs), { player: 'vocals', instrument: 'vocals', part: 'vocals', input: 'mic', difficulty: 'easy' });
    assert.deepEqual(playerInfo('ctl1', prefs), { player: 'ctl1', instrument: 'five_fret', part: 'rhythm', input: 'controller', difficulty: 'medium' });
    assert.deepEqual(playerInfo('ctl2', prefs), { player: 'ctl2', instrument: 'drums', part: 'drums', input: 'controller', difficulty: 'easy' });
    assert.equal(playerInfo('ctl9', prefs).instrument, null);
});

test('judgmentEvent: the entry plus who, scored points, and the part totals after it', () => {
    const ev = judgmentEvent({
        filename: 'a.sloppak', sessionId: 's1',
        entry: { part: 'ctl1', t: 3.5, kind: 'hit', points: 50, factor: 2, multiplier: 3, streak: 9, noteTime: 3.49 },
        info: playerInfo('ctl1', prefs), totals: { multiplier: 3, streak: 9 },
    });
    assert.deepEqual(ev, {
        filename: 'a.sloppak', sessionId: 's1', player: 'ctl1', instrument: 'five_fret', part: 'rhythm', input: 'controller',
        kind: 'hit', points: 100, multiplier: 3, streak: 9, t: 3.5, noteTime: 3.49,
        offsetMs: null, timing: null, canvas: null, local: true,
    });
    // A deploy or bonus carries no multiplier / streak: the part's totals fill them; noteTime unknown is null.
    const bonus = judgmentEvent({
        filename: 'a', sessionId: 's1', entry: { part: 'drums', t: 9, kind: 'bonus', points: 1500 },
        info: playerInfo('drums', prefs), totals: { multiplier: 4, streak: 30 },
    });
    assert.deepEqual([bonus.kind, bonus.points, bonus.multiplier, bonus.streak, bonus.noteTime], ['bonus', 1500, 4, 30, null]);
});

test('resultEvent: one row per playing player from the snapshot', () => {
    const score = createBandScore({ parts: ['drums'] });
    score.record({ part: 'drums', t: 1, kind: 'hit', points: 100, multiplier: 1, streak: 1 });
    score.record({ part: 'drums', t: 2, kind: 'hit', points: 100, multiplier: 1, streak: 2 });
    score.record({ part: 'drums', t: 3, kind: 'miss', points: 0, multiplier: 1, streak: 0 });
    score.record({ part: 'drums', t: 4, kind: 'overhit', points: 0, multiplier: 1, streak: 0 });
    const ev = resultEvent({
        filename: 'a.sloppak', sessionId: 's1', snapshot: score.snapshot(), prefs,
        arrangements: { drums: 2 }, durationSec: 181.5,
    });
    assert.deepEqual(ev, {
        filename: 'a.sloppak', sessionId: 's1', band: false, practice: false, durationSec: 181.5,
        players: [{
            player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert', arrangement: 2,
            score: 200, stars: null, accuracy: 2 / 3, hits: 2, misses: 1, overhits: 1, bestStreak: 2,
            fullCombo: false, proDrums: false, failed: false, sections: [],
        }],
    });
});

test('resultEvent: band when more than one player; full combo; no judgments is accuracy 0', () => {
    const score = createBandScore({ parts: ['ctl1', 'ctl2'] });
    score.record({ part: 'ctl1', t: 1, kind: 'hit', points: 10, multiplier: 1, streak: 1 });
    const ev = resultEvent({ filename: 'a', sessionId: 's', snapshot: score.snapshot(), prefs, practice: true });
    assert.equal(ev.band, true);
    assert.equal(ev.practice, true);
    const [one, two] = ev.players;
    assert.deepEqual([one.player, one.fullCombo, one.accuracy, one.arrangement], ['ctl1', true, 1, null]);
    assert.deepEqual([two.player, two.fullCombo, two.accuracy], ['ctl2', false, 0]);
    assert.equal(ev.durationSec, 0);
});

test('resultEvent: no snapshot is no players', () => {
    assert.deepEqual(resultEvent({ filename: 'a', sessionId: 's', snapshot: null, prefs }).players, []);
});

test('sessionIdFor: unique per session', () => {
    const a = sessionIdFor(1000, 1);
    const b = sessionIdFor(1000, 2);
    assert.equal(typeof a, 'string');
    assert.notEqual(a, b);
});

test('resultEvent: proDrums for drums players only; failed for a player who failed out', () => {
    const score = createBandScore({ parts: ['drums', 'ctl1', 'ctl2'], failMode: 'fail' });
    for (let i = 0; i < 20; i++) score.record({ part: 'ctl1', t: i, kind: 'miss', points: 0 });
    const ev = resultEvent({ filename: 'a', sessionId: 's', snapshot: score.snapshot(), prefs,
        proDrums: { drums: true, ctl1: true, ctl2: true } });
    const by = Object.fromEntries(ev.players.map((p) => [p.player, p]));
    assert.equal(by.drums.proDrums, true);
    assert.equal(by.ctl2.proDrums, true, 'a drums controller');
    assert.equal(by.ctl1.proDrums, false, 'a 5-fret player never');
    assert.deepEqual([by.ctl1.failed, by.drums.failed], [true, false]);
    assert.equal(resultEvent({ filename: 'a', sessionId: 's', snapshot: score.snapshot(), prefs }).players[0].proDrums, false);
});

test('resultEvent: sections per player (stream B3), copied; missing is []', () => {
    const score = createBandScore({ parts: ['drums', 'ctl1'] });
    score.record({ part: 'drums', t: 1, kind: 'hit', points: 10, multiplier: 1, streak: 1 });
    score.record({ part: 'ctl1', t: 1, kind: 'hit', points: 10, multiplier: 1, streak: 1 });
    const verse = { name: 'Verse 1', start: 0, end: 5, hits: 1, misses: 0, accuracy: 1 };
    const sections = { drums: [verse] };
    const ev = resultEvent({ filename: 'a', sessionId: 's', snapshot: score.snapshot(), prefs, sections });
    assert.deepEqual(ev.players[0].sections, [verse]);
    assert.notEqual(ev.players[0].sections[0], verse, 'a copy: listeners never touch the runtime\'s rows');
    assert.deepEqual(ev.players[1].sections, []);
});

// ---- Contract §3 amendment (C1): timing, lane canvas, session lifecycle ----

test('hitTiming: offsetMs (+ = late) from five-fret offsetMs or drums offset (seconds); null off a hit', () => {
    assert.equal(PERFECT_MS, 20);
    assert.deepEqual(hitTiming('hit', { offsetMs: -35 }), { offsetMs: -35, timing: 'early' });
    assert.deepEqual(hitTiming('hit', { offsetMs: 41 }), { offsetMs: 41, timing: 'late' });
    assert.deepEqual(hitTiming('hit', { offsetMs: 20 }), { offsetMs: 20, timing: 'on' }, 'within the window is on');
    assert.deepEqual(hitTiming('hit', { offsetMs: -20 }), { offsetMs: -20, timing: 'on' });
    // The drums engine reports `offset` in seconds (hit time minus note time).
    assert.deepEqual(hitTiming('hit', { offset: 0.0304 }), { offsetMs: 30, timing: 'late' });
    assert.deepEqual(hitTiming('hit', { offset: -0.004 }), { offsetMs: -4, timing: 'on' });
    // offsetMs wins over offset when both are there.
    assert.deepEqual(hitTiming('hit', { offsetMs: -50, offset: 0.5 }), { offsetMs: -50, timing: 'early' });
    // The plugin's own perfect window, when the event carries one.
    assert.deepEqual(hitTiming('hit', { offsetMs: 30, perfectMs: 35 }), { offsetMs: 30, timing: 'on' });
    assert.deepEqual(hitTiming('hit', { offsetMs: 30, perfectWindowMs: 25 }), { offsetMs: 30, timing: 'late' });
    for (const kind of ['miss', 'overhit', 'sustain', 'deploy', 'bonus', 'phrase']) {
        assert.deepEqual(hitTiming(kind, { offsetMs: 10 }), { offsetMs: null, timing: null }, kind);
    }
    assert.deepEqual(hitTiming('hit', {}), { offsetMs: null, timing: null }, 'no offset reported');
    assert.deepEqual(hitTiming('hit', null), { offsetMs: null, timing: null });
});

test('judgmentEvent: timing from the lane event, the lane canvas, local: true', () => {
    const canvas = { tag: 'lane' };
    const ev = judgmentEvent({
        filename: 'a', sessionId: 's1', entry: { part: 'drums', t: 2, kind: 'hit', points: 50, multiplier: 1, streak: 1 },
        info: playerInfo('drums', prefs), totals: {}, detail: { canvas, offset: -0.03 }, canvas,
    });
    assert.deepEqual([ev.offsetMs, ev.timing, ev.canvas, ev.local], [-30, 'early', canvas, true]);
    const miss = judgmentEvent({
        filename: 'a', sessionId: 's1', entry: { part: 'drums', t: 2, kind: 'miss', points: 0 },
        info: playerInfo('drums', prefs), totals: {}, detail: { canvas, offset: 0.2 }, canvas,
    });
    assert.deepEqual([miss.offsetMs, miss.timing, miss.canvas, miss.local], [null, null, canvas, true]);
});

test('sessionStartEvent: the session, the song and each player with its lane canvas', () => {
    const c1 = { tag: 'ctl1' };
    const ev = sessionStartEvent({
        sessionId: 's1', filename: 'a.sloppak', title: 'Holiday', artist: 'Green Day',
        players: ['drums', 'ctl1'], prefs, canvasOf: (id) => (id === 'ctl1' ? c1 : null),
    });
    assert.deepEqual(ev, {
        sessionId: 's1', filename: 'a.sloppak', title: 'Holiday', artist: 'Green Day', band: true,
        players: [
            { player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert', canvas: null },
            { player: 'ctl1', instrument: 'five_fret', part: 'rhythm', input: 'controller', difficulty: 'medium', canvas: c1 },
        ],
    });
    const one = sessionStartEvent({ sessionId: 's2', filename: 'b', players: ['drums'], prefs });
    assert.deepEqual([one.band, one.title, one.artist, one.players[0].canvas], [false, null, null, null]);
});
