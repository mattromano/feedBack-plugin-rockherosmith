import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    loadPrefs, savePrefs, normalizePrefs, pushRecent, clampZoom,
    MIC_HIT_DB_MIN, MIC_HIT_DB_MAX, MIC_HIT_DB_STEP, MIC_HIT_DB_DEFAULT, clampMicHitDb,
    migrateLegacyPrefs, LEGACY_KEY,
} from '../src/prefs.js';

function stub(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        _m: m,
    };
}
const KEY = 'rockherosmith.prefs.v1';
const LEGACY = 'build_a_band.prefs.v1';

test('defaults when empty', () => {
    assert.equal(loadPrefs(stub()).split, 62);
});

test('round-trips split', () => {
    const s = stub();
    savePrefs({ split: 70 }, s);
    assert.equal(loadPrefs(s).split, 70);
});

test('bad JSON falls back to defaults', () => {
    assert.equal(loadPrefs(stub({ [KEY]: '{nope' })).split, 62);
});

test('storage that throws falls back to defaults', () => {
    const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(loadPrefs(bad).split, 62);
    assert.equal(savePrefs({ split: 70 }, bad).split, 70);
});

test('labelScale defaults to 1 and round-trips', () => {
    const s = stub();
    assert.equal(loadPrefs(s).labelScale, 1);
    savePrefs({ labelScale: 1.75 }, s);
    assert.equal(loadPrefs(s).labelScale, 1.75);
    assert.equal(loadPrefs(s).split, 62, 'split untouched');
});

test('labelScale is validated: finite, clamped to 0.75-2.5', () => {
    const load = (v) => loadPrefs(stub({ [KEY]: JSON.stringify({ labelScale: v }) })).labelScale;
    assert.equal(load(9), 2.5);
    assert.equal(load(0.1), 0.75);
    assert.equal(load('2'), 1);
    assert.equal(load(null), 1);
    assert.equal(loadPrefs(stub({ [KEY]: '{"labelScale":1e999}' })).labelScale, 1);
});

const PART_DEFAULTS = {
    guitar: { on: true, deviceKey: '', arrangement: 'Lead', difficulty: 'medium' },
    drums: { on: true, deviceKey: '', difficulty: 'medium', soundMode: 'song' },
    vocals: { on: true, deviceId: '', difficulty: 'medium', hearMyself: false, micHitDb: -30 },
};

test('plan 1 prefs gain the plan 2 defaults', () => {
    const p = loadPrefs(stub({ [KEY]: '{"split":70,"labelScale":1.5}' }));
    assert.equal(p.split, 70);
    assert.equal(p.labelScale, 1.5);
    assert.deepEqual(p.parts, PART_DEFAULTS);
    assert.equal(p.failMode, 'nofail');
    assert.equal(p.fullScreenStage, true);
    assert.equal(p.lastSong, null);
    assert.deepEqual(p.recentSongs, []);
});

test('garbage parts fall back per field', () => {
    const raw = { parts: { guitar: { on: 'yes', arrangement: 'Keys', difficulty: 'hard' }, drums: 7 } };
    const p = loadPrefs(stub({ [KEY]: JSON.stringify(raw) }));
    assert.equal(p.parts.guitar.on, true);
    assert.equal(p.parts.guitar.arrangement, 'Lead');
    assert.equal(p.parts.guitar.difficulty, 'hard');
    assert.deepEqual(p.parts.drums, PART_DEFAULTS.drums);
});

test('savePrefs merges parts per field', () => {
    const s = stub();
    savePrefs({ parts: { drums: { on: false } } }, s);
    const p = loadPrefs(s);
    assert.equal(p.parts.drums.on, false);
    assert.equal(p.parts.drums.soundMode, 'song');
    assert.deepEqual(p.parts.guitar, PART_DEFAULTS.guitar);
    savePrefs({ parts: { drums: { soundMode: 'kit' } } }, s);
    assert.equal(loadPrefs(s).parts.drums.on, false, 'earlier field kept');
});

test('pushRecent dedupes, orders newest first, keeps 10', () => {
    let list = [];
    for (let i = 0; i < 12; i++) list = pushRecent(list, { filename: `f${i}`, title: `t${i}`, artist: 'a' });
    assert.equal(list.length, 10);
    assert.equal(list[0].filename, 'f11');
    list = pushRecent(list, { filename: 'f5', title: 't5', artist: 'a' });
    assert.equal(list.length, 10);
    assert.equal(list[0].filename, 'f5');
    assert.equal(list.filter((e) => e.filename === 'f5').length, 1);
});

