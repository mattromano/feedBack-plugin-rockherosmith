import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandScreenModel, isGoKey, soundModesOff } from '../src/band-model.js';
import { normalizePrefs } from '../src/prefs.js';

const prefs = normalizePrefs({});
const withParts = (parts) => normalizePrefs({ parts });
const fullBand = {
    arrangements: [{ name: 'Lead' }], has_drum_tab: true, has_vocal_pitch: true, stem_ids: ['drums'],
};

test('no song: go disabled with "Pick a song"', () => {
    const m = bandScreenModel({ prefs, item: null });
    assert.equal(m.goEnabled, false);
    assert.equal(m.goHint, 'Pick a song');
    for (const id of ['guitar', 'drums', 'vocals']) {
        assert.equal(m.columns[id].on, true);
        assert.equal(m.columns[id].unavailable, false);
    }
});

test('full band song', () => {
    const m = bandScreenModel({ prefs, item: fullBand });
    assert.equal(m.goEnabled, true);
    assert.equal(m.goHint, 'Press Space or hit any pad to start');
    assert.equal(m.columns.guitar.unavailable, false);
    assert.equal(m.columns.drums.unavailable, false);
    assert.equal(m.columns.vocals.unavailable, false);
    assert.equal(m.columns.drums.soundModesDisabled, false);
    assert.equal(m.columns.vocals.note, '');
    assert.equal(m.columns.guitar.note, 'Pick an input to score your guitar', 'no guitar input in the default prefs');
    assert.equal(m.columns.drums.note, '');
});

test('song without vocal pitch greys vocals with its note', () => {
    const m = bandScreenModel({ prefs, item: { ...fullBand, has_vocal_pitch: false } });
    assert.equal(m.columns.vocals.unavailable, true);
    assert.equal(m.columns.vocals.note, 'No vocal pitch for this song');
    assert.equal(m.columns.vocals.on, true, 'stored setting kept');
    assert.equal(m.goEnabled, true);
});

test('song without a drum stem disables sound modes 2 and 3', () => {
    const m = bandScreenModel({ prefs, item: { ...fullBand, stem_ids: ['guitar'] } });
    assert.equal(m.columns.drums.unavailable, false);
    assert.equal(m.columns.drums.soundModesDisabled, true);
    assert.equal(m.columns.drums.note, 'Rock Band and Kit only need a drum stem');
});

test('soundModesOff: Kit only needs a drum stem; Rock Band a drum stem or an unsplit song', () => {
    assert.deepEqual(soundModesOff(['guitar', 'drums']), []);
    assert.deepEqual(soundModesOff(['guitar', 'bass']), ['rockband', 'kit']);
    assert.deepEqual(soundModesOff([]), ['kit']);
    assert.deepEqual(soundModesOff(['full']), ['kit']);
    assert.deepEqual(soundModesOff(undefined), ['kit']);
});

test("the real drummer's sound modes on an unsplit song: Rock Band muffles the mix, Kit only is greyed", () => {
    for (const stem_ids of [[], ['full']]) {
        const rb = bandScreenModel({ prefs: withParts({ drums: { soundMode: 'rockband' } }), item: { ...fullBand, stem_ids } }).columns.drums;
        assert.deepEqual(rb.soundModeDisabled, ['kit'], JSON.stringify(stem_ids));
        assert.equal(rb.soundModesDisabled, true);
        assert.equal(rb.soundMode, 'rockband');
        assert.equal(rb.note, 'Kit only needs a drum stem');
        const kit = bandScreenModel({ prefs: withParts({ drums: { soundMode: 'kit' } }), item: { ...fullBand, stem_ids } }).columns.drums;
        assert.equal(kit.soundMode, 'song');
    }
    const split = bandScreenModel({ prefs: withParts({ drums: { soundMode: 'rockband' } }), item: { ...fullBand, stem_ids: ['guitar'] } }).columns.drums;
    assert.deepEqual(split.soundModeDisabled, ['rockband', 'kit']);
    assert.equal(split.soundMode, 'song');
    assert.deepEqual(bandScreenModel({ prefs, item: null }).columns.drums.soundModeDisabled, []);
});

