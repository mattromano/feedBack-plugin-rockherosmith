import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soloPrefs, pickSoloController, createSoloPlay, soloKindFor, createOpenSolo, adoptTarget, createAdopt, quickSettingPatch, currentViz } from '../src/solo.js';
import { normalizePrefs } from '../src/prefs.js';

const KEY = 'Xbox#1';

test('soloPrefs: one controller player, every fixed part off, the saved look kept', () => {
    const saved = normalizePrefs({ split: 70, failMode: 'fail', parts: { guitar: { deviceKey: 'g' } },
        controllers: [{ key: 'Other#1', playsAs: 'drums' }] });
    const p = soloPrefs(saved, { kind: 'five_fret', part: 'bass', difficulty: 'hard', controllerKey: KEY, name: 'Xbox' });
    assert.equal(p.split, 70);
    // Solo plays with the Solo screen's fail mode (contract §7), not the band's.
    assert.equal(p.failMode, 'nofail');
    assert.equal(soloPrefs(normalizePrefs({ solo: { failMode: 'fail' } }), { kind: 'drums', controllerKey: KEY }).failMode, 'fail');
    assert.deepEqual([p.parts.guitar.on, p.parts.drums.on, p.parts.vocals.on], [false, false, false]);
    assert.equal(p.parts.guitar.deviceKey, 'g');
    assert.equal(p.controllers.length, 1);
    const c = p.controllers[0];
    assert.deepEqual([c.key, c.playsAs, c.part, c.difficulty, c.partAudio, c.on], [KEY, 'five_fret', 'bass', 'hard', 'rockband', true]);
});

test('soloPrefs: drums plays drums; bad part / difficulty fall back; no key or kind is null', () => {
    const d = soloPrefs({}, { kind: 'drums', difficulty: 'expert', controllerKey: KEY });
    assert.deepEqual([d.controllers[0].playsAs, d.controllers[0].part, d.controllers[0].soundMode], ['drums', 'drums', 'rockband']);
    const f = soloPrefs({}, { kind: 'five_fret', part: 'keys', difficulty: 'insane', controllerKey: KEY });
    // A bad difficulty falls back to the Solo screen's (default expert).
    assert.deepEqual([f.controllers[0].part, f.controllers[0].difficulty], ['guitar', 'expert']);
    assert.equal(soloPrefs({}, { kind: 'five_fret' }), null);
    assert.equal(soloPrefs({}, { kind: 'keys', controllerKey: KEY }), null);
});

const kindsWith = (list) => ({
    five_fret: { api: () => ({ listControllers: async () => list }) },
});

test('pickSoloController: connected, set up, free first', async () => {
    const list = [
        { controllerKey: 'A#1', connected: false, kind: 'gamepad' },
        { controllerKey: 'B#1', connected: true, kind: null },
        { controllerKey: 'C#1', connected: true, kind: 'gamepad', claimedBy: 'drums', name: 'C' },
        { controllerKey: 'D#1', connected: true, kind: 'guitar', name: 'D' },
    ];
    assert.deepEqual(await pickSoloController('five_fret', kindsWith(list)), { controllerKey: 'D#1', name: 'D' });
    assert.deepEqual(await pickSoloController('five_fret', kindsWith(list.slice(0, 3))), { controllerKey: 'C#1', name: 'C' });
    assert.equal(await pickSoloController('five_fret', kindsWith(list.slice(0, 2))), null);
    assert.equal(await pickSoloController('drums', kindsWith(list)), null);
});

function harness({ list, phase = 'idle', start = () => Promise.resolve(true) } = {}) {
    const calls = [];
    const play = createSoloPlay({
        getRuntime: () => ({ phase: () => phase, startSession: (a) => { calls.push(['start', a]); return start(a); } }),
        getScreen: () => ({ openWithSong: (i) => calls.push(['openWithSong', i.filename]) }),
        loadPrefs: () => normalizePrefs({}),
        showScreen: (id) => calls.push(['show', id]),
        kinds: { five_fret: { api: () => ({ listControllers: async () => list || [{ controllerKey: KEY, connected: true, kind: 'gamepad' }] }) } },
    });
    return { play, calls };
}

