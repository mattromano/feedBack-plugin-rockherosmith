import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SOLO_SCREEN_ID, SOLO_INSTRUMENT_OPTIONS, soloLibraryParams, soloPickFilters, libraryUrl,
    soloPlayRequest, soloAvailability, nextSoloItem, soloFields, soloSoundMode, soloSoundModePatch,
    soloListLabel,
} from '../src/solo-screen-model.js';
import { SOLO_DEFAULTS, normalizePrefs } from '../src/prefs.js';

const solo = (patch) => ({ ...SOLO_DEFAULTS, ...patch });

test('the Solo screen is its own core screen next to the band screen', () => {
    assert.equal(SOLO_SCREEN_ID, 'plugin-rockherosmith-solo');
    assert.deepEqual(SOLO_INSTRUMENT_OPTIONS.map((o) => o.id), ['kit', 'drums', 'five_fret', 'guitar']);
});

test('soloLibraryParams: drums (kit or controller) ask for a drum chart', () => {
    assert.deepEqual(soloLibraryParams(solo({ instrument: 'kit' })), { has_drums: '1' });
    assert.deepEqual(soloLibraryParams(solo({ instrument: 'drums' })), { has_drums: '1' });
});

test('soloLibraryParams: 5-fret asks for the part, real charts only unless auto charts show', () => {
    assert.deepEqual(soloLibraryParams(solo({ instrument: 'five_fret', part: 'bass' })), { five_fret: 'bass:chart' });
    assert.deepEqual(soloLibraryParams(solo({ instrument: 'five_fret', part: 'rhythm' }), { showAuto: true }), { five_fret: 'rhythm' });
});

test('soloLibraryParams: real guitar asks for the arrangement', () => {
    assert.deepEqual(soloLibraryParams(solo({ instrument: 'guitar', arrangement: 'Bass' })), { arrangements_has: 'Bass' });
});

test('soloPickFilters: one chip, on, with the instrument params (core library pick)', () => {
    const [chip, ...rest] = soloPickFilters(solo({ instrument: 'five_fret', part: 'guitar' }));
    assert.equal(rest.length, 0);
    assert.equal(chip.id, 'solo');
    assert.equal(chip.on, true);
    assert.equal(chip.label, '5-fret Lead chart');
    assert.deepEqual(chip.params, { five_fret: 'guitar:chart' });
    assert.equal(soloPickFilters(solo({ instrument: 'kit' }))[0].label, 'Drum chart');
    assert.equal(soloPickFilters(solo({ instrument: 'guitar', arrangement: 'Rhythm' }))[0].label, 'Rhythm part');
});

test('soloListLabel names what the list holds', () => {
    assert.equal(soloListLabel(solo({ instrument: 'drums' })), 'Songs with a drum chart');
    assert.equal(soloListLabel(solo({ instrument: 'five_fret', part: 'bass' })), 'Songs with a 5-fret Bass chart');
    assert.equal(soloListLabel(solo({ instrument: 'guitar', arrangement: 'Lead' })), 'Songs with a Lead part');
});

test('libraryUrl: /api/library with the filter, the search, paging, sorted by artist', () => {
    const url = libraryUrl({ has_drums: '1' }, { q: 'ac/dc & co', page: 2, size: 50 });
    assert.ok(url.startsWith('/api/library?'));
    const p = new URLSearchParams(url.split('?')[1]);
    assert.equal(p.get('has_drums'), '1');
    assert.equal(p.get('q'), 'ac/dc & co');
    assert.equal(p.get('page'), '2');
    assert.equal(p.get('size'), '50');
    assert.equal(p.get('sort'), 'artist');
    const bare = new URLSearchParams(libraryUrl({ five_fret: 'bass:chart' }).split('?')[1]);
    assert.equal(bare.has('q'), false, 'no empty search');
    assert.equal(bare.get('page'), '0');
});

const song = { filename: 'a.psarc', title: 'A', arrangements: [{ name: 'Lead', index: 0 }, { name: 'Bass', index: 3 }] };

test('soloPlayRequest: kit, drum controller and 5-fret go through playSolo with kind, part and difficulty', () => {
    assert.deepEqual(soloPlayRequest(solo({ instrument: 'kit', difficulty: 'hard' }), song),
        { via: 'playSolo', item: song, opts: { kind: 'kit', difficulty: 'hard' } });
    assert.deepEqual(soloPlayRequest(solo({ instrument: 'drums', difficulty: 'easy' }), song),
        { via: 'playSolo', item: song, opts: { kind: 'drums', difficulty: 'easy' } });
    assert.deepEqual(soloPlayRequest(solo({ instrument: 'five_fret', part: 'rhythm', difficulty: 'medium' }), song),
        { via: 'playSolo', item: song, opts: { kind: 'five_fret', part: 'rhythm', difficulty: 'medium' } });
});