test('song without a drum chart greys drums; guitar alone still enables Go', () => {
    const m = bandScreenModel({ prefs, item: { ...fullBand, has_drum_tab: false } });
    assert.equal(m.columns.drums.unavailable, true);
    assert.equal(m.columns.drums.note, 'No drum chart for this song');
    assert.equal(m.goEnabled, true);
    const off = bandScreenModel({ prefs: withParts({ guitar: { on: false }, vocals: { on: false } }), item: { ...fullBand, has_drum_tab: false } });
    assert.equal(off.goEnabled, false);
    assert.equal(off.goHint, 'Turn on a part');
});

test('guitar is checked against any of Lead/Rhythm/Bass, not only the chosen one', () => {
    const item = { ...fullBand, arrangements: [{ name: 'Bass' }] };
    const m = bandScreenModel({ prefs, item }); // chosen arrangement: Lead
    assert.equal(m.columns.guitar.unavailable, false);
    const none = bandScreenModel({ prefs, item: { ...fullBand, arrangements: [{ name: 'Drums' }] } });
    assert.equal(none.columns.guitar.unavailable, true);
    assert.equal(none.columns.guitar.note, 'No guitar part in this song');
});

test('only vocals on: Go is enabled for a song with vocal pitch', () => {
    const m = bandScreenModel({ prefs: withParts({ guitar: { on: false }, drums: { on: false } }), item: fullBand });
    assert.equal(m.goEnabled, true);
});

test('nothing on: Go disabled with "Turn on a part"', () => {
    const none = withParts({ guitar: { on: false }, drums: { on: false }, vocals: { on: false } });
    const m = bandScreenModel({ prefs: none, item: fullBand });
    assert.equal(m.goEnabled, false);
    assert.equal(m.goHint, 'Turn on a part');
});

test('karaoke not loaded greys vocals with its note, even with no song', () => {
    const m = bandScreenModel({ prefs, item: null, vocalsSupported: false });
    assert.deepEqual({ unavailable: m.columns.vocals.unavailable, note: m.columns.vocals.note },
        { unavailable: true, note: 'Turn on the Lyrics Karaoke plugin to sing' });
    const withSong = bandScreenModel({ prefs, item: fullBand, vocalsSupported: false });
    assert.equal(withSong.columns.vocals.unavailable, true);
    assert.equal(withSong.columns.vocals.note, 'Turn on the Lyrics Karaoke plugin to sing');
});

test('karaoke not loaded and only vocals on: Go disabled', () => {
    const only = withParts({ guitar: { on: false }, drums: { on: false } });
    const m = bandScreenModel({ prefs: only, item: fullBand, vocalsSupported: false });
    assert.equal(m.goEnabled, false);
    assert.equal(m.goHint, 'Turn on a part');
});

test('isGoKey', () => {
    assert.equal(isGoKey({ code: 'Space' }, null), true);
    assert.equal(isGoKey({ key: ' ' }, { tagName: 'BUTTON' }), true);
    assert.equal(isGoKey({ code: 'Space' }, { tagName: 'INPUT' }), false);
    assert.equal(isGoKey({ code: 'Space' }, { tagName: 'TEXTAREA' }), false);
    assert.equal(isGoKey({ code: 'Space' }, { tagName: 'SELECT' }), false);
    assert.equal(isGoKey({ code: 'Space', repeat: true }, null), false);
    assert.equal(isGoKey({ code: 'Enter' }, null), false);
    assert.equal(isGoKey({ code: 'Space' }, { tagName: 'DIV', isContentEditable: true }), false);
});