test('playSolo starts a one-player session with the song', async () => {
    const { play, calls } = harness();
    const item = { filename: 'a.sloppak', five_fret_parts: ['guitar:chart'] };
    assert.equal(await play(item, { kind: 'five_fret', part: 'guitar', difficulty: 'expert' }), 'started');
    assert.equal(calls.length, 1);
    const [, arg] = calls[0];
    assert.equal(arg.song, item);
    assert.equal(arg.prefs.controllers[0].key, KEY);
    assert.equal(arg.prefs.controllers[0].difficulty, 'expert');
});

test('playSolo opens the band screen with the song when no controller can play', async () => {
    const { play, calls } = harness({ list: [] });
    assert.equal(await play({ filename: 'a.sloppak' }, { kind: 'five_fret' }), 'setup');
    assert.deepEqual(calls, [['openWithSong', 'a.sloppak'], ['show', 'plugin-rockherosmith']]);
});

test('playSolo does nothing mid-session or without a file; a refused start goes to setup', async () => {
    assert.equal(await harness({ phase: 'playing' }).play({ filename: 'a' }, { kind: 'five_fret' }), false);
    assert.equal(await harness().play({}, { kind: 'five_fret' }), false);
    const refused = harness({ start: () => false });
    assert.equal(await refused.play({ filename: 'a', five_fret_parts: ['guitar:chart'] }, { kind: 'five_fret' }), 'setup');
    assert.equal(refused.calls[0][0], 'start');
});

test('soloPrefs keeps the saved miss sound', () => {
    const off = soloPrefs(normalizePrefs({ missSound: false }), { kind: 'five_fret', controllerKey: KEY });
    assert.equal(off.missSound, false);
    assert.equal(soloPrefs({}, { kind: 'drums', controllerKey: KEY }).missSound, true);
});

// ---- Play layer contract §1, §2 ----

const DRUMS_ITEM = { filename: 'd.sloppak', arrangements: [{ index: 0, name: 'Lead' }, { index: 1, name: 'Drums' }] };
const FF_ITEM = { filename: 'f.sloppak', five_fret_parts: ['bass:chart'] };

test('soloPrefs kit: the real drummer only, the connected input first, saved sound mode, no controllers', () => {
    const saved = normalizePrefs({ parts: { drums: { on: false, deviceKey: 'TD-17', soundMode: 'kit', difficulty: 'hard' } },
        controllers: [{ key: KEY, playsAs: 'drums' }] });
    // deviceKey: the drums plugin's connected MIDI input; it wins over the saved one.
    const p = soloPrefs(saved, { kind: 'kit', deviceKey: 'Other MIDI' });
    assert.deepEqual([p.parts.guitar.on, p.parts.drums.on, p.parts.vocals.on], [false, true, false]);
    assert.deepEqual([p.parts.drums.deviceKey, p.parts.drums.soundMode, p.parts.drums.difficulty], ['Other MIDI', 'kit', 'hard']);
    // Nothing connected: the saved input.
    assert.equal(soloPrefs(saved, { kind: 'kit' }).parts.drums.deviceKey, 'TD-17');
    assert.deepEqual(p.controllers, []);
    // No saved device: the drums plugin's MIDI input; a picked difficulty wins.
    const q = soloPrefs({}, { kind: 'kit', deviceKey: 'Other MIDI', difficulty: 'easy' });
    assert.deepEqual([q.parts.drums.deviceKey, q.parts.drums.difficulty, q.parts.drums.soundMode], ['Other MIDI', 'easy', 'song']);
    assert.equal(soloPrefs({}, { kind: 'kit' }).parts.drums.deviceKey, '');
});

