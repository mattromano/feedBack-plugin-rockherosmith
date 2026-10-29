// Band session runtime: Go -> playSong -> stage on song:ready -> end, with a
// fake feedBack bus, the shared fake DOM, in-memory storage and manual timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBandRuntime } from '../src/band-runtime.js';
import { readFileSync } from 'node:fs';
import { createBandScreen } from '../src/band-screen.js';
import { makeDoc, parseHtml, flush } from './fake-dom.mjs';
import { makeFakeContext } from './fake-audio.mjs';
import { starsFromScore } from '../src/yarg-rules.js';
import { CONTROLLER_KINDS } from '../src/controller-model.js';
import { loadPrefs as loadSavedPrefs, savePrefs as savePrefsTo } from '../src/prefs.js';

function memStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        has: (k) => m.has(k),
    };
}

function manualTimers() {
    const pending = new Map();
    let next = 1;
    return {
        setTimer: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
        clearTimer: (id) => { pending.delete(id); },
        delays: () => [...pending.values()].map((t) => t.ms),
        // Fire every pending timer with the given delay.
        fire(ms) {
            for (const [id, t] of [...pending]) {
                if (t.ms !== ms) continue;
                pending.delete(id);
                t.fn();
            }
        },
    };
}

function prefsWith({ guitar = {}, drums = {}, vocals = {} } = {}) {
    return {
        split: 62,
        labelScale: 1,
        parts: {
            guitar: { on: true, deviceKey: '', arrangement: 'Lead', difficulty: 'medium', ...guitar },
            drums: { on: true, deviceKey: '', difficulty: 'medium', soundMode: 'song', ...drums },
            vocals: { on: false, deviceId: '', difficulty: 'medium', hearMyself: false, ...vocals },
        },
    };
}

const ITEM = { filename: 'My Song.sloppak', arrangements: [{ index: 0, name: 'Lead' }, { index: 1, name: 'Bass' }] };
const DRUM_ITEM = { filename: 'Beat.sloppak', arrangements: [{ index: 0, name: 'Lead' }, { index: 1, name: 'Drums' }] };

function setup({ slider = '80', storageInit = { splitscreenActive: 'true' }, settings = { master_difficulty: 60 },
    karaoke = true, karaokePitch = true, mountFails = false, drumLane = true,
    stems = ['guitar', 'drums'], caps = true, pauseStatus = 'paused', overlayApi = true, confirmDialog = true,
    onShowBandScreen, fiveFret = true, pads = ['Xbox#1', 'Xbox#2'], drumPads = ['Kit#1', 'Kit#2'], runtimeOpts = {} } = {}) {
    const bus = new EventTarget();
    const calls = { playSong: [], showScreen: [], setReturnScreen: [], hold: 0, release: 0, setMastery: [],
        setDifficulty: [], clearDifficulty: [], splitStart: 0, fetch: [], setViz: [],
        karaoke: [], karaokeAt: [], playSongAt: [], hides: [], countIn: [], countInAt: [], nd: [], micHit: [],
        caps: [], audioPause: 0, setMasteryAt: [],
        // Plan 7: full screen, the sidebar's links, core's overlay pause, the loop, note_detect's quiet switch.
        fsRequest: 0, fsExit: 0, nav: [], pause: 0, resume: [], resumeAt: [], loop: [], exitSong: 0, togglePlay: 0,
        ndQuiet: [], setController: [], clearController: [], inputTarget: [] };
    // Shared sequence counter: orders karaoke calls against playSong and unmount.
    let seq = 0;
    const doc = makeDoc();
    const player = doc.createElement('div');
    player.id = 'player';
    doc.body.appendChild(player);
    const highwayCanvas = doc.createElement('canvas');
    highwayCanvas.id = 'highway';
    player.appendChild(highwayCanvas);
    if (slider !== null) {
        const s = doc.createElement('input');
        s.id = 'mastery-slider';
        s.value = slider;
        doc.body.appendChild(s);
    }
    // The song's media element: pause() only records (nothing plays).
    const audio = doc.createElement('audio');
    audio.id = 'audio';
    audio.paused = false;
    audio.pause = () => { calls.audioPause++; audio.paused = true; };
    player.appendChild(audio);
    // The HTML Fullscreen API: records, and only moves doc.fullscreenElement
    // (fullscreenchange is fired by the tests through the doc's listeners).
    doc.fullscreenElement = null;
    doc.documentElement = doc.createElement('html');
    doc.documentElement.requestFullscreen = () => { calls.fsRequest++; doc.fullscreenElement = doc.documentElement; };
    doc.exitFullscreen = () => { calls.fsExit++; doc.fullscreenElement = null; };
    // Core's sidebar, its nav links (each with its own recording click
    // listener, as shell binds them) and the Settings screen.
    const sidebar = doc.createElement('nav');
    sidebar.id = 'v3-sidebar';
    doc.body.appendChild(sidebar);
    const navLinks = {};
    for (const key of ['settings', 'songs', 'rockherosmith']) {
        const a = doc.createElement('a');
        a.setAttribute('data-v3-nav', key);
        a.addEventListener('click', () => calls.nav.push(key));
        sidebar.appendChild(a);
        navLinks[key] = a;
    }
    const settingsScreen = doc.createElement('div');
    settingsScreen.id = 'settings';
    settingsScreen.className = 'screen';
    doc.body.appendChild(settingsScreen);
    const bandScreen = doc.createElement('div');
    bandScreen.id = 'plugin-rockherosmith';
    bandScreen.className = 'screen';
    doc.body.appendChild(bandScreen);

    const fb = {
        currentSong: { filename: 'old.psarc', arrangements: [] },
        on: (ev, fn) => bus.addEventListener(ev, fn),
        off: (ev, fn) => bus.removeEventListener(ev, fn),
        emit: (ev, detail) => bus.dispatchEvent(new CustomEvent(ev, { detail })),
        _nextReturnScreen: null,
        setReturnScreen: (id) => { calls.setReturnScreen.push(id); fb._nextReturnScreen = id; },
        holdAutoExit: () => { calls.hold++; return () => { calls.release++; }; },
        setSongCountInOverride: (v) => { calls.countIn.push(v); calls.countInAt.push(++seq); },
        getDisplayTime: () => clock.t,
        // Core's transport flag (window.feedBack.isPlaying): the song plays.
        isPlaying: true,
        // Core's A-B loop (null: unset).
        getLoop: () => ({ loopA: loop.a, loopB: loop.b }),
    };
    const loop = { a: null, b: null };
    // Core's overlay pause (plan 7 R10): records only, nothing plays.
    if (overlayApi) {
        fb.pauseForOverlay = () => { calls.pause++; ++seq; return { wasPlaying: true, gen: 1 }; };
        fb.resumeAfterOverlay = (token) => { calls.resume.push(token); calls.resumeAt.push(++seq); return true; };
    }
    // Core's capability host, recording [name, request] into calls.caps. Nothing plays:
    // stems mutes are only recorded, and playback pause answers with pauseStatus.
    if (caps) {
        fb.capabilities = {
            claim: (req) => { calls.caps.push(['claim', req]); return () => {}; },
            release: (req) => { calls.caps.push(['release', req]); return { ok: true }; },
            dispatch: (req) => {
                calls.caps.push(['dispatch', req]);
                if (req.capability === 'playback') return Promise.resolve({ outcome: 'handled', status: pauseStatus });
                return Promise.resolve({ outcome: 'handled', status: 'applied' });
            },
        };
    }
    // The song's display time, moved by the tests.
    const clock = { t: 0 };
    // The chart: highway time, beats and phrases (overdrive), moved by the tests.
    const chart = { t: 0, beats: [], phrases: null };
    // What the drums engine and karaoke report for overdrive (null: nothing).
    const od = { drums: null, vocals: null };
    let ssActive = false;
    const storage = memStorage(storageInit);
    const win = {
        feedBack: fb,
        localStorage: storage,
        highway: {
            setMastery: (f) => { calls.setMastery.push(f); calls.setMasteryAt.push(++seq); },
            // Ten single notes at the band mastery.
            getFilteredNotes: () => Array.from({ length: 10 }, (_, i) => ({ t: i, s: 0, f: 3 })),
            getFilteredChords: () => [],
            getBeats: () => chart.beats,
            getPhrases: () => chart.phrases,
            getTime: () => chart.t,
        },
        setMastery: () => { throw new Error('window.setMastery persists; never call it'); },
        playSong: (f, i) => { calls.playSongAt.push(++seq); calls.playSong.push([f, i]); },
        showScreen: (id) => calls.showScreen.push(id),
        setLoopStart: () => { calls.loop.push('start'); loop.a = 1; },
        setLoopEnd: () => { calls.loop.push('end'); loop.b = 2; },
        clearLoop: () => { calls.loop.push('clear'); loop.a = null; loop.b = null; },
        requestExitSong: () => { calls.exitSong++; },
        togglePlay: () => { calls.togglePlay++; },
        setViz: (id) => { calls.setViz.push(id); storage.setItem('vizSelection', id); },
        feedBackViz_drums: () => ({ draw() {} }),
        feedBackDrums: {
            setDifficulty: (id, c) => calls.setDifficulty.push([id, c]),
            clearDifficulty: (c) => calls.clearDifficulty.push(c),
            setScoreHudHidden: (c, v) => { calls.hides.push(['drums', c, v]); return true; },
            getInstanceState: (c) => (typeof od.drums === 'function' ? od.drums(c) : od.drums),
            // Plan 6 Part A: `drumPads` are the connected controllerKeys; the pins only record.
            listControllers: () => Promise.resolve(drumPads.map((key, i) => ({ index: i, controllerKey: key, kind: 'kit', connected: true }))),
            setController: (key, c) => { calls.setController.push([key, c]); return true; },
            clearController: (c) => { calls.clearController.push(c); },
            setInputTarget: (c) => { calls.inputTarget.push(c); },
        },
        noteDetect: {
            setScoreHudHidden: (v) => { calls.hides.push(['nd', v]); return true; },
            // Detection on/off, recorded into calls.nd.
            enabled: false,
            isEnabled() { return this.enabled; },
            enable() { calls.nd.push(['enable']); this.enabled = true; return Promise.resolve(true); },
            disable(o) { calls.nd.push(['disable', o]); this.enabled = false; },
            // The input-error quiet switch (plan 7 R16), recorded into calls.ndQuiet.
            quiet: false,
            setInputErrorsQuiet(v) { calls.ndQuiet.push(v); this.quiet = !!v; },
            isInputErrorsQuiet() { return this.quiet; },
        },
        feedBackScorecard: { setHudHidden: (v) => { calls.hides.push(['scorecard', v]); return true; } },
        slopsmithSplitscreen: { isActive: () => ssActive, start: () => { calls.splitStart++; }, stop() { ssActive = false; } },
        stems: { getState: () => stems.map((id) => ({ id, on: true, vol: 1 })) },
    };
    // note_detect's judgments arrive on window.
    const winEvents = new EventTarget();
    win.addEventListener = (t, f) => winEvents.addEventListener(t, f);
    win.removeEventListener = (t, f) => winEvents.removeEventListener(t, f);
    win.dispatchEvent = (e) => winEvents.dispatchEvent(e);
    // Core's _confirmDialog: each prompt waits until the test settles it. As
    // core's, it appends a .feedBack-modal synchronously; its [data-cancel]
    // click answers false; any answer removes it.
    const prompts = [];
    if (confirmDialog) {
        win._confirmDialog = (args) => new Promise((resolve, reject) => {
            const modal = doc.createElement('div');
            modal.className = 'feedBack-modal';
            const cancel = doc.createElement('button');
            cancel.setAttribute('data-cancel', '');
            modal.appendChild(cancel);
            doc.body.appendChild(modal);
            const p = { args, modal, settled: false };
            const done = (f) => (v) => { if (p.settled) return; p.settled = true; modal.remove(); f(v); };
            p.resolve = done(resolve);
            p.reject = done(reject);
            cancel.addEventListener('click', () => p.resolve(false));
            prompts.push(p);
        });
    }
    // Lyrics Karaoke's v1 API, recording [name, arg] into calls.karaoke.
    if (karaoke) {
        const rec = (name, ...args) => { calls.karaoke.push([name, ...args]); calls.karaokeAt.push(++seq); };
        win.lyricsKaraoke = {
            apiVersion: 1,
            mountStrip: (el) => { rec('mountStrip', el); return true; },
            setKaraokeMode: (on) => { rec('setKaraokeMode', on); return Promise.resolve(on ? karaokePitch : false); },
            startMic: () => { rec('startMic'); return Promise.resolve('listening'); },
            stopMic: () => { rec('stopMic'); },
            setDifficulty: (id) => { rec('setDifficulty', id); return true; },
            setHearMyself: (on) => { rec('setHearMyself', on); return true; },
            // Recorded with the other plugins' hide switches.
            setScoreHudHidden: (v) => { calls.hides.push(['karaoke', v]); return true; },
            getOverdrive: () => od.vocals,
            setMicHitThreshold: (db) => { calls.micHit.push(db); },
        };
    }
    // The 5-Fret plugin's band API: `pads` are the connected controllerKeys, and
    // ff.state(canvas) is what getInstanceState reports for a lane (null: nothing).
    const ff = { state: () => null, lists: 0 };
    if (fiveFret) {
        win.feedBackFiveFret = {
            listControllers: () => { ff.lists++; return Promise.resolve(pads.map((key, i) => ({ index: i, controllerKey: key, connected: true }))); },
            setScoreHudHidden: (c, v) => { calls.hides.push(['five_fret', c, v]); return true; },
            getInstanceState: (c) => ff.state(c),
            showAutoCharts: () => false,
        };
        win.feedBackViz_five_fret = () => ({ draw() {} });
    }
    // CONTROLLER_KINDS with its plugin globals read from this fake window.
    const kinds = {
        five_fret: { ...CONTROLLER_KINDS.five_fret,
            api: () => win.feedBackFiveFret || null, laneRenderer: () => win.feedBackViz_five_fret || null },
        drums: { ...CONTROLLER_KINDS.drums,
            api: () => win.feedBackDrums || null, laneRenderer: () => win.feedBackViz_drums || null },
    };
    // Controller lanes that fail to start on the next mounts (getLaneCanvas reports null).
    const failLanes = new Set();
    const mounts = [];
    const mountStage = ({ player: p, song, prefs, deps }) => {
        if (mountFails) throw new Error('mount failed');
        // The real stage stops splitscreen, which clears the stored pref.
        storage.setItem('splitscreenActive', 'false');
        // The real stage's slots: a lane per playing part, a drum-lane canvas
        // beside a guitar lane (drums alone draws on #highway), the strip.
        const on = (id) => !!(prefs.parts[id] && prefs.parts[id].on);
        const root = doc.createElement('div');
        root.className = 'rhs-stage-root';
        p.appendChild(root);
        const lanes = {};
        // drumLane false: the real stage's fallback to a guitar lane only.
        const laneParts = on('guitar') && !drumLane ? ['guitar'] : ['guitar', 'drums'];
        for (const id of laneParts) {
            if (!on(id)) continue;
            lanes[id] = doc.createElement('div');
            lanes[id].className = 'rhs-lane';
            root.appendChild(lanes[id]);
        }
        const drumCanvas = on('guitar') && on('drums') && drumLane ? doc.createElement('canvas') : null;
        if (drumCanvas) lanes.drums.appendChild(drumCanvas);
        // A lane per controller switched on, in join order, each with its canvas.
        const ctlCanvas = {};
        for (const c of prefs.controllers || []) {
            if (!c || c.on !== true || failLanes.has(c.id)) continue;
            lanes[c.id] = doc.createElement('div');
            lanes[c.id].className = 'rhs-lane';
            ctlCanvas[c.id] = doc.createElement('canvas');
            lanes[c.id].appendChild(ctlCanvas[c.id]);
            root.appendChild(lanes[c.id]);
        }
        const stripSlot = on('vocals') ? doc.createElement('div') : null;
        if (stripSlot) root.appendChild(stripSlot);
        const s = { player: p, song, prefs, deps, unmounted: 0, unmountedAt: null, stripSlot, lanes, drumCanvas, ctlCanvas,
            laneSlot: (id) => lanes[id] || null,
            getDrumCanvas: () => drumCanvas,
            getLaneCanvas: (id) => (id === 'drums' ? drumCanvas : ctlCanvas[id] || null),
            unmount() { this.unmounted++; this.unmountedAt = ++seq; root.remove(); } };
        mounts.push(s);
        return s;
    };
    const timers = manualTimers();
    const fetchJson = async (url) => { calls.fetch.push(url); return settings; };
    const makeRuntime = () => createBandRuntime({ win, doc, mountStage, loadPrefs: () => prefsWith(), storage, fetchJson,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer, onShowBandScreen, kinds, ...runtimeOpts });
    const rt = makeRuntime();

    // Core's playSong side: loading, then the song becomes current and is ready.
    function loadSong(item, { hasPhraseData = true } = {}) {
        fb.emit('song:loading', { filename: item.filename });
        fb.currentSong = { filename: item.filename, arrangements: item.arrangements, hasDrumTab: !!item.has_drum_tab,
            hasVocalPitch: !!item.has_vocal_pitch };
        fb.emit('song:loaded', fb.currentSong);
        fb.emit('song:ready', { hasPhraseData });
    }
    const fireWin = (type, detail) => win.dispatchEvent(new CustomEvent(type, { detail }));
    // A cancelable keydown on window (the runtime's and the overlays' capture listeners).
    const keyWin = (code, key, mods = {}) => {
        const e = new Event('keydown', { cancelable: true });
        Object.assign(e, { code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
        win.dispatchEvent(e);
        return e;
    };
    return { rt, fb, doc, win, calls, mounts, storage, timers, player, highwayCanvas, bandScreen, loadSong, clock, chart, od, fireWin, audio,
        sidebar, navLinks, settingsScreen, prompts, keyWin, ff, failLanes,
        makeRuntime, setSplit: (v) => { ssActive = v; },
        // The next mount's stage: with or without a drum lane beside guitar.
        setDrumLane: (v) => { drumLane = v; } };
}

test('no Band button is injected any more', () => {
    const { rt, fb, doc } = setup();
    fb.emit('song:loaded', fb.currentSong);
    assert.equal(doc.getElementById('rhs-band-btn'), null);
    assert.equal(rt.toggle, undefined);
    rt.dispose();
});

test('Go plays the chosen guitar arrangement from the band screen', async () => {
    const { rt, calls } = setup();
    const prefs = prefsWith({ guitar: { arrangement: 'Bass' } });
    const started = rt.startSession({ song: ITEM, prefs });
    assert.equal(typeof started.then, 'function', 'a started session returns a promise');
    assert.deepEqual(calls.playSong, [['My%20Song.sloppak', 1]]);
    assert.deepEqual(calls.setReturnScreen, ['plugin-rockherosmith']);
    assert.equal(rt.phase(), 'armed');
    assert.equal(rt.startSession({ song: ITEM, prefs }), false);
    assert.equal(calls.playSong.length, 1);
    assert.equal(await started, true);
    rt.dispose();
});

test("the band song's song:ready mounts the stage and applies guitar mastery", () => {
    const { rt, calls, mounts, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'medium' } }) });
    loadSong(ITEM, { hasPhraseData: true });
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].player, player);
    assert.equal(mounts[0].song.filename, 'My Song.sloppak');
    assert.equal(mounts[0].prefs.parts.guitar.difficulty, 'medium');
    assert.deepEqual(calls.setMastery, [0.5]);
    assert.equal(rt.phase(), 'playing');
    assert.equal(rt.isMounted(), true);
    rt.dispose();
});

test('a one-difficulty chart shows the toast and leaves mastery alone', () => {
    const { rt, calls, loadSong, player, timers } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM, { hasPhraseData: false });
    assert.deepEqual(calls.setMastery, []);
    const toast = player.querySelector('div.rhs-toast');
    assert.ok(toast);
    assert.equal(toast.textContent, 'This chart has one difficulty');
    assert.ok(timers.delays().includes(4000));
    timers.fire(4000);
    assert.equal(player.querySelector('div.rhs-toast'), null);
    rt.dispose();
});

test('song:ready for a different song ends the session without mounting', () => {
    const { rt, fb, mounts, calls } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    fb.currentSong = { filename: 'other.psarc', arrangements: [] };
    fb.emit('song:ready', { hasPhraseData: true });
    assert.equal(mounts.length, 0);
    assert.equal(rt.phase(), 'idle');
    assert.deepEqual(calls.setMastery, [0.8], 'only the restore');
    rt.dispose();
});

test('drums only: plays the drum arrangement, mounts the stage (R10), pins the drum difficulty to #highway', () => {
    const { rt, fb, doc, calls, mounts, loadSong, highwayCanvas } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith({ guitar: { on: false }, drums: { difficulty: 'hard' } }) });
    assert.deepEqual(calls.playSong, [['Beat.sloppak', 1]]);
    loadSong(DRUM_ITEM);
    assert.equal(mounts.length, 1, 'drums alone gets a stage');
    assert.deepEqual(calls.setMastery, [], 'no guitar mastery when guitar is off');
    assert.deepEqual(calls.setDifficulty, [['hard', highwayCanvas]]);
    const fresh = doc.createElement('canvas');
    fb.emit('highway:canvas-replaced', { oldCanvas: highwayCanvas, newCanvas: fresh });
    assert.deepEqual(calls.setDifficulty.at(-1), ['hard', fresh]);
    fb.emit('song:stop', {});
    assert.ok(calls.clearDifficulty.includes(highwayCanvas));
    const n = calls.setDifficulty.length;
    fb.emit('highway:canvas-replaced', { oldCanvas: fresh, newCanvas: doc.createElement('canvas') });
    assert.equal(calls.setDifficulty.length, n, 'listener removed at teardown');
    rt.dispose();
});

test('song:ended holds auto-exit and shows the results; Next song releases once and shows the band screen', () => {
    const { rt, fb, calls, mounts, loadSong, timers, player } = setup();
    rt.startSession({ song: { ...ITEM, title: 'Everlong', artist: 'Foo Fighters' }, prefs: prefsWith() });
    loadSong(ITEM);
    fb.emit('song:ended', {});
    assert.equal(calls.hold, 1);
    assert.equal(calls.release, 0);
    assert.equal(rt.phase(), 'ending');
    const results = player.querySelector('.rhs-results');
    assert.ok(results, 'the results show in #player');
    assert.equal(results.querySelector('.rhs-results-sub').textContent, 'Everlong · Foo Fighters');
    assert.deepEqual(results.querySelectorAll('.rhs-card').map((c) => c.getAttribute('data-part')), ['guitar'], 'ITEM has no drum chart');
    assert.ok(!timers.delays().includes(1500), 'no 1.5 s exit');
    assert.equal(mounts[0].unmounted, 0, 'the stage stays under the results');
    rt.next();
    assert.equal(calls.release, 1);
    assert.equal(mounts[0].unmounted, 1);
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith']);
    assert.equal(player.querySelector('.rhs-results'), null);
    assert.equal(rt.phase(), 'idle');
    rt.next();
    assert.equal(calls.release, 1, 'released once');
    fb.emit('song:ended', {});
    assert.equal(calls.hold, 1, 'no hold outside a session');
    rt.dispose();
});

test('the band screen is not re-shown when release already returned to it', () => {
    const { rt, fb, calls, loadSong, bandScreen } = setup();
    fb.holdAutoExit = () => () => {
        calls.release++;
        bandScreen.classList.add('active');
        fb.emit('screen:changing', { id: 'plugin-rockherosmith', from: 'player' });
    };
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    fb.emit('song:ended', {});
    rt.next();
    assert.equal(calls.release, 1);
    assert.deepEqual(calls.showScreen, []);
    rt.dispose();
});

test('Play again tears down and starts the same song with the same prefs', async () => {
    const { rt, fb, calls, mounts, loadSong, player } = setup();
    const prefs = prefsWith({ guitar: { arrangement: 'Bass', difficulty: 'hard' } });
    rt.startSession({ song: ITEM, prefs });
    loadSong(ITEM);
    fb.emit('song:ended', {});
    rt.again();
    assert.equal(calls.release, 0, 'the held exit is dropped, never released');
    assert.equal(mounts[0].unmounted, 1);
    assert.equal(player.querySelector('.rhs-results'), null);
    assert.deepEqual(calls.playSong, [['My%20Song.sloppak', 1], ['My%20Song.sloppak', 1]]);
    assert.deepEqual(calls.showScreen, []);
    assert.equal(rt.phase(), 'armed');
    loadSong(ITEM);
    assert.equal(rt.phase(), 'playing');
    assert.equal(mounts.length, 2);
    assert.equal(mounts[1].prefs.parts.guitar.difficulty, 'hard');
    assert.equal(calls.hold, 1);
    fb.emit('song:ended', {});
    assert.equal(calls.hold, 2, 'the replayed session ends with results too');
    assert.ok(player.querySelector('.rhs-results'));
    rt.dispose();
    assert.equal(player.querySelector('.rhs-results'), null);
});

test('a Play again whose playSong rejects warns and leaves the runtime idle', async () => {
    const { rt, fb, win, loadSong } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    fb.emit('song:ended', {});
    win.playSong = () => Promise.reject(new Error('load failed'));
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a);
    try {
        rt.again();
        await flush();
    } finally { console.warn = warn; }
    assert.equal(rt.phase(), 'idle');
    assert.ok(warns.some((a) => a.some((x) => x instanceof Error && /load failed/.test(x.message))));
    rt.dispose();
});

test('leaving while the results show tears down without releasing', () => {
    for (const leave of [
        (e) => e.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' }),
        (e) => e.fb.emit('song:loading', { filename: 'next.psarc' }),
        (e) => e.fb.emit('song:stop', {}),
    ]) {
        const env = setup();
        env.rt.startSession({ song: ITEM, prefs: prefsWith() });
        env.loadSong(ITEM);
        env.fb.emit('song:ended', {});
        assert.ok(env.player.querySelector('.rhs-results'));
        leave(env);
        assert.equal(env.rt.phase(), 'idle');
        assert.equal(env.calls.release, 0);
        assert.equal(env.mounts[0].unmounted, 1);
        assert.equal(env.player.querySelector('.rhs-results'), null);
        assert.deepEqual(env.calls.showScreen, []);
        env.rt.next();
        env.rt.again();
        assert.equal(env.calls.release, 0);
        assert.equal(env.calls.playSong.length, 1);
        env.rt.dispose();
    }
});

test('leaving the player ends the session and restores mastery and the splitscreen pref', () => {
    const { rt, fb, calls, mounts, storage, loadSong } = setup({ storageInit: { splitscreenActive: 'true' } });
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'expert' } }) });
    loadSong(ITEM);
    assert.equal(storage.getItem('splitscreenActive'), 'false');
    fb.emit('screen:changing', { id: 'player', from: 'player' });
    assert.equal(mounts[0].unmounted, 0, 'staying on the player keeps the session');
    fb.emit('screen:changing', { id: 'v3-songs', from: 'player' });
    assert.equal(mounts[0].unmounted, 1);
    assert.deepEqual(calls.setMastery, [1, 0.8]);
    assert.equal(storage.getItem('splitscreenActive'), 'true');
    assert.equal(calls.splitStart, 0);
    assert.equal(rt.phase(), 'idle');
    rt.dispose();
});

test('a null splitscreen pref is removed again on teardown', () => {
    const { rt, fb, storage, loadSong } = setup({ storageInit: {} });
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    assert.equal(storage.getItem('splitscreenActive'), 'false');
    fb.emit('song:stop', {});
    assert.equal(storage.has('splitscreenActive'), false);
    rt.dispose();
});

test('mastery falls back to /api/settings when the slider is missing', async () => {
    const { rt, fb, calls, loadSong } = setup({ slider: null, settings: { master_difficulty: 60 } });
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'hard' } }) });
    await flush();
    assert.deepEqual(calls.fetch, ['/api/settings']);
    loadSong(ITEM);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.setMastery, [0.75, 0.6]);
    rt.dispose();
});

// Splitscreen's real start/stop shape: start() flips active and announces
// panels-changed while still _starting, so stop() then only defers (persists
// 'false' and stops once start finishes, without another event).
function fakeSplitscreen(env) {
    const ss = { active: false, starting: false, stopAfterStart: false, starts: 0, stops: 0 };
    ss.isActive = () => ss.active;
    ss.stop = () => {
        ss.stops++;
        if (ss.starting) { env.storage.setItem('splitscreenActive', 'false'); ss.stopAfterStart = true; return; }
        if (!ss.active) return;
        env.storage.setItem('splitscreenActive', 'false');
        ss.active = false;
    };
    ss.start = () => {
        ss.starts++;
        ss.starting = true;
        ss.active = true;
        env.fb.emit('splitscreen:panels-changed', {});
        ss.starting = false;
        if (ss.stopAfterStart) { ss.stopAfterStart = false; ss.active = false; }
    };
    env.win.slopsmithSplitscreen = ss;
    return ss;
}

test('a saved splitscreen pref does not auto-start splitscreen on the band song', () => {
    const env = setup({ storageInit: { splitscreenActive: 'true' } });
    const { rt, win, storage, mounts, loadSong } = env;
    const ss = fakeSplitscreen(env);
    const play = win.playSong;
    let wasActive = null;
    // Splitscreen's playSong wrapper reads the stored pref, then starts on ready.
    win.playSong = (f, a) => { wasActive = storage.getItem('splitscreenActive') === 'true'; return play(f, a); };
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    if (wasActive) ss.start();
    assert.equal(wasActive, false);
    assert.equal(ss.starts, 0);
    assert.equal(rt.phase(), 'playing');
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].unmounted, 0);
    assert.equal(rt.isMounted(), true);
    env.fb.emit('song:stop', {});
    assert.equal(storage.getItem('splitscreenActive'), 'true', 'the saved pref comes back at teardown');
    rt.dispose();
});

test('Always Split starting after mount is stopped and the stage remounted', () => {
    const env = setup();
    const { rt, mounts, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    ss.start();
    assert.equal(ss.stops, 1);
    assert.equal(rt.phase(), 'playing');
    assert.equal(mounts[0].unmounted, 1, 'the stage yields while splitscreen is up');
    timers.fire(50);
    assert.equal(mounts.length, 2, 'remounted once splitscreen is down');
    assert.equal(mounts[1].unmounted, 0);
    assert.equal(rt.isMounted(), true);
    env.fb.emit('splitscreen:panels-changed', {}); // inactive: a rename etc.
    assert.equal(rt.phase(), 'playing');
    rt.dispose();
});

test('splitscreen starting before song:ready delays the mount until it is down', () => {
    const env = setup();
    const { rt, mounts, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    // Stays up a while: active until the stop is honoured on a later tick.
    ss.stop = () => { ss.stops++; };
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    ss.active = true;
    env.fb.emit('splitscreen:panels-changed', {});
    env.fb.emit('splitscreen:panels-changed', {}); // same start, announced again
    assert.equal(ss.stops, 1);
    loadSong(ITEM);
    assert.equal(mounts.length, 0, 'no mount while splitscreen is up');
    timers.fire(50);
    assert.equal(mounts.length, 0);
    ss.active = false;
    timers.fire(50);
    assert.equal(mounts.length, 1);
    assert.equal(rt.phase(), 'playing');
    rt.dispose();
});

test('splitscreen starting a third time in one session ends it with a warning', () => {
    const env = setup();
    const { rt, mounts, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
        rt.startSession({ song: ITEM, prefs: prefsWith() });
        loadSong(ITEM);
        ss.start(); timers.fire(50);
        ss.start(); timers.fire(50);
        assert.equal(rt.phase(), 'playing');
        assert.equal(mounts.length, 3);
        ss.start();
    } finally {
        console.warn = warn;
    }
    assert.equal(rt.phase(), 'idle');
    assert.ok(mounts.every((m) => m.unmounted === 1));
    assert.ok(warns.some((w) => /splitscreen keeps starting/.test(w)));
    rt.dispose();
});

test('mastery is restored from the slider as it is at teardown', () => {
    const { rt, fb, doc, calls, loadSong } = setup({ slider: '80' });
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'easy' } }) });
    loadSong(ITEM);
    doc.getElementById('mastery-slider').value = '40'; // the user moved it mid-song
    fb.emit('song:stop', {});
    assert.deepEqual(calls.setMastery, [0.25, 0.4]);
    rt.dispose();
});