test('guitar column says how to get guitar scored', () => {
    const picked = withParts({ guitar: { on: true, deviceKey: 'usb-guitar' } });
    assert.equal(bandScreenModel({ prefs: picked, item: fullBand, noteDetectLoaded: true }).columns.guitar.note, '');
    assert.equal(bandScreenModel({ prefs, item: fullBand, noteDetectLoaded: true }).columns.guitar.note,
        'Pick an input to score your guitar');
    assert.equal(bandScreenModel({ prefs: picked, item: fullBand, noteDetectLoaded: false }).columns.guitar.note,
        'Turn on Note Detection to score your guitar');
    const off = withParts({ guitar: { on: false } });
    assert.equal(bandScreenModel({ prefs: off, item: fullBand, noteDetectLoaded: false }).columns.guitar.note, '', 'an off part needs no hint');
    const noGuitar = { arrangements: [{ name: 'Drums' }] };
    assert.equal(bandScreenModel({ prefs, item: noGuitar, noteDetectLoaded: false }).columns.guitar.note, 'No guitar part in this song');
});

test('the drums column says which sound mode will play', () => {
    const kit = withParts({ drums: { soundMode: 'kit' } });
    assert.equal(bandScreenModel({ prefs: kit, item: { ...fullBand, stem_ids: ['guitar'] } }).columns.drums.soundMode, 'song');
    assert.equal(bandScreenModel({ prefs: kit, item: { ...fullBand, stem_ids: ['drums'] } }).columns.drums.soundMode, 'kit');
    assert.equal(bandScreenModel({ prefs: kit, item: null }).columns.drums.soundMode, 'kit');
});

test('pickEnabled and setupHint', () => {
    const allOff = withParts({ guitar: { on: false }, drums: { on: false }, vocals: { on: false } });
    let m = bandScreenModel({ prefs: allOff, item: null });
    assert.equal(m.pickEnabled, false);
    assert.equal(m.setupHint, 'Turn on a part');
    m = bandScreenModel({ prefs, item: null });
    assert.equal(m.pickEnabled, true);
    assert.equal(m.setupHint, '');
    m = bandScreenModel({ prefs, item: null, pickAvailable: false });
    assert.equal(m.pickEnabled, false);
    assert.equal(m.setupHint, 'Update feedBack to pick songs here');
    const onlyVocals = withParts({ guitar: { on: false }, drums: { on: false }, vocals: { on: true } });
    m = bandScreenModel({ prefs: onlyVocals, item: null, vocalsSupported: false });
    assert.equal(m.pickEnabled, false);
    assert.equal(m.setupHint, 'Turn on a part');
    assert.equal(bandScreenModel({ prefs: onlyVocals, item: null }).pickEnabled, true);
});

test('guitar arrangements grey what the song lacks', () => {
    const p = withParts({ guitar: { arrangement: 'Lead' } });
    const m = bandScreenModel({ prefs: p, item: { arrangements: [{ name: 'Rhythm' }] } });
    assert.deepEqual(m.columns.guitar.arrangements, { Lead: false, Rhythm: true, Bass: false });
    assert.equal(m.columns.guitar.arrangement, 'Rhythm');
    assert.equal(p.parts.guitar.arrangement, 'Lead');
    const kept = bandScreenModel({ prefs: withParts({ guitar: { arrangement: 'Bass' } }),
        item: { arrangements: [{ name: 'Lead' }, { name: 'Bass' }] } });
    assert.equal(kept.columns.guitar.arrangement, 'Bass');
    const none = bandScreenModel({ prefs: withParts({ guitar: { arrangement: 'Rhythm' } }),
        item: { arrangements: [{ name: 'Drums' }] } });
    assert.equal(none.columns.guitar.arrangement, 'Rhythm');
});