test('recentSongs and lastSong are validated', () => {
    const raw = { recentSongs: [{ title: 'no file' }, { filename: 'a', title: 'A', artist: 'X' }, { filename: 'a', title: 'dup' }, 5],
        lastSong: { title: 'x' } };
    const p = loadPrefs(stub({ [KEY]: JSON.stringify(raw) }));
    assert.deepEqual(p.recentSongs, [{ filename: 'a', title: 'A', artist: 'X' }]);
    assert.equal(p.lastSong, null);
    const ok = loadPrefs(stub({ [KEY]: JSON.stringify({ lastSong: { filename: 'z' } }) }));
    assert.deepEqual(ok.lastSong, { filename: 'z', title: '', artist: '' });
});

test('zoom defaults to 1 per lane and is clamped', () => {
    const s = stub();
    assert.deepEqual(loadPrefs(s).zoom, { guitar: 1, drums: 1 });
    const saved = savePrefs({ zoom: { drums: 2 } }, s);
    assert.equal(saved.zoom.drums, 1.3);
    assert.equal(saved.zoom.guitar, 1);
    savePrefs({ zoom: { guitar: 0.8 } }, s);
    assert.deepEqual(loadPrefs(s).zoom, { guitar: 0.8, drums: 1.3 }, 'merged per key');
    assert.equal(clampZoom(NaN), 1);
    assert.equal(clampZoom(0.74), 0.74);
    assert.equal(clampZoom(0.1), 0.7);
    assert.equal(clampZoom(1.1 + 0.1), 1.2);
    assert.deepEqual(loadPrefs(stub({ [KEY]: '{"zoom":"big"}' })).zoom, { guitar: 1, drums: 1 });
});

test('micHitDb defaults, clamps and rounds', () => {
    assert.deepEqual([MIC_HIT_DB_MIN, MIC_HIT_DB_MAX, MIC_HIT_DB_STEP, MIC_HIT_DB_DEFAULT], [-48, -12, 3, -30]);
    const s = stub();
    assert.equal(loadPrefs(s).parts.vocals.micHitDb, -30, 'missing');
    assert.equal(clampMicHitDb(-70), -48);
    assert.equal(clampMicHitDb(0), -12);
    assert.equal(clampMicHitDb(-29.6), -30);
    assert.equal(clampMicHitDb('x'), -30);
    assert.equal(clampMicHitDb(undefined), -30);
    assert.equal(clampMicHitDb(NaN), -30);
    const bad = stub({ [KEY]: JSON.stringify({ parts: { vocals: { micHitDb: -70 } } }) });
    assert.equal(loadPrefs(bad).parts.vocals.micHitDb, -48);
    savePrefs({ parts: { vocals: { micHitDb: -24 } } }, s);
    assert.equal(loadPrefs(s).parts.vocals.micHitDb, -24);
    assert.equal(loadPrefs(s).parts.vocals.hearMyself, false, 'other vocals fields untouched');
    assert.equal('micHitDb' in loadPrefs(s).parts.guitar, false);
});

test('pickFilters defaults', () => {
    assert.deepEqual(loadPrefs(stub()).pickFilters,
        { playable: true, drumStem: false, drums: false, vocals: false, guitar: false, fiveFret: false, fiveFretReal: false });
});

test('bad values fall back', () => {
    const s = stub({ [KEY]: JSON.stringify({ pickFilters: { playable: 'x', drums: true, bogus: true } }) });
    const pf = loadPrefs(s).pickFilters;
    assert.equal(pf.playable, true);
    assert.equal(pf.drums, true);
    assert.equal('bogus' in pf, false);
});

test('savePrefs merges pickFilters', () => {
    const s = stub();
    const next = savePrefs({ pickFilters: { drumStem: true } }, s);
    assert.equal(next.pickFilters.drumStem, true);
    assert.equal(next.pickFilters.playable, true);
    assert.equal(loadPrefs(s).pickFilters.playable, true);
    assert.equal(loadPrefs(s).pickFilters.drumStem, true);
});