test('a missing master_difficulty restores full mastery', async () => {
    const { rt, fb, calls, loadSong } = setup({ slider: null, settings: {} });
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'hard' } }) });
    await flush();
    loadSong(ITEM);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.setMastery, [0.75, 1]);
    rt.dispose();
});

test('a late playSong rejection does not tear down a playing session', async () => {
    const { rt, win, fb, calls, mounts, loadSong } = setup();
    let reject;
    win.playSong = (f, i) => { calls.playSong.push([f, i]); return new Promise((_, r) => { reject = r; }); };
    const started = rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    reject(new Error('late failure'));
    await assert.rejects(started, /late failure/);
    assert.equal(rt.phase(), 'playing');
    assert.equal(mounts[0].unmounted, 0);
    assert.equal(fb._nextReturnScreen, 'plugin-rockherosmith', 'a started song keeps its origin');
    rt.dispose();
});

test('a failed Go clears the return screen it set', async () => {
    const { rt, win, fb } = setup();
    win.playSong = () => Promise.reject(new Error('load failed'));
    await assert.rejects(rt.startSession({ song: ITEM, prefs: prefsWith() }), /load failed/);
    assert.equal(fb._nextReturnScreen, null);
    rt.dispose();
});

test('drum sound mode falls back to song when the picked song has no drum stem', () => {
    const { rt, mounts, loadSong } = setup();
    const item = { ...DRUM_ITEM, stem_ids: ['guitar'] };
    rt.startSession({ song: item, prefs: prefsWith({ drums: { soundMode: 'rockband' } }) });
    loadSong(item);
    assert.equal(mounts[0].prefs.parts.drums.soundMode, 'song');
    rt.dispose();
    const b = setup();
    const withStem = { ...DRUM_ITEM, stem_ids: ['drums'] };
    b.rt.startSession({ song: withStem, prefs: prefsWith({ drums: { soundMode: 'kit' } }) });
    b.loadSong(withStem);
    assert.equal(b.mounts[0].prefs.parts.drums.soundMode, 'kit');
    b.rt.dispose();
});

test('dispose ends a running session and removes every listener', () => {
    const { rt, fb, calls, mounts, loadSong, storage } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    rt.dispose();
    assert.equal(mounts[0].unmounted, 1);
    assert.equal(storage.getItem('splitscreenActive'), 'true');
    assert.equal(rt.phase(), 'idle');
    const masteryCalls = calls.setMastery.length;
    fb.emit('song:ended', {});
    fb.emit('song:ready', { hasPhraseData: true });
    fb.emit('song:stop', {});
    assert.equal(calls.hold, 0);
    assert.equal(mounts.length, 1);
    assert.equal(calls.setMastery.length, masteryCalls);
});

test('a failed playSong rejects startSession and returns the runtime to idle', async () => {
    for (const fail of [
        () => Promise.reject(new Error('load failed')),
        () => { throw new Error('sync failure'); },
    ]) {
        const { rt, win, calls } = setup();
        const real = win.playSong;
        win.playSong = (f, i) => { calls.playSong.push([f, i]); return fail(); };
        await assert.rejects(rt.startSession({ song: ITEM, prefs: prefsWith() }), /failure|failed/);
        assert.equal(rt.phase(), 'idle');
        win.playSong = real;
        const again = rt.startSession({ song: ITEM, prefs: prefsWith() });
        assert.equal(await again, true, 'the next Go starts');
        assert.equal(rt.phase(), 'armed');
        rt.dispose();
    }
});

// ── Effective parts: a part plays only when it is on AND the song has its chart ──

test('a drum-only pack with default prefs is a drums-only session', () => {
    const { rt, calls, mounts, loadSong, highwayCanvas } = setup();
    const kit = { filename: 'Kit.sloppak', arrangements: [{ index: 0, name: 'Drums' }] };
    rt.startSession({ song: kit, prefs: prefsWith() });
    assert.deepEqual(calls.playSong, [['Kit.sloppak', 0]]);
    loadSong(kit);
    assert.equal(mounts.length, 1, 'drums alone gets a stage');
    assert.equal(mounts[0].prefs.parts.guitar.on, false, 'no guitar lane for a song with no guitar part');
    assert.deepEqual(calls.setMastery, [], 'no guitar mastery');
    assert.deepEqual(calls.setDifficulty, [['medium', highwayCanvas]]);
    assert.deepEqual(calls.setViz, [], 'a Drums arrangement needs no view switch');
    rt.dispose();
});

test('guitar set to Bass on a song with no Bass plays the Lead index', () => {
    const { rt, calls } = setup();
    const song = { filename: 'g.sloppak', arrangements: [{ index: 0, name: 'Rhythm' }, { index: 2, name: 'Lead' }] };
    rt.startSession({ song, prefs: prefsWith({ guitar: { arrangement: 'Bass' } }) });
    assert.deepEqual(calls.playSong, [['g.sloppak', 2]]);
    rt.dispose();
});

test('vocals on with no vocal pitch is ignored', async () => {
    const { rt, calls, mounts, loadSong, storage } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith({ vocals: { on: true, deviceId: 'usb-mic' } }) });
    loadSong(ITEM);
    await flush();
    assert.equal(mounts[0].prefs.parts.vocals.on, false);
    assert.equal(mounts[0].prefs.parts.drums.on, false, 'drums has no chart on this song either');
    assert.equal(storage.getItem('lyrics_karaoke.deviceId'), null, 'karaoke mic left alone');
    rt.dispose();
    assert.deepEqual(calls.karaoke, [], 'karaoke never called');
});

test('drums only plays the drum arrangement index, not its list position', () => {
    const { rt, calls } = setup();
    const song = { filename: 'd.sloppak', arrangements: [{ index: 0, name: 'Lead' }, { index: 2, name: 'Drums' }] };
    rt.startSession({ song, prefs: prefsWith({ guitar: { on: false } }) });
    assert.deepEqual(calls.playSong, [['d.sloppak', 2]]);
    rt.dispose();
});

const TAB = { filename: 'deep.feedpak', has_drum_tab: true,
    arrangements: [{ index: 0, name: 'Lead' }, { index: 1, name: 'Bass' }] };

// Watches every write to the saved view.
function trackViz(storage) {
    const writes = [];
    const set = storage.setItem, remove = storage.removeItem;
    storage.setItem = (k, v) => { if (k === 'vizSelection') writes.push(['set', v]); set(k, v); };
    storage.removeItem = (k) => { if (k === 'vizSelection') writes.push(['remove']); remove(k); };
    return writes;
}

test('drums only on a drum-tab-only pack installs the drums renderer on song:ready without saving it', () => {
    const { rt, fb, win, calls, mounts, loadSong, highwayCanvas, storage } = setup({
        storageInit: { splitscreenActive: 'true', vizSelection: 'highway_3d' } });
    const installed = [];
    const drumsRenderer = { draw() {} };
    win.feedBackViz_drums = () => drumsRenderer;
    win.highway.setRenderer = (r) => installed.push(r);
    const writes = trackViz(storage);
    rt.startSession({ song: TAB, prefs: prefsWith({ guitar: { on: false } }) });
    assert.deepEqual(calls.playSong, [['deep.feedpak', undefined]], 'any arrangement streams the drum tab');
    assert.deepEqual(installed, [], 'nothing before the band song is ready');
    loadSong(TAB);
    assert.equal(mounts.length, 1, 'drums alone gets a stage');
    assert.deepEqual(installed, [drumsRenderer], 'installed on song:ready');
    assert.deepEqual(calls.setViz, [], 'never through setViz, which saves the pick');
    assert.equal(storage.getItem('vizSelection'), 'highway_3d');
    assert.deepEqual(calls.setDifficulty, [['medium', highwayCanvas]]);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.setViz, ['highway_3d'], "the user's saved view is re-applied");
    assert.equal(storage.getItem('vizSelection'), 'highway_3d');
    assert.ok(writes.every((w) => w[0] === 'set' && w[1] === 'highway_3d'), JSON.stringify(writes));
    rt.dispose();
});

test('with no saved view, teardown re-applies the picker view and leaves nothing saved', () => {
    const { rt, fb, win, doc, calls, loadSong, storage } = setup();
    win.highway.setRenderer = () => {};
    const picker = doc.createElement('select');
    picker.id = 'viz-picker';
    picker.value = 'highway_3d';
    doc.body.appendChild(picker);
    rt.startSession({ song: TAB, prefs: prefsWith({ guitar: { on: false } }) });
    loadSong(TAB);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.setViz, ['highway_3d']);
    assert.equal(storage.getItem('vizSelection'), null, "never 'auto' or anything else");
    rt.dispose();
});

// ── Vocals: karaoke joins the band session ──

const PITCH_ITEM = { ...ITEM, filename: 'Sing.sloppak', has_vocal_pitch: true };
const SINGER = { on: true, difficulty: 'hard', hearMyself: false, deviceId: 'usb-mic' };
const names = (calls) => calls.karaoke.map((c) => c[0]);

test('Go with vocals arms difficulty and hear-myself before playSong', () => {
    const { rt, calls } = setup();
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    assert.deepEqual(calls.karaoke.slice(0, 2), [['setDifficulty', 'hard'], ['setHearMyself', false]]);
    assert.equal(calls.playSong.length, 1);
    assert.ok(calls.karaokeAt[1] < calls.playSongAt[0], 'armed before playSong');
    assert.ok(!names(calls).includes('setKaraokeMode'), 'karaoke mode waits for song:ready');
    rt.dispose();
});

test('song:ready hosts the strip in the stage slot, then starts the mic with the band mic', async () => {
    const { rt, calls, mounts, loadSong, storage } = setup();
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    assert.equal(mounts.length, 1);
    assert.ok(mounts[0].stripSlot);
    assert.deepEqual(calls.karaoke.slice(2), [['mountStrip', mounts[0].stripSlot], ['setKaraokeMode', true], ['startMic']]);
    assert.equal(storage.getItem('lyrics_karaoke.deviceId'), 'usb-mic');
    rt.dispose();
});

test('vocals alone is a session: no arrangement index, the stage mounts', async () => {
    const { rt, calls, mounts, loadSong } = setup();
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ guitar: { on: false }, drums: { on: false }, vocals: SINGER }) });
    assert.deepEqual(calls.playSong, [['Sing.sloppak', undefined]]);
    loadSong(PITCH_ITEM);
    await flush();
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].prefs.parts.vocals.on, true);
    assert.equal(rt.isMounted(), true);
    assert.ok(names(calls).includes('startMic'));
    rt.dispose();
});

test('teardown stops karaoke before the stage unmounts and clears every override', async () => {
    const { rt, fb, calls, mounts, loadSong } = setup();
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    const n = calls.karaoke.length;
    fb.emit('screen:changing', { id: 'v3-songs', from: 'player' });
    assert.deepEqual(calls.karaoke.slice(n), [
        ['stopMic'], ['setKaraokeMode', false], ['mountStrip', null], ['setDifficulty', null], ['setHearMyself', null],
    ]);
    assert.equal(mounts[0].unmounted, 1);
    assert.ok(calls.karaokeAt.slice(n).every((at) => at < mounts[0].unmountedAt), 'all before the stage unmounts');
    rt.dispose();
});

test('no karaoke plugin: vocals sits out and karaoke is never called', async () => {
    const { rt, calls, mounts, loadSong, storage } = setup({ karaoke: false });
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    assert.equal(mounts[0].prefs.parts.vocals.on, false);
    assert.equal(mounts[0].stripSlot, null);
    assert.deepEqual(calls.karaoke, []);
    assert.equal(storage.getItem('lyrics_karaoke.deviceId'), null);
    rt.dispose();
});

// Vocals only plays at Go when the library item has_vocal_pitch, so a refused
// karaoke mode is a failure, not a missing chart.
test('karaoke mode refused for a song the library lists with pitch: "Vocals couldn\'t start", no mic', async () => {
    const { rt, calls, loadSong, player } = setup({ karaokePitch: false });
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    const toasts = player.querySelectorAll('div.rhs-toast').map((t) => t.textContent);
    assert.deepEqual(toasts, ["Vocals couldn't start"]);
    assert.ok(!names(calls).includes('startMic'));
    rt.dispose();
});

test('karaoke\'s mic failing to start (no mic picked, denied) says "Vocals couldn\'t start"', async () => {
    const { rt, win, calls, loadSong, player } = setup();
    win.lyricsKaraoke.startMic = () => { calls.karaoke.push(['startMic']); return Promise.resolve('error'); };
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    assert.ok(names(calls).includes('startMic'));
    const toasts = player.querySelectorAll('div.rhs-toast').map((t) => t.textContent);
    assert.deepEqual(toasts, ["Vocals couldn't start"]);
    rt.dispose();
});

test('the stage failing to mount with vocals armed says "Vocals couldn\'t start" and opens no mic', async () => {
    const { rt, calls, loadSong, player } = setup({ mountFails: true });
    const error = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    try {
        rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
        loadSong(PITCH_ITEM);
    } finally {
        console.error = error;
    }
    await flush();
    assert.ok(errors.some((e) => /stage failed to mount/.test(e)));
    const toasts = player.querySelectorAll('div.rhs-toast').map((t) => t.textContent);
    assert.deepEqual(toasts, ["Vocals couldn't start"]);
    assert.ok(!names(calls).includes('startMic'));
    rt.dispose();
});

test('the stage failing to mount without vocals shows no vocals toast', () => {
    const { rt, loadSong, player } = setup({ mountFails: true });
    const error = console.error;
    console.error = () => {};
    try {
        rt.startSession({ song: ITEM, prefs: prefsWith() });
        loadSong(ITEM);
    } finally {
        console.error = error;
    }
    const toasts = player.querySelectorAll('div.rhs-toast').map((t) => t.textContent);
    assert.ok(!toasts.includes("Vocals couldn't start"), JSON.stringify(toasts));
    rt.dispose();
});

test('leaving the player while karaoke is loading never opens the mic', async () => {
    const { rt, fb, win, calls, loadSong } = setup();
    let resolve;
    const real = win.lyricsKaraoke.setKaraokeMode;
    win.lyricsKaraoke.setKaraokeMode = (on) => {
        real(on);
        return on ? new Promise((r) => { resolve = r; }) : Promise.resolve(false);
    };
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    assert.equal(typeof resolve, 'function', 'karaoke mode requested');
    fb.emit('screen:changing', { from: 'player', id: 'v3-songs' });
    resolve(true);
    await flush();
    assert.ok(!names(calls).includes('startMic'));
    assert.deepEqual(calls.karaoke.at(-1), ['setKaraokeMode', false], 'karaoke mode not left on');
    rt.dispose();
});

test('a splitscreen remount re-hosts the strip in the new slot', async () => {
    const env = setup();
    const { rt, calls, mounts, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    ss.start();
    timers.fire(50);
    assert.equal(mounts.length, 2);
    const strips = calls.karaoke.filter((c) => c[0] === 'mountStrip');
    assert.equal(strips.at(-1)[1], mounts[1].stripSlot);
    assert.notEqual(mounts[1].stripSlot, mounts[0].stripSlot);
    rt.dispose();
});

test('drums alone with vocals: the stage mounts and the drum difficulty is pinned to #highway', async () => {
    const { rt, fb, calls, mounts, loadSong, highwayCanvas } = setup();
    const item = { ...DRUM_ITEM, filename: 'BeatSing.sloppak', has_vocal_pitch: true };
    rt.startSession({ song: item, prefs: prefsWith({ guitar: { on: false }, drums: { difficulty: 'hard' }, vocals: SINGER }) });
    assert.deepEqual(calls.playSong, [['BeatSing.sloppak', 1]], 'the drum arrangement on the main highway');
    loadSong(item);
    await flush();
    assert.equal(mounts.length, 1, 'the strip needs a stage');
    assert.equal(mounts[0].prefs.parts.guitar.on, false);
    assert.equal(mounts[0].prefs.parts.drums.on, true);
    assert.equal(mounts[0].prefs.parts.vocals.on, true);
    assert.deepEqual(calls.setDifficulty, [['hard', highwayCanvas]]);
    assert.ok(names(calls).includes('startMic'));
    fb.emit('song:stop', {});
    assert.equal(mounts[0].unmounted, 1);
    assert.ok(calls.clearDifficulty.includes(highwayCanvas));
    rt.dispose();
});

test("hear-myself off that karaoke didn't take: no mic, toast, overrides still cleared", async () => {
    for (const broken of [() => false, () => { throw new Error('boom'); }]) {
        const { rt, fb, win, calls, mounts, loadSong, player, storage } = setup();
        const real = win.lyricsKaraoke.setHearMyself;
        win.lyricsKaraoke.setHearMyself = (on) => { real(on); return on === false ? broken() : true; };
        const warns = [];
        const warn = console.warn;
        console.warn = (...a) => warns.push(a.join(' '));
        try {
            rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
        } finally {
            console.warn = warn;
        }
        assert.ok(warns.some((w) => /hear-myself off could not be applied/.test(w)));
        loadSong(PITCH_ITEM);
        await flush();
        assert.deepEqual(names(calls), ['setDifficulty', 'setHearMyself'], 'nothing past arming');
        assert.equal(mounts[0].prefs.parts.vocals.on, false, 'vocals sits out: no strip');
        assert.equal(storage.getItem('lyrics_karaoke.deviceId'), null, 'mic id never written');
        const toasts = player.querySelectorAll('div.rhs-toast').map((t) => t.textContent);
        assert.ok(toasts.includes("Vocals couldn't start"), JSON.stringify(toasts));
        fb.emit('song:stop', {});
        assert.deepEqual(calls.karaoke.slice(-3), [['mountStrip', null], ['setDifficulty', null], ['setHearMyself', null]]);
        rt.dispose();
    }
});

test('splitscreen still up at song:ready: vocals start once the stage mounts after it is down', async () => {
    const env = setup();
    const { rt, calls, mounts, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    ss.stop = () => { ss.stops++; };
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    ss.active = true;
    env.fb.emit('splitscreen:panels-changed', {});
    loadSong(PITCH_ITEM);
    await flush();
    assert.equal(mounts.length, 0);
    assert.ok(!names(calls).includes('setKaraokeMode'), 'nothing before the stage');
    ss.active = false;
    timers.fire(50);
    await flush();
    assert.equal(mounts.length, 1);
    assert.deepEqual(calls.karaoke.slice(2), [['mountStrip', mounts[0].stripSlot], ['setKaraokeMode', true], ['startMic']]);
    rt.dispose();
});

// ── Plan 4: scoring, the band HUD and the plugins' hide switches ──

const scoreText = (player) => {
    const el = player.querySelector('.rhs-hud-score');
    return el ? el.textContent : null;
};
const guitarHit = (extra = {}) => ({ isDefault: true, counted: true, hit: true, points: 50, multiplier: 1, streak: 1, ...extra });
const FULL_ITEM = { ...DRUM_ITEM, filename: 'Full.sloppak', has_vocal_pitch: true };

test('Go forces the song count-in, and teardown clears it', () => {
    const { rt, fb, calls, loadSong } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    assert.deepEqual(calls.countIn, [true]);
    assert.ok(calls.countInAt[0] < calls.playSongAt[0], 'forced before playSong');
    loadSong(ITEM);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.countIn, [true, null]);
    rt.dispose();
    assert.deepEqual(calls.countIn, [true, null], 'cleared once');
});

test("mount hides every plugin's own score display; leaving shows them again", () => {
    const { rt, fb, doc, calls, mounts, loadSong } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    assert.ok(doc.body.classList.contains('rhs-band-song'), 'set at session start, before any count-in');
    loadSong(DRUM_ITEM);
    const lane = mounts[0].drumCanvas;
    assert.ok(lane);
    assert.deepEqual(calls.hides, [['nd', true], ['drums', lane, true], ['scorecard', true]]);
    assert.ok(doc.body.classList.contains('rhs-band-song'));
    assert.ok(doc.getElementById('player').querySelector('.rhs-hud'), 'the band HUD is up');
    fb.emit('screen:changing', { id: 'v3-songs', from: 'player' });
    assert.deepEqual(calls.hides.slice(3).sort(), [['drums', lane, false], ['nd', false], ['scorecard', false]].sort());
    assert.equal(doc.body.classList.contains('rhs-band-song'), false);
    assert.equal(doc.getElementById('player').querySelector('.rhs-hud'), null);
    rt.dispose();
});

test('every way a session ends gives each display back and clears the count-in override', () => {
    const exits = {
        stop: (e) => e.fb.emit('song:stop', {}),
        leave: (e) => e.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' }),
        'new song': (e) => e.fb.emit('song:loading', { filename: 'next.psarc' }),
        'song end': (e) => { e.fb.emit('song:ended', {}); e.rt.next(); },
        'end then leave': (e) => { e.fb.emit('song:ended', {}); e.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' }); },
        dispose: (e) => e.rt.dispose(),
        'splitscreen thrice': (e) => {
            const ss = fakeSplitscreen(e);
            const warn = console.warn;
            console.warn = () => {};
            try { ss.start(); e.timers.fire(50); ss.start(); e.timers.fire(50); ss.start(); } finally { console.warn = warn; }
        },
    };
    for (const [name, exit] of Object.entries(exits)) {
        const env = setup();
        env.rt.startSession({ song: FULL_ITEM, prefs: prefsWith({ vocals: SINGER }) });
        env.fb.emit('count-in:tick', { n: 1, total: 4 });
        env.loadSong(FULL_ITEM, { hasPhraseData: false });
        assert.ok(env.player.querySelector('.rhs-toasts'), `${name}: a toast is up`);
        assert.ok(env.player.querySelector('.rhs-countin'), `${name}: the count-in is up`);
        assert.ok(env.calls.hides.some((h) => h[0] === 'karaoke' && h[1] === true), name);
        exit(env);
        assert.equal(env.rt.phase(), 'idle', name);
        const last = new Map();
        // The last call per switch (per canvas for drums).
        for (const h of env.calls.hides) last.set(h.length === 3 ? h[1] : h[0], h.at(-1));
        assert.ok(last.size >= 3, name);
        assert.ok([...last.values()].every((v) => v === false), `${name}: ${JSON.stringify([...last].map(([k, v]) => [typeof k === 'string' ? k : 'canvas', v]))}`);
        assert.equal(env.calls.countIn.at(-1), null, name);
        assert.equal(env.doc.body.classList.contains('rhs-band-song'), false, name);
        assert.equal(env.player.querySelector('.rhs-hud'), null, name);
        assert.equal(env.player.querySelector('.rhs-part-hud'), null, name);
        assert.equal(env.player.querySelector('.rhs-toasts'), null, `${name}: toasts cleared`);
        assert.equal(env.player.querySelector('.rhs-countin'), null, `${name}: count-in gone`);
        assert.equal(last.get('karaoke'), false, `${name}: karaoke's own HUD back`);
        env.rt.dispose();
    }
});

test('a failed mount or a failed Go still clears the count-in override and the body class', async () => {
    const a = setup({ mountFails: true });
    const error = console.error;
    console.error = () => {};
    try {
        a.rt.startSession({ song: ITEM, prefs: prefsWith() });
        a.loadSong(ITEM);
    } finally { console.error = error; }
    assert.deepEqual(a.calls.hides, [], 'no band HUD, so the plugins keep theirs');
    a.fb.emit('song:stop', {});
    assert.deepEqual(a.calls.countIn, [true, null]);
    assert.equal(a.doc.body.classList.contains('rhs-band-song'), false);
    a.rt.dispose();
    const b = setup();
    b.win.playSong = () => Promise.reject(new Error('load failed'));
    await assert.rejects(b.rt.startSession({ song: ITEM, prefs: prefsWith() }), /load failed/);
    assert.deepEqual(b.calls.countIn, [true, null]);
    assert.equal(b.doc.body.classList.contains('rhs-band-song'), false);
    b.rt.dispose();
});

test("a guitar hit from the default detector scores; a panel detector's doesn't", () => {
    const { rt, loadSong, player, fireWin } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    assert.equal(scoreText(player), '0');
    fireWin('notedetect:hit', guitarHit());
    assert.equal(scoreText(player), '50');
    fireWin('notedetect:hit', guitarHit({ isDefault: false }));
    assert.equal(scoreText(player), '50');
    fireWin('notedetect:hit', guitarHit({ counted: false }));
    assert.equal(scoreText(player), '50');
    rt.dispose();
});

test('a guitar judgment delivered twice (window, then bubbled from its instance root) counts once', () => {
    const { rt, loadSong, player, fireWin } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    const detail = guitarHit();
    fireWin('notedetect:hit', detail);
    fireWin('notedetect:hit', detail);
    assert.equal(scoreText(player), '50');
    const miss = { isDefault: true, counted: true, hit: false, points: 0, multiplier: 1, streak: 0 };
    fireWin('notedetect:miss', miss);
    fireWin('notedetect:miss', miss);
    assert.equal(rt.snapshot().parts.guitar.misses, 1);
    fireWin('notedetect:hit', guitarHit());
    assert.equal(scoreText(player), '100', 'a new judgment still scores');
    rt.dispose();
});

test("drums events score only from the band's drum canvas", () => {
    const { rt, fb, doc, mounts, loadSong, player, clock } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    const lane = mounts[0].drumCanvas;
    clock.t = 3;
    fb.emit('drums:hit', { canvas: doc.createElement('canvas'), points: 30, multiplier: 1, combo: 1 });
    assert.equal(scoreText(player), '0');
    fb.emit('drums:hit', { canvas: lane, points: 30, multiplier: 1, combo: 1, stars: 0.5 });
    assert.equal(scoreText(player), '30');
    fb.emit('drums:miss', { canvas: lane, multiplier: 1, combo: 0 });
    fb.emit('drums:overhit', { canvas: lane, multiplier: 1, combo: 0 });
    const d = rt.snapshot().parts.drums;
    assert.deepEqual([d.hits, d.misses, d.overhits, d.stars], [1, 1, 1, 0.5]);
    rt.dispose();
});

test('drums alone scores from #highway and follows its replacement, hiding the new canvas', () => {
    const { rt, fb, doc, calls, loadSong, player, highwayCanvas } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith({ guitar: { on: false } }) });
    loadSong(DRUM_ITEM);
    assert.deepEqual(calls.hides, [['drums', highwayCanvas, true], ['scorecard', true]], 'no guitar: note_detect untouched');
    fb.emit('drums:hit', { canvas: highwayCanvas, points: 20, multiplier: 1, combo: 1 });
    assert.equal(scoreText(player), '20');
    const fresh = doc.createElement('canvas');
    fb.emit('highway:canvas-replaced', { oldCanvas: highwayCanvas, newCanvas: fresh });
    assert.deepEqual(calls.hides.at(-1), ['drums', fresh, true]);
    fb.emit('drums:hit', { canvas: highwayCanvas, points: 20, multiplier: 1, combo: 2 });
    assert.equal(scoreText(player), '20', 'the old canvas is no longer the band one');
    fb.emit('drums:hit', { canvas: fresh, points: 20, multiplier: 1, combo: 2 });
    assert.equal(scoreText(player), '40');
    fb.emit('song:stop', {});
    const shown = calls.hides.filter((h) => h[0] === 'drums' && h[2] === false).map((h) => h[1]);
    assert.ok(shown.includes(highwayCanvas) && shown.includes(fresh), 'both canvases shown again');
    rt.dispose();
});

test("the drum lane's replaced canvas is hidden and becomes the band's", () => {
    const { rt, fb, doc, calls, mounts, loadSong, player } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    const lane = mounts[0].drumCanvas;
    const fresh = doc.createElement('canvas');
    // The real stage adopts the clone; the fake follows it.
    mounts[0].getDrumCanvas = () => fresh;
    fb.emit('highway:canvas-replaced', { oldCanvas: lane, newCanvas: fresh });
    assert.deepEqual(calls.hides.at(-1), ['drums', fresh, true]);
    fb.emit('drums:hit', { canvas: fresh, points: 25, multiplier: 1, combo: 1 });
    assert.equal(scoreText(player), '25');
    // A core swap the stage found without an announcement is hidden on first use.
    const quiet = doc.createElement('canvas');
    mounts[0].getDrumCanvas = () => quiet;
    fb.emit('drums:hit', { canvas: quiet, points: 25, multiplier: 1, combo: 2 });
    assert.deepEqual(calls.hides.at(-1), ['drums', quiet, true]);
    assert.equal(scoreText(player), '50');
    fb.emit('song:stop', {});
    const shown = calls.hides.filter((h) => h[0] === 'drums' && h[2] === false).map((h) => h[1]);
    for (const c of [lane, fresh, quiet]) assert.ok(shown.includes(c));
    rt.dispose();
});

test('karaoke phrases score with their totals', async () => {
    const { rt, fb, loadSong, player, clock } = setup();
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    clock.t = 12;
    fb.emit('karaoke:phrase', { phraseIndex: 0, rating: 'Great', accuracy: 0.9, points: 400, multiplier: 2, streak: 3, stars: 2.4 });
    assert.equal(scoreText(player), '400');
    const v = rt.snapshot().parts.vocals;
    assert.deepEqual([v.multiplier, v.streak, v.stars, v.hits], [2, 3, 2.4, 1]);
    fb.emit('karaoke:reset', { multiplier: 1, streak: 0, stars: 1.1 });
    const r = rt.snapshot().parts.vocals;
    assert.deepEqual([r.multiplier, r.streak, r.stars, r.score], [1, 0, 1.1, 400]);
    fb.emit('karaoke:reset', null);
    assert.equal(rt.snapshot().parts.vocals.stars, null);
    rt.dispose();
});

test("a backward seek rewinds the band score; a loop wrap doesn't", () => {
    const { rt, fb, loadSong, player, clock, fireWin } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    clock.t = 10;
    fireWin('notedetect:hit', guitarHit());
    clock.t = 20;
    fireWin('notedetect:hit', guitarHit({ points: 70, streak: 2 }));
    assert.equal(scoreText(player), '120');
    fb.emit('song:seek', { from: 20, to: 10.5, reason: 'loop-wrap' });
    assert.equal(scoreText(player), '120', 'a loop wrap stays cumulative');
    fb.emit('song:seek', { from: 20, to: 19.98 });
    assert.equal(scoreText(player), '120', 'within 50 ms is not a rewind');
    fb.emit('song:seek', { from: 20, to: 15 });
    assert.equal(scoreText(player), '50');
    fb.emit('song:seek', { from: 15, to: 30 });
    fb.emit('song:seek', { from: NaN, to: 0 });
    assert.equal(scoreText(player), '50', 'forward and malformed seeks keep the score');
    rt.dispose();
});