test('a smart_name-only arrangement counts', () => {
    const m = bandScreenModel({ prefs: withParts({ guitar: { arrangement: 'Lead' } }),
        item: { arrangements: [{ smart_name: 'Rhythm', index: 0 }] } });
    assert.deepEqual(m.columns.guitar.arrangements, { Lead: false, Rhythm: true, Bass: false });
    assert.equal(m.columns.guitar.arrangement, 'Rhythm');
});

test('no song: every arrangement available', () => {
    const m = bandScreenModel({ prefs: withParts({ guitar: { arrangement: 'Bass' } }), item: null });
    assert.deepEqual(m.columns.guitar.arrangements, { Lead: true, Rhythm: true, Bass: true });
    assert.equal(m.columns.guitar.arrangement, 'Bass');
});

test('a five_fret_only pack leaves the guitar column unavailable with no arrangement offered', () => {
    const item = { arrangements: [{ index: 0, name: 'Lead', notes: 0 }], five_fret_only: true };
    const col = bandScreenModel({ prefs, item }).columns.guitar;
    assert.equal(col.unavailable, true);
    assert.deepEqual(col.arrangements, { Lead: false, Rhythm: false, Bass: false });
});

// ---- controller players ----
const ctl = (o) => ({ key: 'pad#1', id: 'ctl1', name: 'Xbox', playsAs: 'five_fret', part: 'guitar',
    difficulty: 'medium', lefty: false, partAudio: 'rockband', on: true, ...o });
const ctlPrefs = (controllers, fixedOn = false) => normalizePrefs({
    parts: { guitar: { on: fixedOn }, drums: { on: fixedOn }, vocals: { on: fixedOn } }, controllers,
});
const status = (...keys) => ({ available: true, reason: null, connected: new Set(keys) });
const song = { arrangements: [], five_fret_parts: ['guitar:chart', 'bass:auto'], stem_ids: ['guitar', 'bass'] };
const model = (controllers, extra = {}) => bandScreenModel({
    prefs: ctlPrefs(controllers), item: song, fiveFretLoaded: true, controllerStatus: status('pad#1'), ...extra,
});

test('a joined connected controller makes Go possible with every fixed part off', () => {
    const m = model([ctl()]);
    assert.equal(m.goEnabled, true);
    assert.equal(m.pickEnabled, true);
    assert.equal(m.controllers[0].connected, true);
    assert.equal(m.controllers[0].unavailable, false);
    assert.equal(model([]).goEnabled, false);
});

test('a band of controllers only can Go and open the song pick', () => {
    const m = bandScreenModel({ prefs: ctlPrefs([ctl(), ctl({ key: 'pad#2', id: 'ctl2', part: 'bass' })]),
        item: null, fiveFretLoaded: true, controllerStatus: status('pad#1', 'pad#2') });
    assert.equal(m.pickEnabled, true);
    assert.equal(m.goEnabled, false, 'no song yet');
    assert.equal(model([ctl()]).goEnabled, true);
});

test('a disconnected controller: not connected, not counted', () => {
    const m = model([ctl()], { controllerStatus: status() });
    assert.equal(m.controllers[0].connected, false);
    assert.equal(m.controllers[0].unavailable, true);
    assert.equal(m.controllers[0].note, 'Not connected');
    assert.equal(m.goEnabled, false);
    assert.equal(m.pickEnabled, false);
    // an off controller is not counted either
    assert.equal(model([ctl({ on: false })]).goEnabled, false);
});

test('stored Rhythm on a song with Lead and Bass shows Lead selected', () => {
    const m = model([ctl({ part: 'rhythm' })], { showAuto: true });
    assert.equal(m.controllers[0].part, 'guitar');
    assert.equal(m.controllers[0].unavailable, false);
    // the stored part is not rewritten
    assert.equal(ctlPrefs([ctl({ part: 'rhythm' })]).controllers[0].part, 'rhythm');
});