test('soloPrefs controller: sound mode, part audio and lefty from its saved entry, else the solo sound mode', () => {
    const saved = normalizePrefs({ solo: { soundMode: 'kit' },
        controllers: [{ key: KEY, playsAs: 'drums', soundMode: 'song', partAudio: 'always', lefty: true }] });
    const known = soloPrefs(saved, { kind: 'drums', controllerKey: KEY });
    assert.deepEqual([known.controllers[0].soundMode, known.controllers[0].partAudio, known.controllers[0].lefty], ['song', 'always', true]);
    const fresh = soloPrefs(saved, { kind: 'drums', controllerKey: 'New#1' });
    assert.deepEqual([fresh.controllers[0].soundMode, fresh.controllers[0].partAudio], ['kit', 'rockband']);
    assert.equal(soloPrefs({}, { kind: 'drums', controllerKey: 'New#1' }).controllers[0].soundMode, 'rockband');
});

function kitHarness({ midi = { key: 'TD-17', name: 'TD-17', connected: true }, midiApi = true, list = [], drumsApi = true } = {}) {
    const calls = [];
    const win = {};
    if (drumsApi) {
        win.feedBackDrums = { listControllers: async () => list };
        if (midiApi) win.feedBackDrums.midiInput = () => midi;
    }
    const play = createSoloPlay({
        getRuntime: () => ({ phase: () => 'idle', startSession: (a) => { calls.push(['start', a]); return Promise.resolve(true); } }),
        getScreen: () => ({ openWithSong: (i) => calls.push(['openWithSong', i.filename]) }),
        loadPrefs: () => normalizePrefs({}),
        showScreen: (id) => calls.push(['show', id]),
        win,
        kinds: { drums: { api: () => win.feedBackDrums || null }, five_fret: { api: () => null } },
    });
    return { play, calls, win };
}

test('playSolo kit: a solo session on the drums plugin MIDI input, no controller needed', async () => {
    const { play, calls } = kitHarness();
    assert.equal(await play(DRUMS_ITEM, { kind: 'kit', difficulty: 'expert' }), 'started');
    const [name, arg] = calls[0];
    assert.equal(name, 'start');
    assert.equal(arg.solo, true);
    assert.deepEqual([arg.prefs.parts.drums.on, arg.prefs.parts.drums.deviceKey, arg.prefs.parts.drums.difficulty], [true, 'TD-17', 'expert']);
    assert.deepEqual(arg.prefs.controllers, []);
});

test('playSolo kit without the midiInput API still starts (the drums plugin keeps its own input)', async () => {
    const { play, calls } = kitHarness({ midiApi: false });
    assert.equal(await play(DRUMS_ITEM, { kind: 'kit' }), 'started');
    assert.equal(calls[0][1].prefs.parts.drums.deviceKey, '');
});

test('playSolo: a song with no chart for the kind goes to setup', async () => {
    const { play, calls } = kitHarness();
    assert.equal(await play({ filename: 'g.psarc', arrangements: [{ index: 0, name: 'Lead' }] }, { kind: 'kit' }), 'setup');
    assert.deepEqual(calls, [['openWithSong', 'g.psarc'], ['show', 'plugin-rockherosmith']]);
    const ff = harness();
    assert.equal(await ff.play(DRUMS_ITEM, { kind: 'five_fret' }), 'setup');
    assert.equal(ff.calls.some(([n]) => n === 'start'), false);
    assert.equal(await kitHarness().play(DRUMS_ITEM, { kind: 'keys' }), 'setup');
});

test('playSolo controller solos are solo sessions', async () => {
    const { play, calls } = harness();
    await play({ filename: 'a', five_fret_parts: ['guitar:chart'] }, { kind: 'five_fret' });
    assert.equal(calls[0][1].solo, true);
});

test('soloKindFor: kit with a connected MIDI input, else drums with a connected game controller, else null', async () => {
    const gp = (connected) => ({ feedBack: { gamepadInput: { version: 1, list: () => [{ id: 'pad', connected }] } } });
    const midi = (connected) => ({ midiInput: () => ({ key: 'k', name: 'k', connected }) });
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: { ...gp(true), feedBackDrums: midi(true) } }), 'kit');
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: { ...gp(true), feedBackDrums: midi(false) } }), 'drums');
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: { ...gp(false), feedBackDrums: midi(false) } }), null);
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: { feedBackDrums: { midiInput: () => null } } }), null);
    // No drums plugin, or a song without drums: null.
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: gp(true) }), null);
    assert.equal(await soloKindFor({ filename: 'g', arrangements: [{ index: 0, name: 'Lead' }] }, { win: { ...gp(true), feedBackDrums: midi(true) } }), null);
    // No song given: the inputs alone decide.
    assert.equal(await soloKindFor(undefined, { win: { feedBackDrums: midi(true) } }), 'kit');
});