test("a seek rewinds the ledger before karaoke's reset applies, in either listener order", async () => {
    for (const karaokeFirst of [true, false]) {
        const { rt, fb, loadSong, clock } = setup();
        const onSeek = () => fb.emit('karaoke:reset', { multiplier: 1, streak: 0, stars: 0.3 });
        // Karaoke emits its reset from its own song:seek listener.
        if (karaokeFirst) fb.on('song:seek', onSeek);
        rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
        loadSong(PITCH_ITEM);
        await flush();
        if (!karaokeFirst) fb.on('song:seek', onSeek);
        clock.t = 10;
        fb.emit('karaoke:phrase', { rating: 'Good', accuracy: 0.8, points: 100, multiplier: 1, streak: 1, stars: 1 });
        clock.t = 20;
        fb.emit('karaoke:phrase', { rating: 'Great', accuracy: 0.9, points: 200, multiplier: 2, streak: 2, stars: 2 });
        fb.emit('song:seek', { from: 20, to: 15 });
        const v = rt.snapshot().parts.vocals;
        assert.deepEqual([v.score, v.multiplier, v.streak, v.stars], [100, 1, 0, 0.3], `karaokeFirst=${karaokeFirst}`);
        rt.dispose();
    }
});

test("judgments after the song ended don't score", () => {
    const { rt, fb, loadSong, player, mounts, fireWin } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fireWin('notedetect:hit', guitarHit());
    fb.emit('song:ended', {});
    assert.equal(rt.phase(), 'ending');
    fireWin('notedetect:hit', guitarHit());
    fb.emit('drums:hit', { canvas: mounts[0].drumCanvas, points: 30, multiplier: 1, combo: 1 });
    fb.emit('karaoke:phrase', { points: 100, multiplier: 1, streak: 1 });
    fb.emit('song:seek', { from: 20, to: 0 });
    assert.equal(scoreText(player), '50');
    assert.equal(rt.snapshot().score, 50);
    rt.dispose();
});

test('guitar star thresholds come from the filtered notes at the band mastery', () => {
    const a = setup();
    a.rt.startSession({ song: ITEM, prefs: prefsWith() });
    a.loadSong(ITEM);
    assert.equal(a.rt.snapshot().parts.guitar.stars, 0);
    a.rt.dispose();
    const b = setup();
    b.win.highway.getFilteredNotes = () => [];
    b.rt.startSession({ song: ITEM, prefs: prefsWith() });
    b.loadSong(ITEM);
    assert.equal(b.rt.snapshot().parts.guitar.stars, null);
    b.rt.dispose();
    // The band mastery is applied before the notes are read.
    const c = setup();
    let mastery = null;
    c.win.highway.setMastery = (f) => { mastery = f; };
    c.win.highway.getFilteredNotes = () => (mastery === 0.5 ? [{ t: 1 }] : []);
    c.rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'medium' } }) });
    c.loadSong(ITEM);
    assert.equal(c.rt.snapshot().parts.guitar.stars, 0);
    c.rt.dispose();
});

test('only the parts playing are in the band score', async () => {
    const { rt, loadSong } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(ITEM);
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar'], 'no drum chart, no vocal pitch');
    rt.dispose();
    assert.equal(rt.snapshot(), null, 'no session, no snapshot');
});

test("vocals that couldn't start leave the band, so they never pin it at ×1", async () => {
    const { rt, loadSong, player, fireWin } = setup({ karaokePitch: false });
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    assert.ok(rt.snapshot().parts.vocals);
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar']);
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 1, 'the strip HUD goes too');
    fireWin('notedetect:hit', guitarHit({ multiplier: 2, streak: 10 }));
    assert.equal(rt.snapshot().bandMultiplier, 2);
    assert.ok(Number.isFinite(rt.snapshot().parts.guitar.stars), 'guitar thresholds kept');
    rt.dispose();
});

test('a splitscreen remount keeps the score and re-hosts the HUD', () => {
    const env = setup();
    const { rt, mounts, loadSong, timers, player, fireWin } = env;
    const ss = fakeSplitscreen(env);
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fireWin('notedetect:hit', guitarHit({ multiplier: 2, streak: 12, points: 100 }));
    ss.start();
    timers.fire(50);
    assert.equal(mounts.length, 2);
    assert.equal(scoreText(player), '100');
    assert.equal(player.querySelectorAll('.rhs-hud').length, 1);
    const hud = mounts[1].laneSlot('guitar').querySelector('.rhs-part-hud');
    assert.ok(hud, 'the guitar lane HUD is in the new lane');
    assert.equal(hud.querySelector('.rhs-mult').textContent, '×2');
    assert.ok(mounts[1].laneSlot('drums').querySelector('.rhs-part-hud'));
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 2);
    assert.ok(env.calls.hides.some((h) => h[0] === 'drums' && h[1] === mounts[1].drumCanvas && h[2] === true),
        'the new drum lane canvas is hidden');
    rt.dispose();
});

test('toasts stack: one difficulty and no pitch both show', async () => {
    const { rt, loadSong, player } = setup({ karaokePitch: false });
    const item = { ...ITEM, filename: 'Sing2.sloppak', has_vocal_pitch: true };
    rt.startSession({ song: item, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(item, { hasPhraseData: false });
    await flush();
    const box = player.querySelector('.rhs-toasts');
    assert.ok(box);
    assert.deepEqual(box.querySelectorAll('div.rhs-toast').map((t) => t.textContent),
        ['This chart has one difficulty', "Vocals couldn't start"]);
    rt.dispose();
    assert.equal(player.querySelector('.rhs-toasts'), null, 'cleared at teardown');
});

test("the band's count-in shows over the player and goes at teardown", () => {
    const { rt, fb, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    fb.emit('count-in:tick', { n: 1, total: 4 });
    assert.equal(player.querySelector('.rhs-countin').textContent, '4', 'drawn before the stage mounts');
    loadSong(ITEM);
    fb.emit('count-in:tick', { n: 2, total: 4 });
    assert.equal(player.querySelector('.rhs-countin').textContent, '3');
    fb.emit('song:stop', {});
    assert.equal(player.querySelector('.rhs-countin'), null);
    fb.emit('count-in:tick', { n: 3, total: 4 });
    assert.equal(player.querySelector('.rhs-countin'), null, 'no longer listening');
    rt.dispose();
});

test('dispose removes every listener: a second runtime on the same bus scores once', () => {
    const env = setup();
    const { fb, win, loadSong, player, fireWin, mounts } = env;
    // Every listener a runtime holds on the bus and on window: [where, event, fn].
    let held = [];
    const track = (where, addFn, removeFn) => [
        (ev, fn, o) => { held.push([where, ev, fn]); addFn(ev, fn, o); },
        (ev, fn, o) => { held = held.filter((h) => !(h[0] === where && h[1] === ev && h[2] === fn)); removeFn(ev, fn, o); },
    ];
    [fb.on, fb.off] = track('bus', fb.on, fb.off);
    [win.addEventListener, win.removeEventListener] = track('win', win.addEventListener, win.removeEventListener);
    const live = { get size() { return held.length; }, [Symbol.iterator]: () => held.map((h) => h[0] + ':' + h[1])[Symbol.iterator]() };
    const first = env.makeRuntime();
    assert.ok(live.size > 0);
    first.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    first.dispose();
    assert.deepEqual([...live], [], 'nothing left listening');
    const second = env.makeRuntime();
    second.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fireWin('notedetect:hit', guitarHit());
    fb.emit('drums:hit', { canvas: mounts.at(-1).drumCanvas, points: 30, multiplier: 1, combo: 1 });
    assert.equal(second.snapshot().score, 80);
    assert.equal(first.snapshot(), null);
    assert.equal(player.querySelectorAll('.rhs-hud').length, 1, 'one band HUD');
    assert.equal(scoreText(player), '80');
    second.dispose();
    env.rt.dispose();
});

test('guitar star thresholds apply when the stage mounts after splitscreen went down', () => {
    const env = setup();
    const { rt, mounts, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    ss.stop = () => { ss.stops++; };
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    ss.active = true;
    env.fb.emit('splitscreen:panels-changed', {});
    loadSong(ITEM);
    assert.equal(mounts.length, 0);
    ss.active = false;
    timers.fire(50);
    assert.equal(mounts.length, 1);
    assert.equal(rt.snapshot().parts.guitar.stars, 0);
    rt.dispose();
});

test("the results show this session's numbers", () => {
    const { rt, fb, loadSong, player, fireWin, mounts } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fireWin('notedetect:hit', guitarHit());
    fb.emit('song:ended', {});
    const card = player.querySelector('.rhs-results').querySelector('.rhs-card[data-part="guitar"]');
    const stats = card.querySelectorAll('.rhs-stat').map((r) => r.children.map((c) => c.textContent));
    assert.ok(stats.some(([label, value]) => label === 'Notes hit' && value === '1 / 1'), JSON.stringify(stats));
    assert.equal(card.querySelector('.rhs-card-pct').textContent, '100%');
    assert.equal(player.querySelector('.rhs-results-score').textContent, '50');
    assert.ok(mounts[0].drumCanvas);
    rt.dispose();
});

test("the drums card reads star power phrases from the band's drum canvas", () => {
    const { rt, fb, win, loadSong, player, mounts } = setup();
    const asked = [];
    win.feedBackDrums.getInstanceState = (c) => {
        asked.push(c);
        return { starPower: { active: false, amount: 0, phrasesHit: 4, phrasesTotal: 5 } };
    };
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fb.emit('song:ended', {});
    assert.deepEqual(asked, [mounts[0].drumCanvas]);
    const stats = player.querySelector('.rhs-card[data-part="drums"]').querySelectorAll('.rhs-stat')
        .map((r) => r.children.map((c) => c.textContent));
    assert.ok(stats.some(([label, value]) => label === 'Star power phrases' && value === '4 / 5'), JSON.stringify(stats));
    rt.dispose();
});

test('a throwing getInstanceState still shows the results, without star power', () => {
    const { rt, fb, win, loadSong, player } = setup();
    win.feedBackDrums.getInstanceState = () => { throw new Error('boom'); };
    const warn = console.warn;
    console.warn = () => {};
    try {
        rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
        loadSong(DRUM_ITEM);
        fb.emit('song:ended', {});
    } finally { console.warn = warn; }
    const drums = player.querySelector('.rhs-card[data-part="drums"]');
    assert.ok(drums);
    assert.ok(!drums.querySelectorAll('.rhs-stat').some((r) => r.children[0].textContent === 'Star power phrases'));
    rt.dispose();
});

test('a session whose stage never mounted still ends on the results', () => {
    const { rt, fb, calls, loadSong, player } = setup({ mountFails: true });
    const error = console.error;
    console.error = () => {};
    try {
        rt.startSession({ song: ITEM, prefs: prefsWith() });
        loadSong(ITEM);
    } finally { console.error = error; }
    fb.emit('song:ended', {});
    const results = player.querySelector('.rhs-results');
    assert.ok(results);
    assert.equal(results.querySelector('.rhs-results-score').textContent, '0');
    assert.equal(results.querySelectorAll('.rhs-card').length, 0);
    rt.next();
    assert.equal(calls.release, 1);
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith']);
    rt.dispose();
});

test('results that cannot show fall through to Next song, so the held exit is released', () => {
    const { rt, fb, calls, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    player.remove();
    fb.emit('song:ended', {});
    assert.equal(rt.phase(), 'idle');
    assert.equal(calls.hold, 1);
    assert.equal(calls.release, 1);
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith']);
    rt.dispose();
});

test("results that cannot show return to the band screen without opening the pick", () => {
    let n = 0;
    const { rt, fb, calls, loadSong, player } = setup({ onShowBandScreen: () => { n++; } });
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    player.remove();
    fb.emit('song:ended', {});
    assert.equal(rt.phase(), 'idle');
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith']);
    assert.equal(n, 0, 'no user asked for Next song, so the library pick stays shut');
    rt.dispose();
});

// ── Parts that can't play leave the band (final review I1) ──

test('a drum lane that failed to start leaves the band: ×N from the other parts, no drums HUD or card', () => {
    const { rt, fb, loadSong, player, fireWin } = setup({ drumLane: false });
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar']);
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 1, 'no drums HUD');
    fireWin('notedetect:hit', guitarHit({ multiplier: 3, streak: 20 }));
    assert.equal(rt.snapshot().bandMultiplier, 3);
    fb.emit('song:ended', {});
    assert.deepEqual(player.querySelector('.rhs-results').querySelectorAll('.rhs-card').map((c) => c.getAttribute('data-part')), ['guitar']);
    rt.dispose();
});

test('drums alone with the drums plugin missing leaves the band', async () => {
    const { rt, win, loadSong, player } = setup();
    delete win.feedBackDrums;
    delete win.feedBackViz_drums;
    const item = { ...DRUM_ITEM, filename: 'BeatSing.sloppak', has_vocal_pitch: true };
    rt.startSession({ song: item, prefs: prefsWith({ guitar: { on: false }, vocals: SINGER }) });
    loadSong(item);
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['vocals']);
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 1, 'the strip HUD only');
    rt.dispose();
});

test('drums alone with the drums plugin present stays in the band', () => {
    const { rt, loadSong } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith({ guitar: { on: false } }) });
    loadSong(DRUM_ITEM);
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['drums']);
    rt.dispose();
});

test("vocals' mic failing after guitar judgments still drops vocals", async () => {
    const { rt, win, loadSong, player, fireWin } = setup();
    let fail;
    win.lyricsKaraoke.startMic = () => new Promise((r) => { fail = () => r('error'); });
    rt.startSession({ song: PITCH_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    fireWin('notedetect:hit', guitarHit({ multiplier: 2, streak: 10 }));
    assert.equal(rt.snapshot().bandMultiplier, 1, 'vocals still pins it while it may start');
    fail();
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar']);
    assert.equal(rt.snapshot().bandMultiplier, 2);
    assert.equal(rt.snapshot().parts.guitar.score, 50, 'the guitar judgment is kept');
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 1, 'the strip HUD goes');
    rt.dispose();
});

// ── Play again keeps the plugins' own HUDs hidden (final review M2) ──

test("Play again never shows the plugins' own HUDs between the two sessions", async () => {
    const { rt, fb, calls, loadSong } = setup();
    rt.startSession({ song: FULL_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(FULL_ITEM);
    await flush();
    fb.emit('song:ended', {});
    const n = calls.hides.length;
    rt.again();
    assert.ok(calls.hides.slice(n).every((h) => h.at(-1) === true), 'nothing shown again at the replay teardown');
    loadSong(FULL_ITEM);
    await flush();
    assert.ok(calls.hides.slice(n).every((h) => h.at(-1) === true), JSON.stringify(calls.hides.slice(n).map((h) => [h[0], h.at(-1)])));
    fb.emit('song:stop', {});
    const last = new Map();
    for (const h of calls.hides) last.set(h.length === 3 ? h[1] : h[0], h.at(-1));
    assert.ok([...last.values()].every((v) => v === false), 'a real exit still gives every display back');
    rt.dispose();
});

test('a Play again that fails to start still gives the displays back', async () => {
    const { rt, fb, win, calls, loadSong } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fb.emit('song:ended', {});
    win.playSong = () => Promise.reject(new Error('load failed'));
    const warn = console.warn;
    console.warn = () => {};
    try {
        rt.again();
        await flush();
    } finally { console.warn = warn; }
    assert.equal(rt.phase(), 'idle');
    const last = new Map();
    for (const h of calls.hides) last.set(h.length === 3 ? h[1] : h[0], h.at(-1));
    assert.ok(last.size >= 3);
    assert.ok([...last.values()].every((v) => v === false));
    rt.dispose();
});

test('stopVocals keepHud leaves karaoke\'s score HUD hidden for a replay', async () => {
    const { stopVocals } = await import('../src/vocals.js');
    const seen = [];
    const api = { stopMic() {}, setKaraokeMode: () => Promise.resolve(false), mountStrip() {}, setDifficulty() {}, setHearMyself() {},
        setScoreHudHidden: (v) => seen.push(v) };
    stopVocals(api, { keepHud: true });
    assert.deepEqual(seen, []);
    stopVocals(api);
    assert.deepEqual(seen, [false]);
});

test("a replay that doesn't arm karaoke again gives karaoke's HUD back", async () => {
    const { rt, fb, win, calls, loadSong } = setup();
    rt.startSession({ song: FULL_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(FULL_ITEM);
    await flush();
    fb.emit('song:ended', {});
    const karaoke = win.lyricsKaraoke;
    delete win.lyricsKaraoke;
    rt.again();
    assert.deepEqual(calls.hides.filter((h) => h[0] === 'karaoke').at(-1), ['karaoke', false]);
    win.lyricsKaraoke = karaoke;
    rt.dispose();
});

// ── Guitar scoring needs note_detect's detection on (final review M7) ──

const GUITARIST = { deviceKey: 'usb-guitar' };

test('a guitar input turns note_detect detection on at mount and silently off at teardown', () => {
    const { rt, fb, calls, loadSong } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: GUITARIST }) });
    assert.deepEqual(calls.nd, [], 'nothing before the stage mounts');
    loadSong(ITEM);
    assert.deepEqual(calls.nd, [['enable']]);
    const hiddenFirst = calls.hides.findIndex((h) => h[0] === 'nd' && h[1] === true);
    assert.ok(hiddenFirst >= 0, 'its HUD is hidden');
    fb.emit('song:stop', {});
    assert.deepEqual(calls.nd, [['enable'], ['disable', { silent: true }]], 'silent: never its summary');
    rt.dispose();
    assert.equal(calls.nd.length, 2);
});

test('no guitar input picked: note_detect is never enabled', () => {
    const { rt, fb, calls, loadSong } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.nd, []);
    rt.dispose();
});

test('note_detect already on: left on, never disabled by the band', () => {
    const { rt, fb, win, calls, loadSong } = setup();
    win.noteDetect.enabled = true;
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: GUITARIST }) });
    loadSong(ITEM);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.nd, []);
    assert.equal(win.noteDetect.enabled, true);
    rt.dispose();
});

test('guitar not playing: note_detect is never enabled', () => {
    const { rt, fb, calls, loadSong } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith({ guitar: { on: false, deviceKey: 'usb-guitar' } }) });
    loadSong(DRUM_ITEM);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.nd, []);
    rt.dispose();
});

test('a splitscreen remount does not enable twice; Play again enables once per session', () => {
    const env = setup();
    const { rt, fb, calls, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: GUITARIST }) });
    loadSong(ITEM);
    ss.start();
    timers.fire(50);
    assert.deepEqual(calls.nd, [['enable']]);
    fb.emit('song:ended', {});
    rt.again();
    loadSong(ITEM);
    assert.deepEqual(calls.nd, [['enable'], ['disable', { silent: true }], ['enable']]);
    rt.dispose();
    assert.deepEqual(calls.nd.at(-1), ['disable', { silent: true }]);
});

test('an enable that rejects is only warned about', async () => {
    const { rt, win, loadSong } = setup();
    win.noteDetect.enable = () => Promise.reject(new Error('no mic'));
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a);
    try {
        rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: GUITARIST }) });
        loadSong(ITEM);
        await flush();
    } finally { console.warn = warn; }
    assert.equal(rt.phase(), 'playing');
    assert.ok(warns.length >= 1);
    rt.dispose();
});

// ── Overdrive (plan 5 Task 10) ──

// Two phrases over nine notes (0..8), then a 12 s gap before the note at 20.
const OD_NOTES = [...Array.from({ length: 9 }, (_, i) => ({ t: i, s: 0, f: 3 })), { t: 20, s: 0, f: 3 }];
const OD_PHRASES = [{ start_time: 0, end_time: 4.5 }, { start_time: 4.5, end_time: 9 }];

function odSetup(opts) {
    const env = setup(opts);
    env.win.highway.getFilteredNotes = () => OD_NOTES;
    env.chart.phrases = OD_PHRASES;
    // Display time and chart time move together here.
    env.at = (t) => { env.clock.t = t; env.chart.t = t; };
    return env;
}

const odHud = (player, part) => {
    const hud = player.querySelectorAll('.rhs-part-hud').find((h) => h.getAttribute('data-part') === part);
    return hud ? hud.querySelector('.rhs-od').querySelector('i') : null;
};

// Nine hits clear both phrases; two ticks past them fill half a bar; three
// onsets in the gap deploy. Guitar overdrive is active from display time 11.5.
function deployGuitar(env) {
    const { fireWin, timers, at } = env;
    for (let i = 0; i < 9; i++) {
        at(i);
        fireWin('notedetect:hit', guitarHit({ noteTime: i, points: 100 }));
    }
    at(6);
    timers.fire(100);
    at(10);
    timers.fire(100);
    for (const t of [10.5, 11, 11.5]) {
        at(t);
        const onset = { t, midi: null, confidence: null, level: 0.3, source: 'level', isDefault: true };
        fireWin('notedetect:onset', onset);
        fireWin('notedetect:onset', onset);
    }
}

test('guitar overdrive doubles guitar points while active', () => {
    const env = odSetup();
    const { rt, loadSong, fireWin, at } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    deployGuitar(env);
    assert.equal(rt.snapshot().parts.guitar.deploys, 1, 'one deploy entry for three onsets each dispatched twice');
    assert.equal(rt.overdrive().guitar.active, true);
    at(12);
    const before = rt.snapshot().parts.guitar.score;
    fireWin('notedetect:hit', guitarHit({ noteTime: 20, points: 100 }));
    assert.equal(rt.snapshot().parts.guitar.score - before, 200);
    rt.dispose();
});

test('onsets before the bar is ready never deploy', () => {
    const env = odSetup();
    const { rt, loadSong, fireWin, at } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    for (const t of [10.5, 11, 11.5, 12]) {
        at(t);
        fireWin('notedetect:onset', { t, source: 'level', isDefault: true });
    }
    fireWin('notedetect:onset', { t: 12.5, source: 'level', isDefault: false });
    assert.equal(rt.snapshot().parts.guitar.deploys, 0);
    rt.dispose();
});

test('drums and vocals points are never doubled', () => {
    const env = odSetup();
    const { rt, fb, loadSong, mounts, at } = env;
    rt.startSession({ song: FULL_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(FULL_ITEM);
    deployGuitar(env);
    assert.equal(rt.overdrive().guitar.active, true, 'the band meter is active');
    at(12);
    const before = rt.snapshot().parts;
    fb.emit('drums:hit', { canvas: mounts[0].drumCanvas, points: 120, multiplier: 4, combo: 9, spActive: true });
    fb.emit('karaoke:phrase', { rating: 'Great', accuracy: 0.9, points: 1600, multiplier: 2, streak: 2 });
    const after = rt.snapshot().parts;
    assert.equal(after.drums.score - before.drums.score, 120);
    assert.equal(after.vocals.score - before.vocals.score, 1600);
    rt.dispose();
});

test('drums sp-activate and karaoke od-activate record deploys', () => {
    const env = odSetup();
    const { rt, fb, doc, loadSong, mounts } = env;
    rt.startSession({ song: FULL_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(FULL_ITEM);
    fb.emit('drums:sp-activate', { canvas: doc.createElement('canvas'), spActive: true, spAmount: 0.5 });
    assert.equal(rt.snapshot().parts.drums.deploys, 0, 'another canvas does nothing');
    fb.emit('drums:sp-activate', { canvas: mounts[0].drumCanvas, spActive: true, spAmount: 0.5 });
    fb.emit('karaoke:od-activate', { fill: 0.5, t: 3 });
    const parts = rt.snapshot().parts;
    assert.equal(parts.drums.deploys, 1);
    assert.equal(parts.vocals.deploys, 1);
    assert.equal(parts.guitar.deploys, 0);
    rt.dispose();
});

test('the tick mirrors drums and vocals bars', () => {
    const env = odSetup();
    const { rt, loadSong, mounts, player, timers, od } = env;
    const asked = [];
    od.drums = (c) => { asked.push(c); return { starPower: { amount: 0.5, active: false } }; };
    od.vocals = { fill: 0.25, active: false, ready: false };
    rt.startSession({ song: FULL_ITEM, prefs: prefsWith({ vocals: SINGER }) });
    loadSong(FULL_ITEM);
    timers.fire(100);
    assert.equal(odHud(player, 'drums').style.width, '50%');
    assert.equal(odHud(player, 'vocals').style.width, '25%');
    assert.ok(asked.length > 0 && asked.every((c) => c === mounts[0].drumCanvas), 'read from the band drum canvas');
    assert.ok(timers.delays().includes(100), 'the tick runs again');
    rt.dispose();
});

test('drums stars use the full chart after a seek (M6)', () => {
    const env = odSetup();
    const { rt, fb, loadSong, mounts, timers, od, at } = env;
    const full = [60, 120, 200, 450, 750, 1090];
    od.drums = { starPower: { amount: 0, active: false }, starThresholds: full };
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    timers.fire(100);
    at(3);
    fb.emit('drums:hit', { canvas: mounts[0].drumCanvas, points: 300, multiplier: 1, combo: 1, stars: 5 });
    fb.emit('song:seek', { from: 30, to: 20 });
    // The drums engine rebuilt from the seek: thresholds for the rest only.
    od.drums = { starPower: { amount: 0, active: false }, starThresholds: [6, 12, 20, 45, 75, 109] };
    at(20);
    timers.fire(100);
    assert.equal(rt.snapshot().parts.drums.stars, starsFromScore(300, full));
    rt.dispose();
});

test('rewinding restores the guitar bar', () => {
    const env = odSetup();
    const { rt, fb, loadSong, fireWin, timers, at } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    for (let i = 0; i < 5; i++) {
        at(i);
        fireWin('notedetect:hit', guitarHit({ noteTime: i }));
    }
    at(6);
    timers.fire(100);
    assert.equal(rt.overdrive().guitar.fill, 0.25, 'a gain');
    fb.emit('song:seek', { from: 30, to: 5 });
    at(5);
    assert.equal(rt.overdrive().guitar.fill, 0);
    rt.dispose();
});

test('a loop wrap keeps the guitar bar and reopens the looped phrases', () => {
    const env = odSetup();
    const { rt, fb, loadSong, fireWin, timers, at } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    for (let i = 0; i < 5; i++) {
        at(i);
        fireWin('notedetect:hit', guitarHit({ noteTime: i }));
    }
    at(6);
    timers.fire(100);
    fb.emit('song:seek', { from: 6, to: 0, reason: 'loop-wrap' });
    // Display time keeps moving across a wrap; the chart goes back.
    env.clock.t = 7;
    env.chart.t = 1;
    for (let i = 0; i < 5; i++) fireWin('notedetect:hit', guitarHit({ noteTime: i }));
    env.clock.t = 12;
    env.chart.t = 6;
    timers.fire(100);
    assert.equal(rt.overdrive().guitar.fill, 0.5, 'the reopened phrase earns again');
    rt.dispose();
});

test('teardown stops the overdrive tick', () => {
    const env = odSetup();
    const { rt, fb, loadSong, timers } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    assert.ok(timers.delays().includes(100));
    fb.emit('song:ended', {});
    rt.next();
    assert.ok(!timers.delays().includes(100));
    assert.equal(rt.overdrive(), null);
    rt.dispose();
});

test('splitscreen up at song:ready: overdrive starts once the stage mounts', () => {
    const env = odSetup();
    const { rt, loadSong, timers } = env;
    const ss = fakeSplitscreen(env);
    ss.stop = () => { ss.stops++; };
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    ss.active = true;
    env.fb.emit('splitscreen:panels-changed', {});
    loadSong(ITEM);
    assert.equal(rt.overdrive(), null, 'no ledger yet');
    ss.active = false;
    timers.fire(50);
    assert.ok(rt.overdrive(), 'started with the ledger');
    assert.deepEqual(timers.delays().filter((ms) => ms === 100), [100], 'one tick chain');
    rt.dispose();
});

// ── Fail mode (plan 5 Task 11) ──

const failPrefs = (opts) => ({ ...prefsWith(opts), failMode: 'fail' });
const guitarMiss = () => ({ isDefault: true, counted: true, hit: false, points: 0, multiplier: 1, streak: 0 });
const FAIL_CLAIM = 'rockherosmith:fail:guitar';
const capCalls = (calls, name, pred = () => true) => calls.caps.filter((c) => c[0] === name && pred(c[1])).map((c) => c[1]);
const stemsCommand = (calls, command) => capCalls(calls, 'dispatch', (r) => r.capability === 'stems' && r.command === command);
const toastTexts = (player) => player.querySelectorAll('div.rhs-toast').map((t) => t.textContent);
const partCallout = (player, part) => {
    const hud = player.querySelectorAll('.rhs-part-hud').find((h) => h.getAttribute('data-part') === part);
    return hud ? hud.querySelector('.rhs-callout').textContent : null;
};

// 14 guitar misses empty the crowd from its 0.66 start (−0.05 each), at display times from..from+13.
function dropGuitar(env, from = 1) {
    for (let i = 0; i < 14; i++) {
        env.clock.t = from + i;
        env.fireWin('notedetect:miss', guitarMiss());
    }
}

test('an empty crowd drops the player: grey lane, stem muted, toast', () => {
    const env = setup();
    const { rt, loadSong, mounts, calls, player } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    assert.equal(rt.snapshot().parts.guitar.failed, true);
    assert.ok(mounts[0].lanes.guitar.classList.contains('rhs-failed'));
    assert.equal(mounts[0].lanes.drums.classList.contains('rhs-failed'), false);
    assert.deepEqual(capCalls(calls, 'claim'), [{ capability: 'stems', claimId: FAIL_CLAIM, requester: 'rockherosmith' }]);
    assert.deepEqual(stemsCommand(calls, 'mute').map((r) => r.args), [{ id: 'guitar', claimId: FAIL_CLAIM }]);
    assert.ok(toastTexts(player).includes('Guitar dropped out: overdrive brings them back'));
    assert.equal(partCallout(player, 'guitar'), 'DROPPED OUT');
    assert.equal(rt.phase(), 'playing', 'drums still play');
    rt.dispose();
});

test("a bandmate's overdrive rescues them", async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls, player } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    fb.emit('drums:sp-activate', { canvas: mounts[0].drumCanvas, spActive: true, spAmount: 0.5 });
    assert.equal(mounts[0].lanes.guitar.classList.contains('rhs-failed'), false);
    assert.equal(rt.snapshot().parts.guitar.crowd, 0.4);
    assert.equal(partCallout(player, 'guitar'), 'SAVED!');
    await flush();   // the restore follows the mute's answer
    assert.deepEqual(stemsCommand(calls, 'restore').map((r) => r.args), [{ claimId: FAIL_CLAIM }]);
    assert.deepEqual(capCalls(calls, 'release'), [{ capability: 'stems', claimId: FAIL_CLAIM, requester: 'rockherosmith' }]);
    rt.dispose();
});

test('no fail never drops', () => {
    const env = setup();
    const { rt, loadSong, mounts, calls } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: { ...prefsWith(), failMode: 'nofail' } });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    assert.equal(rt.snapshot().parts.guitar.crowd, 0);
    assert.deepEqual(stemsCommand(calls, 'mute'), []);
    assert.deepEqual(capCalls(calls, 'claim'), []);
    assert.equal(mounts[0].lanes.guitar.classList.contains('rhs-failed'), false);
    rt.dispose();
});