test('showAuto off: an auto-only part is not offered', () => {
    const m = model([ctl({ part: 'bass' })]);
    assert.equal(m.controllers[0].part, 'guitar', 'bass is auto-only, so Lead');
    assert.deepEqual(m.controllers[0].parts.bass, { has: false, kind: null, takenBy: [] });
    const auto = model([ctl({ part: 'bass' })], { item: { five_fret_parts: ['bass:auto'], stem_ids: [] } });
    assert.equal(auto.controllers[0].unavailable, true);
    assert.equal(auto.goEnabled, false);
    assert.equal(model([ctl({ part: 'bass' })], { showAuto: true }).controllers[0].part, 'bass');
});

test('no 5-fret part: the row is unavailable with its note', () => {
    const m = model([ctl()], { item: { arrangements: [{ name: 'Lead' }] } });
    assert.equal(m.controllers[0].unavailable, true);
    assert.equal(m.controllers[0].note, 'No 5-fret chart for this song');
    assert.equal(m.goEnabled, false);
    const noPlugin = model([ctl()], { fiveFretLoaded: false });
    assert.equal(noPlugin.controllers[0].note, 'Install the 5-Fret or Drums plugin to play on a controller');
    assert.equal(noPlugin.goEnabled, false);
});

test('parts show real/auto and who else holds them', () => {
    const two = [ctl({ name: 'Xbox' }), ctl({ key: 'pad#2', id: 'ctl2', name: 'Guitar', part: 'bass' })];
    const m = model(two, { controllerStatus: status('pad#1', 'pad#2'), showAuto: true });
    assert.deepEqual(m.controllers[0].parts, {
        guitar: { has: true, kind: 'chart', takenBy: [] },
        rhythm: { has: false, kind: null, takenBy: [] },
        bass: { has: true, kind: 'auto', takenBy: ['Guitar'] },
        drums: { has: false, kind: null, takenBy: [] },
    });
    assert.deepEqual(m.controllers[1].parts.guitar.takenBy, ['Xbox']);
    assert.deepEqual(m.controllers[1].parts.bass.takenBy, []);
});

test('part audio greyed without the part\'s stem', () => {
    const m = model([ctl(), ctl({ key: 'pad#2', id: 'ctl2', part: 'bass' })], { controllerStatus: status('pad#1', 'pad#2'), showAuto: true,
        item: { five_fret_parts: ['guitar:chart', 'bass:chart'], stem_ids: ['guitar'] } });
    assert.equal(m.controllers[0].partAudioDisabled, false);
    assert.equal(m.controllers[0].note, '');
    assert.equal(m.controllers[1].partAudioDisabled, true);
    assert.equal(m.controllers[1].note, 'Part audio needs a bass stem');
    assert.equal(m.controllers[0].partAudio, 'rockband');
});

test('an unsplit song keeps Rock Band part audio (it muffles the whole song); My kit only stays greyed', () => {
    for (const stem_ids of [[], ['full']]) {
        const m = model([ctl({ part: 'bass' })], { controllerStatus: status('pad#1'), showAuto: true,
            item: { five_fret_parts: ['guitar:chart', 'bass:chart'], stem_ids } });
        assert.equal(m.controllers[0].partAudioDisabled, false, JSON.stringify(stem_ids));
        assert.equal(m.controllers[0].note, '');
        const unsplitDrums = { ...drumSong, stem_ids };
        const rb = dmodel([dctl()], { item: unsplitDrums }).controllers[0];
        assert.deepEqual(rb.soundModeDisabled, ['kit']);
        assert.equal(rb.soundMode, 'rockband');
        assert.equal(rb.note, '');
        const kit = dmodel([dctl({ soundMode: 'kit' })], { item: unsplitDrums }).controllers[0];
        assert.equal(kit.soundMode, 'song');
        assert.equal(kit.note, 'Kit only needs a drum stem');
    }
});