test('soloKindFor and kit playSolo wait for the drums MIDI discovery', async () => {
    let connected = false;
    const drums = {
        midiInput: () => ({ key: 'TD-17', name: 'TD-17', connected }),
        whenMidiReady: () => new Promise((r) => setTimeout(() => { connected = true; r(); }, 5)),
    };
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: { feedBackDrums: drums } }), 'kit');
    // A rejecting whenMidiReady still answers.
    const bad = { midiInput: () => ({ key: 'k', connected: true }), whenMidiReady: () => Promise.reject(new Error('x')) };
    assert.equal(await soloKindFor(DRUMS_ITEM, { win: { feedBackDrums: bad } }), 'kit');
    const { play, calls, win } = kitHarness({ midi: { key: 'TD-17', connected: false } });
    let ready = false;
    win.feedBackDrums.whenMidiReady = () => Promise.resolve().then(() => { ready = true; });
    win.feedBackDrums.midiInput = () => (ready ? { key: 'TD-17', connected: true } : null);
    assert.equal(await play(DRUMS_ITEM, { kind: 'kit' }), 'started');
    assert.equal(calls[0][1].prefs.parts.drums.deviceKey, 'TD-17');
});

test('openSolo (stub until the Solo screen): the band screen, its song pick on next', () => {
    const calls = [];
    const open = createOpenSolo({ getScreen: () => ({ nextSong: () => calls.push('nextSong') }), showScreen: (id) => calls.push(id) });
    open();
    open({ next: true });
    assert.deepEqual(calls, ['plugin-rockherosmith', 'plugin-rockherosmith', 'nextSong']);
});

// Adopt: what a plain play on the drum or 5-fret view becomes.
function vizWin({ picker = null, stored = null, songInfo = {}, drumsMatch = true, ffMatch = false, ffState = null } = {}) {
    const doc = { getElementById: (id) => (id === 'viz-picker' && picker !== null ? { value: picker } : (id === 'highway' ? { id } : null)) };
    const drums = () => ({});
    drums.matchesArrangement = () => drumsMatch;
    const ff = () => ({});
    ff.matchesArrangement = () => ffMatch;
    const win = {
        localStorage: { getItem: (k) => (k === 'vizSelection' ? stored : null) },
        highway: { getSongInfo: () => songInfo },
        feedBackViz_drums: drums, feedBackViz_five_fret: ff,
        feedBackFiveFret: { getInstanceState: () => ffState, listControllers: async () => [] },
    };
    return { win, doc };
}

test('currentViz: the picker, else the saved view; auto resolves through the views that match the part', () => {
    assert.equal(currentViz(vizWin({ picker: 'drums' }).win, vizWin({ picker: 'drums' }).doc), 'drums');
    const st = vizWin({ stored: 'five_fret' });
    assert.equal(currentViz(st.win, st.doc), 'five_fret');
    const auto = vizWin({ picker: 'auto', drumsMatch: true });
    assert.equal(currentViz(auto.win, auto.doc), 'drums');
    const autoFf = vizWin({ picker: 'auto', drumsMatch: false, ffMatch: true });
    assert.equal(currentViz(autoFf.win, autoFf.doc), 'five_fret');
    const none = vizWin({ picker: 'auto', drumsMatch: false });
    assert.equal(currentViz(none.win, none.doc), null);
    const def = vizWin({ picker: 'default' });
    assert.equal(currentViz(def.win, def.doc), null);
});