test('everyone out: the song pauses and the results say Band failed', async () => {
    const env = setup();
    const { rt, loadSong, calls, player } = env;
    rt.startSession({ song: ITEM, prefs: failPrefs({ drums: { on: false } }) });
    loadSong(ITEM);
    dropGuitar(env);
    assert.equal(rt.phase(), 'ending');
    assert.deepEqual(capCalls(calls, 'dispatch', (r) => r.capability === 'playback'), [
        { capability: 'playback', command: 'pause', requester: 'rockherosmith', args: { requesterId: 'rockherosmith' } },
    ]);
    await flush();
    assert.equal(calls.audioPause, 0, "core's pause answered 'paused'");
    const results = player.querySelector('.rhs-results');
    assert.ok(results);
    assert.equal(results.querySelector('.rhs-results-failed').textContent, 'Band failed');
    assert.equal(calls.hold, 0, 'the song never ended: no exit is held');
    rt.dispose();
});

test("band failed: #audio pauses when core's pause doesn't answer 'paused' or there is no capability host", async () => {
    for (const opts of [{ pauseStatus: 'no-target' }, { caps: false }]) {
        const env = setup(opts);
        const { rt, loadSong, calls } = env;
        rt.startSession({ song: ITEM, prefs: failPrefs({ drums: { on: false } }) });
        loadSong(ITEM);
        dropGuitar(env);
        assert.equal(rt.phase(), 'ending');
        await flush();
        assert.equal(calls.audioPause, 1, JSON.stringify(opts));
        rt.dispose();
    }
});

test('after Band failed, Next song reaches the band screen and Play again replays, with no exit held', async () => {
    for (const exit of ['next', 'again']) {
        const env = setup();
        const { rt, loadSong, calls, player } = env;
        rt.startSession({ song: ITEM, prefs: failPrefs({ drums: { on: false } }) });
        loadSong(ITEM);
        dropGuitar(env);
        assert.equal(rt.phase(), 'ending');
        rt[exit]();
        await flush();
        assert.equal(calls.hold, 0, exit);
        assert.equal(calls.release, 0, `${exit}: no exit to release`);
        assert.equal(player.querySelector('.rhs-results'), null, exit);
        if (exit === 'next') {
            assert.deepEqual(calls.showScreen, ['plugin-rockherosmith']);
            assert.equal(rt.phase(), 'idle');
        } else {
            assert.deepEqual(calls.playSong, [['My%20Song.sloppak', 0], ['My%20Song.sloppak', 0]]);
            assert.equal(rt.phase(), 'armed');
            loadSong(ITEM);
            assert.equal(rt.phase(), 'playing', 'the replay plays');
            assert.equal(rt.snapshot().parts.guitar.failed, false, 'a fresh ledger');
        }
        rt.dispose();
    }
});

test('a seek back before the drop restores the player silently', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls, player } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    assert.ok(mounts[0].lanes.guitar.classList.contains('rhs-failed'));
    fb.emit('song:seek', { from: 20, to: 0.5 });
    assert.equal(rt.snapshot().parts.guitar.failed, false);
    assert.equal(mounts[0].lanes.guitar.classList.contains('rhs-failed'), false);
    assert.notEqual(partCallout(player, 'guitar'), 'SAVED!');
    await flush();   // the restore follows the mute's answer
    assert.deepEqual(stemsCommand(calls, 'restore').map((r) => r.args), [{ claimId: FAIL_CLAIM }]);
    assert.equal(capCalls(calls, 'release').length, 1);
    // Dropping again after the rewind claims and mutes again.
    dropGuitar(env, 21);
    assert.equal(stemsCommand(calls, 'mute').length, 2);
    rt.dispose();
});

test('every exit path releases the stem claim', async () => {
    const exits = {
        'Next song': (e) => { e.fb.emit('song:ended', {}); e.rt.next(); },
        'Play again': (e) => { e.fb.emit('song:ended', {}); e.rt.again(); },
        'song:stop': (e) => e.fb.emit('song:stop', {}),
        'screen:changing away': (e) => e.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' }),
    };
    for (const [name, exit] of Object.entries(exits)) {
        const env = setup();
        env.rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
        env.loadSong(DRUM_ITEM);
        dropGuitar(env);
        assert.equal(stemsCommand(env.calls, 'mute').length, 1, name);
        exit(env);
        await flush();
        assert.deepEqual(stemsCommand(env.calls, 'restore').map((r) => r.args), [{ claimId: FAIL_CLAIM }], name);
        assert.deepEqual(capCalls(env.calls, 'release'), [{ capability: 'stems', claimId: FAIL_CLAIM, requester: 'rockherosmith' }], name);
        const kinds = env.calls.caps.map((c) => c[0] + (c[1].command ? ':' + c[1].command : ''));
        assert.ok(kinds.indexOf('dispatch:restore') < kinds.indexOf('release'), `${name}: restore before release`);
        env.rt.dispose();
        await flush();
        assert.equal(capCalls(env.calls, 'release').length, 1, `${name}: released once`);
    }
});

test('a song without that stem still drops the player', () => {
    const env = setup({ stems: [] });
    const { rt, loadSong, mounts, calls } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    assert.ok(mounts[0].lanes.guitar.classList.contains('rhs-failed'));
    assert.deepEqual(calls.caps, []);
    rt.dispose();
});

test('a HUD remount keeps a dropped part greyed', async () => {
    const env = setup();
    const { rt, loadSong, player } = env;
    let fail;
    env.win.lyricsKaraoke.startMic = () => new Promise((r) => { fail = () => r('error'); });
    rt.startSession({ song: FULL_ITEM, prefs: failPrefs({ vocals: SINGER }) });
    loadSong(FULL_ITEM);
    await flush();
    dropGuitar(env);
    fail();
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar', 'drums'], 'vocals left the band');
    const hud = player.querySelectorAll('.rhs-part-hud').find((h) => h.getAttribute('data-part') === 'guitar');
    assert.ok(hud.classList.contains('rhs-failed'), 'the remounted HUD is greyed again');
    assert.equal(rt.phase(), 'playing');
    rt.dispose();
});

// Review carry-forward: dropPart can fail the band.
test('dropping the last part still alive fails the band', async () => {
    const env = setup();
    const { rt, loadSong, player, calls } = env;
    let fail;
    env.win.lyricsKaraoke.startMic = () => new Promise((r) => { fail = () => r('error'); });
    rt.startSession({ song: PITCH_ITEM, prefs: failPrefs({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    dropGuitar(env);
    assert.equal(rt.phase(), 'playing', 'vocals are still in');
    fail();
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar']);
    assert.equal(rt.phase(), 'ending');
    assert.equal(player.querySelector('.rhs-results-failed').textContent, 'Band failed');
    assert.equal(capCalls(calls, 'dispatch', (r) => r.capability === 'playback').length, 1);
    rt.dispose();
});

// Review carry-forward (ledger): dropPart keeps the deploys that took effect.
test("a dropped part's rescue stays: the rescued player is still in", async () => {
    const env = setup();
    const { rt, fb, loadSong, player, calls } = env;
    let fail;
    env.win.lyricsKaraoke.startMic = () => new Promise((r) => { fail = () => r('error'); });
    rt.startSession({ song: PITCH_ITEM, prefs: failPrefs({ vocals: SINGER }) });
    loadSong(PITCH_ITEM);
    await flush();
    dropGuitar(env);
    env.clock.t = 16;
    fb.emit('karaoke:od-activate', { fill: 0.5, t: 16 });
    assert.equal(rt.snapshot().parts.guitar.failed, false, 'rescued');
    fail();
    await flush();
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar']);
    assert.equal(rt.snapshot().parts.guitar.failed, false, 'still rescued after vocals left');
    assert.equal(rt.phase(), 'playing');
    const hud = player.querySelectorAll('.rhs-part-hud').find((h) => h.getAttribute('data-part') === 'guitar');
    assert.equal(hud.classList.contains('rhs-failed'), false);
    assert.equal(stemsCommand(calls, 'mute').length, 1, 'no new mute');
    rt.dispose();
});

// Review carry-forward (ledger): a failed part's streak resets and its deploy is ignored.
test("a dropped drummer's star power rescues nobody, and a rescue restarts the player at ×1", () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls, player } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    const lane = mounts[0].drumCanvas;
    fb.emit('drums:hit', { canvas: lane, points: 30, multiplier: 3, combo: 25 });
    assert.equal(rt.snapshot().parts.drums.multiplier, 3);
    for (let i = 0; i < 14; i++) fb.emit('drums:miss', { canvas: lane, multiplier: 1, combo: 0 });
    assert.equal(rt.snapshot().parts.drums.failed, true);
    assert.equal(rt.snapshot().parts.drums.streak, 0);
    assert.equal(rt.snapshot().parts.drums.multiplier, 1);
    assert.deepEqual(stemsCommand(calls, 'mute').map((r) => r.args.id), ['drums']);
    const before = partCallout(player, 'drums');
    fb.emit('drums:sp-activate', { canvas: lane, spActive: true, spAmount: 0.5 });
    assert.equal(rt.snapshot().parts.drums.failed, true, "its own deploy doesn't bring it back");
    assert.equal(rt.snapshot().parts.drums.deploys, 0);
    assert.equal(partCallout(player, 'drums'), before, 'no OVERDRIVE! on a dropped lane');
    assert.deepEqual(stemsCommand(calls, 'restore'), []);
    rt.dispose();
});

test("a dropped guitar's noodle never deploys", () => {
    const env = odSetup();
    const { rt, loadSong, fireWin, timers, at } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    // Two cleared phrases fill half a bar: ready.
    for (let i = 0; i < 9; i++) {
        at(i);
        fireWin('notedetect:hit', guitarHit({ noteTime: i, points: 100 }));
    }
    at(6);
    timers.fire(100);
    at(10);
    timers.fire(100);
    assert.equal(rt.overdrive().guitar.ready, true);
    // Nine hits lift the crowd to 0.84: 17 misses empty it.
    for (let i = 0; i < 17; i++) { at(10 + i * 0.01); fireWin('notedetect:miss', guitarMiss()); }
    assert.equal(rt.snapshot().parts.guitar.failed, true);
    for (const t of [10.5, 11, 11.5]) {
        at(t);
        fireWin('notedetect:onset', { t, midi: null, confidence: null, level: 0.3, source: 'level', isDefault: true });
    }
    assert.equal(rt.overdrive().guitar.active, false, 'the bar is not spent');
    assert.equal(rt.snapshot().parts.guitar.deploys, 0);
    assert.equal(rt.snapshot().parts.guitar.failed, true);
    rt.dispose();
});

// ── Final review fixes (plan 5) ──

// Fix 4: deploy handlers.
test('karaoke od-activate without a vocals part records and calls out nothing', () => {
    const env = odSetup();
    const { rt, fb, loadSong, player } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    fb.emit('karaoke:od-activate', { fill: 0.5, t: 16 });
    const parts = rt.snapshot().parts;
    assert.deepEqual(Object.keys(parts), ['guitar', 'drums']);
    assert.equal(parts.guitar.failed, true, 'a karaoke deploy outside the band rescues nobody');
    assert.equal(parts.drums.deploys, 0);
    assert.ok(!player.querySelectorAll('.rhs-callout').some((c) => c.textContent === 'OVERDRIVE!'));
    rt.dispose();
});

test('with no overdrive session, a drums deploy still rescues', (t) => {
    t.mock.method(console, 'warn', () => {});   // createOverdriveSession's throw is logged
    for (const by of ['drums', 'vocals']) {
        const env = setup();
        const { rt, fb, loadSong, mounts } = env;
        // Malformed beats: createOverdriveSession throws, so the band has no overdrive.
        env.chart.beats = new Proxy([], { get() { throw new Error('bad beats'); } });
        rt.startSession({ song: FULL_ITEM, prefs: failPrefs({ vocals: SINGER }) });
        loadSong(FULL_ITEM);
        assert.equal(rt.overdrive(), null, `${by}: no overdrive session`);
        dropGuitar(env);
        assert.equal(rt.snapshot().parts.guitar.failed, true, by);
        if (by === 'drums') fb.emit('drums:sp-activate', { canvas: mounts[0].drumCanvas, spActive: true, spAmount: 0.5 });
        else fb.emit('karaoke:od-activate', { fill: 0.5, t: 16 });
        assert.equal(rt.snapshot().parts[by].deploys, 1, by);
        assert.equal(rt.snapshot().parts.guitar.failed, false, `${by}: rescued`);
        rt.dispose();
    }
});

// Fix 5: each part's stem claim operations run in order. Stems mutes answer
// only when the test resolves them; everything else answers at once.
function holdMutes(env) {
    const held = [];
    const answer = env.fb.capabilities.dispatch;
    env.fb.capabilities.dispatch = (req) => {
        if (req.capability !== 'stems' || req.command !== 'mute') return answer(req);
        env.calls.caps.push(['dispatch', req]);
        return new Promise((r) => held.push(() => r({ outcome: 'handled', status: 'applied' })));
    };
    return held;
}
const capKinds = (calls) => calls.caps.map((c) => c[0] + (c[1].command ? ':' + c[1].command : ''));

test('fail → rescue while the mute is pending: restore is dispatched after the mute resolves', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    const held = holdMutes(env);
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    assert.equal(held.length, 1, 'the mute is in flight');
    fb.emit('drums:sp-activate', { canvas: mounts[0].drumCanvas, spActive: true, spAmount: 0.5 });
    assert.equal(rt.snapshot().parts.guitar.failed, false);
    await flush();
    assert.deepEqual(stemsCommand(calls, 'restore'), [], 'the restore waits for the mute');
    assert.deepEqual(capCalls(calls, 'release'), []);
    held[0]();
    await flush();
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    rt.dispose();
});

test('teardown while the mute is pending still restores and releases after it', async () => {
    const env = setup();
    const { rt, fb, loadSong, calls } = env;
    const held = holdMutes(env);
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    fb.emit('song:stop', {});
    assert.equal(rt.phase(), 'idle');
    await flush();
    assert.deepEqual(stemsCommand(calls, 'restore'), []);
    held[0]();
    await flush();
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    rt.dispose();
});

test("Play again while the mute is pending: the replay's mute follows the old restore and release", async () => {
    const env = setup();
    const { rt, fb, loadSong, calls } = env;
    const held = holdMutes(env);
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    fb.emit('song:ended', {});
    rt.again();
    loadSong(DRUM_ITEM);
    assert.equal(rt.phase(), 'playing');
    dropGuitar(env, 30);
    await flush();
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute'], 'everything waits for the first mute');
    held[0]();
    await flush();
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release', 'claim', 'dispatch:mute']);
    held[1]();
    rt.dispose();
    await flush();
    assert.deepEqual(capKinds(calls).slice(-2), ['dispatch:restore', 'release']);
});

// Parked T11 M3.
test('dispose() mid-song after a drop restores and releases', async () => {
    const env = setup();
    const { rt, loadSong, calls } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: failPrefs() });
    loadSong(DRUM_ITEM);
    dropGuitar(env);
    rt.dispose();
    await flush();
    assert.deepEqual(stemsCommand(calls, 'restore').map((r) => r.args), [{ claimId: FAIL_CLAIM }]);
    assert.deepEqual(capCalls(calls, 'release'), [{ capability: 'stems', claimId: FAIL_CLAIM, requester: 'rockherosmith' }]);
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
});

// Fix 6 (controller ruling): guitar onsets never deploy while the song is paused.
test('onsets while paused never deploy', () => {
    const env = odSetup();
    const { rt, fb, loadSong, fireWin, at } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    fb.isPlaying = false;
    deployGuitar(env);
    assert.equal(rt.snapshot().parts.guitar.deploys, 0);
    assert.equal(rt.overdrive().guitar.active, false, 'the bar is not spent');
    // Playing again: the gap's deploy is still there.
    fb.isPlaying = true;
    for (const t of [12, 12.5, 13]) {
        at(t);
        fireWin('notedetect:onset', { t, midi: null, confidence: null, level: 0.3, source: 'level', isDefault: true });
    }
    assert.equal(rt.snapshot().parts.guitar.deploys, 1);
    rt.dispose();
});

// Residual (re-review): in browser-audio mode feedBack.isPlaying can stay true
// across an ordinary pause, so a highway clock that stood still between the
// last two OD ticks also counts as paused.
function readyGuitar(env) {
    const { fireWin, at, timers } = env;
    for (let i = 0; i < 9; i++) {
        at(i);
        fireWin('notedetect:hit', guitarHit({ noteTime: i, points: 100 }));
    }
    at(6);
    timers.fire(100);
    at(10);
    timers.fire(100);
    assert.equal(env.rt.overdrive().guitar.ready, true);
}
const onsetAt = (env, t) => env.fireWin('notedetect:onset', { t, midi: null, confidence: null, level: 0.3, source: 'level', isDefault: true });

test('with isPlaying stuck true and the chart clock frozen across two ticks, onsets never deploy', () => {
    const env = odSetup();
    const { rt, fb, loadSong, clock, timers } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    readyGuitar(env);
    assert.equal(fb.isPlaying, true, 'core never flipped it');
    timers.fire(100);   // chart time still 10: paused
    for (const t of [10.5, 11, 11.5]) { clock.t = t; onsetAt(env, t); }
    assert.equal(rt.snapshot().parts.guitar.deploys, 0);
    assert.equal(rt.overdrive().guitar.active, false, 'the bar is not spent');
    rt.dispose();
});

test('with isPlaying true and the chart clock advancing, onsets still deploy', () => {
    const env = odSetup();
    const { rt, loadSong, at, timers } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    loadSong(ITEM);
    readyGuitar(env);
    at(10.2);
    timers.fire(100);
    for (const t of [10.5, 11, 11.5]) { at(t); onsetAt(env, t); }
    assert.equal(rt.snapshot().parts.guitar.deploys, 1);
    assert.equal(rt.overdrive().guitar.active, true);
    rt.dispose();
});

// ── Drum sound modes (plan 6 Task 3): My kit only holds the sound claim ──

const STEM_ITEM = { ...DRUM_ITEM, stem_ids: ['guitar', 'drums'] };
const SOUND_CLAIM = 'rockherosmith:sound:drums';
const isSound = (r) => !!r && (r.claimId === SOUND_CLAIM || !!(r.args && r.args.claimId === SOUND_CLAIM));
const soundCommand = (calls, command) => stemsCommand(calls, command).filter(isSound);
const soundCaps = (calls) => calls.caps.filter((c) => isSound(c[1]));
const kitPrefs = (drums = {}) => prefsWith({ drums: { soundMode: 'kit', ...drums } });

test('My kit only mutes the drum stem under its own claim', () => {
    const env = setup();
    const { rt, loadSong, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
    loadSong(STEM_ITEM);
    assert.deepEqual(capCalls(calls, 'claim', isSound), [{ capability: 'stems', claimId: SOUND_CLAIM, requester: 'rockherosmith' }]);
    assert.deepEqual(soundCommand(calls, 'mute').map((r) => r.args), [{ id: 'drums', claimId: SOUND_CLAIM }]);
    assert.deepEqual(rt.drumSound(), { mode: 'kit', muted: true });
    rt.dispose();
});

test('the stems graph arriving after song:ready still gets the mute', async () => {
    const ids = [];
    const env = setup({ stems: ids });
    const { rt, loadSong, calls, fireWin } = env;
    rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
    loadSong(STEM_ITEM);
    assert.deepEqual(stemsCommand(calls, 'mute'), [], 'no stems yet');
    ids.push('guitar', 'drums');
    fireWin('stems:state', { event: 'provider-ready', stemIds: ids });
    assert.equal(soundCommand(calls, 'mute').length, 1);
    fireWin('stems:state', { event: 'provider-ready', stemIds: ids });
    await flush();   // the forced re-mute queues behind the first one
    assert.equal(soundCommand(calls, 'mute').length, 2, 'a rebuilt graph is muted again');
    assert.deepEqual(soundCommand(calls, 'restore'), []);
    fireWin('stems:state', { event: 'state' });
    await flush();
    assert.equal(soundCaps(calls).length, 4, 'nothing more: two claims, two mutes');
    rt.dispose();
});

test('song drums never claim; nothing without a playing drums part', () => {
    const cases = [
        ['song', {}, prefsWith({ drums: { soundMode: 'song' } })],
        ['drums off', {}, kitPrefs({ on: false })],
        ['no drum lane', { drumLane: false }, kitPrefs()],
    ];
    for (const [name, opts, prefs] of cases) {
        const env = setup(opts);
        const { rt, loadSong, calls, fireWin } = env;
        rt.startSession({ song: STEM_ITEM, prefs });
        loadSong(STEM_ITEM);
        fireWin('stems:state', { event: 'provider-ready', stemIds: ['guitar', 'drums'] });
        assert.deepEqual(soundCaps(calls), [], name);
        assert.equal(rt.drumSound(), null, name);
        rt.dispose();
    }
});

test('no capability host or no drum stem: no dispatch, no throw', () => {
    {
        const env = setup({ caps: false });
        const { rt, loadSong, fireWin } = env;
        rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
        loadSong(STEM_ITEM);
        fireWin('stems:state', { event: 'provider-ready', stemIds: ['guitar', 'drums'] });
        assert.equal(rt.drumSound().muted, false);
        rt.dispose();
    }
    {
        const env = setup({ stems: ['guitar'] });
        const { rt, loadSong, calls } = env;
        rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
        loadSong(STEM_ITEM);
        assert.deepEqual(soundCaps(calls), []);
        rt.dispose();
    }
});

test('every exit path restores and releases the kit claim', async () => {
    const exits = {
        'Next song': (e) => { e.fb.emit('song:ended', {}); e.rt.next(); },
        'Play again': (e) => { e.fb.emit('song:ended', {}); e.rt.again(); },
        'song:stop': (e) => e.fb.emit('song:stop', {}),
        'screen:changing away': (e) => e.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' }),
        'song change': (e) => e.fb.emit('song:loading', { filename: 'next.psarc' }),
        'dispose()': (e) => e.rt.dispose(),
    };
    for (const [name, exit] of Object.entries(exits)) {
        const env = setup();
        env.rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
        env.loadSong(STEM_ITEM);
        assert.equal(soundCommand(env.calls, 'mute').length, 1, name);
        exit(env);
        await flush();
        assert.deepEqual(soundCommand(env.calls, 'restore').map((r) => r.args), [{ claimId: SOUND_CLAIM }], name);
        assert.deepEqual(capCalls(env.calls, 'release', isSound), [{ capability: 'stems', claimId: SOUND_CLAIM, requester: 'rockherosmith' }], name);
        const kinds = soundCaps(env.calls).map((c) => c[0] + (c[1].command ? ':' + c[1].command : ''));
        assert.ok(kinds.indexOf('dispatch:restore') < kinds.indexOf('release'), `${name}: restore before release`);
        assert.equal(env.rt.drumSound(), null, name);
        env.rt.dispose();
        await flush();
        assert.equal(capCalls(env.calls, 'release', isSound).length, 1, `${name}: released once`);
    }
});

test("Play again: the replay's kit mute follows the old restore and release", async () => {
    const env = setup();
    const { rt, fb, loadSong, calls } = env;
    const held = holdMutes(env);
    rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
    loadSong(STEM_ITEM);
    fb.emit('song:ended', {});
    rt.again();
    loadSong(STEM_ITEM);
    assert.equal(rt.phase(), 'playing');
    await flush();
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute'], 'everything waits for the first mute');
    held[0]();
    await flush();
    assert.deepEqual(capKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release', 'claim', 'dispatch:mute']);
    assert.deepEqual(rt.drumSound(), { mode: 'kit', muted: true });
    held[1]();
    rt.dispose();
    await flush();
    assert.deepEqual(capKinds(calls).slice(-2), ['dispatch:restore', 'release']);
});

test('pausing changes nothing', () => {
    const env = setup();
    const { rt, fb, loadSong, calls, timers } = env;
    rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
    loadSong(STEM_ITEM);
    fb.isPlaying = false;
    timers.fire(100);
    timers.fire(100);
    assert.deepEqual(soundCommand(calls, 'restore'), []);
    assert.equal(rt.drumSound().muted, true);
    rt.dispose();
});

// ── Task 3 review gaps ──

const FAIL_DRUMS = 'rockherosmith:fail:drums';
const isFailDrums = (r) => !!r && (r.claimId === FAIL_DRUMS || !!(r.args && r.args.claimId === FAIL_DRUMS));
const soundKinds = (calls) => soundCaps(calls).map((c) => c[0] + (c[1].command ? ':' + c[1].command : ''));
// 14 drums misses on the band's drum canvas, at display times from..from+13.
function dropDrums(env, from = 1) {
    for (let i = 0; i < 14; i++) {
        env.clock.t = from + i;
        env.fb.emit('drums:miss', { canvas: env.mounts[0].drumCanvas, multiplier: 1, combo: 0 });
    }
}

test('the band-failed ending keeps the kit claim until teardown', async () => {
    const env = setup();
    const { rt, loadSong, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: failPrefs({ drums: { soundMode: 'kit' } }) });
    loadSong(STEM_ITEM);
    dropGuitar(env);
    dropDrums(env, 15);
    assert.equal(rt.phase(), 'ending', 'band failed');
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute'], 'the results keep the claim');
    env.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' });
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    assert.equal(rt.drumSound(), null);
    rt.dispose();
});

test('a stems provider-ready while the results show or after teardown sends nothing', async () => {
    const env = setup();
    const { rt, fb, loadSong, calls, fireWin } = env;
    rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
    loadSong(STEM_ITEM);
    fb.emit('song:ended', {});
    assert.equal(rt.phase(), 'ending');
    fireWin('stems:state', { event: 'provider-ready', stemIds: ['guitar', 'drums'] });
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute'], 'results: nothing sent');
    rt.next();
    await flush();
    const after = soundKinds(calls);
    assert.deepEqual(after, ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    fireWin('stems:state', { event: 'provider-ready', stemIds: ['guitar', 'drums'] });
    await flush();
    assert.deepEqual(soundKinds(calls), after, 'after teardown: nothing sent');
    rt.dispose();
});

test('drums dropping out of the band mid-song release the sound claim', async () => {
    const env = setup();
    const { rt, loadSong, mounts, calls, timers } = env;
    const ss = fakeSplitscreen(env);
    rt.startSession({ song: STEM_ITEM, prefs: kitPrefs() });
    loadSong(STEM_ITEM);
    assert.equal(soundCommand(calls, 'mute').length, 1);
    // The remounted stage falls back to a guitar lane only: drums leave the band.
    env.setDrumLane(false);
    ss.start();
    timers.fire(50);
    assert.equal(mounts.length, 2);
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar'], 'drums left the band');
    assert.equal(rt.phase(), 'playing');
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    assert.equal(rt.drumSound(), null);
    rt.dispose();
    await flush();
    assert.equal(capCalls(calls, 'release', isSound).length, 1, 'released once');
});

// ── Drum sound modes (plan 6 Task 4): Rock Band judgments drive the drum stem ──

const rb = () => prefsWith({ drums: { soundMode: 'rockband' } });
const miss = (canvas) => ({ canvas, multiplier: 1, combo: 0 });
const hit = (canvas, combo = 1) => ({ canvas, points: 30, multiplier: 1, combo });

test('Rock Band: a miss drops the drum stem, the next hit brings it back', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: rb() });
    loadSong(STEM_ITEM);
    const lane = mounts[0].drumCanvas;
    assert.deepEqual(soundCaps(calls), [], 'no sound dispatch at load');
    fb.emit('drums:miss', miss(lane));
    assert.deepEqual(soundCommand(calls, 'mute').map((r) => r.args), [{ id: 'drums', claimId: SOUND_CLAIM }]);
    assert.equal(rt.drumSound().muted, true);
    fb.emit('drums:miss', miss(lane));
    await flush();
    assert.equal(soundCommand(calls, 'mute').length, 1, 'a second miss sends nothing more');
    fb.emit('drums:hit', hit(lane));
    await flush();
    assert.deepEqual(soundCommand(calls, 'restore').map((r) => r.args), [{ claimId: SOUND_CLAIM }]);
    assert.equal(capCalls(calls, 'release', isSound).length, 1);
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    assert.equal(rt.drumSound().muted, false);
    fb.emit('drums:hit', hit(lane, 2));
    await flush();
    assert.equal(soundCaps(calls).length, 4, 'a second hit sends nothing more');
    rt.dispose();
});

test('Rock Band: an overhit drops it too, but not while paused', () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: rb() });
    loadSong(STEM_ITEM);
    const lane = mounts[0].drumCanvas;
    fb.isPlaying = false;
    fb.emit('drums:overhit', { canvas: lane });
    assert.deepEqual(soundCaps(calls), [], 'a paused overhit is ignored');
    assert.equal(rt.drumSound().muted, false);
    fb.isPlaying = true;
    fb.emit('drums:overhit', { canvas: lane });
    assert.equal(soundCommand(calls, 'mute').length, 1);
    assert.equal(rt.drumSound().muted, true);
    rt.dispose();
});

test("Rock Band: another canvas's judgments are ignored", () => {
    const env = setup();
    const { rt, fb, doc, loadSong, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: rb() });
    loadSong(STEM_ITEM);
    fb.emit('drums:miss', miss(doc.createElement('canvas')));
    assert.deepEqual(soundCaps(calls), []);
    assert.equal(rt.drumSound().muted, false);
    rt.dispose();
});

test('Rock Band: drums alone on #highway follow the mode too', () => {
    const env = setup();
    const { rt, fb, loadSong, calls, highwayCanvas } = env;
    rt.startSession({ song: STEM_ITEM, prefs: prefsWith({ guitar: { on: false }, drums: { soundMode: 'rockband' } }) });
    loadSong(STEM_ITEM);
    fb.emit('drums:miss', miss(highwayCanvas));
    assert.deepEqual(soundCommand(calls, 'mute').map((r) => r.args), [{ id: 'drums', claimId: SOUND_CLAIM }]);
    rt.dispose();
});

test('Rock Band: any seek brings the drums back', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: rb() });
    loadSong(STEM_ITEM);
    const lane = mounts[0].drumCanvas;
    const seeks = [{ from: 20, to: 5 }, { from: 5, to: 30 }, { from: 30, to: 10, reason: 'loop-wrap' }];
    for (const [i, seek] of seeks.entries()) {
        fb.emit('drums:miss', miss(lane));
        assert.equal(rt.drumSound().muted, true, `muted before seek ${i}`);
        fb.emit('song:seek', seek);
        assert.equal(rt.drumSound().muted, false);
        await flush();   // the restore queues behind the mute
        assert.equal(soundCommand(calls, 'restore').length, i + 1, `seek ${JSON.stringify(seek)} restores`);
    }
    assert.equal(soundCommand(calls, 'mute').length, 3);
    fb.emit('song:seek', { from: 10, to: 2 });
    await flush();
    assert.equal(soundCommand(calls, 'restore').length, 3, 'a seek with the drums in sends nothing');
    rt.dispose();
});

test('Rock Band: a hit while the mute is still pending: the restore follows it', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    const held = holdMutes(env);
    rt.startSession({ song: STEM_ITEM, prefs: rb() });
    loadSong(STEM_ITEM);
    const lane = mounts[0].drumCanvas;
    fb.emit('drums:miss', miss(lane));
    fb.emit('drums:hit', hit(lane));
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute']);
    held[0]();
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    rt.dispose();
});