// ---- drums controllers ----
const dctl = (o) => ctl({ key: 'kit#1', id: 'ctl3', name: 'Kit', playsAs: 'drums', part: 'drums', soundMode: 'rockband', ...o });
const drumSong = { arrangements: [], five_fret_parts: ['guitar:chart'], stem_ids: ['guitar', 'drums'], has_drum_tab: true };
const dmodel = (controllers, extra = {}) => bandScreenModel({
    prefs: ctlPrefs(controllers), item: drumSong, fiveFretLoaded: true, drumsLoaded: true,
    controllerStatus: status('pad#1', 'kit#1', 'kit#2'), ...extra,
});

test('an undecided controller sits out with its note and doesn\'t enable Go', () => {
    const u = ctl({ playsAs: null, part: null });
    const m = dmodel([u]);
    const r = m.controllers[0];
    assert.equal(r.playsAs, null);
    assert.deepEqual(r.kinds, []);
    assert.equal(r.unavailable, true);
    assert.equal(r.note, 'Choose 5-Fret or Drums');
    assert.equal(r.part, null);
    assert.equal(r.parts, null);
    assert.equal(m.goEnabled, false);
    assert.equal(m.pickEnabled, false);
    // the others still play
    const both = dmodel([u, ctl({ key: 'kit#1', id: 'ctl2' })]);
    assert.equal(both.goEnabled, true);
    assert.equal(both.pickEnabled, true);
    // kinds come from the caller's per-key map
    const k = dmodel([u], { controllerStatus: { ...status('pad#1'), kinds: new Map([['pad#1', ['five_fret', 'drums']]]) } });
    assert.deepEqual(k.controllers[0].kinds, ['five_fret', 'drums']);
    assert.deepEqual(dmodel([dctl()]).controllers[0].kinds, ['drums']);
});

test('a drums controller on a song without a drum chart is unavailable; Go uses the others', () => {
    const noChart = { ...drumSong, has_drum_tab: false };
    const m = dmodel([dctl(), ctl()], { item: noChart });
    assert.equal(m.controllers[0].unavailable, true);
    assert.equal(m.controllers[0].note, 'No drum chart for this song');
    assert.equal(m.controllers[0].part, 'drums', 'the stored part stays, like a 5-fret row');
    assert.deepEqual(m.controllers[0].parts.drums, { has: false, kind: null, takenBy: [] });
    assert.equal(m.controllers[1].unavailable, false);
    assert.equal(m.goEnabled, true);
    assert.equal(dmodel([dctl()], { item: noChart }).goEnabled, false);
    const ok = dmodel([dctl()]);
    assert.equal(ok.controllers[0].unavailable, false);
    assert.equal(ok.controllers[0].part, 'drums');
    assert.equal(ok.controllers[0].parts.drums.kind, 'chart');
    assert.equal(ok.goEnabled, true);
});

test('drums row: takenBy lists the real drummer and other drum controllers', () => {
    const two = [dctl({ name: 'Kit A' }), dctl({ key: 'kit#2', id: 'ctl4', name: 'Kit B' })];
    const realOn = bandScreenModel({
        prefs: normalizePrefs({ parts: { guitar: { on: false }, drums: { on: true }, vocals: { on: false } }, controllers: two }),
        item: drumSong, fiveFretLoaded: true, drumsLoaded: true, controllerStatus: status('kit#1', 'kit#2'),
    });
    assert.deepEqual(realOn.controllers[0].parts.drums.takenBy, ['Kit B', 'Drums']);
    assert.deepEqual(realOn.controllers[1].parts.drums.takenBy, ['Kit A', 'Drums']);
    const m = dmodel(two);
    assert.deepEqual(m.controllers[0].parts.drums.takenBy, ['Kit B']);
    // a 5-fret controller and an off or undecided one don't take drums
    const mixed = dmodel([dctl(), ctl(), dctl({ key: 'kit#2', id: 'ctl4', name: 'Off', on: false }), ctl({ key: 'x#9', id: 'ctl5', playsAs: null, part: null })]);
    assert.deepEqual(mixed.controllers[0].parts.drums.takenBy, []);
});