test('adoptTarget: the drum view on a drum part, the 5-fret view, nothing else', () => {
    const d = vizWin({ picker: 'drums' });
    assert.deepEqual(adoptTarget(d.win, d.doc), { kind: 'drums' });
    // The drum view on a guitar part shows "pick the Drums part": nothing to adopt.
    const wrong = vizWin({ picker: 'drums', drumsMatch: false });
    assert.equal(adoptTarget(wrong.win, wrong.doc), null);
    const f = vizWin({ picker: 'five_fret', ffState: { controllerKey: 'Gtr#1', instrument: 'bass' } });
    assert.deepEqual(adoptTarget(f.win, f.doc), { kind: 'five_fret', controllerKey: 'Gtr#1', part: 'bass', sourceKind: 'chart' });
    const g = vizWin({ picker: 'highway_3d' });
    assert.equal(adoptTarget(g.win, g.doc), null);
});

test('createAdopt: off without adoptSolo; kit on the drum view with MIDI; the playing 5-fret controller', async () => {
    const d = vizWin({ picker: 'drums' });
    d.win.feedBackDrums = { midiInput: () => ({ key: 'TD-17', connected: true }), listControllers: async () => [] };
    const kinds = { drums: { api: () => d.win.feedBackDrums }, five_fret: { api: () => d.win.feedBackFiveFret } };
    const off = createAdopt({ win: d.win, doc: d.doc, loadPrefs: () => normalizePrefs({ adoptSolo: false }), kinds });
    assert.equal(await off(DRUMS_ITEM), null);
    const on = createAdopt({ win: d.win, doc: d.doc, loadPrefs: () => normalizePrefs({}), kinds });
    const kit = (await on(DRUMS_ITEM)).prefs;
    assert.deepEqual([kit.parts.drums.on, kit.parts.drums.deviceKey, kit.controllers.length], [true, 'TD-17', 0]);

    // No MIDI input connected, a drums controller connected: that controller.
    d.win.feedBackDrums = { midiInput: () => null, listControllers: async () => [{ controllerKey: 'Kit#1', connected: true, kind: 'kit' }] };
    const ctl = (await on(DRUMS_ITEM)).prefs;
    assert.deepEqual([ctl.parts.drums.on, ctl.controllers[0].key, ctl.controllers[0].playsAs], [false, 'Kit#1', 'drums']);
    // Neither: the kit (keyboard or the plugin's own input).
    d.win.feedBackDrums = { midiInput: () => null, listControllers: async () => [] };
    assert.equal((await on(DRUMS_ITEM)).prefs.parts.drums.on, true);

    const f = vizWin({ picker: 'five_fret', ffState: { controllerKey: 'Gtr#1', instrument: 'bass' } });
    const ffKinds = { drums: { api: () => null }, five_fret: { api: () => f.win.feedBackFiveFret } };
    const ffAdopt = createAdopt({ win: f.win, doc: f.doc, loadPrefs: () => normalizePrefs({}), kinds: ffKinds });
    const five = (await ffAdopt(FF_ITEM)).prefs;
    assert.deepEqual([five.controllers[0].key, five.controllers[0].playsAs, five.controllers[0].part], ['Gtr#1', 'five_fret', 'bass']);
    // No controller playing and none connected: nothing to adopt.
    const lone = vizWin({ picker: 'five_fret' });
    const loneAdopt = createAdopt({ win: lone.win, doc: lone.doc, loadPrefs: () => normalizePrefs({}),
        kinds: { drums: { api: () => null }, five_fret: { api: () => lone.win.feedBackFiveFret } }, wait: () => Promise.resolve() });
    assert.equal(await loneAdopt(FF_ITEM), null);
});