test('Rock Band stacked with fail mode: each claim follows its own rule', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: failPrefs({ drums: { soundMode: 'rockband' } }) });
    loadSong(STEM_ITEM);
    const lane = mounts[0].drumCanvas;
    dropDrums(env);
    assert.equal(rt.snapshot().parts.drums.failed, true, 'drums dropped out');
    await flush();
    assert.deepEqual(soundCommand(calls, 'mute').map((r) => r.args), [{ id: 'drums', claimId: SOUND_CLAIM }]);
    assert.deepEqual(stemsCommand(calls, 'mute').filter(isFailDrums).map((r) => r.args), [{ id: 'drums', claimId: FAIL_DRUMS }]);
    fb.emit('drums:hit', hit(lane));
    await flush();
    assert.equal(soundCommand(calls, 'restore').length, 1, 'the dropped drummer still drives Rock Band');
    assert.deepEqual(stemsCommand(calls, 'restore').filter(isFailDrums), [], 'the fail claim holds');
    const sound = soundCaps(calls).length;
    fb.emit('song:stop', {});
    await flush();
    assert.equal(stemsCommand(calls, 'restore').filter(isFailDrums).length, 1);
    assert.equal(capCalls(calls, 'release', isFailDrums).length, 1);
    assert.equal(soundCaps(calls).length, sound, 'nothing more for the sound claim');
    rt.dispose();
});

// ── Final review fixes (plan 6) ──

// Fix 2 (T4 M1): a fail-mode rescue while Rock Band holds the drums.
const RB_RESCUE_ITEM = { ...FULL_ITEM, stem_ids: ['guitar', 'drums', 'vocals'] };
const rbRescuePrefs = () => failPrefs({ vocals: SINGER, drums: { soundMode: 'rockband' } });

test('Rock Band: a rescue with the drums out restores the fail claim only', async () => {
    const env = setup();
    const { rt, fb, loadSong, calls } = env;
    rt.startSession({ song: RB_RESCUE_ITEM, prefs: rbRescuePrefs() });
    loadSong(RB_RESCUE_ITEM);
    await flush();
    dropDrums(env);
    assert.equal(rt.snapshot().parts.drums.failed, true);
    await flush();
    env.clock.t = 16;
    fb.emit('karaoke:od-activate', { fill: 0.5, t: 16 });
    assert.equal(rt.snapshot().parts.drums.failed, false, 'rescued');
    await flush();
    assert.deepEqual(stemsCommand(calls, 'restore').filter(isFailDrums).map((r) => r.args), [{ claimId: FAIL_DRUMS }]);
    assert.equal(capCalls(calls, 'release', isFailDrums).length, 1);
    assert.deepEqual(soundCommand(calls, 'restore'), [], 'Rock Band keeps the drums out until a hit');
    assert.deepEqual(rt.drumSound(), { mode: 'rockband', muted: true });
    rt.dispose();
});

test('Rock Band: a rescue with the drums back in sends only the fail restore', async () => {
    const env = setup();
    const { rt, fb, loadSong, mounts, calls } = env;
    rt.startSession({ song: RB_RESCUE_ITEM, prefs: rbRescuePrefs() });
    loadSong(RB_RESCUE_ITEM);
    await flush();
    dropDrums(env);
    fb.emit('drums:hit', hit(mounts[0].drumCanvas));
    await flush();
    assert.equal(soundCommand(calls, 'restore').length, 1);
    assert.equal(capCalls(calls, 'release', isSound).length, 1);
    const sound = soundCaps(calls).length;
    env.clock.t = 16;
    fb.emit('karaoke:od-activate', { fill: 0.5, t: 16 });
    await flush();
    assert.equal(stemsCommand(calls, 'restore').filter(isFailDrums).length, 1);
    assert.equal(capCalls(calls, 'release', isFailDrums).length, 1);
    assert.equal(soundCaps(calls).length, sound, 'nothing for the sound claim');
    assert.deepEqual(rt.drumSound(), { mode: 'rockband', muted: false });
    rt.dispose();
});

// Fix 3 (T4 M3): the Rock Band band-failed ending.
test('Rock Band: the band-failed ending keeps the drums out until teardown', async () => {
    const env = setup();
    const { rt, loadSong, calls } = env;
    rt.startSession({ song: STEM_ITEM, prefs: failPrefs({ drums: { soundMode: 'rockband' } }) });
    loadSong(STEM_ITEM);
    dropGuitar(env);
    dropDrums(env, 15);
    assert.equal(rt.phase(), 'ending', 'band failed');
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute'], 'the band-failing miss muted; the results keep it');
    env.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' });
    await flush();
    assert.deepEqual(soundKinds(calls).slice(-2), ['dispatch:restore', 'release']);
    assert.equal(soundKinds(calls).length, 4);
    for (const part of ['guitar', 'drums']) {
        const isFail = (r) => !!r && (r.claimId === `rockherosmith:fail:${part}`
            || !!(r.args && r.args.claimId === `rockherosmith:fail:${part}`));
        assert.equal(stemsCommand(calls, 'restore').filter(isFail).length, 1, `${part} fail restore`);
        assert.equal(capCalls(calls, 'release', isFail).length, 1, `${part} fail release`);
    }
    assert.equal(rt.drumSound(), null);
    const total = calls.caps.length;
    rt.dispose();
    await flush();
    assert.equal(calls.caps.length, total, 'dispose sends nothing more');
});

// Fix 4 (T4 M2): without overdrive, a stall tick still tracks the paused chart.
test('without overdrive, a stalled chart still ignores a paused overhit', async (t) => {
    t.mock.method(console, 'warn', () => {});   // createOverdriveSession's throw is logged
    const env = setup();
    const { rt, fb, loadSong, mounts, calls, timers } = env;
    env.chart.beats = new Proxy([], { get() { throw new Error('bad beats'); } });
    rt.startSession({ song: STEM_ITEM, prefs: rb() });
    loadSong(STEM_ITEM);
    assert.equal(rt.overdrive(), null, 'no overdrive session');
    const lane = mounts[0].drumCanvas;
    fb.isPlaying = true;
    env.chart.t = 5;
    timers.fire(100);
    timers.fire(100);
    fb.emit('drums:overhit', { canvas: lane });
    await flush();
    assert.deepEqual(soundCommand(calls, 'mute'), [], 'a stalled chart: the overhit is ignored');
    assert.equal(rt.drumSound().muted, false);
    env.chart.t = 6;
    timers.fire(100);
    fb.emit('drums:overhit', { canvas: lane });
    await flush();
    assert.equal(soundCommand(calls, 'mute').length, 1, 'the chart moves again: the overhit mutes');
    rt.dispose();
    assert.ok(!timers.delays().includes(100), 'no stall tick left after teardown');
});

// ---- Plan 7 Task 8: full screen, the hover chrome, the sidebar and Settings ----

const fullPrefs = (on = true, parts = {}) => ({ ...prefsWith(parts), fullScreenStage: on });
const bodyHas = (doc, cls) => doc.body.classList.contains(cls);

test('full screen on: Go asks once, Play again keeps it, Next song leaves it', () => {
    const { rt, fb, calls, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: fullPrefs(true) });
    loadSong(ITEM);
    assert.equal(calls.fsRequest, 1);
    assert.ok(player.classList.contains('rhs-full'));
    assert.deepEqual(rt.stageUi(), { full: true, fullScreen: true, sidebar: false, overlay: null, partSheet: false });
    fb.emit('song:ended', {});
    rt.again();
    loadSong(ITEM);
    assert.equal(calls.fsRequest, 1, 'Play again finds it already on');
    assert.equal(calls.fsExit, 0);
    assert.ok(player.classList.contains('rhs-full'));
    fb.emit('song:ended', {});
    rt.next();
    assert.equal(calls.fsExit, 1);
    assert.ok(!player.classList.contains('rhs-full'));
    assert.equal(rt.stageUi(), null);
    rt.dispose();
});

test("full screen off: no request until the chrome's Full screen button", () => {
    const { rt, calls, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: fullPrefs(false) });
    loadSong(ITEM);
    assert.equal(calls.fsRequest, 0);
    assert.ok(!player.classList.contains('rhs-full'));
    const btn = player.querySelector('.rhs-chrome-full');
    btn.click();
    assert.equal(calls.fsRequest, 1);
    assert.ok(player.classList.contains('rhs-full'));
    assert.equal(rt.stageUi().full, true);
    btn.click();
    assert.equal(calls.fsExit, 1);
    assert.ok(!player.classList.contains('rhs-full'));
    assert.equal(rt.stageUi().full, false);
    rt.dispose();
});

test('leaving browser full screen turns full mode off', () => {
    const { rt, doc, calls, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: fullPrefs(true) });
    loadSong(ITEM);
    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    assert.equal(rt.stageUi().full, false);
    assert.equal(rt.stageUi().fullScreen, false);
    assert.ok(!player.classList.contains('rhs-full'));
    assert.equal(calls.fsExit, 0, 'nothing left to exit');
    rt.dispose();
    assert.equal(doc.listenerCount(), 0, 'dispose removes the fullscreenchange listener');
});

test('M opens the sidebar; Escape closes it and stays in the song', () => {
    const { rt, doc, win, calls, loadSong, keyWin } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    const m = keyWin('KeyM', 'm');
    assert.ok(m.defaultPrevented);
    assert.ok(bodyHas(doc, 'rhs-sidebar-open'));
    assert.equal(rt.stageUi().sidebar, true);
    const esc = keyWin('Escape', 'Escape');
    assert.ok(esc.defaultPrevented);
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'));
    assert.equal(rt.phase(), 'playing');
    assert.deepEqual(calls.showScreen, []);
    // With the sidebar shut, Escape is core's again (leave the song).
    assert.equal(keyWin('Escape', 'Escape').defaultPrevented, false);
    // A modifier, or typing, leaves M alone.
    assert.equal(keyWin('KeyM', 'm', { ctrlKey: true }).defaultPrevented, false);
    const typing = new Event('keydown', { cancelable: true });
    Object.assign(typing, { code: 'KeyM', key: 'm' });
    Object.defineProperty(typing, 'target', { value: { tagName: 'INPUT' } });
    win.dispatchEvent(typing);
    assert.equal(typing.defaultPrevented, false);
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'));
    rt.dispose();
});

test('the Menu button opens the sidebar and never toggles it shut', () => {
    const { rt, doc, loadSong, keyWin, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    const menu = player.querySelector('.rhs-chrome-menu');
    menu.click();
    assert.ok(bodyHas(doc, 'rhs-sidebar-open'));
    menu.click();
    assert.ok(bodyHas(doc, 'rhs-sidebar-open'), 'a second click keeps it open');
    keyWin('KeyM', 'm');
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'), 'M toggles');
    rt.dispose();
});

test('Settings from the sidebar pauses, shows over the stage and resumes with the same token', () => {
    const { rt, doc, win, calls, loadSong, keyWin, sidebar, navLinks, settingsScreen } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'medium' } }) });
    loadSong(ITEM);
    keyWin('KeyM', 'm');
    const click = sidebar.fire('click', { target: navLinks.settings });
    assert.ok(click.defaultPrevented);
    assert.equal(calls.pause, 1);
    assert.ok(bodyHas(doc, 'rhs-settings-over'));
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'), 'the sidebar closed first');
    assert.deepEqual(calls.nav, [], 'the link itself is not followed');
    assert.equal(settingsScreen.getAttribute('aria-modal'), 'true');
    assert.equal(rt.stageUi().overlay, 'settings');
    assert.equal(rt.phase(), 'playing');
    // M does nothing under Settings.
    keyWin('KeyM', 'm');
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'));
    win.highway.setMastery(0.9); // core's loadSettings applies the solo mastery
    const esc = keyWin('Escape', 'Escape');
    assert.ok(esc.defaultPrevented);
    assert.ok(!bodyHas(doc, 'rhs-settings-over'));
    assert.equal(calls.setMastery.at(-1), 0.5);
    assert.deepEqual(calls.resume, [{ wasPlaying: true, gen: 1 }]);
    assert.ok(calls.resumeAt[0] > calls.setMasteryAt.at(-1), 'the band mastery is back before the resume');
    assert.equal(rt.stageUi().overlay, null);
    assert.equal(rt.phase(), 'playing');
    // resumeAfterOverlay answered true (a scheduled resume): Settings opens again normally.
    sidebar.fire('click', { target: navLinks.settings });
    assert.equal(calls.pause, 2);
    keyWin('Escape', 'Escape');
    assert.equal(calls.resume.length, 2);
    rt.dispose();
});

test('another item asks first: Stay resumes, Leave follows the link', async () => {
    const { rt, calls, loadSong, sidebar, navLinks, prompts } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    sidebar.fire('click', { target: navLinks.songs });
    assert.equal(calls.pause, 1);
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].args, { title: 'Leave the song?', body: 'This ends the band song.', confirmText: 'Leave', cancelText: 'Stay' });
    assert.equal(rt.stageUi().overlay, 'confirm');
    prompts[0].resolve(false);
    await flush();
    assert.equal(calls.resume.length, 1);
    assert.deepEqual(calls.nav, []);
    assert.equal(rt.stageUi().overlay, null);
    sidebar.fire('click', { target: navLinks.songs });
    prompts[1].resolve(true);
    await flush();
    assert.deepEqual(calls.nav, ['songs']);
    assert.equal(calls.resume.length, 1, 'no second resume');
    sidebar.fire('click', { target: navLinks.rockherosmith });
    assert.equal(prompts.length, 3, 'the RockHeroSmith entry asks too');
    prompts[2].reject(new Error('gone'));
    await flush();
    assert.equal(calls.resume.length, 2, 'a rejected prompt resumes');
    rt.dispose();
});

test('no confirm dialog in core: the item is followed directly', () => {
    const { rt, calls, loadSong, sidebar, navLinks } = setup({ confirmDialog: false });
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    sidebar.fire('click', { target: navLinks.songs });
    assert.deepEqual(calls.nav, ['songs']);
    rt.dispose();
});

test('every exit closes the sidebar, Settings and full screen', async () => {
    {
        const { rt, fb, doc, calls, loadSong, keyWin, sidebar, navLinks, settingsScreen } = setup();
        rt.startSession({ song: ITEM, prefs: fullPrefs(true) });
        loadSong(ITEM);
        keyWin('KeyM', 'm');
        sidebar.fire('click', { target: navLinks.settings });
        keyWin('KeyM', 'm'); // ignored under Settings
        fb.emit('song:stop', {});
        assert.ok(!bodyHas(doc, 'rhs-sidebar-open'));
        assert.ok(!bodyHas(doc, 'rhs-settings-over'));
        assert.equal(settingsScreen.getAttribute('role'), null);
        assert.deepEqual(calls.resume, []);
        assert.equal(calls.fsExit, 1);
        assert.equal(rt.stageUi(), null);
        rt.dispose();
    }
    {
        const { rt, fb, calls, loadSong, sidebar, navLinks, prompts } = setup();
        rt.startSession({ song: ITEM, prefs: fullPrefs(true) });
        loadSong(ITEM);
        sidebar.fire('click', { target: navLinks.songs });
        fb.emit('song:stop', {});
        assert.equal(calls.fsExit, 1);
        prompts[0].resolve(false);
        await flush();
        assert.deepEqual(calls.resume, [], 'a prompt answered after the end resumes nothing');
        assert.deepEqual(calls.nav, []);
        rt.dispose();
    }
});

test('note_detect stays quiet in a band song and the band says why', () => {
    const { rt, fb, calls, loadSong, fireWin, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    assert.deepEqual(calls.ndQuiet, [true]);
    const d = { message: 'denied', isDefault: true };
    fireWin('notedetect:input-error', d);
    fireWin('notedetect:input-error', d);
    assert.deepEqual(toastTexts(player), ["Guitar input couldn't start"]);
    fireWin('notedetect:input-error', { message: 'x', isDefault: false });
    assert.equal(toastTexts(player).length, 1);
    fb.emit('song:stop', {});
    assert.deepEqual(calls.ndQuiet, [true, false], 'the previous value comes back');
    rt.dispose();
});

test('drums alone leaves note_detect alone', () => {
    const { rt, calls, loadSong, fireWin, player } = setup();
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith({ guitar: { on: false } }) });
    loadSong(DRUM_ITEM);
    fireWin('notedetect:input-error', { message: 'x', isDefault: true });
    assert.deepEqual(calls.ndQuiet, []);
    assert.deepEqual(toastTexts(player), []);
    rt.dispose();
});

test('the loop button cycles start, end and clear', () => {
    const { rt, calls, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    const btn = player.querySelector('.rhs-chrome-loop');
    assert.equal(btn.textContent, 'Loop A');
    btn.click();
    assert.equal(btn.textContent, 'Loop B');
    btn.click();
    assert.equal(btn.textContent, 'Clear loop');
    btn.click();
    assert.equal(btn.textContent, 'Loop A');
    assert.deepEqual(calls.loop, ['start', 'end', 'clear']);
    rt.dispose();
});

test('End asks core to leave the song', () => {
    const { rt, calls, loadSong, player } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    player.querySelector('.rhs-chrome-end').click();
    assert.equal(calls.exitSong, 1);
    rt.dispose();
});

test("without core's overlay API the band pauses and resumes with togglePlay", () => {
    const { rt, fb, calls, loadSong, keyWin, sidebar, navLinks } = setup({ overlayApi: false });
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    fb.isPlaying = true;
    sidebar.fire('click', { target: navLinks.settings });
    assert.equal(calls.togglePlay, 1);
    fb.isPlaying = false;
    keyWin('Escape', 'Escape');
    assert.equal(calls.togglePlay, 2);
    // Paused before Settings opened: nothing to resume.
    sidebar.fire('click', { target: navLinks.settings });
    keyWin('Escape', 'Escape');
    assert.equal(calls.togglePlay, 2);
    rt.dispose();
});

test('the sidebar, M and the chrome exist only while the song plays', () => {
    const { rt, fb, doc, calls, loadSong, keyWin, player, sidebar, navLinks } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    fb.emit('song:ended', {});
    keyWin('KeyM', 'm');
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'));
    player.querySelector('.rhs-chrome-menu').click();
    player.querySelector('.rhs-edge').fire('pointerenter');
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'), 'the chrome opens nothing under the results');
    sidebar.fire('click', { target: navLinks.settings });
    assert.ok(!bodyHas(doc, 'rhs-settings-over'));
    assert.equal(calls.pause, 0);
    rt.next();
    assert.equal(player.querySelector('.rhs-chrome'), null);
    assert.equal(player.querySelector('.rhs-edge'), null);
    rt.dispose();
});

test('a song ending with the sidebar open closes it for the results', () => {
    const { rt, fb, doc, loadSong, keyWin } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    keyWin('KeyM', 'm');
    fb.emit('song:ended', {});
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'));
    rt.dispose();
});

test("solo play keeps core's sidebar: the takeover lives only inside a band session", () => {
    const { rt, fb, loadSong, sidebar, navLinks, calls } = setup();
    assert.equal(sidebar.listenerCount(), 0, 'no takeover before a band song');
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    assert.equal(sidebar.listenerCount(), 1);
    fb.emit('song:ended', {});
    rt.again();
    loadSong(ITEM);
    assert.equal(sidebar.listenerCount(), 1, 'one sidebar per session');
    fb.emit('song:stop', {});
    assert.equal(sidebar.listenerCount(), 0, 'teardown destroys it');
    const click = sidebar.fire('click', { target: navLinks.songs });
    assert.equal(click.defaultPrevented, false);
    assert.deepEqual(calls.nav, []);
    rt.dispose();
});

test('every stage unmount takes the chrome with it (splitscreen remount)', () => {
    const env = setup();
    const { rt, fb, win, loadSong, player, timers } = env;
    rt.startSession({ song: ITEM, prefs: fullPrefs(true) });
    loadSong(ITEM);
    win.slopsmithSplitscreen.stop = () => {}; // splitscreen takes its time going down
    env.setSplit(true);
    fb.emit('splitscreen:panels-changed', {});
    assert.equal(player.querySelectorAll('.rhs-chrome').length, 0);
    assert.ok(!player.classList.contains('rhs-full'), 'no full-mode CSS without a stage');
    env.setSplit(false);
    timers.fire(50);
    assert.equal(player.querySelectorAll('.rhs-chrome').length, 1, 'the remount brings it back');
    assert.ok(player.classList.contains('rhs-full'));
    fb.emit('song:stop', {});
    assert.equal(player.querySelectorAll('.rhs-chrome').length, 0);
    assert.ok(!player.classList.contains('rhs-full'));
    rt.dispose();
});

test('a Play again whose song fails to start leaves full screen', (t) => {
    t.mock.method(console, 'warn', () => {});
    const { rt, fb, calls, loadSong, win } = setup();
    rt.startSession({ song: ITEM, prefs: fullPrefs(true) });
    loadSong(ITEM);
    fb.emit('song:ended', {});
    const playSong = win.playSong;
    // The replayed song fails to start: the replayed session goes back to idle.
    win.playSong = () => { throw new Error('nope'); };
    rt.again();
    win.playSong = playSong;
    return Promise.resolve().then(flush).then(() => {
        assert.equal(rt.phase(), 'idle');
        assert.equal(calls.fsExit, 1);
        rt.dispose();
    });
});

// ---- Plan 7 final review fixes ----

test("a late loadSettings can't leave the solo mastery", async () => {
    for (const closedFirst of [true, false]) {
        const { rt, win, calls, loadSong, keyWin, sidebar, navLinks } = setup();
        let resolveLoad;
        win.loadSettings = () => new Promise((r) => { resolveLoad = r; });
        rt.startSession({ song: ITEM, prefs: prefsWith({ guitar: { difficulty: 'medium' } }) });
        loadSong(ITEM);
        sidebar.fire('click', { target: navLinks.settings });
        if (closedFirst) {
            keyWin('Escape', 'Escape');
            assert.equal(calls.setMastery.at(-1), 0.5);
            assert.equal(calls.resume.length, 1);
        }
        win.highway.setMastery(0.9); // the late _applyMastery
        resolveLoad();
        await flush();
        assert.equal(calls.setMastery.at(-1), 0.5, 'the band mastery wins');
        if (!closedFirst) {
            keyWin('Escape', 'Escape');
            assert.equal(calls.setMastery.at(-1), 0.5);
        }
        assert.equal(calls.resume.length, 1, 'the late load resumes nothing');
        rt.dispose();
    }
});

test('a loadSettings settling after song:stop sets no mastery', async () => {
    const { rt, fb, win, calls, loadSong, sidebar, navLinks } = setup();
    let resolveLoad;
    win.loadSettings = () => new Promise((r) => { resolveLoad = r; });
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    sidebar.fire('click', { target: navLinks.settings });
    fb.emit('song:stop', {});
    const n = calls.setMastery.length;
    resolveLoad();
    await flush();
    assert.equal(calls.setMastery.length, n);
    rt.dispose();
});

test('every exit closes the leave prompt through its own cancel', async () => {
    for (const exit of ['stop', 'dispose', 'newSong']) {
        const { rt, fb, doc, calls, loadSong, sidebar, navLinks, prompts } = setup();
        rt.startSession({ song: ITEM, prefs: prefsWith() });
        loadSong(ITEM);
        sidebar.fire('click', { target: navLinks.songs });
        assert.equal(prompts.length, 1);
        assert.ok(prompts[0].modal.parentNode, 'the prompt shows');
        if (exit === 'stop') fb.emit('song:stop', {});
        else if (exit === 'dispose') rt.dispose();
        else fb.emit('song:loading', { filename: 'Other.sloppak' });
        assert.ok(!prompts[0].modal.parentNode, `${exit}: the prompt is gone`);
        assert.ok(!doc.body.querySelector('.feedBack-modal'), `${exit}: no modal left`);
        assert.equal(prompts[0].settled, true, `${exit}: the prompt settled`);
        await flush();
        assert.deepEqual(calls.resume, [], `${exit}: nothing resumes`);
        assert.deepEqual(calls.nav, [], `${exit}: the link is not followed`);
        rt.dispose();
    }
});

test('the song ending under Settings closes it before the results and resumes nothing', () => {
    const { rt, fb, doc, player, calls, loadSong, keyWin, sidebar, navLinks, settingsScreen } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    sidebar.fire('click', { target: navLinks.settings });
    assert.ok(bodyHas(doc, 'rhs-settings-over'));
    fb.emit('song:ended', {});
    assert.ok(!bodyHas(doc, 'rhs-settings-over'));
    assert.equal(settingsScreen.getAttribute('role'), null);
    assert.ok(player.querySelector('.rhs-results'), 'the results show');
    assert.deepEqual(calls.resume, []);
    assert.equal(rt.stageUi().overlay, null);
    keyWin('Escape', 'Escape');
    assert.deepEqual(calls.resume, [], 'a later Escape resumes nothing');
    rt.dispose();
});

test('the song ending under the leave prompt closes it before the results and resumes nothing', async () => {
    const { rt, fb, doc, player, calls, loadSong, sidebar, navLinks, prompts } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    sidebar.fire('click', { target: navLinks.songs });
    fb.emit('song:ended', {});
    assert.ok(!doc.body.querySelector('.feedBack-modal'), 'the prompt is gone');
    assert.ok(player.querySelector('.rhs-results'));
    assert.equal(rt.stageUi().overlay, null);
    prompts[0].resolve(true);
    await flush();
    assert.deepEqual(calls.resume, []);
    assert.deepEqual(calls.nav, []);
    rt.dispose();
});

test('a held M opens the sidebar once', () => {
    const { rt, doc, loadSong, keyWin } = setup();
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    keyWin('KeyM', 'm');
    assert.ok(bodyHas(doc, 'rhs-sidebar-open'));
    for (let i = 0; i < 2; i++) {
        const e = keyWin('KeyM', 'm', { repeat: true });
        assert.ok(e.defaultPrevented, 'a repeat is still consumed');
        assert.ok(bodyHas(doc, 'rhs-sidebar-open'), 'a repeat does not toggle');
    }
    keyWin('KeyM', 'm', { repeat: false });
    assert.ok(!bodyHas(doc, 'rhs-sidebar-open'), 'a fresh press closes it');
    rt.dispose();
});

// ── Plan 8 Task 5: Next song goes straight to the library pick ──────────
// ITEM's session driven to the results; the next test step calls rt.next().
function toResults(env) {
    env.rt.startSession({ song: ITEM, prefs: prefsWith() });
    env.loadSong(ITEM);
    env.fb.emit('song:ended', {});
    assert.equal(env.rt.phase(), 'ending');
}

test('Next song calls onShowBandScreen once, after the band screen is shown', () => {
    const order = [];
    const env = setup({ onShowBandScreen: () => order.push('hook') });
    env.win.showScreen = (id) => { env.calls.showScreen.push(id); order.push(`show:${id}`); };
    toResults(env);
    env.rt.next();
    assert.deepEqual(order, ['show:plugin-rockherosmith', 'hook']);
    env.rt.next();
    assert.equal(order.length, 2, 'idle: a second next() does nothing');
    env.rt.dispose();
});

test('the band screen already active still calls onShowBandScreen', () => {
    let n = 0;
    const env = setup({ onShowBandScreen: () => { n++; } });
    env.bandScreen.classList.add('active');
    toResults(env);
    env.rt.next();
    assert.deepEqual(env.calls.showScreen, [], 'no second showScreen');
    assert.equal(n, 1);
    env.rt.dispose();
});

test('Play again and leaving never call onShowBandScreen', async () => {
    let n = 0;
    const env = setup({ onShowBandScreen: () => { n++; } });
    toResults(env);
    env.rt.again();
    await flush();
    assert.equal(n, 0, 'Play again');
    env.rt.dispose();
    const e2 = setup({ onShowBandScreen: () => { n++; } });
    toResults(e2);
    e2.fb.emit('screen:changing', { id: 'v3-songs' });
    e2.fb.emit('song:loading', { filename: 'other.psarc' });
    assert.equal(n, 0, 'leaving');
    e2.rt.dispose();
});

test("a throwing onShowBandScreen doesn't break Next song", () => {
    const env = setup({ onShowBandScreen: () => { throw new Error('boom'); } });
    toResults(env);
    env.rt.next();
    assert.equal(env.rt.phase(), 'idle');
    assert.equal(env.calls.release, 1, 'releaseExit still ran');
    assert.deepEqual(env.calls.showScreen, ['plugin-rockherosmith']);
    env.rt.dispose();
});

// The real end-of-song sequence with the real band screen: results, Next song
// (the runtime's ending.next), teardown, core switching screens, the band
// screen showing. Core's showScreen emits screen:changing at once and
// screen:changed after an await; the pick must open exactly once, whatever
// hide() runs on the way.
const BAND_HTML = readFileSync(new URL('../screen.html', import.meta.url), 'utf8');

function endToEnd({ activeAtNext = false, extraHides = [] } = {}) {
    const picks = [];
    let bs = null;
    const env = setup({ onShowBandScreen: () => { if (bs && typeof bs.nextSong === 'function') bs.nextSong(); } });
    parseHtml(BAND_HTML, env.doc, env.bandScreen);
    if (activeAtNext) env.bandScreen.classList.add('active');
    bs = createBandScreen({
        root: env.doc.getElementById('rockherosmith-root'), doc: env.doc, win: env.win,
        storage: env.storage, loadPrefs: () => prefsWith(), savePrefs: (p) => p, deviceMemo: {},
        fetchJson: async () => ({ songs: [] }), onGo: () => false,
        library: { pick(opts) { picks.push(opts); return new Promise(() => {}); } },
    });
    // Core's showScreen: changing now, .active flips, changed after an await.
    env.win.showScreen = (id) => {
        env.calls.showScreen.push(id);
        env.fb.emit('screen:changing', { id, from: 'player' });
        env.bandScreen.classList.add('active');
        return Promise.resolve().then(() => env.fb.emit('screen:changed', { id, from: 'player' }));
    };
    return { ...env, bs, picks };
}

test('end of song: Next song opens the library pick once, though hide() runs on the way', async () => {
    const t = endToEnd();
    toResults(t);
    // Core's exit and the teardown leave other screens' changing events first.
    t.fb.emit('screen:changing', { id: 'player', from: 'v3-songs' });
    t.rt.next();
    assert.equal(t.bs.view(), 'confirm');
    assert.equal(t.picks.length, 0, 'waits for the band screen to show');
    // A late leaving event for the player before the band screen's own changed.
    t.fb.emit('screen:changed', { id: 'player', from: 'v3-songs' });
    await flush();
    await flush();
    assert.equal(t.picks.length, 1, 'opened exactly once');
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    await flush();
    assert.equal(t.picks.length, 1, 'a repeated show does not reopen it');
    t.bs.dispose();
    t.rt.dispose();
});

test('end of song: the band screen already visible opens the pick once, now', async () => {
    const t = endToEnd({ activeAtNext: true });
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'v3-songs' });
    assert.equal(t.bs.isVisible(), true);
    toResults(t);
    t.rt.next();
    assert.equal(t.picks.length, 1);
    await flush();
    await flush();
    assert.equal(t.picks.length, 1, 'the later screen:changed does not reopen it');
    t.bs.dispose();
    t.rt.dispose();
});

test("end of song: an overlapping showScreen before the band screen's late changed drops the pick", async () => {
    const t = endToEnd();
    toResults(t);
    // Core flips .active to the band screen now and fires changed after an await.
    t.win.showScreen = (id) => {
        t.calls.showScreen.push(id);
        t.fb.emit('screen:changing', { id, from: 'player' });
        t.settingsScreen.classList.remove('active');
        t.bandScreen.classList.add('active');
        return Promise.resolve().then(() => t.fb.emit('screen:changed', { id, from: 'player' }));
    };
    t.rt.next();
    // The user starts Settings before the band screen's late screen:changed.
    t.fb.emit('screen:changing', { id: 'settings', from: 'plugin-rockherosmith' });
    t.bandScreen.classList.remove('active');
    t.settingsScreen.classList.add('active');
    await flush();
    await flush();
    assert.equal(t.picks.length, 0, 'the pick must not take the user from Settings to Songs');
    assert.ok(t.settingsScreen.classList.contains('active'), 'Settings is still the active screen');
    t.bs.dispose();
    t.rt.dispose();
});

