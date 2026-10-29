// Per-section accuracy (plan phase 7): section ranges from the song's markers,
// tallied from the time-stamped ledger entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionRanges, entryTime, judgedAs, rangeTally, playerSections, worstSections } from '../src/sections.js';

test('sectionRanges: sorted, numbered per name, consecutive repeats merged, ends at the next start or the song end', () => {
    const raw = [
        { name: 'chorus', time: 40 },
        { name: 'intro', time: 0 },
        { name: 'verse', time: 10 },
        { name: 'verse', time: 25 },
        { name: 'verse2', time: 60 },
        { name: '', startTime: 80 },
    ];
    assert.deepEqual(sectionRanges(raw, 100), [
        { name: 'Intro 1', start: 0, end: 10 },
        { name: 'Verse 1', start: 10, end: 40 },
        { name: 'Chorus 1', start: 40, end: 60 },
        { name: 'Verse 2', start: 60, end: 80 },
        { name: 'Section 1', start: 80, end: 100 },
    ]);
});

test('sectionRanges: start_time / start keys, underscores, bad input', () => {
    assert.deepEqual(sectionRanges([{ name: 'guitar_solo', start_time: 5 }, { name: 'outro', start: 9 }], 12), [
        { name: 'Guitar solo 1', start: 5, end: 9 },
        { name: 'Outro 1', start: 9, end: 12 },
    ]);
    // No duration: the last section runs 4 s past its start.
    assert.deepEqual(sectionRanges([{ name: 'riff', time: 3 }], NaN), [{ name: 'Riff 1', start: 3, end: 7 }]);
    assert.deepEqual(sectionRanges(null, 100), []);
    assert.deepEqual(sectionRanges([{ name: 'x', time: 'nope' }, null], 100), []);
});

test('entryTime prefers the note time; judgedAs follows the ledger', () => {
    assert.equal(entryTime({ t: 5, noteTime: 4.8 }), 4.8);
    assert.equal(entryTime({ t: 5, noteTime: null }), 5);
    assert.equal(entryTime({}), NaN);
    assert.equal(judgedAs({ kind: 'hit' }), 'hit');
    assert.equal(judgedAs({ kind: 'phrase', passed: true }), 'hit');
    assert.equal(judgedAs({ kind: 'phrase' }), 'miss');
    assert.equal(judgedAs({ kind: 'miss' }), 'miss');
    assert.equal(judgedAs({ kind: 'overhit' }), null);
    assert.equal(judgedAs({ kind: 'deploy' }), null);
    assert.equal(judgedAs({ kind: 'bonus' }), null);
});

const E = (part, kind, t, extra = {}) => ({ part, kind, t, ...extra });

test('rangeTally counts the given players in [start, end)', () => {
    const entries = [
        E('drums', 'hit', 1), E('drums', 'miss', 2), E('drums', 'overhit', 2.5),
        E('ctl1', 'hit', 3), E('drums', 'hit', 5), E('drums', 'hit', 9),
    ];
    assert.deepEqual(rangeTally(entries, 0, 5, ['drums']), { hits: 1, misses: 1, accuracy: 0.5 });
    assert.deepEqual(rangeTally(entries, 0, 5, ['drums', 'ctl1']), { hits: 2, misses: 1, accuracy: 2 / 3 });
    assert.deepEqual(rangeTally(entries, 10, 20, ['drums']), { hits: 0, misses: 0, accuracy: null });
    assert.deepEqual(rangeTally(null, 0, 5, ['drums']), { hits: 0, misses: 0, accuracy: null });
});

test('playerSections: per player, only sections it was judged in', () => {
    const ranges = [{ name: 'Intro 1', start: 0, end: 10 }, { name: 'Verse 1', start: 10, end: 20 }, { name: 'Outro 1', start: 20, end: 30 }];
    const entries = [
        E('drums', 'hit', 1), E('drums', 'hit', 2), E('drums', 'miss', 12),
        E('ctl1', 'hit', 25, { noteTime: 19.9 }), E('drums', 'hit', 31),
    ];
    const out = playerSections(entries, ranges, ['drums', 'ctl1', 'vocals']);
    assert.deepEqual(out.drums, [
        { name: 'Intro 1', start: 0, end: 10, hits: 2, misses: 0, accuracy: 1 },
        { name: 'Verse 1', start: 10, end: 20, hits: 0, misses: 1, accuracy: 0 },
    ]);
    // Judged by its note time, not when the event came in.
    assert.deepEqual(out.ctl1, [{ name: 'Verse 1', start: 10, end: 20, hits: 1, misses: 0, accuracy: 1 }]);
    assert.deepEqual(out.vocals, []);
    assert.deepEqual(playerSections(entries, [], ['drums']), { drums: [] });
});

test('worstSections: up to n of the lowest, below 100%, enough notes', () => {
    const s = (name, hits, misses) => ({ name, hits, misses, accuracy: hits / (hits + misses) });
    const list = [s('A', 10, 0), s('B', 5, 5), s('C', 8, 2), s('D', 0, 2), s('E', 3, 7), s('F', 9, 1)];
    // D has too few notes to count; E then B are worst.
    assert.deepEqual(worstSections(list), [4, 1]);
    assert.deepEqual(worstSections(list, { n: 3 }), [4, 1, 2]);
    assert.deepEqual(worstSections(list, { minJudged: 1, n: 1 }), [3]);
    assert.deepEqual(worstSections([s('A', 10, 0)]), []);
    // Equal accuracy: more misses first.
    assert.deepEqual(worstSections([s('A', 5, 5), s('B', 10, 10)], { n: 1 }), [1]);
    assert.deepEqual(worstSections(null), []);
});