test('quickSettingPatch: a band lane change saves into that controller entry; a solo one into the Solo choices', () => {
    const prefs = normalizePrefs({ controllers: [{ key: 'Gtr#1', playsAs: 'five_fret', part: 'guitar', difficulty: 'easy' }] });
    const band = quickSettingPatch(prefs, { controllerKey: 'Gtr#1', key: 'difficulty', value: 'hard', lane: true });
    assert.equal(band.controllers[0].difficulty, 'hard');
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'Gtr#1', key: 'part', value: 'bass', lane: true }).controllers[0].part, 'bass');
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'Gtr#1', key: 'lefty', value: true, lane: true }).controllers[0].lefty, true);
    // Not a lane pin, an unknown key or value, or an unsaved controller: nothing to save.
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'Gtr#1', key: 'difficulty', value: 'hard', lane: false }), null);
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'Gtr#1', key: 'offset', value: 10, lane: true }), null);
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'Gtr#1', key: 'difficulty', value: 'insane', lane: true }), null);
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'New#1', key: 'difficulty', value: 'hard', lane: true }), null);
    // A solo session: the Solo screen's difficulty / part.
    assert.deepEqual(quickSettingPatch(prefs, { controllerKey: 'New#1', key: 'difficulty', value: 'hard', lane: true }, { solo: true }),
        { solo: { difficulty: 'hard' } });
    assert.deepEqual(quickSettingPatch(prefs, { controllerKey: 'New#1', key: 'part', value: 'rhythm', lane: true }, { solo: true }),
        { solo: { part: 'rhythm' } });
    assert.equal(quickSettingPatch(prefs, { controllerKey: 'New#1', key: 'lefty', value: true, lane: true }, { solo: true }), null);
});

// The player's own difficulty wins when adopting (coordinator ruling on open question 3).
test('createAdopt: the drums plugin difficulty on #highway (Expert+ is Expert), else the saved one', async () => {
    const d = vizWin({ picker: 'drums' });
    const asked = [];
    d.win.feedBackDrums = { midiInput: () => ({ key: 'TD-17', connected: true }), listControllers: async () => [],
        getDifficulty: (c) => { asked.push(c); return 'hard'; } };
    const kinds = { drums: { api: () => d.win.feedBackDrums }, five_fret: { api: () => null } };
    const adopt = createAdopt({ win: d.win, doc: d.doc, loadPrefs: () => normalizePrefs({ parts: { drums: { difficulty: 'easy' } } }), kinds });
    assert.equal((await adopt(DRUMS_ITEM)).prefs.parts.drums.difficulty, 'hard');
    assert.deepEqual(asked, [{ id: 'highway' }]);
    d.win.feedBackDrums.getDifficulty = () => 'expert_plus';
    assert.equal((await adopt(DRUMS_ITEM)).prefs.parts.drums.difficulty, 'expert');
    d.win.feedBackDrums.getDifficulty = () => 'bogus';
    assert.equal((await adopt(DRUMS_ITEM)).prefs.parts.drums.difficulty, 'easy');
    delete d.win.feedBackDrums.getDifficulty;
    assert.equal((await adopt(DRUMS_ITEM)).prefs.parts.drums.difficulty, 'easy');
    // A drums controller adopted on the drum view plays at the plugin's difficulty too.
    d.win.feedBackDrums = { midiInput: () => null, getDifficulty: () => 'medium',
        listControllers: async () => [{ controllerKey: 'Kit#1', connected: true, kind: 'kit' }] };
    assert.equal((await adopt(DRUMS_ITEM)).prefs.controllers[0].difficulty, 'medium');
});

test('createAdopt 5-fret: the lane difficulty from getDifficulty or its state, else the saved solo difficulty', async () => {
    const f = vizWin({ picker: 'five_fret', ffState: { controllerKey: 'Gtr#1', instrument: 'bass', difficulty: 'easy' } });
    const kinds = { drums: { api: () => null }, five_fret: { api: () => f.win.feedBackFiveFret } };
    const adopt = createAdopt({ win: f.win, doc: f.doc, loadPrefs: () => normalizePrefs({ solo: { difficulty: 'hard' } }), kinds });
    assert.equal((await adopt(FF_ITEM)).prefs.controllers[0].difficulty, 'easy', 'from its state');
    f.win.feedBackFiveFret.getDifficulty = () => 'medium';
    assert.equal((await adopt(FF_ITEM)).prefs.controllers[0].difficulty, 'medium', 'getDifficulty first');
    f.win.feedBackFiveFret.getDifficulty = () => 'expert_plus';
    assert.equal((await adopt(FF_ITEM)).prefs.controllers[0].difficulty, 'expert');
    delete f.win.feedBackFiveFret.getDifficulty;
    const bare = vizWin({ picker: 'five_fret', ffState: { controllerKey: 'Gtr#1', instrument: 'bass' } });
    const bareAdopt = createAdopt({ win: bare.win, doc: bare.doc, loadPrefs: () => normalizePrefs({ solo: { difficulty: 'hard' } }),
        kinds: { drums: { api: () => null }, five_fret: { api: () => bare.win.feedBackFiveFret } } });
    assert.equal((await bareAdopt(FF_ITEM)).prefs.controllers[0].difficulty, 'hard', 'saved fallback');
});