test('end of song: leaving to another screen before the band screen shows drops the pick', async () => {
    const t = endToEnd();
    toResults(t);
    t.win.showScreen = (id) => { t.calls.showScreen.push(id); };
    t.rt.next();
    t.fb.emit('screen:changing', { id: 'v3-settings', from: 'player' });
    t.bandScreen.classList.add('active');
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'v3-settings' });
    await flush();
    assert.equal(t.picks.length, 0);
    t.bs.dispose();
    t.rt.dispose();
});

// ---- Plan 3 Task 10: controller players in the band session ----

const FF_ITEM = { ...DRUM_ITEM, filename: 'Frets.sloppak', five_fret_parts: ['guitar:chart', 'bass:chart'] };
const PAD1 = { key: 'Xbox#1', id: 'ctl1', name: 'Xbox', playsAs: 'five_fret', part: 'bass', difficulty: 'expert',
    lefty: false, partAudio: 'rockband', on: true };
const PAD2 = { ...PAD1, key: 'Xbox#2', id: 'ctl2', name: 'Xbox 2' };
const ctlPrefs = (controllers = [PAD1], opts) => ({ ...prefsWith(opts), controllers });
// Go, let listControllers settle, then core loads the song.
async function goCtl(env, prefs = ctlPrefs(), item = FF_ITEM) {
    env.rt.startSession({ song: item, prefs });
    await flush();
    env.loadSong(item);
}
// A five-fret band event's detail on a lane canvas.
const ffEv = (canvas, extra = {}) => ({ canvas, controllerKey: 'Xbox#1', score: 0, combo: 1, multiplier: 1,
    spActive: false, resets: 1, noteTime: 0, ...extra });
const partHud = (player, id) => player.querySelectorAll('.rhs-part-hud').find((h) => h.getAttribute('data-part') === id) || null;
const ffHides = (calls) => calls.hides.filter((h) => h[0] === 'five_fret');

test('Go with a joined controller: ctl1 in the ledger and HUD, its score HUD hidden', async () => {
    const env = setup();
    const { rt, mounts, calls, player, ff } = env;
    await goCtl(env);
    assert.equal(ff.lists, 1, 'the connected list is read once, at Go');
    const m = mounts[0];
    const [c] = m.prefs.controllers;
    assert.equal(c.on, true);
    assert.equal(c.part, 'bass');
    assert.equal(c.sourceKind, 'chart');
    assert.equal(c.key, 'Xbox#1');
    assert.equal(c.difficulty, 'expert');
    assert.ok(m.deps && m.deps.kinds && m.deps.kinds.five_fret, 'the stage gets the controller kinds');
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar', 'drums', 'ctl1']);
    const hud = partHud(player, 'ctl1');
    assert.ok(hud && hud.parentNode === m.lanes.ctl1, "ctl1's HUD sits in its lane");
    assert.deepEqual(ffHides(calls), [['five_fret', m.ctlCanvas.ctl1, true]]);
    rt.dispose();

    // A band of controllers alone has a stage and a ledger of its own.
    const solo = setup();
    await goCtl(solo, ctlPrefs([PAD1], { guitar: { on: false }, drums: { on: false } }));
    assert.equal(solo.mounts.length, 1);
    assert.deepEqual(solo.calls.playSong, [['Frets.sloppak', undefined]]);
    assert.deepEqual(Object.keys(solo.rt.snapshot().parts), ['ctl1']);
    solo.rt.dispose();
});

test("events on ctl1's canvas score ctl1 only", async () => {
    const env = setup();
    const { rt, fb, mounts } = env;
    await goCtl(env, ctlPrefs([PAD1, { ...PAD2, part: 'guitar' }]));
    const { ctl1, ctl2 } = mounts[0].ctlCanvas;
    fb.emit('five_fret:hit', ffEv(ctl1, { score: 100, combo: 1 }));
    let parts = rt.snapshot().parts;
    assert.equal(parts.ctl1.score, 100);
    assert.equal(parts.ctl1.hits, 1);
    assert.equal(parts.ctl2.score, 0);
    assert.equal(parts.guitar.score + parts.drums.score, 0);
    fb.emit('five_fret:miss', ffEv(ctl2, { score: 0, combo: 0, controllerKey: 'Xbox#2' }));
    fb.emit('five_fret:overstrum', ffEv(ctl1, { score: 100, combo: 0 }));
    parts = rt.snapshot().parts;
    assert.equal(parts.ctl2.misses, 1);
    assert.equal(parts.ctl1.overhits, 1);
    assert.equal(parts.ctl1.misses, 0);
    assert.equal(parts.ctl1.score, 100);
    rt.dispose();
});

test('sustain-end adds held points', async () => {
    const env = setup();
    const { rt, fb, mounts } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:hit', ffEv(canvas, { score: 100 }));
    fb.emit('five_fret:sustain-end', ffEv(canvas, { score: 137 }));
    const p = rt.snapshot().parts.ctl1;
    assert.equal(p.score, 137);
    assert.equal(p.hits, 1, 'a sustain is not another note');
    rt.dispose();
});

test('two controllers on one part score separately', async () => {
    const env = setup();
    const { rt, fb, mounts } = env;
    await goCtl(env, ctlPrefs([PAD1, PAD2]));
    const m = mounts[0];
    assert.deepEqual(m.prefs.controllers.map((c) => [c.id, c.key, c.part, c.on]),
        [['ctl1', 'Xbox#1', 'bass', true], ['ctl2', 'Xbox#2', 'bass', true]]);
    assert.notEqual(m.ctlCanvas.ctl1, m.ctlCanvas.ctl2);
    fb.emit('five_fret:hit', ffEv(m.ctlCanvas.ctl1, { score: 100 }));
    fb.emit('five_fret:hit', ffEv(m.ctlCanvas.ctl2, { score: 50, controllerKey: 'Xbox#2' }));
    fb.emit('five_fret:hit', ffEv(m.ctlCanvas.ctl1, { score: 160 }));
    const parts = rt.snapshot().parts;
    assert.equal(parts.ctl1.score, 160);
    assert.equal(parts.ctl2.score, 50);
    rt.dispose();
});

test('sp-activate rescues a failed bandmate', async () => {
    const env = setup();
    const { rt, fb, mounts, player, clock } = env;
    await goCtl(env, { ...ctlPrefs([PAD1, PAD2]), failMode: 'fail' });
    const { ctl1, ctl2 } = mounts[0].ctlCanvas;
    dropGuitar(env);
    assert.equal(rt.snapshot().parts.guitar.failed, true);
    fb.emit('five_fret:sp-activate', ffEv(ctl1, { score: 0, spActive: true }));
    let parts = rt.snapshot().parts;
    assert.equal(parts.guitar.failed, false, 'the guitarist is back');
    assert.equal(parts.ctl1.deploys, 1);
    assert.equal(partCallout(player, 'guitar'), 'SAVED!');
    // A controller drops out the same way (14 misses empty its crowd), with its own name.
    for (let i = 0; i < 14; i++) {
        clock.t = 20 + i;
        fb.emit('five_fret:miss', ffEv(ctl2, { combo: 0, controllerKey: 'Xbox#2' }));
    }
    assert.equal(rt.snapshot().parts.ctl2.failed, true);
    assert.ok(mounts[0].lanes.ctl2.classList.contains('rhs-failed'));
    assert.ok(toastTexts(player).includes('Bass (5-Fret) · Xbox 2 dropped out: overdrive brings them back'), JSON.stringify(toastTexts(player)));
    // A dropped-out controller's own deploy rescues nobody; a bandmate's does.
    fb.emit('five_fret:sp-activate', ffEv(ctl2, { controllerKey: 'Xbox#2', spActive: true }));
    assert.equal(rt.snapshot().parts.ctl2.failed, true);
    fb.emit('drums:sp-activate', { canvas: mounts[0].drumCanvas, spActive: true });
    parts = rt.snapshot().parts;
    assert.equal(parts.ctl2.failed, false);
    assert.equal(parts.ctl2.saves, 1);
    rt.dispose();
});

test("stars from the lane's thresholds", async () => {
    const env = setup();
    const { rt, fb, mounts, ff } = env;
    const full = [60, 120, 200, 450, 750, 1090];
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    ff.state = (c) => (c === canvas ? { starPower: { amount: 0, active: false }, starThresholds: full } : null);
    fb.emit('five_fret:hit', ffEv(canvas, { score: 300, stars: 5 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, starsFromScore(300, full));
    // After a seek the engine reports the rest of the chart only: the full chart's stay.
    ff.state = () => ({ starPower: { amount: 0, active: false }, starThresholds: [6, 12, 20, 45, 75, 109] });
    fb.emit('five_fret:hit', ffEv(canvas, { score: 400 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, starsFromScore(400, full));
    rt.dispose();
});

test('a controller disconnected at Go sits out', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const env = setup({ pads: ['Xbox#1'] });
    await goCtl(env, ctlPrefs([PAD1, PAD2]));
    const m = env.mounts[0];
    assert.deepEqual(m.prefs.controllers.map((c) => [c.id, c.on]), [['ctl1', true], ['ctl2', false]]);
    assert.equal(m.ctlCanvas.ctl2, undefined, 'no dead lane');
    assert.deepEqual(Object.keys(env.rt.snapshot().parts), ['guitar', 'drums', 'ctl1']);
    env.rt.dispose();

    // Without the 5-Fret plugin, with a list that rejects, or a list not back by
    // song:ready, every controller sits out and the song plays.
    const rejecting = setup();
    rejecting.win.feedBackFiveFret.listControllers = () => Promise.reject(new Error('no profiles'));
    const late = setup();
    late.win.feedBackFiveFret.listControllers = () => new Promise(() => {});
    for (const env2 of [setup({ fiveFret: false }), rejecting, late]) {
        await goCtl(env2, ctlPrefs([PAD1]));
        assert.equal(env2.mounts.length, 1);
        assert.equal(env2.mounts[0].prefs.controllers[0].on, false);
        assert.deepEqual(Object.keys(env2.rt.snapshot().parts), ['guitar', 'drums']);
        env2.rt.dispose();
    }

    // A song with no 5-fret part: the controller sits out too.
    const none = setup();
    await goCtl(none, ctlPrefs([PAD1]), ITEM);
    assert.equal(none.mounts[0].prefs.controllers[0].on, false);
    none.rt.dispose();
});

test('a lane that failed to start leaves the band', async () => {
    const env = setup();
    const { rt, fb, failLanes, player, calls } = env;
    failLanes.add('ctl1');
    await goCtl(env, ctlPrefs([PAD1, PAD2]));
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar', 'drums', 'ctl2']);
    assert.equal(partHud(player, 'ctl1'), null);
    assert.ok(partHud(player, 'ctl2'));
    assert.deepEqual(ffHides(calls).map((h) => h[1]), [env.mounts[0].ctlCanvas.ctl2]);
    fb.emit('five_fret:hit', ffEv(env.doc.createElement('canvas'), { score: 100 }));
    assert.equal(rt.snapshot().score, 0);
    rt.dispose();
});

test('a backward seek drops later controller entries and the next delta starts from the reset score', async () => {
    const env = setup();
    const { rt, fb, mounts, clock } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    for (const [t, score] of [[1, 100], [2, 200], [3, 300]]) {
        clock.t = t;
        fb.emit('five_fret:hit', ffEv(canvas, { score }));
    }
    assert.equal(rt.snapshot().parts.ctl1.score, 300);
    fb.emit('song:seek', { from: 3, to: 1.5 });
    assert.equal(rt.snapshot().parts.ctl1.score, 100, 'the entries after 1.5 are gone');
    // The engine reset its scoring on the seek: its score counts again from there.
    clock.t = 1.6;
    fb.emit('five_fret:hit', ffEv(canvas, { score: 250, resets: 2 }));
    assert.equal(rt.snapshot().parts.ctl1.score, 350);
    clock.t = 1.7;
    fb.emit('five_fret:hit', ffEv(canvas, { score: 300, resets: 2 }));
    assert.equal(rt.snapshot().parts.ctl1.score, 400);
    rt.dispose();
});

test("teardown unhides and the results keep the controller's numbers", async () => {
    const env = setup();
    const { rt, fb, mounts, calls, player } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:hit', ffEv(canvas, { score: 120 }));
    fb.emit('song:ended', {});
    assert.ok(player.querySelector('.rhs-results'), 'the results show');
    assert.equal(rt.snapshot().parts.ctl1.score, 120);
    assert.equal(player.querySelector('.rhs-results-score').textContent, '120');
    rt.next();
    assert.deepEqual(ffHides(calls), [['five_fret', canvas, true], ['five_fret', canvas, false]]);
    // Leaving mid-song unhides too.
    const env2 = setup();
    await goCtl(env2);
    env2.fb.emit('song:stop', {});
    assert.deepEqual(ffHides(env2.calls).map((h) => h[2]), [true, false]);
    rt.dispose();
    env2.rt.dispose();
});

test('Play again keeps the lanes', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, loadSong, ff } = env;
    await goCtl(env);
    const first = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:hit', ffEv(first, { score: 120 }));
    fb.emit('song:ended', {});
    rt.again();
    await flush();
    assert.equal(ff.lists, 2, 'the replay reads the connected list again');
    loadSong(FF_ITEM);
    assert.equal(mounts.length, 2);
    const second = mounts[1].ctlCanvas.ctl1;
    assert.ok(second);
    assert.equal(rt.snapshot().parts.ctl1.score, 0);
    assert.deepEqual(ffHides(calls), [['five_fret', first, true], ['five_fret', first, false], ['five_fret', second, true]]);
    fb.emit('five_fret:hit', ffEv(second, { score: 80 }));
    assert.equal(rt.snapshot().parts.ctl1.score, 80, "a new lane's first event counts from 0");
    fb.emit('five_fret:hit', ffEv(first, { score: 999 }));
    assert.equal(rt.snapshot().parts.ctl1.score, 80, "the old lane's canvas is no longer the band's");
    rt.dispose();
});

test('Start on a controller lane toggles band pause', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, doc } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#1', canvas });
    assert.equal(calls.togglePlay, 1);
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#1', canvas });
    assert.equal(calls.togglePlay, 2);
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#9', canvas: doc.createElement('canvas') });
    assert.equal(calls.togglePlay, 2, 'another canvas does nothing');
    rt.dispose();
});

test('holding Back on a controller lane opens the leave prompt', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, prompts } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas });
    assert.equal(calls.pause, 1, 'the song pauses under the prompt');
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].args, { title: 'Leave the song?', body: 'This ends the band song.', confirmText: 'Leave', cancelText: 'Stay' });
    prompts[0].resolve(false);
    await flush();
    assert.equal(calls.resume.length, 1, 'Stay resumes');
    assert.deepEqual(calls.showScreen, []);
    fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas });
    prompts[1].resolve(true);
    await flush();
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith'], 'Leave goes back to the band screen');
    rt.dispose();
});

test('under the leave prompt, Start on a controller lane stays', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, prompts, doc } = env;
    await goCtl(env, ctlPrefs([PAD1, { ...PAD2, part: 'guitar' }]));
    const [c1, c2] = [mounts[0].ctlCanvas.ctl1, mounts[0].ctlCanvas.ctl2];
    fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas: c1 });
    assert.equal(prompts.length, 1);
    // Another band controller answers too.
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#2', canvas: c2 });
    assert.equal(calls.togglePlay, 0, 'Start answers the prompt, it does not toggle');
    assert.equal(prompts[0].settled, true, 'the prompt settled');
    assert.ok(!doc.body.querySelector('.feedBack-modal'), 'the modal is gone');
    assert.equal(rt.stageUi().overlay, null);
    assert.equal(calls.resume.length, 1, 'Stay resumes');
    assert.deepEqual(calls.showScreen, []);
    await flush();
    assert.equal(calls.resume.length, 1, "the modal's own Cancel answer does nothing more");
    assert.equal(rt.phase(), 'playing');
    // With the prompt gone, Start toggles pause again.
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#1', canvas: c1 });
    assert.equal(calls.togglePlay, 1);
    rt.dispose();
});

test('under the leave prompt, holding Back again leaves', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, prompts, doc } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas });
    assert.equal(prompts.length, 1);
    fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas });
    assert.equal(prompts.length, 1, 'no second prompt');
    assert.equal(prompts[0].settled, true);
    assert.ok(!doc.body.querySelector('.feedBack-modal'), 'the modal is gone');
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith'], 'Leave goes back to the band screen');
    assert.equal(calls.resume.length, 0, 'Leave resumes nothing');
    await flush();
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith']);
    rt.dispose();
});

test('under Settings, Start and a held Back on a controller lane do nothing', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, prompts, keyWin, sidebar, navLinks } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    keyWin('KeyM', 'm');
    sidebar.fire('click', { target: navLinks.settings });
    assert.equal(rt.stageUi().overlay, 'settings');
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#1', canvas });
    fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas });
    assert.equal(calls.togglePlay, 0);
    assert.equal(prompts.length, 0);
    assert.equal(rt.stageUi().overlay, 'settings', 'Settings stays open');
    assert.equal(calls.resume.length, 0);
    rt.dispose();
});

test("events from a canvas the band doesn't own are ignored", async () => {
    const env = setup();
    const { rt, fb, mounts, calls, doc, prompts } = env;
    const stray = doc.createElement('canvas');
    // Before any session: nothing happens.
    fb.emit('five_fret:hit', ffEv(stray, { score: 10 }));
    fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#1', canvas: stray });
    await goCtl(env);
    for (const canvas of [stray, mounts[0].drumCanvas, env.highwayCanvas, undefined]) {
        for (const type of ['hit', 'miss', 'overstrum', 'sustain-end', 'sp-activate']) fb.emit('five_fret:' + type, ffEv(canvas, { score: 500 }));
        fb.emit('five_fret:band-pause', { controllerKey: 'Xbox#1', canvas });
        fb.emit('five_fret:band-back-hold', { controllerKey: 'Xbox#1', canvas });
    }
    fb.emit('five_fret:hit', null);
    const snap = rt.snapshot();
    assert.equal(snap.score, 0);
    assert.equal(snap.parts.ctl1.hits + snap.parts.ctl1.misses + snap.parts.ctl1.overhits + snap.parts.ctl1.deploys, 0);
    assert.equal(calls.togglePlay, 0);
    assert.equal(prompts.length, 0);
    // The band's own lane still scores.
    fb.emit('five_fret:hit', ffEv(mounts[0].ctlCanvas.ctl1, { score: 500 }));
    assert.equal(rt.snapshot().parts.ctl1.score, 500);
    rt.dispose();
});

// ---- Plan 3 Task 11: Rock Band part audio for controller players, per stem ----

const BASS_STEM = 'rockherosmith:sound:stem:bass';
const isStemSound = (claimId) => (r) => !!r && (r.claimId === claimId || !!(r.args && r.args.claimId === claimId));
const stemSoundKinds = (calls, claimId) => calls.caps.filter((c) => isStemSound(claimId)(c[1]))
    .map((c) => c[0] + (c[1].command ? ':' + c[1].command : ''));
const BASS_STEMS = ['guitar', 'bass', 'drums'];

test('a controller miss mutes the bass stem through its claim; a hit restores and releases', async () => {
    const env = setup({ stems: BASS_STEMS });
    const { rt, fb, mounts, calls } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), [], 'nothing at load');
    fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.deepEqual(capCalls(calls, 'claim', isStemSound(BASS_STEM)), [{ capability: 'stems', claimId: BASS_STEM, requester: 'rockherosmith' }]);
    assert.deepEqual(stemsCommand(calls, 'mute').filter(isStemSound(BASS_STEM)).map((r) => r.args), [{ id: 'bass', claimId: BASS_STEM }]);
    fb.emit('five_fret:overstrum', ffEv(canvas, { combo: 0 }));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute'], 'already dropped');
    fb.emit('five_fret:hit', ffEv(canvas, { score: 50 }));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    // Any seek brings a dropped stem back (Review Focus 5).
    fb.emit('five_fret:miss', ffEv(canvas, { combo: 0, score: 50 }));
    await flush();
    fb.emit('song:seek', { from: 10, to: 4 });
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM).slice(4), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    // The guitar and drum stems are never touched by the bass player.
    assert.ok(calls.caps.every((c) => !isStemSound('rockherosmith:sound:stem:guitar')(c[1])));
    rt.dispose();
});

test('Always play sends nothing', async () => {
    const env = setup({ stems: BASS_STEMS });
    const { rt, fb, mounts, calls } = env;
    await goCtl(env, ctlPrefs([{ ...PAD1, partAudio: 'always' }]));
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    fb.emit('five_fret:overstrum', ffEv(canvas, { combo: 0 }));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), []);
    rt.dispose();
    // A Lead controller beside the real guitarist: the guitar stem is theirs too.
    const lead = setup({ stems: BASS_STEMS });
    await goCtl(lead, ctlPrefs([{ ...PAD1, part: 'guitar' }]));
    lead.fb.emit('five_fret:miss', ffEv(lead.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    await flush();
    assert.deepEqual(stemSoundKinds(lead.calls, 'rockherosmith:sound:stem:guitar'), []);
    lead.rt.dispose();
});

test('a failed controller mutes its stem; rescue unmutes', async () => {
    const env = setup({ stems: BASS_STEMS });
    const { rt, fb, mounts, calls, clock } = env;
    await goCtl(env, { ...ctlPrefs([{ ...PAD1, partAudio: 'always' }]), failMode: 'fail' });
    const canvas = mounts[0].ctlCanvas.ctl1;
    for (let i = 0; i < 14; i++) {
        clock.t = 20 + i;
        fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    }
    assert.equal(rt.snapshot().parts.ctl1.failed, true);
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute']);
    fb.emit('drums:sp-activate', { canvas: mounts[0].drumCanvas, spActive: true });
    assert.equal(rt.snapshot().parts.ctl1.failed, false);
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    rt.dispose();
});

test('teardown restores held claims', async () => {
    const env = setup({ stems: BASS_STEMS });
    const { rt, fb, mounts, calls } = env;
    await goCtl(env);
    fb.emit('five_fret:miss', ffEv(mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    fb.emit('song:stop');
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    const total = calls.caps.length;
    fb.emit('five_fret:hit', ffEv(mounts[0].ctlCanvas.ctl1, { score: 10 }));
    env.fireWin('stems:state', { event: 'provider-ready', stemIds: BASS_STEMS });
    await flush();
    assert.equal(calls.caps.length, total, 'nothing after the session');
    rt.dispose();
});

test('provider-ready re-mutes', async () => {
    // The stems graph arrives after song:ready: the stem sound is rebuilt then.
    const ids = [];
    const env = setup({ stems: ids });
    const { rt, fb, mounts, calls, fireWin } = env;
    await goCtl(env);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), [], 'no stems yet');
    ids.push(...BASS_STEMS);
    fireWin('stems:state', { event: 'provider-ready', stemIds: ids });
    fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute']);
    // A rebuilt graph lost the claim: the held mute is sent again.
    fireWin('stems:state', { event: 'provider-ready', stemIds: ids });
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM), ['claim', 'dispatch:mute', 'claim', 'dispatch:mute']);
    fb.emit('five_fret:hit', ffEv(canvas, { score: 10 }));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, BASS_STEM).slice(4), ['dispatch:restore', 'release']);
    rt.dispose();
});

// ---- Plan 6 Task B6: drums controllers score, deploy and fail in the band ----

const KIT1 = { key: 'Kit#1', id: 'ctl1', name: 'Kit', playsAs: 'drums', part: 'drums', difficulty: 'expert',
    lefty: false, partAudio: 'rockband', soundMode: 'rockband', on: true };
const KIT2 = { ...KIT1, key: 'Kit#2', id: 'ctl2', name: 'Kit 2' };
const padPrefs = (controllers = [KIT1], opts) => ctlPrefs(controllers, opts);
// A drums bus event's detail on a lane canvas.
const drEv = (canvas, extra = {}) => ({ canvas, points: 0, multiplier: 1, combo: 1, spActive: false, ...extra });
const drumHides = (calls, canvas) => calls.hides.filter((h) => h[0] === 'drums' && h[1] === canvas).map((h) => h[2]);

test('Go with a drums controller: ctl1 in the ledger and HUD, its drum HUD hidden', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, player } = env;
    await goCtl(env, padPrefs(), DRUM_ITEM);
    const m = mounts[0];
    const [c] = m.prefs.controllers;
    assert.deepEqual([c.on, c.part, c.sourceKind, c.key], [true, 'drums', 'chart', 'Kit#1']);
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar', 'drums', 'ctl1']);
    const hud = partHud(player, 'ctl1');
    assert.ok(hud && hud.parentNode === m.lanes.ctl1, "ctl1's HUD sits in its lane");
    assert.deepEqual(drumHides(calls, m.ctlCanvas.ctl1), [true]);
    assert.deepEqual(drumHides(calls, m.drumCanvas), [true], "the real drummer's HUD is hidden too");
    fb.emit('song:stop', {});
    assert.deepEqual(drumHides(calls, m.ctlCanvas.ctl1), [true, false], 'teardown shows it again');
    rt.dispose();
});

test('a MIDI drummer and a controller drummer score only their own canvases', async () => {
    const env = setup();
    const { rt, fb, mounts } = env;
    await goCtl(env, padPrefs([KIT1], { drums: { soundMode: 'rockband' } }), STEM_ITEM);
    const { drumCanvas } = mounts[0];
    const lane = mounts[0].ctlCanvas.ctl1;
    // The real drummer's canvas: only drums.
    fb.emit('drums:hit', drEv(drumCanvas, { points: 50, combo: 1 }));
    fb.emit('drums:overhit', drEv(drumCanvas));
    assert.equal(rt.drumSound().muted, true, "the real drummer's overhit drops its stem");
    fb.emit('drums:hit', drEv(drumCanvas, { points: 50, combo: 1 }));
    assert.equal(rt.drumSound().muted, false, 'its next hit brings it back');
    let parts = rt.snapshot().parts;
    assert.deepEqual([parts.drums.score, parts.drums.hits, parts.drums.overhits], [100, 2, 1]);
    assert.deepEqual([parts.ctl1.score, parts.ctl1.hits, parts.ctl1.overhits, parts.ctl1.misses], [0, 0, 0, 0]);
    // The controller's canvas: only ctl1, and the real drummer's Rock Band stem doesn't drop.
    fb.emit('drums:hit', drEv(lane, { points: 30, combo: 1 }));
    fb.emit('drums:miss', drEv(lane, { combo: 0 }));
    fb.emit('drums:overhit', drEv(lane));
    parts = rt.snapshot().parts;
    assert.deepEqual([parts.ctl1.score, parts.ctl1.hits, parts.ctl1.misses, parts.ctl1.overhits], [30, 1, 1, 1]);
    assert.deepEqual([parts.drums.score, parts.drums.hits, parts.drums.misses, parts.drums.overhits], [100, 2, 0, 1]);
    assert.equal(rt.drumSound().muted, false, "a controller miss never drops the real drummer's stem");
    fb.emit('drums:miss', drEv(drumCanvas, { combo: 0 }));
    assert.equal(rt.drumSound().muted, true, "the real drummer's own miss still does");
    assert.equal(rt.snapshot().parts.ctl1.misses, 1);
    // Deploys: each canvas its own player.
    fb.emit('drums:sp-activate', drEv(lane, { spActive: true }));
    parts = rt.snapshot().parts;
    assert.deepEqual([parts.ctl1.deploys, parts.drums.deploys], [1, 0]);
    fb.emit('drums:sp-activate', drEv(drumCanvas, { spActive: true }));
    parts = rt.snapshot().parts;
    assert.deepEqual([parts.ctl1.deploys, parts.drums.deploys], [1, 1]);
    rt.dispose();
});

test('two drums controllers score separately', async () => {
    const env = setup();
    const { rt, fb, mounts, doc } = env;
    await goCtl(env, padPrefs([KIT1, KIT2], { drums: { on: false } }), DRUM_ITEM);
    const { ctl1, ctl2 } = mounts[0].ctlCanvas;
    assert.notEqual(ctl1, ctl2);
    fb.emit('drums:hit', drEv(ctl1, { points: 40, multiplier: 4, spActive: true, combo: 9 }));
    fb.emit('drums:hit', drEv(ctl2, { points: 25 }));
    fb.emit('drums:miss', drEv(ctl2, { combo: 0 }));
    fb.emit('drums:hit', drEv(doc.createElement('canvas'), { points: 999 }));
    const parts = rt.snapshot().parts;
    assert.deepEqual(Object.keys(parts), ['guitar', 'ctl1', 'ctl2']);
    assert.deepEqual([parts.ctl1.score, parts.ctl1.hits, parts.ctl1.misses], [40, 1, 0]);
    assert.deepEqual([parts.ctl2.score, parts.ctl2.hits, parts.ctl2.misses], [25, 1, 1]);
    assert.equal(parts.guitar.score, 0);
    rt.dispose();
});

test('sp-activate on the controller lane rescues a failed bandmate', async () => {
    const env = setup();
    const { rt, fb, mounts, player, clock } = env;
    await goCtl(env, { ...padPrefs([KIT1, KIT2]), failMode: 'fail' }, DRUM_ITEM);
    const { ctl1, ctl2 } = mounts[0].ctlCanvas;
    dropGuitar(env);
    assert.equal(rt.snapshot().parts.guitar.failed, true);
    fb.emit('drums:sp-activate', drEv(ctl1, { spActive: true }));
    let parts = rt.snapshot().parts;
    assert.equal(parts.guitar.failed, false, 'the guitarist is back');
    assert.equal(parts.ctl1.deploys, 1);
    assert.equal(parts.drums.deploys, 0);
    assert.equal(partCallout(player, 'guitar'), 'SAVED!');
    // A drums controller drops out on its misses, and the real drummer's deploy rescues it.
    for (let i = 0; i < 14; i++) {
        clock.t = 20 + i;
        fb.emit('drums:miss', drEv(ctl2, { combo: 0 }));
    }
    assert.equal(rt.snapshot().parts.ctl2.failed, true);
    assert.ok(mounts[0].lanes.ctl2.classList.contains('rhs-failed'));
    fb.emit('drums:sp-activate', drEv(ctl2, { spActive: true }));
    assert.equal(rt.snapshot().parts.ctl2.failed, true, "its own deploy rescues nobody");
    fb.emit('drums:sp-activate', drEv(mounts[0].drumCanvas, { spActive: true }));
    parts = rt.snapshot().parts;
    assert.equal(parts.ctl2.failed, false);
    assert.equal(parts.ctl2.saves, 1);
    rt.dispose();
});

test('controller drum meter mirrored from getInstanceState', async () => {
    const env = odSetup();
    const { rt, mounts, player, timers, od } = env;
    const asked = new Set();
    let lane = null;
    od.drums = (c) => { asked.add(c); return { starPower: { amount: c === lane ? 0.75 : 0.25, active: false } }; };
    await goCtl(env, padPrefs(), DRUM_ITEM);
    lane = mounts[0].ctlCanvas.ctl1;
    timers.fire(100);
    assert.equal(odHud(player, 'ctl1').style.width, '75%');
    assert.equal(odHud(player, 'drums').style.width, '25%');
    assert.ok(asked.has(lane) && asked.has(mounts[0].drumCanvas), 'each read from its own canvas');
    assert.deepEqual(rt.overdrive().controllers.ctl1, { fill: 0.75, active: false });
    rt.dispose();
});