test('soloPlayRequest: real guitar plays the arrangement through playSongAs with resetView', () => {
    assert.deepEqual(soloPlayRequest(solo({ instrument: 'guitar', arrangement: 'Bass' }), song),
        { via: 'playSongAs', item: song, filename: 'a.psarc', opts: { arrangement: 3, resetView: true } });
    // Smart names and numbered parts ("Lead 2") still find the arrangement.
    const smart = { filename: 'b', arrangements: [{ name: 'Rhythm', smart_name: 'Lead 2', index: 1 }] };
    assert.equal(soloPlayRequest(solo({ instrument: 'guitar', arrangement: 'Lead' }), smart).opts.arrangement, 1);
    // No such arrangement: core's default one.
    assert.deepEqual(soloPlayRequest(solo({ instrument: 'guitar', arrangement: 'Rhythm' }), song).opts, { resetView: true });
});

test('soloPlayRequest: null without a file', () => {
    assert.equal(soloPlayRequest(solo({}), null), null);
    assert.equal(soloPlayRequest(solo({}), { title: 'x' }), null);
});

test('soloAvailability: the kit needs the drums plugin and a connected MIDI input', () => {
    assert.deepEqual(soloAvailability(solo({ instrument: 'kit' }), { drums: true, midi: { connected: true, name: 'TD-17' } }),
        { ok: true, message: 'MIDI kit: TD-17', controls: null });
    const off = soloAvailability(solo({ instrument: 'kit' }), { drums: true, midi: { connected: false, key: 'k' } });
    assert.equal(off.ok, false);
    assert.match(off.message, /No MIDI kit connected/);
    assert.equal(off.controls, 'drums');
    assert.equal(soloAvailability(solo({ instrument: 'kit' }), { drums: true, midi: null }).ok, false);
    const none = soloAvailability(solo({ instrument: 'kit' }), { drums: false });
    assert.equal(none.ok, false);
    assert.match(none.message, /Drums plugin/);
    assert.equal(none.controls, null);
});

test('soloAvailability: controllers need their plugin and a connected controller', () => {
    assert.equal(soloAvailability(solo({ instrument: 'drums' }), { drums: true, controller: { name: 'Pad' } }).ok, true);
    const noPad = soloAvailability(solo({ instrument: 'drums' }), { drums: true, controller: null });
    assert.equal(noPad.ok, false);
    assert.match(noPad.message, /No drum controller/);
    assert.equal(noPad.controls, 'drums');
    const ff = soloAvailability(solo({ instrument: 'five_fret' }), { fiveFret: true, controller: null });
    assert.equal(ff.ok, false);
    assert.equal(ff.controls, 'five_fret');
    assert.match(soloAvailability(solo({ instrument: 'five_fret' }), { fiveFret: false }).message, /5-Fret plugin/);
    assert.equal(soloAvailability(solo({ instrument: 'five_fret' }), { fiveFret: true, controller: { name: '' } }).ok, true);
});

test('soloAvailability: real guitar is always playable; checking says so', () => {
    assert.equal(soloAvailability(solo({ instrument: 'guitar' }), {}).ok, true);
    const busy = soloAvailability(solo({ instrument: 'kit' }), { checking: true });
    assert.equal(busy.ok, false);
    assert.equal(busy.checking, true);
});

test('nextSoloItem: the song after the one just played, null at the end or when it is not listed', () => {
    const list = [{ filename: 'a' }, { filename: 'b' }, { filename: 'c' }];
    assert.equal(nextSoloItem(list, 'a').filename, 'b');
    assert.equal(nextSoloItem(list, 'c'), null);
    assert.equal(nextSoloItem(list, 'zz'), null);
    assert.equal(nextSoloItem([], 'a'), null);
    assert.equal(nextSoloItem(null, 'a'), null);
});

test('soloFields: which choices each instrument shows', () => {
    assert.deepEqual(soloFields('kit'), { part: false, arrangement: false, difficulty: true, soundMode: true });
    assert.deepEqual(soloFields('drums'), { part: false, arrangement: false, difficulty: true, soundMode: true });
    assert.deepEqual(soloFields('five_fret'), { part: true, arrangement: false, difficulty: true, soundMode: false });
    assert.deepEqual(soloFields('guitar'), { part: false, arrangement: true, difficulty: false, soundMode: false });
});

test('soloSoundMode: the kit uses the real drummer\'s sound, a controller solo the solo one', () => {
    const p = normalizePrefs({ parts: { drums: { soundMode: 'kit' } }, solo: { soundMode: 'song' } });
    assert.equal(soloSoundMode(p, 'kit'), 'kit');
    assert.equal(soloSoundMode(p, 'drums'), 'song');
    assert.deepEqual(soloSoundModePatch('kit', 'rockband'), { parts: { drums: { soundMode: 'rockband' } } });
    assert.deepEqual(soloSoundModePatch('drums', 'kit'), { solo: { soundMode: 'kit' } });
    assert.equal(soloSoundModePatch('drums', 'loud'), null);
    assert.equal(soloSoundModePatch('guitar', 'kit'), null);
});