test('normalizePrefs keeps valid controllers and repairs bad fields, duplicate keys and ids', () => {
    const s = stub({ [KEY]: JSON.stringify({ controllers: [
        { key: 'a#0', id: 'ctl2', name: 'A', playsAs: 'five_fret', part: 'bass', difficulty: 'expert', lefty: true, partAudio: 'always', on: false },
        { key: 'b#0', id: 'ctl2', name: 5, playsAs: 'drums', part: 'kazoo', difficulty: 'nope', lefty: 'y', partAudio: 'x' },
        { key: 'a#0', id: 'ctl9' },
        { id: 'ctl3' },
        { key: 7 },
        'junk',
        { key: 'c#0', id: 'guitar' },
    ] }) });
    const c = loadPrefs(s).controllers;
    assert.deepEqual(c, [
        { key: 'a#0', id: 'ctl2', name: 'A', playsAs: 'five_fret', part: 'bass', difficulty: 'expert', lefty: true, partAudio: 'always', soundMode: 'rockband', on: false },
        { key: 'b#0', id: 'ctl1', name: '', playsAs: 'drums', part: 'drums', difficulty: 'medium', lefty: false, partAudio: 'rockband', soundMode: 'rockband', on: true },
        { key: 'c#0', id: 'ctl3', name: '', playsAs: null, part: null, difficulty: 'medium', lefty: false, partAudio: 'rockband', soundMode: 'rockband', on: true },
    ]);
    assert.deepEqual(loadPrefs(stub()).controllers, []);
    assert.deepEqual(loadPrefs(stub({ [KEY]: JSON.stringify({ controllers: 'x' }) })).controllers, []);
});

test('savePrefs({ controllers }) replaces the list', () => {
    const s = stub();
    savePrefs({ controllers: [{ key: 'a#0' }, { key: 'b#0' }] }, s);
    assert.deepEqual(savePrefs({ controllers: [{ key: 'b#0' }] }, s).controllers.map((c) => c.key), ['b#0']);
    assert.deepEqual(loadPrefs(s).controllers.map((c) => c.id), ['ctl1']);
});

test('normalizePrefs keeps only registered controllerKinds', () => {
    const s = stub({ [KEY]: JSON.stringify({ controllerKinds: { 'a#0': 'five_fret', 'b#0': 'kazoo', 'c#0': 4 } }) });
    assert.deepEqual(loadPrefs(s).controllerKinds, { 'a#0': 'five_fret' });
    assert.deepEqual(loadPrefs(stub()).controllerKinds, {});
    assert.deepEqual(savePrefs({ controllerKinds: { 'z#0': 'five_fret', 'y#0': 'nope' } }, s).controllerKinds, { 'z#0': 'five_fret' });
});

test('the pick chips default the 5-fret filters off', () => {
    const pf = loadPrefs(stub()).pickFilters;
    assert.equal(pf.fiveFret, false);
    assert.equal(pf.fiveFretReal, false);
});

test('normalizePrefs keeps playsAs null, validates part per kind and soundMode, cleans the controllerKinds map', () => {
    const p = normalizePrefs({
        controllers: [
            { key: 'u#0', id: 'ctl1', playsAs: null, part: 'bass', soundMode: 'kit' },
            { key: 'd#0', id: 'ctl2', playsAs: 'drums', part: 'bass', soundMode: 'song' },
            { key: 'f#0', id: 'ctl3', playsAs: 'five_fret', part: 'drums', soundMode: 'loud' },
            { key: 'old#0', id: 'ctl4', playsAs: 'five_fret', part: 'rhythm' },
        ],
        controllerKinds: { 'u#0': 'drums', 'd#0': 'five_fret', 'x#0': 'kazoo', 'y#0': null },
    });
    assert.deepEqual(p.controllers.map((c) => [c.key, c.playsAs, c.part, c.soundMode]), [
        ['u#0', null, null, 'kit'],
        ['d#0', 'drums', 'drums', 'song'],
        ['f#0', 'five_fret', 'guitar', 'rockband'],
        ['old#0', 'five_fret', 'rhythm', 'rockband'],
    ]);
    assert.deepEqual(p.controllerKinds, { 'u#0': 'drums', 'd#0': 'five_fret' });
    assert.equal(p.controllerKinds['old#0'], undefined, 'a pre-Plan-6 controller gets no invented choice');
});

test('LEGACY_KEY is the old Build-a-Band key', () => {
    assert.equal(LEGACY_KEY, LEGACY);
});

test('legacy prefs move on first load', () => {
    const legacy = JSON.stringify({
        parts: { guitar: { deviceKey: 'g1' } },
        controllers: [{ key: 'pad#1', id: 'ctl1', playsAs: 'drums' }],
    });
    const s = stub({ [LEGACY]: legacy });
    const p = loadPrefs(s);
    assert.equal(p.parts.guitar.deviceKey, 'g1');
    assert.equal(p.controllers.length, 1);
    assert.equal(s.getItem(KEY), legacy);
    assert.equal(s.getItem(LEGACY), legacy);
});