test("a drums controller's stars follow the real drummer's rule", async () => {
    const env = setup();
    const { rt, fb, mounts, od } = env;
    await goCtl(env, padPrefs(), DRUM_ITEM);
    const lane = mounts[0].ctlCanvas.ctl1;
    // No thresholds reported yet: the engine's own stars.
    fb.emit('drums:hit', drEv(lane, { points: 100, stars: 2.5 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, 2.5);
    // Once the lane reports thresholds, they measure the band's score.
    const full = [60, 120, 200, 450, 750, 1090];
    od.drums = (c) => (c === lane ? { starPower: { amount: 0, active: false }, starThresholds: full } : null);
    fb.emit('drums:hit', drEv(lane, { points: 200, stars: 1 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, starsFromScore(300, full));
    rt.dispose();
});

test('a drums controller lane moves from partial to full-chart thresholds (M6)', async () => {
    const env = setup();
    const { rt, fb, mounts, od, clock } = env;
    await goCtl(env, padPrefs(), DRUM_ITEM);
    const lane = mounts[0].ctlCanvas.ctl1;
    const partial = [6, 12, 20, 45, 75, 109];
    const full = [60, 120, 200, 450, 750, 1090];
    let th = partial;
    od.drums = (c) => (c === lane ? { starPower: { amount: 0, active: false }, starThresholds: th } : null);
    // The song started mid-chart: the engine reports the rest's thresholds first.
    clock.t = 30;
    fb.emit('drums:hit', drEv(lane, { points: 100 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, starsFromScore(100, partial));
    // A seek back to the start: the engine now reports the full chart's; they win.
    fb.emit('song:seek', { from: 31, to: 0 });
    th = full;
    clock.t = 1;
    fb.emit('drums:hit', drEv(lane, { points: 300 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, starsFromScore(300, full));
    // A later seek forward reports partial ones again: the full set stays.
    th = partial;
    clock.t = 40;
    fb.emit('drums:hit', drEv(lane, { points: 100 }));
    assert.equal(rt.snapshot().parts.ctl1.stars, starsFromScore(400, full));
    rt.dispose();
});

test("the real drum lane's judgments never rebuild the controller lanes", async () => {
    const env = setup();
    const { rt, fb, mounts } = env;
    await goCtl(env, padPrefs(), DRUM_ITEM);
    const m = mounts[0];
    let reads = 0;
    const get = m.getLaneCanvas;
    m.getLaneCanvas = (id) => { reads++; return get(id); };
    for (const type of ['hit', 'miss', 'overhit', 'sp-activate']) fb.emit('drums:' + type, drEv(m.drumCanvas, { points: 10 }));
    assert.equal(reads, 0, 'no lane lookups for the real drummer');
    assert.equal(rt.snapshot().parts.drums.hits, 1);
    fb.emit('drums:hit', drEv(m.ctlCanvas.ctl1, { points: 10 }));
    assert.equal(rt.snapshot().parts.ctl1.hits, 1, 'the controller lane still scores');
    rt.dispose();
});

test('a drums controller disconnected at Go sits out', async () => {
    const env = setup({ drumPads: ['Kit#1'] });
    await goCtl(env, padPrefs([KIT1, KIT2]), DRUM_ITEM);
    const m = env.mounts[0];
    assert.deepEqual(m.prefs.controllers.map((c) => [c.id, c.on]), [['ctl1', true], ['ctl2', false]]);
    assert.equal(m.ctlCanvas.ctl2, undefined, 'no dead lane');
    assert.deepEqual(Object.keys(env.rt.snapshot().parts), ['guitar', 'drums', 'ctl1']);
    env.rt.dispose();

    // Without setController, without the renderer, on a song with no drum chart,
    // or undecided (playsAs null, even with a remembered kind): it sits out too.
    const noPin = setup();
    delete noPin.win.feedBackDrums.setController;
    const noViz = setup();
    delete noViz.win.feedBackViz_drums;
    const cases = [
        [noPin, padPrefs(), DRUM_ITEM],
        [noViz, padPrefs(), DRUM_ITEM],
        [setup(), padPrefs(), ITEM],
        [setup(), { ...padPrefs([{ ...KIT1, playsAs: null }]), controllerKinds: { 'Kit#1': 'drums' } }, DRUM_ITEM],
    ];
    for (const [env2, prefs, item] of cases) {
        await goCtl(env2, prefs, item);
        assert.equal(env2.mounts.length, 1);
        assert.equal(env2.mounts[0].prefs.controllers[0].on, false);
        assert.ok(!Object.keys(env2.rt.snapshot().parts).includes('ctl1'));
        env2.rt.dispose();
    }
});

test('a drums controller lane that failed to start leaves the band', async () => {
    const env = setup();
    const { rt, fb, failLanes, player } = env;
    failLanes.add('ctl1');
    await goCtl(env, padPrefs([KIT1, KIT2]), DRUM_ITEM);
    assert.deepEqual(Object.keys(rt.snapshot().parts), ['guitar', 'drums', 'ctl2']);
    assert.equal(partHud(player, 'ctl1'), null);
    fb.emit('drums:hit', drEv(env.doc.createElement('canvas'), { points: 100 }));
    assert.equal(rt.snapshot().score, 0);
    rt.dispose();
});

test('a backward seek drops later drums-controller entries', async () => {
    const env = setup();
    const { rt, fb, mounts, clock } = env;
    await goCtl(env, padPrefs(), DRUM_ITEM);
    const lane = mounts[0].ctlCanvas.ctl1;
    for (const t of [1, 2, 3]) {
        clock.t = t;
        fb.emit('drums:hit', drEv(lane, { points: 100 }));
    }
    assert.equal(rt.snapshot().parts.ctl1.score, 300);
    fb.emit('song:seek', { from: 3, to: 1.5 });
    assert.equal(rt.snapshot().parts.ctl1.score, 100, 'the entries after 1.5 are gone');
    clock.t = 1.6;
    fb.emit('drums:hit', drEv(lane, { points: 40 }));
    assert.equal(rt.snapshot().parts.ctl1.score, 140, 'drums points are per hit, not a running score');
    rt.dispose();
});

test('Start on a drums controller lane toggles band pause; a held Back opens the leave prompt', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, prompts } = env;
    await goCtl(env, padPrefs(), DRUM_ITEM);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('drums:band-pause', { controllerKey: 'Kit#1', canvas });
    assert.equal(calls.togglePlay, 1);
    fb.emit('drums:band-pause', { controllerKey: 'Kit#1', canvas: mounts[0].drumCanvas });
    assert.equal(calls.togglePlay, 1, "the real drum lane's canvas does nothing");
    fb.emit('drums:band-back-hold', { controllerKey: 'Kit#1', canvas });
    assert.equal(prompts.length, 1);
    // Under the prompt, Start is Stay.
    fb.emit('drums:band-pause', { controllerKey: 'Kit#1', canvas });
    assert.equal(calls.togglePlay, 1, 'Start answers the prompt, it does not toggle');
    assert.equal(prompts[0].settled, true);
    assert.equal(calls.resume.length, 1, 'Stay resumes');
    // Hold Back, then hold it again: Leave.
    fb.emit('drums:band-back-hold', { controllerKey: 'Kit#1', canvas });
    fb.emit('drums:band-back-hold', { controllerKey: 'Kit#1', canvas });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].settled, true);
    assert.deepEqual(calls.showScreen, ['plugin-rockherosmith'], 'Leave goes back to the band screen');
    rt.dispose();
});

test('every drums controller lane is unpinned at the end, Play again included', async () => {
    const env = setup();
    const { rt, fb, mounts, calls, loadSong } = env;
    await goCtl(env, padPrefs([KIT1, KIT2]), DRUM_ITEM);
    const first = mounts[0];
    // The fake stage records unmounts; the real stage's unmount unpins (Task B5).
    fb.emit('song:ended', {});
    rt.again();
    await flush();
    assert.equal(first.unmounted, 1, 'Play again unmounts the old lanes');
    loadSong(DRUM_ITEM);
    fb.emit('song:stop', {});
    assert.equal(mounts[1].unmounted, 1, 'leaving unmounts the new ones');
    assert.ok(calls.hides.filter((h) => h[0] === 'drums' && h[2] === true).every((h) =>
        drumHides(calls, h[1]).at(-1) === false), 'every hidden drum HUD came back');
    rt.dispose();
});

// ---- Plan 6 Task B7: drum sound modes for controller drummers ----

const DRUMS_STEM = 'rockherosmith:sound:stem:drums';
const noRealDrums = { drums: { on: false } };

test('a drums controller miss in Rock Band mutes the drums stem under rockherosmith:sound:stem:drums; a hit restores', async () => {
    const env = setup();
    const { rt, fb, mounts, calls } = env;
    await goCtl(env, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    const lane = mounts[0].ctlCanvas.ctl1;
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), [], 'nothing at load');
    fb.emit('drums:miss', drEv(lane, { combo: 0 }));
    assert.deepEqual(capCalls(calls, 'claim', isStemSound(DRUMS_STEM)), [{ capability: 'stems', claimId: DRUMS_STEM, requester: 'rockherosmith' }]);
    assert.deepEqual(stemsCommand(calls, 'mute').filter(isStemSound(DRUMS_STEM)).map((r) => r.args), [{ id: 'drums', claimId: DRUMS_STEM }]);
    fb.emit('drums:overhit', drEv(lane));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute'], 'already dropped');
    fb.emit('drums:hit', drEv(lane, { points: 50 }));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    // An overhit drops it too, and any seek brings it back.
    fb.emit('drums:overhit', drEv(lane));
    fb.emit('song:seek', { from: 10, to: 4 });
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM).slice(4), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    assert.deepEqual(soundCaps(calls), [], "the real drummer's sound claim is never used");
    rt.dispose();
});

test('a paused overhit is ignored', async () => {
    const env = setup();
    const { rt, fb, mounts, calls } = env;
    await goCtl(env, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    const lane = mounts[0].ctlCanvas.ctl1;
    fb.isPlaying = false;
    fb.emit('drums:overhit', drEv(lane));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), [], 'a stray pad tap while paused');
    fb.isPlaying = true;
    fb.emit('drums:overhit', drEv(lane));
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute']);
    rt.dispose();
});

test('My kit only on drums controllers mutes the drums stem all song; teardown restores', async () => {
    const env = setup();
    const { rt, fb, mounts, calls } = env;
    const kit = (c) => ({ ...c, soundMode: 'kit' });
    await goCtl(env, padPrefs([kit(KIT1), kit(KIT2)], noRealDrums), DRUM_ITEM);
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute'], 'muted from the start');
    const { ctl1, ctl2 } = mounts[0].ctlCanvas;
    fb.emit('drums:hit', drEv(ctl1, { points: 50 }));
    fb.emit('drums:miss', drEv(ctl2, { combo: 0 }));
    fb.emit('song:seek', { from: 10, to: 4 });
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute'], 'judgments and seeks keep it muted');
    fb.emit('song:stop', {});
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    rt.dispose();
});

test('a Song drums controller, or a song with no drum stem, sends nothing', async () => {
    const env = setup();
    await goCtl(env, padPrefs([{ ...KIT1, soundMode: 'song' }], noRealDrums), DRUM_ITEM);
    env.fb.emit('drums:miss', drEv(env.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    await flush();
    assert.deepEqual(stemSoundKinds(env.calls, DRUMS_STEM), []);
    env.rt.dispose();
    // No drum stem: My kit only and Rock Band play as Song.
    for (const soundMode of ['kit', 'rockband']) {
        const e = setup({ stems: ['guitar'] });
        await goCtl(e, padPrefs([{ ...KIT1, soundMode }], noRealDrums), DRUM_ITEM);
        e.fb.emit('drums:miss', drEv(e.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
        await flush();
        assert.deepEqual(capCalls(e.calls, 'claim'), [], soundMode);
        e.rt.dispose();
    }
});

test("the real drummer's own sound claim is untouched", async () => {
    const env = setup();
    const { rt, fb, mounts, calls, clock } = env;
    await goCtl(env, { ...padPrefs([{ ...KIT1, soundMode: 'kit' }, KIT2], { drums: { soundMode: 'rockband' } }), failMode: 'fail' }, STEM_ITEM);
    await flush();
    const { drumCanvas } = mounts[0];
    const { ctl1, ctl2 } = mounts[0].ctlCanvas;
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), [], 'no kit mute with a real drummer');
    // Controller misses (and both controllers dropping out) never touch the drum stem.
    for (let i = 0; i < 14; i++) {
        clock.t = 20 + i;
        fb.emit('drums:miss', drEv(ctl1, { combo: 0 }));
        fb.emit('drums:overhit', drEv(ctl2));
        fb.emit('drums:miss', drEv(ctl2, { combo: 0 }));
    }
    await flush();
    assert.deepEqual([rt.snapshot().parts.ctl1.failed, rt.snapshot().parts.ctl2.failed], [true, true]);
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), [], 'no drops, no fail mute');
    assert.deepEqual(soundCaps(calls), [], "the real drummer's Rock Band stem stays");
    assert.equal(rt.drumSound().muted, false);
    // The real drummer's own v1 rules still run, under its own claim.
    fb.emit('drums:miss', drEv(drumCanvas, { combo: 0 }));
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute']);
    fb.emit('drums:hit', drEv(drumCanvas, { points: 50 }));
    await flush();
    assert.deepEqual(soundKinds(calls), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    // Everyone on the drum stem out: the real drummer's fail claim mutes it, stem-sound doesn't.
    dropDrums(env, 40);
    await flush();
    assert.equal(rt.snapshot().parts.drums.failed, true);
    assert.equal(capCalls(calls, 'claim', isFailDrums).length, 1);
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), []);
    rt.dispose();
});

// ---- Plan 6 Part B final review fixes ----

test("drums only: #highway is the drums input target, re-pinned on a replace, cleared at the end and on Play again", async () => {
    const env = setup();
    const { rt, fb, doc, calls, loadSong, highwayCanvas } = env;
    await goCtl(env, padPrefs([KIT1], { guitar: { on: false } }), DRUM_ITEM);
    assert.deepEqual(calls.inputTarget, [highwayCanvas], "the real drummer's canvas holds the band pin");
    const fresh = doc.createElement('canvas');
    fb.emit('highway:canvas-replaced', { oldCanvas: highwayCanvas, newCanvas: fresh });
    assert.deepEqual(calls.inputTarget, [highwayCanvas, fresh], 'the pin follows the replace');
    fb.emit('song:ended', {});
    rt.again();
    await flush();
    assert.equal(calls.inputTarget.at(-1), null, 'Play again clears it');
    loadSong(DRUM_ITEM);
    assert.equal(calls.inputTarget.at(-1), highwayCanvas, 'the replay pins it again');
    fb.emit('song:stop', {});
    assert.equal(calls.inputTarget.at(-1), null, 'leaving clears it');
    rt.dispose();

    // Beside a guitar the stage pins its own drum lane; the runtime adds nothing.
    const lead = setup();
    await goCtl(lead, padPrefs([KIT1]), DRUM_ITEM);
    lead.fb.emit('song:stop', {});
    assert.deepEqual(lead.calls.inputTarget, []);
    lead.rt.dispose();
});

test("drums only: the real drummer's judgments never rebuild the controller lanes", async () => {
    const env = setup();
    const { rt, fb, doc, mounts, highwayCanvas } = env;
    await goCtl(env, padPrefs([KIT1], { guitar: { on: false } }), DRUM_ITEM);
    const m = mounts[0];
    let reads = 0;
    const get = m.getLaneCanvas;
    m.getLaneCanvas = (id) => { reads++; return get(id); };
    for (const type of ['hit', 'miss', 'overhit', 'sp-activate']) fb.emit('drums:' + type, drEv(highwayCanvas, { points: 10 }));
    const fresh = doc.createElement('canvas');
    fb.emit('highway:canvas-replaced', { oldCanvas: highwayCanvas, newCanvas: fresh });
    fb.emit('drums:hit', drEv(fresh, { points: 10 }));
    assert.equal(reads, 0, 'no lane lookups for the real drummer, before or after a replace');
    assert.equal(rt.snapshot().parts.drums.hits, 2);
    fb.emit('drums:hit', drEv(m.ctlCanvas.ctl1, { points: 10 }));
    assert.equal(rt.snapshot().parts.ctl1.hits, 1, 'the controller lane still scores');
    rt.dispose();
});

test("a controller drum lane's replaced canvas has its score HUD hidden at once; teardown shows it", async () => {
    const env = setup();
    const { rt, fb, doc, mounts, calls } = env;
    await goCtl(env, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    const m = mounts[0];
    const lane = m.ctlCanvas.ctl1;
    const fresh = doc.createElement('canvas');
    // The stage adopts the clone (its own listener), then the event reaches the runtime.
    m.ctlCanvas.ctl1 = fresh;
    fb.emit('highway:canvas-replaced', { oldCanvas: lane, newCanvas: fresh });
    assert.deepEqual(drumHides(calls, fresh), [true], 'hidden before any judgment');
    fb.emit('drums:hit', drEv(fresh, { points: 10 }));
    assert.deepEqual(drumHides(calls, fresh), [true], 'hidden once');
    assert.equal(rt.snapshot().parts.ctl1.hits, 1);
    fb.emit('song:stop', {});
    assert.deepEqual(drumHides(calls, fresh), [true, false]);
    rt.dispose();
});

test('My kit only wanted at start, before the stems provider is ready, mutes the drum stem once on provider-ready', async () => {
    const ids = [];
    const env = setup({ stems: ids });
    const { rt, fb, calls, fireWin } = env;
    await goCtl(env, padPrefs([{ ...KIT1, soundMode: 'kit' }], noRealDrums), DRUM_ITEM);
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), [], 'no stems yet');
    ids.push('guitar', 'drums');
    fireWin('stems:state', { event: 'provider-ready', stemIds: ids });
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute']);
    fb.emit('song:stop', {});
    await flush();
    assert.deepEqual(stemSoundKinds(calls, DRUMS_STEM), ['claim', 'dispatch:mute', 'dispatch:restore', 'release']);
    rt.dispose();
});

// ---- Rock Band audio feedback: the miss clunk and the full-mix muffle ----

// A fake AudioContext on the window and a manual clock for the clunk's rate
// limit: each clunk is one oscillator. Nothing plays.
function withClunks(env) {
    const made = [];
    const t = { ms: 10000 };
    env.win.performance = { now: () => t.ms };
    env.win.AudioContext = function FakeCtx() { const c = makeFakeContext(); made.push(c); return c; };
    const count = () => made.reduce((n, c) => n + c.nodes.filter((x) => x.kind === 'osc').length, 0);
    // Moves the clock past the rate limit.
    const later = () => { t.ms += 200; };
    return { made, count, later, t };
}