test('sound modes greyed without a drum stem', () => {
    const withStem = dmodel([dctl({ soundMode: 'kit' })]).controllers[0];
    assert.deepEqual(withStem.soundModeDisabled, []);
    assert.equal(withStem.soundMode, 'kit');
    assert.equal(withStem.note, '');
    const noStem = dmodel([dctl({ soundMode: 'kit' })], { item: { ...drumSong, stem_ids: ['guitar'] } }).controllers[0];
    assert.deepEqual(noStem.soundModeDisabled, ['rockband', 'kit']);
    assert.equal(noStem.soundMode, 'song', 'plays as Song drums');
    assert.equal(noStem.note, 'Rock Band and Kit only need a drum stem');
    const song = dmodel([dctl({ soundMode: 'song' })], { item: { ...drumSong, stem_ids: [] } }).controllers[0];
    assert.equal(song.soundMode, 'song');
    assert.equal(song.note, '');
    // the stored mode is untouched, and no song means nothing greyed
    assert.equal(ctlPrefs([dctl({ soundMode: 'kit' })]).controllers[0].soundMode, 'kit');
    assert.deepEqual(dmodel([dctl()], { item: null }).controllers[0].soundModeDisabled, []);
});

test("with the real drummer on, a drums controller's row says the drummer's sound mode sets the stem", () => {
    const realOn = (c, item = drumSong) => bandScreenModel({
        prefs: normalizePrefs({ parts: { guitar: { on: false }, drums: { on: true }, vocals: { on: false } }, controllers: [c] }),
        item, fiveFretLoaded: true, drumsLoaded: true, controllerStatus: status('kit#1', 'pad#1'),
    }).controllers[0];
    const r = realOn(dctl({ soundMode: 'kit' }));
    assert.equal(r.note, "The drummer's sound mode sets the drum stem");
    assert.equal(r.unavailable, false, 'it still plays');
    assert.equal(r.soundMode, 'kit', 'the stored mode stays');
    // A missing drum stem says so first; a 5-fret row and a real-drummer-less band say nothing.
    assert.equal(realOn(dctl(), { ...drumSong, stem_ids: ['guitar'] }).note, 'Rock Band and Kit only need a drum stem');
    assert.equal(realOn(ctl({ key: 'pad#1' })).note, '');
    assert.equal(dmodel([dctl({ soundMode: 'kit' })]).controllers[0].note, '');
});

test('no five-fret but drums loaded: controllers available; neither: reason no-controller-plugins', () => {
    const drumsOnly = dmodel([dctl()], { fiveFretLoaded: false });
    assert.equal(drumsOnly.controllers[0].available, true);
    assert.equal(drumsOnly.goEnabled, true);
    // a 5-fret row with the 5-fret plugin missing keeps the 5-fret-specific note
    const ff = dmodel([ctl()], { fiveFretLoaded: false });
    assert.equal(ff.controllers[0].unavailable, true);
    assert.equal(ff.controllers[0].note, 'Install the 5-Fret plugin to play on a controller');
    const noDrums = dmodel([dctl()], { drumsLoaded: false });
    assert.equal(noDrums.controllers[0].note, 'Install the Drums plugin to play on a controller');
    assert.equal(noDrums.goEnabled, false);
    const neither = dmodel([dctl(), ctl()], { fiveFretLoaded: false, drumsLoaded: false,
        controllerStatus: { ...status('pad#1', 'kit#1'), available: false, reason: 'no-controller-plugins' } });
    assert.equal(neither.controllers[0].note, 'Install the 5-Fret or Drums plugin to play on a controller');
    assert.equal(neither.controllers[1].note, 'Install the 5-Fret or Drums plugin to play on a controller');
    assert.equal(neither.goEnabled, false);
});