// ---- PR #3 review fixes ----

test('kit playSolo: the connected MIDI input, never a saved different one; not connected: the saved one, never the dead key', async () => {
    const saved = normalizePrefs({ parts: { drums: { deviceKey: 'Saved Kit' } } });
    const mk = (midi) => {
        const calls = [];
        const win = { feedBackDrums: { midiInput: () => midi, listControllers: async () => [] } };
        const play = createSoloPlay({
            getRuntime: () => ({ phase: () => 'idle', startSession: (a) => { calls.push(a); return Promise.resolve(true); } }),
            getScreen: () => null, loadPrefs: () => saved, showScreen: () => {}, win,
            kinds: { drums: { api: () => win.feedBackDrums }, five_fret: { api: () => null } },
        });
        return { play, calls };
    };
    const on = mk({ key: 'TD-17', connected: true });
    await on.play(DRUMS_ITEM, { kind: 'kit' });
    assert.equal(on.calls[0].prefs.parts.drums.deviceKey, 'TD-17');
    const off = mk({ key: 'TD-17', connected: false });
    await off.play(DRUMS_ITEM, { kind: 'kit' });
    assert.equal(off.calls[0].prefs.parts.drums.deviceKey, 'Saved Kit');
});

test('createAdopt kit: the connected input wins over the saved one', async () => {
    const d = vizWin({ picker: 'drums' });
    d.win.feedBackDrums = { midiInput: () => ({ key: 'TD-17', connected: true }), listControllers: async () => [] };
    const adopt = createAdopt({ win: d.win, doc: d.doc, loadPrefs: () => normalizePrefs({ parts: { drums: { deviceKey: 'Saved Kit' } } }),
        kinds: { drums: { api: () => d.win.feedBackDrums }, five_fret: { api: () => null } } });
    assert.equal((await adopt(DRUMS_ITEM)).prefs.parts.drums.deviceKey, 'TD-17');
});

test('createAdopt 5-fret: the song gets the part the plugin is playing (core songs carry no 5-fret parts)', async () => {
    const f = vizWin({ picker: 'five_fret', ffState: { controllerKey: 'Gtr#1', instrument: 'bass', sourceKind: 'auto' } });
    const adopt = createAdopt({ win: f.win, doc: f.doc, loadPrefs: () => normalizePrefs({}),
        kinds: { drums: { api: () => null }, five_fret: { api: () => f.win.feedBackFiveFret } } });
    const core = { filename: 'f.sloppak', arrangements: [] };
    const r = await adopt(core);
    assert.deepEqual(r.song.five_fret_parts, ['bass:auto']);
    assert.equal(r.song.filename, 'f.sloppak');
    assert.equal(r.prefs.controllers[0].part, 'bass');
});

test('createAdopt 5-fret: waits for the instance to report its part; none: no adopt', async () => {
    let state = null;
    const f = vizWin({ picker: 'five_fret' });
    f.win.feedBackFiveFret.getInstanceState = () => state;
    let waits = 0;
    const adopt = createAdopt({ win: f.win, doc: f.doc, loadPrefs: () => normalizePrefs({}),
        kinds: { drums: { api: () => null }, five_fret: { api: () => f.win.feedBackFiveFret } },
        wait: () => { waits++; if (waits === 3) state = { controllerKey: 'Gtr#1', instrument: 'guitar' }; return Promise.resolve(); } });
    const r = await adopt({ filename: 'f' });
    assert.equal(waits, 3);
    assert.deepEqual(r.song.five_fret_parts, ['guitar:chart']);
    state = null;
    waits = -100;
    assert.equal(await adopt({ filename: 'f' }), null, 'no part reported in time');
});