test('a Rock Band controller miss, overstrum or overhit plays the clunk; a hit does not', async () => {
    const env = setup({ stems: BASS_STEMS });
    const a = withClunks(env);
    await goCtl(env);
    const canvas = env.mounts[0].ctlCanvas.ctl1;
    assert.equal(a.made.length, 0, 'no AudioContext before the first clunk');
    env.fb.emit('five_fret:hit', ffEv(canvas, { score: 50 }));
    assert.equal(a.count(), 0);
    env.fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.equal(a.count(), 1);
    a.later();
    env.fb.emit('five_fret:overstrum', ffEv(canvas, { combo: 0 }));
    assert.equal(a.count(), 2);
    a.later();
    env.fb.emit('five_fret:sustain-end', ffEv(canvas));
    assert.equal(a.count(), 2, 'a sustain end is not a miss');
    assert.equal(a.made.length, 1, 'one AudioContext');
    env.rt.dispose();
    // A drums controller's overhit (while the song plays) clunks too.
    const d = setup();
    const b = withClunks(d);
    await goCtl(d, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    const lane = d.mounts[0].ctlCanvas.ctl1;
    d.fb.isPlaying = false;
    d.fb.emit('drums:overhit', drEv(lane));
    assert.equal(b.count(), 0, 'a stray pad tap while paused');
    d.fb.isPlaying = true;
    d.fb.emit('drums:overhit', drEv(lane));
    assert.equal(b.count(), 1);
    b.later();
    d.fb.emit('drums:miss', drEv(lane, { combo: 0 }));
    assert.equal(b.count(), 2);
    d.rt.dispose();
});

test('the clunk is rate-limited: a burst of misses plays one', async () => {
    const env = setup({ stems: BASS_STEMS });
    const a = withClunks(env);
    await goCtl(env, ctlPrefs([PAD1, PAD2]));
    const { ctl1, ctl2 } = env.mounts[0].ctlCanvas;
    env.fb.emit('five_fret:miss', ffEv(ctl1, { combo: 0 }));
    a.t.ms += 20;
    env.fb.emit('five_fret:miss', ffEv(ctl2, { combo: 0, controllerKey: 'Xbox#2' }));
    a.t.ms += 20;
    env.fb.emit('five_fret:overstrum', ffEv(ctl1, { combo: 0 }));
    assert.equal(a.count(), 1);
    a.t.ms += 100;
    env.fb.emit('five_fret:miss', ffEv(ctl1, { combo: 0 }));
    assert.equal(a.count(), 2);
    env.rt.dispose();
});

test('no clunk with the miss sound off, for Always play or Song drums, or for a real part', async () => {
    const off = setup({ stems: BASS_STEMS });
    const a = withClunks(off);
    await goCtl(off, { ...ctlPrefs(), missSound: false });
    off.fb.emit('five_fret:miss', ffEv(off.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    assert.equal(a.count(), 0);
    assert.equal(a.made.length, 0, 'no AudioContext either');
    off.rt.dispose();
    const always = setup({ stems: BASS_STEMS });
    const b = withClunks(always);
    await goCtl(always, ctlPrefs([{ ...PAD1, partAudio: 'always' }]));
    always.fb.emit('five_fret:miss', ffEv(always.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    assert.equal(b.count(), 0);
    always.rt.dispose();
    const song = setup();
    const c = withClunks(song);
    await goCtl(song, padPrefs([{ ...KIT1, soundMode: 'song' }], noRealDrums), DRUM_ITEM);
    song.fb.emit('drums:miss', drEv(song.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    assert.equal(c.count(), 0);
    song.rt.dispose();
    // A real guitarist's miss: note_detect's judgment never clunks.
    const real = setup();
    const r = withClunks(real);
    real.rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    real.loadSong(DRUM_ITEM);
    real.fireWin('notedetect:miss', { t: 1, s: 0, f: 3 });
    assert.equal(r.count(), 0);
    real.rt.dispose();
});

test('no WebAudio: a miss is still judged, nothing throws', async () => {
    const env = setup({ stems: BASS_STEMS });
    await goCtl(env);
    env.fb.emit('five_fret:miss', ffEv(env.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    assert.deepEqual(stemSoundKinds(env.calls, BASS_STEM), ['claim', 'dispatch:mute'], 'the drop-out still happens');
    env.rt.dispose();
});

// An unsplit song (no stems listed, no stem_ids): core's <audio> at the Song fader's 80%.
function unsplit(opts = {}) {
    const env = setup({ stems: [], ...opts });
    env.audio.volume = 0.8;
    const applied = [];
    env.fb.audio = {
        readSongVolume: () => 80,
        applySongVolume: () => { applied.push(env.audio.volume); env.audio.volume = 0.8; return Promise.resolve(80); },
    };
    return { env, applied };
}
const dipped = (env) => Math.abs(env.audio.volume - 0.32) < 1e-9;
// The controller plays alone (a real part would share the full mix and keep it).
const NO_REAL = { guitar: { on: false }, drums: { on: false } };
const soloCtl = (c = PAD1) => ctlPrefs([c], NO_REAL);

test('unsplit song: a controller miss dips the full mix, a hit brings it back; no stem claim', async () => {
    const { env, applied } = unsplit();
    await goCtl(env, soloCtl());
    const canvas = env.mounts[0].ctlCanvas.ctl1;
    env.fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.ok(dipped(env), `dipped to 40% (${env.audio.volume})`);
    env.fb.emit('five_fret:overstrum', ffEv(canvas, { combo: 0 }));
    env.fb.emit('five_fret:hit', ffEv(canvas, { score: 50 }));
    await flush();
    assert.equal(env.audio.volume, 0.8);
    assert.equal(applied.length, 1, "restored once, through core's Song fader");
    // A seek brings it back too.
    env.fb.emit('five_fret:miss', ffEv(canvas, { combo: 0, score: 50 }));
    assert.ok(dipped(env));
    env.fb.emit('song:seek', { from: 10, to: 4 });
    await flush();
    assert.equal(env.audio.volume, 0.8);
    assert.deepEqual(capCalls(env.calls, 'claim'), [], 'the full mix takes no stems claim');
    env.rt.dispose();
});

test("unsplit song: a 'full'-only sloppak under JUCE dips the engine's backing gain", async () => {
    const { env, applied } = unsplit({ stems: ['full'] });
    const gains = [];
    env.win._juceMode = true;
    env.win.feedBackDesktop = { audio: { setGain: (bus, v) => { gains.push([bus, v]); return Promise.resolve(); } } };
    await goCtl(env, soloCtl());
    const canvas = env.mounts[0].ctlCanvas.ctl1;
    env.fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.equal(gains.length, 1);
    assert.equal(gains[0][0], 'backing');
    assert.ok(Math.abs(gains[0][1] - 0.32) < 1e-9);
    env.fb.emit('five_fret:hit', ffEv(canvas, { score: 50 }));
    await flush();
    assert.equal(applied.length, 1, 'the Song fader re-applied');
    assert.deepEqual(capCalls(env.calls, 'claim'), []);
    env.rt.dispose();
});

test('unsplit song: every exit path brings the full mix back', async () => {
    const exits = {
        'Next song': (e) => { e.fb.emit('song:ended', {}); e.rt.next(); },
        'Play again': (e) => { e.fb.emit('song:ended', {}); e.rt.again(); },
        'song:stop': (e) => e.fb.emit('song:stop', {}),
        'screen:changing away': (e) => e.fb.emit('screen:changing', { id: 'v3-songs', from: 'player' }),
        dispose: (e) => e.rt.dispose(),
    };
    for (const [name, exit] of Object.entries(exits)) {
        const { env } = unsplit();
        await goCtl(env, soloCtl());
        env.fb.emit('five_fret:miss', ffEv(env.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
        assert.ok(dipped(env), name);
        exit(env);
        await flush();
        assert.equal(env.audio.volume, 0.8, name);
        env.rt.dispose();
    }
});

test('unsplit song: a failed-out band muffles the mix until the session ends', async () => {
    const { env } = unsplit();
    const { rt, fb, mounts, clock } = env;
    await goCtl(env, { ...ctlPrefs([{ ...PAD1, partAudio: 'always' }], NO_REAL), failMode: 'fail' });
    const canvas = mounts[0].ctlCanvas.ctl1;
    for (let i = 0; i < 13; i++) {
        clock.t = 20 + i;
        fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    }
    assert.equal(env.audio.volume, 0.8, 'Always play: misses keep the mix');
    clock.t = 40;
    fb.emit('five_fret:miss', ffEv(canvas, { combo: 0 }));
    assert.equal(rt.snapshot().parts.ctl1.failed, true);
    assert.ok(dipped(env), 'out: muffled');
    fb.emit('song:stop', {});
    await flush();
    assert.equal(env.audio.volume, 0.8);
    rt.dispose();
});

test('a split song without the controller part stem leaves the mix alone', async () => {
    const env = setup({ stems: ['guitar', 'drums'] });
    env.audio.volume = 0.8;
    await goCtl(env, soloCtl());
    env.fb.emit('five_fret:miss', ffEv(env.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    await flush();
    assert.equal(env.audio.volume, 0.8);
    assert.deepEqual(capCalls(env.calls, 'claim'), []);
    env.rt.dispose();
});

test('a real part beside the controller on an unsplit song keeps the mix', async () => {
    const { env } = unsplit();
    await goCtl(env, ctlPrefs([PAD1], { drums: { on: false } }));
    assert.equal(env.mounts[0].prefs.parts.guitar.on, true);
    env.fb.emit('five_fret:miss', ffEv(env.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    await flush();
    assert.equal(env.audio.volume, 0.8);
    env.rt.dispose();
});

// ---- Play layer (contract §2, §3, §4, §6) ----

// Kit solo: the real drummer alone on #highway (no controllers).
const kitSolo = (drums = {}) => ({ ...prefsWith({ guitar: { on: false }, drums: { soundMode: 'song', ...drums } }), controllers: [] });
// Records the core bus's play:* events.
function playEvents(fb) {
    const got = { judgment: [], result: [] };
    fb.on('play:judgment', (e) => got.judgment.push(e.detail));
    fb.on('play:result', (e) => got.result.push(e.detail));
    return got;
}

test('play:judgment for every ledger entry, with the session id and who played', () => {
    const env = setup();
    const { rt, fb, loadSong, highwayCanvas, clock } = env;
    const got = playEvents(fb);
    rt.startSession({ song: DRUM_ITEM, prefs: kitSolo({ difficulty: 'expert' }), solo: true });
    loadSong(DRUM_ITEM);
    clock.t = 4;
    fb.emit('drums:hit', drEv(highwayCanvas, { points: 50, combo: 3, multiplier: 2 }));
    fb.emit('drums:miss', drEv(highwayCanvas, { combo: 0 }));
    // Another canvas's judgment is not the band's: no entry, no event.
    fb.emit('drums:hit', drEv(env.doc.createElement('canvas'), { points: 50 }));
    assert.equal(got.judgment.length, 2);
    const [hit, miss] = got.judgment;
    assert.deepEqual(hit, { filename: DRUM_ITEM.filename, sessionId: hit.sessionId, player: 'drums', instrument: 'drums',
        part: 'drums', input: 'kit', kind: 'hit', points: 50, multiplier: 2, streak: 3, t: 4, noteTime: null });
    assert.equal(typeof hit.sessionId, 'string');
    assert.equal(miss.kind, 'miss');
    assert.equal(miss.sessionId, hit.sessionId);
    rt.dispose();
});

test('play:result once when the results open, never on leaving mid-song; a new session id each session', async () => {
    const env = setup();
    const { rt, fb, loadSong, highwayCanvas, clock } = env;
    const got = playEvents(fb);
    rt.startSession({ song: DRUM_ITEM, prefs: kitSolo({ difficulty: 'hard' }), solo: true });
    loadSong(DRUM_ITEM);
    fb.emit('drums:hit', drEv(highwayCanvas, { points: 100, combo: 1 }));
    clock.t = 200;
    fb.emit('song:ended', {});
    assert.equal(got.result.length, 1);
    const r = got.result[0];
    assert.deepEqual([r.filename, r.band, r.practice, r.durationSec], [DRUM_ITEM.filename, false, false, 200]);
    assert.equal(r.sessionId, got.judgment[0].sessionId);
    assert.equal(r.players.length, 1);
    const p = r.players[0];
    assert.deepEqual([p.player, p.instrument, p.part, p.input, p.difficulty, p.hits, p.misses, p.accuracy, p.fullCombo, p.arrangement],
        ['drums', 'drums', 'drums', 'kit', 'hard', 1, 0, 1, true, null]);
    assert.deepEqual(p.sections, []);
    assert.deepEqual([p.proDrums, p.failed], [false, false]);
    rt.again();
    await flush();
    loadSong(DRUM_ITEM);
    fb.emit('drums:hit', drEv(highwayCanvas, { points: 100, combo: 1 }));
    assert.notEqual(got.judgment[1].sessionId, r.sessionId, 'Play again is a new session');
    fb.emit('song:stop', {});
    assert.equal(got.result.length, 1, 'leaving mid-song sends no result');
    rt.dispose();
});

test('drums:bonus scores points only, on the real drummer and on a drums controller lane', async () => {
    const env = setup();
    const { rt, fb, loadSong, highwayCanvas } = env;
    const got = playEvents(fb);
    rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    loadSong(DRUM_ITEM);
    fb.emit('drums:hit', drEv(highwayCanvas, { points: 100, combo: 5, multiplier: 2 }));
    fb.emit('drums:bonus', { canvas: highwayCanvas, points: 1500, reason: 'solo' });
    const d = rt.snapshot().parts.drums;
    assert.deepEqual([d.score, d.streak, d.hits], [1600, 5, 1]);
    assert.deepEqual([got.judgment[1].kind, got.judgment[1].points, got.judgment[1].streak], ['bonus', 1500, 5]);
    rt.dispose();
    const c = setup();
    await goCtl(c, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    c.fb.emit('drums:bonus', { canvas: c.mounts[0].ctlCanvas.ctl1, points: 700, reason: 'solo' });
    assert.equal(c.rt.snapshot().parts.ctl1.score, 700);
    c.rt.dispose();
});

test('Rock Band mutes the drums pads for the session; other modes leave them', async () => {
    const env = setup();
    const pads = [];
    env.win.feedBackDrums.setPadSound = (o) => { pads.push(o); return { muted: !!o.muted, volume: 1 }; };
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    env.loadSong(STEM_ITEM);
    assert.deepEqual(pads, [{ muted: true }]);
    env.fb.emit('song:stop', {});
    assert.deepEqual(pads, [{ muted: true }, { muted: false }]);
    env.rt.dispose();
    const song = setup();
    const p2 = [];
    song.win.feedBackDrums.setPadSound = (o) => { p2.push(o); return o; };
    song.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'song' }), solo: true });
    song.loadSong(STEM_ITEM);
    song.fb.emit('song:stop', {});
    assert.deepEqual(p2, []);
    song.rt.dispose();
    // A drums controller in Rock Band mutes them too.
    const ctl = setup();
    const p3 = [];
    ctl.win.feedBackDrums.setPadSound = (o) => { p3.push(o); return o; };
    await goCtl(ctl, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    assert.deepEqual(p3, [{ muted: true }]);
    ctl.rt.dispose();
    assert.deepEqual(p3, [{ muted: true }, { muted: false }]);
});

test('without setPadSound, Rock Band falls back to window.__drumsMutePads', () => {
    const env = setup();
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    env.loadSong(STEM_ITEM);
    assert.equal(env.win.__drumsMutePads, true);
    env.fb.emit('song:stop', {});
    assert.equal(env.win.__drumsMutePads, false);
    env.rt.dispose();
});

test('the real drummer in Rock Band on an unsplit song muffles the full mix on a miss', async () => {
    const { env } = unsplit();
    const item = { ...DRUM_ITEM };
    env.rt.startSession({ song: item, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    env.loadSong(item);
    assert.equal(env.mounts[0].prefs.parts.drums.soundMode, 'rockband');
    env.fb.emit('drums:miss', drEv(env.highwayCanvas, { combo: 0 }));
    assert.ok(dipped(env), `dipped (${env.audio.volume})`);
    env.fb.emit('drums:hit', drEv(env.highwayCanvas, { points: 10 }));
    await flush();
    assert.equal(env.audio.volume, 0.8);
    env.rt.dispose();
});

// Adopt: a plain play on the drum view (core loads the song itself).
function adoptEnv({ adoptPrefs = kitSolo(), onShowSoloScreen, onQuickSetting } = {}) {
    const asked = [];
    const shown = [];
    const env = setup({ runtimeOpts: {
        adopt: (song) => { asked.push(song.filename); return Promise.resolve(adoptPrefs); },
        onShowSoloScreen: onShowSoloScreen || ((o) => shown.push(o)),
        onQuickSetting,
    } });
    return { env, asked, shown };
}

test('a plain play outside a session is adopted: playing at once, no playSong, stage and HUD up', async () => {
    const { env, asked } = adoptEnv();
    const { rt, calls, mounts, loadSong, fb, highwayCanvas } = env;
    loadSong(DRUM_ITEM);
    assert.equal(rt.phase(), 'idle');
    await flush();
    assert.deepEqual(asked, [DRUM_ITEM.filename]);
    assert.equal(rt.phase(), 'playing');
    assert.deepEqual(calls.playSong, []);
    assert.deepEqual(calls.setReturnScreen, []);
    assert.equal(mounts.length, 1);
    fb.emit('drums:hit', drEv(highwayCanvas, { points: 10, combo: 1 }));
    assert.equal(rt.snapshot().parts.drums.hits, 1);
    // The drum view is the user's: the band never switches it.
    assert.deepEqual(calls.setViz, []);
    fb.emit('song:stop', {});
    assert.equal(rt.phase(), 'idle');
    assert.equal(mounts[0].unmounted, 1);
    rt.dispose();
});

test('adopted results: Next song goes to the Solo screen; Play again replays as a solo session', async () => {
    const { env, shown } = adoptEnv();
    const { rt, calls, loadSong, fb } = env;
    loadSong(DRUM_ITEM);
    await flush();
    fb.emit('song:ended', {});
    rt.next();
    assert.deepEqual(shown, [{ next: true }]);
    assert.equal(calls.release, 1);
    assert.equal(calls.showScreen.includes('plugin-rockherosmith'), false);
    // Play again on an adopted play goes through playSong (the drum arrangement).
    loadSong(DRUM_ITEM);
    await flush();
    fb.emit('song:ended', {});
    rt.again();
    assert.deepEqual(calls.playSong, [['Beat.sloppak', 1]]);
    loadSong(DRUM_ITEM);
    fb.emit('song:ended', {});
    rt.next();
    assert.equal(shown.length, 2, 'the replay is still solo');
    rt.dispose();
});

test('playSolo sessions go to the Solo screen; band sessions to the band screen', () => {
    const { env, shown } = adoptEnv();
    const { rt, loadSong, fb } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    loadSong(DRUM_ITEM);
    fb.emit('song:ended', {});
    rt.next();
    assert.equal(shown.length, 1);
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    fb.emit('song:ended', {});
    rt.next();
    assert.equal(shown.length, 1);
    assert.ok(env.calls.showScreen.includes('plugin-rockherosmith'));
    rt.dispose();
});

test('no adopt: off (null prefs), no hook, a song change or stop before it answers, or a dispose', async () => {
    const off = adoptEnv({ adoptPrefs: null });
    off.env.loadSong(DRUM_ITEM);
    await flush();
    assert.equal(off.env.rt.phase(), 'idle');
    off.env.rt.dispose();
    const none = setup();
    none.loadSong(DRUM_ITEM);
    await flush();
    assert.equal(none.rt.phase(), 'idle');
    none.rt.dispose();
    const moved = adoptEnv();
    moved.env.loadSong(DRUM_ITEM);
    moved.env.fb.emit('song:loading', { filename: 'other.psarc' });
    await flush();
    assert.equal(moved.env.rt.phase(), 'idle');
    moved.env.rt.dispose();
    const stopped = adoptEnv();
    stopped.env.loadSong(DRUM_ITEM);
    stopped.env.fb.emit('song:stop', {});
    await flush();
    assert.equal(stopped.env.rt.phase(), 'idle');
    stopped.env.rt.dispose();
    const gone = adoptEnv();
    gone.env.loadSong(DRUM_ITEM);
    gone.env.rt.dispose();
    await flush();
    assert.equal(gone.env.rt.phase(), 'idle');
    assert.equal(gone.env.mounts.length, 0);
});

test('a song RockHeroSmith started is never adopted', async () => {
    const { env, asked } = adoptEnv();
    env.rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    env.loadSong(DRUM_ITEM);
    await flush();
    assert.deepEqual(asked, []);
    assert.equal(env.mounts.length, 1);
    env.rt.dispose();
});

test('five_fret:quick-setting on a session lane reaches onQuickSetting with solo', async () => {
    const got = [];
    const { env } = adoptEnv({ onQuickSetting: (d, o) => got.push([d.key, d.value, o.solo]) });
    await goCtl(env);
    const canvas = env.mounts[0].ctlCanvas.ctl1;
    env.fb.emit('five_fret:quick-setting', { canvas, controllerKey: 'Xbox#1', key: 'difficulty', value: 'hard', lane: true });
    env.fb.emit('five_fret:quick-setting', { canvas: env.doc.createElement('canvas'), key: 'difficulty', value: 'easy', lane: true });
    assert.deepEqual(got, [['difficulty', 'hard', false]]);
    env.rt.dispose();
});

test('play:result proDrums reads the drums engine state at the results', () => {
    const env = setup();
    const got = playEvents(env.fb);
    env.od.drums = { proDrums: true };
    env.rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(DRUM_ITEM);
    env.fb.emit('song:ended', {});
    assert.equal(got.result[0].players[0].proDrums, true);
    env.rt.dispose();
});

test('soloActive: only while a solo or adopted session with a scoring player runs; never pending, a band or a refused adopt', async () => {
    const { env } = adoptEnv();
    const { rt, loadSong, fb } = env;
    assert.equal(rt.soloActive(), false);
    loadSong(DRUM_ITEM);
    assert.equal(rt.soloActive(), false, 'pending: no scoring player yet');
    await flush();
    assert.equal(rt.soloActive(), true, 'adopted');
    fb.emit('song:stop', {});
    assert.equal(rt.soloActive(), false);
    rt.startSession({ song: DRUM_ITEM, prefs: prefsWith() });
    loadSong(DRUM_ITEM);
    assert.equal(rt.soloActive(), false, 'a band session');
    rt.dispose();
    const off = adoptEnv({ adoptPrefs: null });
    off.env.loadSong(DRUM_ITEM);
    await flush();
    assert.equal(off.env.rt.soloActive(), false);
    off.env.rt.dispose();
});

test('play:result proDrums falls back to the drums judgment detail when the state has none', async () => {
    const env = setup();
    const got = playEvents(env.fb);
    env.rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(DRUM_ITEM);
    env.fb.emit('drums:hit', drEv(env.highwayCanvas, { points: 10, proDrums: true }));
    env.fb.emit('song:ended', {});
    assert.equal(got.result[0].players[0].proDrums, true);
    env.rt.dispose();
    // A state that says false wins over an older event.
    const s2 = setup();
    const g2 = playEvents(s2.fb);
    s2.od.drums = { proDrums: false };
    s2.rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    s2.loadSong(DRUM_ITEM);
    s2.fb.emit('drums:hit', drEv(s2.highwayCanvas, { points: 10, proDrums: true }));
    s2.fb.emit('song:ended', {});
    assert.equal(g2.result[0].players[0].proDrums, false);
    s2.rt.dispose();
    // A drums controller lane's detail.
    const c = setup();
    const g3 = playEvents(c.fb);
    await goCtl(c, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    c.fb.emit('drums:hit', drEv(c.mounts[0].ctlCanvas.ctl1, { points: 10, proDrums: true }));
    c.fb.emit('song:ended', {});
    assert.equal(g3.result[0].players.find((p) => p.player === 'ctl1').proDrums, true);
    c.rt.dispose();
});

// ---- PR #3 review fixes ----

test('an adopted 5-fret play scores: the part comes from the adopt, not core\'s song', async () => {
    // Core's currentSong (loadSong) carries no five_fret_parts.
    const adoptPrefs = { prefs: { ...prefsWith(NO_REAL), controllers: [{ ...PAD1, part: 'bass' }] },
        song: { filename: FF_ITEM.filename, five_fret_parts: ['bass:chart'] } };
    const { env } = adoptEnv({ adoptPrefs });
    const got = playEvents(env.fb);
    env.loadSong(FF_ITEM);
    await flush();
    assert.equal(env.rt.phase(), 'playing');
    assert.equal(env.rt.soloActive(), true);
    const canvas = env.mounts[0].ctlCanvas.ctl1;
    assert.ok(canvas, 'the controller has a lane');
    env.fb.emit('five_fret:hit', ffEv(canvas, { score: 50 }));
    assert.equal(env.rt.snapshot().parts.ctl1.hits, 1);
    assert.equal(got.judgment[0].instrument, 'five_fret');
    env.rt.dispose();
});

test('an adopt with no scoring player does not adopt', async () => {
    // 5-fret prefs on a song with no 5-fret part: nobody can play.
    const adoptPrefs = { ...prefsWith(NO_REAL), controllers: [{ ...PAD1 }] };
    const { env } = adoptEnv({ adoptPrefs });
    env.loadSong(FF_ITEM);
    await flush();
    assert.equal(env.rt.phase(), 'idle');
    assert.equal(env.rt.soloActive(), false);
    assert.equal(env.mounts.length, 0);
    // A stage whose only lane fails to start: the session goes again.
    const lost = adoptEnv({ adoptPrefs: { prefs: adoptPrefs, song: { filename: FF_ITEM.filename, five_fret_parts: ['bass:chart'] } } });
    lost.env.failLanes.add('ctl1');
    lost.env.loadSong(FF_ITEM);
    await flush();
    assert.equal(lost.env.rt.phase(), 'idle');
    assert.equal(lost.env.rt.soloActive(), false);
    env.rt.dispose();
    lost.env.rt.dispose();
});

test('a pending adopt is dropped once the song ended', async () => {
    const { env, asked } = adoptEnv();
    env.loadSong(DRUM_ITEM);
    env.fb.emit('song:ended', {});
    await flush();
    assert.deepEqual(asked, [DRUM_ITEM.filename]);
    assert.equal(env.rt.phase(), 'idle');
    env.rt.dispose();
});

test('an adopted kit keeps the player\'s own difficulty on #highway (no band pin)', async () => {
    const { env } = adoptEnv({ adoptPrefs: kitSolo({ difficulty: 'easy' }) });
    env.loadSong(DRUM_ITEM);
    await flush();
    assert.equal(env.rt.phase(), 'playing');
    assert.deepEqual(env.calls.setDifficulty, []);
    assert.deepEqual(env.calls.inputTarget.filter(Boolean), [env.highwayCanvas], 'still the input target');
    env.rt.dispose();
});

test('Rock Band pads: muted only when a drop-out applies; stems not reported yet is Song + pads until they are', () => {
    // Split song without a drum stem: the session already plays Song + pads.
    const split = setup({ stems: ['guitar'] });
    const p1 = [];
    split.win.feedBackDrums.setPadSound = (o) => { p1.push(o); return o; };
    split.rt.startSession({ song: { ...DRUM_ITEM, stem_ids: ['guitar'] }, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    split.loadSong(DRUM_ITEM);
    assert.deepEqual(p1, []);
    split.rt.dispose();
    // Stems not listed yet (a split song): no mute until stems reports a drum stem.
    const stems = [];
    const late = setup({ stems });
    const p2 = [];
    late.win.feedBackDrums.setPadSound = (o) => { p2.push(o); return o; };
    late.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    late.loadSong(STEM_ITEM);
    assert.deepEqual(p2, []);
    stems.push('guitar', 'drums');
    late.fireWin('stems:state', { event: 'provider-ready', stemIds: ['guitar', 'drums'] });
    assert.deepEqual(p2, [{ muted: true }]);
    late.rt.dispose();
    assert.deepEqual(p2, [{ muted: true }, { muted: false }]);
});

test('pad mute: restored to what it was before, first thing at teardown', () => {
    const env = setup();
    const pads = [];
    let muted = true;
    env.win.feedBackDrums.getPadSound = () => ({ muted, volume: 1 });
    env.win.feedBackDrums.setPadSound = (o) => { pads.push(o); muted = !!o.muted; return { muted, volume: 1 }; };
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    env.loadSong(STEM_ITEM);
    env.fb.emit('song:stop', {});
    assert.deepEqual(pads, [], 'already muted: nothing to do or undo');
    env.rt.dispose();
    const b = setup();
    const order = [];
    b.win.feedBackDrums.getPadSound = () => ({ muted: false, volume: 1 });
    b.win.feedBackDrums.setPadSound = (o) => { order.push(['pads', o.muted, b.mounts[0].unmounted]); return o; };
    b.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    b.loadSong(STEM_ITEM);
    b.fb.emit('song:stop', {});
    assert.deepEqual(order, [['pads', true, 0], ['pads', false, 0]], 'unmuted before the stage goes');
    b.rt.dispose();
    // The __drumsMutePads fallback keeps a value that was already set.
    const c = setup();
    c.win.__drumsMutePads = true;
    c.rt.startSession({ song: STEM_ITEM, prefs: kitSolo({ soundMode: 'rockband' }), solo: true });
    c.loadSong(STEM_ITEM);
    c.fb.emit('song:stop', {});
    assert.equal(c.win.__drumsMutePads, true);
    c.rt.dispose();
});

test('play:result reports the difficulty at song end: a 5-fret quick setting, the drums plugin pick', async () => {
    const env = setup();
    const got = playEvents(env.fb);
    await goCtl(env, ctlPrefs([PAD1], NO_REAL));
    const canvas = env.mounts[0].ctlCanvas.ctl1;
    env.fb.emit('five_fret:quick-setting', { canvas, controllerKey: 'Xbox#1', key: 'difficulty', value: 'hard', lane: true });
    env.fb.emit('song:ended', {});
    assert.equal(got.result[0].players[0].difficulty, 'hard');
    env.rt.dispose();
    const d = setup();
    const g2 = playEvents(d.fb);
    d.win.feedBackDrums.getDifficulty = (c) => (c === d.highwayCanvas ? 'expert_plus' : null);
    d.rt.startSession({ song: DRUM_ITEM, prefs: kitSolo({ difficulty: 'easy' }), solo: true });
    d.loadSong(DRUM_ITEM);
    d.fb.emit('song:ended', {});
    assert.equal(g2.result[0].players[0].difficulty, 'expert');
    d.rt.dispose();
});

// ---- B1: the in-song Part sheet and a live sound-mode switch ----

// The plugins' quick settings, recorded: [plugin, el, opts], with a destroy count.
function quickSettings(env) {
    const mounts = [];
    const fake = (plugin) => (el, opts) => {
        const m = { plugin, el, opts, destroyed: 0 };
        mounts.push(m);
        return { destroy() { m.destroyed++; } };
    };
    env.win.feedBackDrums.mountQuickSettings = fake('drums');
    if (env.win.feedBackFiveFret) env.win.feedBackFiveFret.mountQuickSettings = fake('five_fret');
    return mounts;
}
const sheetEl = (env) => env.player.querySelector('.rhs-part-sheet');

test("P opens the Part sheet over the playing kit solo without pausing; P closes it", () => {
    const env = setup();
    const qs = quickSettings(env);
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(STEM_ITEM);
    const p = env.keyWin('KeyP', 'p');
    assert.equal(p.defaultPrevented, true);
    assert.ok(sheetEl(env));
    assert.equal(env.rt.stageUi().partSheet, true);
    assert.equal(env.calls.pause, 0, 'opening never pauses');
    assert.equal(env.calls.togglePlay, 0);
    assert.deepEqual(qs.map((m) => m.plugin), ['drums']);
    assert.equal(qs[0].opts.canvas, env.highwayCanvas, 'the kit plays on #highway');
    assert.deepEqual(qs[0].opts.soundModes.map((m) => m.id), ['rockband', 'song', 'kit']);
    assert.equal(qs[0].opts.soundMode, 'song');
    // M does nothing under the sheet; P again closes it.
    env.keyWin('KeyM', 'm');
    assert.equal(env.rt.stageUi().sidebar, false);
    env.keyWin('KeyP', 'p');
    assert.equal(sheetEl(env), null);
    assert.equal(qs[0].destroyed, 1);
    assert.equal(env.rt.stageUi().partSheet, false);
    env.rt.dispose();
});

test("the stage menu's Part item opens the sheet; a guitar-only band has none", () => {
    const env = setup();
    quickSettings(env);
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(STEM_ITEM);
    env.keyWin('KeyM', 'm');
    const item = env.sidebar.querySelector('.rhs-sidebar-item');
    assert.ok(item);
    assert.equal(item.textContent, 'Part');
    item.click();
    assert.equal(env.rt.stageUi().sidebar, false);
    assert.ok(sheetEl(env));
    env.rt.dispose();
    const g = setup();
    g.rt.startSession({ song: ITEM, prefs: prefsWith({ drums: { on: false } }) });
    g.loadSong(ITEM);
    g.keyWin('KeyM', 'm');
    assert.equal(g.sidebar.querySelector('.rhs-sidebar-item'), null);
    assert.equal(g.keyWin('KeyP', 'p').defaultPrevented, false, 'P is left alone');
    assert.equal(g.rt.openPartSheet(), false);
    g.rt.dispose();
});

test("a band's sheet has the real drummer, each drums controller and each 5-fret controller on its lane", async () => {
    const env = setup();
    const qs = quickSettings(env);
    await goCtl(env, ctlPrefs([{ ...KIT1, id: 'ctl1' }, { ...PAD1, id: 'ctl2' }], { guitar: { on: true }, drums: { on: true } }), { ...FF_ITEM, stem_ids: ['guitar', 'drums'] });
    assert.equal(env.rt.openPartSheet(), true);
    const m = env.mounts[0];
    assert.deepEqual(qs.map((q) => [q.plugin, q.opts.canvas]), [
        ['drums', m.drumCanvas], ['drums', m.ctlCanvas.ctl1], ['five_fret', m.ctlCanvas.ctl2],
    ]);
    assert.equal(qs[2].opts.controllerKey, 'Xbox#1');
    assert.equal(qs[1].opts.soundMode, 'rockband');
    env.rt.dispose();
    assert.equal(sheetEl(env), null, 'teardown closes it');
    assert.deepEqual(qs.map((q) => q.destroyed), [1, 1, 1]);
});

test("the real drummer's sound mode switches live: drum stem, pads, saved prefs, no restart", async () => {
    const env = setup();
    const qs = quickSettings(env);
    const pads = [];
    env.win.feedBackDrums.setPadSound = (o) => { pads.push(o); return { muted: !!o.muted, volume: 1 }; };
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(STEM_ITEM);
    env.rt.openPartSheet();
    qs[0].opts.onSoundMode('kit');
    assert.deepEqual(env.rt.drumSound(), { mode: 'kit', muted: true });
    assert.deepEqual(soundCommand(env.calls, 'mute').map((r) => r.args), [{ id: 'drums', claimId: SOUND_CLAIM }]);
    assert.equal(loadSavedPrefs(env.storage).parts.drums.soundMode, 'kit');
    assert.deepEqual(pads, []);
    // Rock Band: the stem comes back (no drop yet) and the pads go quiet.
    qs[0].opts.onSoundMode('rockband');
    await flush();
    assert.equal(soundCommand(env.calls, 'restore').length, 1);
    assert.deepEqual(env.rt.drumSound(), { mode: 'rockband', muted: false });
    assert.deepEqual(pads, [{ muted: true }]);
    env.fb.emit('drums:miss', drEv(env.highwayCanvas, { combo: 0 }));
    assert.equal(soundCommand(env.calls, 'mute').length, 2, 'a miss drops the stem now');
    // Song + pads: the stem back, the pads back, the mode gone.
    qs[0].opts.onSoundMode('song');
    await flush();
    assert.equal(soundCommand(env.calls, 'restore').length, 2);
    assert.equal(env.rt.drumSound(), null);
    assert.deepEqual(pads, [{ muted: true }, { muted: false }]);
    assert.equal(loadSavedPrefs(env.storage).parts.drums.soundMode, 'song');
    assert.equal(env.calls.playSong.length, 1, 'the song never restarts');
    assert.equal(env.mounts.length, 1);
    assert.equal(env.calls.pause, 0);
    env.fb.emit('song:stop', {});
    assert.deepEqual(pads, [{ muted: true }, { muted: false }], 'nothing left to release');
    env.rt.dispose();
});

test('a mode the stems can not play: Kit only on an unsplit song plays Song + pads; bad ids do nothing', () => {
    const { env } = unsplit();
    env.rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(DRUM_ITEM);
    assert.equal(env.rt.setSoundMode('drums', 'kit'), true);
    assert.equal(env.rt.drumSound(), null, 'no drum stem: the song keeps its drums');
    assert.equal(loadSavedPrefs(env.storage).parts.drums.soundMode, 'kit', 'the pick is still saved');
    assert.equal(env.rt.setSoundMode('drums', 'loud'), false);
    assert.equal(env.rt.setSoundMode('ctl9', 'kit'), false);
    assert.equal(env.rt.setSoundMode('guitar', 'kit'), false);
    env.rt.dispose();
});

test("a drums controller's sound mode switches live and goes into its saved entry", async () => {
    const env = setup();
    const qs = quickSettings(env);
    const pads = [];
    env.win.feedBackDrums.setPadSound = (o) => { pads.push(o); return o; };
    savePrefsTo({ controllers: [KIT1] }, env.storage);
    await goCtl(env, padPrefs([KIT1], noRealDrums), DRUM_ITEM);
    assert.deepEqual(pads, [{ muted: true }], 'Rock Band: pads quiet');
    env.rt.openPartSheet();
    // Kit only: the drums stem mutes under the controller's stem claim, the pads play.
    qs[0].opts.onSoundMode('kit');
    await flush();
    assert.deepEqual(stemSoundKinds(env.calls, DRUMS_STEM), ['claim', 'dispatch:mute']);
    assert.deepEqual(pads, [{ muted: true }, { muted: false }]);
    assert.equal(loadSavedPrefs(env.storage).controllers[0].soundMode, 'kit');
    // Song + pads: the stem comes back and is released.
    qs[0].opts.onSoundMode('song');
    await flush();
    assert.deepEqual(stemSoundKinds(env.calls, DRUMS_STEM).slice(2), ['dispatch:restore', 'release']);
    env.fb.emit('drums:miss', drEv(env.mounts[0].ctlCanvas.ctl1, { combo: 0 }));
    assert.equal(stemSoundKinds(env.calls, DRUMS_STEM).length, 4, 'a miss drops nothing in Song + pads');
    env.rt.dispose();
});

test('a solo controller with no saved entry saves into the Solo choices', async () => {
    const env = setup();
    quickSettings(env);
    env.rt.startSession({ song: DRUM_ITEM, prefs: padPrefs([KIT1], noRealDrums), solo: true });
    await flush();
    env.loadSong(DRUM_ITEM);
    assert.equal(env.rt.setSoundMode('ctl1', 'song'), true);
    assert.equal(loadSavedPrefs(env.storage).solo.soundMode, 'song');
    env.rt.dispose();
});

test('the results close the sheet without a resume', () => {
    const env = setup();
    const qs = quickSettings(env);
    env.rt.startSession({ song: STEM_ITEM, prefs: kitSolo(), solo: true });
    env.loadSong(STEM_ITEM);
    env.rt.openPartSheet();
    env.fb.emit('song:ended', {});
    assert.equal(sheetEl(env), null);
    assert.equal(qs[0].destroyed, 1);
    assert.deepEqual(env.calls.resume, []);
    env.rt.dispose();
});

// ---- Leaving a solo or adopted session mid-song goes to the Solo screen ----

// Core's showScreen: screen:changing, then screen:changed (as session.js / shell do).
const coreShow = (fb, id, from = 'player') => {
    fb.emit('screen:changing', { id, from });
    fb.emit('screen:changed', { id, from });
};

test('leaving a playSolo session mid-song (Esc, End song) opens the Solo screen, not band setup', () => {
    const { env, shown } = adoptEnv();
    const { rt, loadSong, fb } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    loadSong(DRUM_ITEM);
    coreShow(fb, 'plugin-rockherosmith');   // core's exit to the return screen
    assert.equal(rt.phase(), 'idle');
    assert.deepEqual(shown, [{ next: false }]);
    // Only once: a later visit to the band screen is the user's.
    coreShow(fb, 'plugin-rockherosmith', 'v3-home');
    assert.equal(shown.length, 1);
    rt.dispose();
});

test('an adopted play left mid-song goes to the Solo screen wherever core returns', async () => {
    const { env, shown } = adoptEnv();
    const { rt, loadSong, fb } = env;
    loadSong(DRUM_ITEM);
    await flush();
    assert.equal(rt.phase(), 'playing');
    coreShow(fb, 'v3-songs');
    assert.deepEqual(shown, [{ next: false }]);
    rt.dispose();
});

test('a held Back leave in a solo session goes to the Solo screen; in a band, to band setup', async () => {
    const { env, shown } = adoptEnv();
    const { rt, fb, mounts, calls, prompts } = env;
    rt.startSession({ song: DRUM_ITEM, prefs: padPrefs([KIT1], noRealDrums), solo: true });
    await flush();
    env.loadSong(DRUM_ITEM);
    const canvas = mounts[0].ctlCanvas.ctl1;
    fb.emit('drums:band-back-hold', { controllerKey: 'Kit#1', canvas });
    assert.equal(prompts.length, 1);
    prompts[0].resolve(true);
    await flush();
    assert.deepEqual(shown, [{ next: false }], 'the Solo screen');
    assert.deepEqual(calls.showScreen, [], 'never band setup');
    // Core then leaves the player for it: not opened a second time.
    coreShow(fb, 'plugin-rockherosmith-solo');
    assert.equal(shown.length, 1);
    assert.equal(rt.phase(), 'idle');
    rt.dispose();
    // A solo session without the hook: band setup, as before.
    const b = setup();
    b.rt.startSession({ song: DRUM_ITEM, prefs: padPrefs([KIT1], noRealDrums), solo: true });
    await flush();
    b.loadSong(DRUM_ITEM);
    b.fb.emit('drums:band-back-hold', { controllerKey: 'Kit#1', canvas: b.mounts[0].ctlCanvas.ctl1 });
    b.prompts[0].resolve(true);
    await flush();
    assert.deepEqual(b.calls.showScreen, ['plugin-rockherosmith']);
    b.rt.dispose();
});

test('band sessions still return to the band screen; a sidebar link is followed, not redirected', async () => {
    const { env, shown } = adoptEnv();
    const { rt, loadSong, fb } = env;
    rt.startSession({ song: ITEM, prefs: prefsWith() });
    loadSong(ITEM);
    coreShow(fb, 'plugin-rockherosmith');
    assert.deepEqual(shown, [], 'a band session: no Solo screen');
    rt.dispose();
    const b = adoptEnv();
    b.env.rt.startSession({ song: DRUM_ITEM, prefs: kitSolo(), solo: true });
    b.env.loadSong(DRUM_ITEM);
    // The sidebar's Songs link, answered Leave: the user goes to Songs.
    b.env.keyWin('KeyM', 'm');
    b.env.navLinks.songs.click = () => coreShow(b.env.fb, 'v3-songs');
    b.env.sidebar.fire('click', { target: b.env.navLinks.songs, preventDefault() {}, stopPropagation() {} });
    assert.equal(b.env.prompts.length, 1);
    b.env.prompts[0].resolve(true);
    await flush();
    assert.equal(b.env.rt.phase(), 'idle');
    assert.deepEqual(b.shown, [], 'followed to Songs, no Solo screen');
    b.env.rt.dispose();
});