test('an existing new key is never overwritten', () => {
    const s = stub({ [KEY]: JSON.stringify({ split: 40 }), [LEGACY]: JSON.stringify({ split: 80 }) });
    assert.equal(migrateLegacyPrefs(s), 'present');
    assert.equal(loadPrefs(s).split, 40);
});

test('savePrefs writes only the new key', () => {
    const legacy = JSON.stringify({ parts: { guitar: { deviceKey: 'g1' } } });
    const s = stub({ [LEGACY]: legacy });
    savePrefs({ split: 50 }, s);
    assert.equal(s.getItem(LEGACY), legacy);
    const saved = JSON.parse(s.getItem(KEY));
    assert.equal(saved.split, 50);
    assert.equal(saved.parts.guitar.deviceKey, 'g1');
});

test('invalid legacy JSON is copied verbatim and loads defaults', () => {
    const s = stub({ [LEGACY]: '{oops' });
    assert.equal(migrateLegacyPrefs(s), 'migrated');
    assert.equal(s.getItem(KEY), '{oops');
    assert.equal(loadPrefs(s).split, 62);
    assert.equal(s.getItem(LEGACY), '{oops');
});

test('no keys: none', () => {
    assert.equal(migrateLegacyPrefs(stub()), 'none');
});

test('storage that throws: none', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    assert.equal(migrateLegacyPrefs(bad), 'none');
    assert.equal(loadPrefs(bad).split, 62);
});

test('migration never removes the legacy key', () => {
    const s = stub({ [LEGACY]: '{}' });
    s.removeItem = () => { throw new Error('removeItem must not be called'); };
    assert.equal(migrateLegacyPrefs(s), 'migrated');
});

test('missSound: on by default, a saved false kept, garbage falls back to on', () => {
    assert.equal(loadPrefs(stub({})).missSound, true);
    assert.equal(loadPrefs(stub({ [KEY]: '{"missSound":false}' })).missSound, false);
    assert.equal(loadPrefs(stub({ [KEY]: '{"missSound":"no"}' })).missSound, true);
});

// Play layer contract §7: adopting plain plays, and the Solo screen's choices.
const SOLO_DEFAULTS = {
    instrument: 'kit', part: 'guitar', arrangement: 'Lead', difficulty: 'expert',
    soundMode: 'rockband', crowd: true, failMode: 'nofail', autoNext: false,
};

test('adoptSolo: on by default, a saved false kept, garbage falls back to on', () => {
    assert.equal(loadPrefs(stub({})).adoptSolo, true);
    assert.equal(loadPrefs(stub({ [KEY]: '{"adoptSolo":false}' })).adoptSolo, false);
    assert.equal(loadPrefs(stub({ [KEY]: '{"adoptSolo":1}' })).adoptSolo, true);
});

test('solo: defaults, and each bad field falls back alone', () => {
    assert.deepEqual(loadPrefs(stub({})).solo, SOLO_DEFAULTS);
    assert.deepEqual(normalizePrefs({ solo: 'x' }).solo, SOLO_DEFAULTS);
    const kept = { instrument: 'five_fret', part: 'bass', arrangement: 'Rhythm', difficulty: 'hard',
        soundMode: 'kit', crowd: false, failMode: 'fail', autoNext: true };
    assert.deepEqual(normalizePrefs({ solo: kept }).solo, kept);
    const bad = normalizePrefs({ solo: { instrument: 'keys', part: 'drums', arrangement: 'Combo', difficulty: 'expert_plus',
        soundMode: 'loud', crowd: 'y', failMode: 'never', autoNext: 0, bogus: 1 } }).solo;
    assert.deepEqual(bad, SOLO_DEFAULTS);
    assert.equal(normalizePrefs({ solo: { instrument: 'guitar' } }).solo.instrument, 'guitar');
    assert.equal(normalizePrefs({ solo: { instrument: 'drums' } }).solo.instrument, 'drums');
});

test('savePrefs merges solo shallowly', () => {
    const s = stub({});
    savePrefs({ solo: { instrument: 'five_fret', part: 'bass' } }, s);
    const next = savePrefs({ solo: { difficulty: 'hard' } }, s);
    assert.deepEqual([next.solo.instrument, next.solo.part, next.solo.difficulty], ['five_fret', 'bass', 'hard']);
    assert.deepEqual(loadPrefs(s).solo, next.solo);
    assert.equal(savePrefs({ adoptSolo: false }, s).adoptSolo, false);
    assert.equal(loadPrefs(s).solo.part, 'bass');
});
