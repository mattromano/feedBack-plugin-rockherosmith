// createSoloScreen against its own skeleton in the fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSoloScreen, createOpenSolo, mountSoloScreenElement, SOLO_SCREEN_HTML, SOLO_SCREEN_ID } from '../src/solo-screen.js';
import { loadPrefs, savePrefs } from '../src/prefs.js';
import { makeDoc, makeEl, parseHtml, flush, makeTimers } from './fake-dom.mjs';

const KEY = 'rockherosmith.prefs.v1';
const SONGS = [
    { filename: 'a.psarc', title: 'Alpha', artist: 'A', arrangements: [{ name: 'Lead', index: 0 }, { name: 'Bass', index: 2 }], has_drum_tab: 1 },
    { filename: 'b.psarc', title: 'Bravo', artist: 'B', arrangements: [{ name: 'Lead', index: 0 }], has_drum_tab: 1 },
    { filename: 'c.psarc', title: 'Charlie', artist: 'C', arrangements: [{ name: 'Lead', index: 0 }], has_drum_tab: 1 },
];

function memStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function setup({ solo = {}, parts, active = true, midi = { key: 'td', name: 'TD-17', connected: true }, drums = true, fiveFret = true,
    controllers = { drums: [], five_fret: [] }, showAuto = false, songs = SONGS, total, playResult = 'started', picker = null } = {}) {
    const doc = makeDoc();
    const el = makeEl('div', doc);
    el.setAttribute('id', SOLO_SCREEN_ID);
    el.classList.add('screen');
    if (active) el.classList.add('active');
    doc.body.appendChild(el);
    parseHtml(SOLO_SCREEN_HTML, doc, el);
    const root = doc.getElementById('rockherosmith-solo-root');
    const storage = memStorage({ [KEY]: JSON.stringify({ solo, ...(parts ? { parts } : {}) }) });
    const bus = new EventTarget();
    const shown = [];
    const controls = [];
    const songsAs = [];
    const win = {
        feedBack: {
            on: (t, f) => bus.addEventListener(t, f),
            off: (t, f) => bus.removeEventListener(t, f),
            emit: (t, detail) => bus.dispatchEvent(new CustomEvent(t, { detail })),
            ui: { playSongAs: (f, o) => { songsAs.push([f, o]); return true; } },
        },
        showScreen: (id) => shown.push(id),
    };
    const listing = (kind) => ({ listControllers: async () => controllers[kind] });
    if (drums) {
        win.feedBackDrums = {
            whenMidiReady: async () => midi, midiInput: () => midi,
            openControls: (o) => controls.push(['drums', o]),
            ...listing('drums'),
        };
    }
    if (fiveFret) {
        win.feedBackFiveFret = { showAutoCharts: () => showAuto, openControls: (o) => controls.push(['five_fret', o]), ...listing('five_fret') };
    }
    const kinds = { drums: { api: () => win.feedBackDrums || null }, five_fret: { api: () => win.feedBackFiveFret || null } };
    const urls = [];
    const plays = [];
    const timers = makeTimers();
    const screen = createSoloScreen({
        root, win, doc, kinds,
        loadPrefs: () => loadPrefs(storage), savePrefs: (p) => savePrefs(p, storage),
        playSolo: async (item, opts) => { plays.push([item.filename, opts]); return playResult; },
        openBand: () => shown.push('band'),
        fetchJson: async (url) => {
            urls.push(url);
            const q = new URLSearchParams(url.split('?')[1]);
            const page = Number(q.get('page'));
            const size = Number(q.get('size'));
            return { songs: songs.slice(page * size, page * size + size), total: total === undefined ? songs.length : total };
        },
        library: picker,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    const seg = (f) => root.querySelector(`.rhs-seg[data-field="${f}"]`);
    const btn = (f, v) => seg(f).querySelector(`button[data-value="${v}"]`);
    const pressed = (f) => seg(f).querySelector('button[aria-pressed="true"]')?.getAttribute('data-value');
    const fieldHidden = (f) => root.querySelector(`.rhs-field[data-solo-field="${f}"]`).hidden;
    const rows = () => root.querySelectorAll('.rhs-solo-song');
    const params = (i = urls.length - 1) => new URLSearchParams(urls[i].split('?')[1]);
    const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
    return { doc, el, root, win, bus, screen, storage, urls, plays, shown, controls, songsAs, timers, seg, btn, pressed, fieldHidden, rows, params, settle,
        prefs: () => loadPrefs(storage), status: () => root.querySelector('.rhs-solo-status-text').textContent,
        note: () => root.querySelector('.rhs-solo-note').textContent };
}

test('shows the saved choices and only the fields the instrument uses', async () => {
    const t = setup({ solo: { instrument: 'kit', difficulty: 'hard' }, parts: { drums: { soundMode: 'kit' } } });
    await t.settle();
    assert.equal(t.pressed('instrument'), 'kit');
    assert.equal(t.pressed('difficulty'), 'hard');
    assert.equal(t.pressed('soundMode'), 'kit', 'the kit shows the real drummer\'s sound');
    assert.equal(t.pressed('crowd'), 'on');
    assert.equal(t.pressed('failMode'), 'nofail');
    assert.equal(t.pressed('autoNext'), 'off');
    assert.equal(t.fieldHidden('part'), true);
    assert.equal(t.fieldHidden('arrangement'), true);
    assert.equal(t.fieldHidden('soundMode'), false);
    assert.equal(t.root.querySelector('.rhs-solo-listlabel').textContent, 'Songs with a drum chart');
    t.screen.dispose();
});

test('on show: the drum-chart list loads, and the first song is focused for A / Enter', async () => {
    const t = setup({ solo: { instrument: 'kit' } });
    await t.settle();
    assert.equal(t.params(0).get('has_drums'), '1');
    assert.deepEqual(t.rows().map((r) => r.getAttribute('data-filename')), ['a.psarc', 'b.psarc', 'c.psarc']);
    assert.equal(t.rows()[0].querySelector('.rhs-solo-title').textContent, 'Alpha');
    assert.equal(t.doc.activeElement, t.rows()[0]);
    assert.match(t.status(), /MIDI kit: TD-17/);
    t.screen.dispose();
});

test('hidden at start: nothing loads until screen:changed brings the Solo screen up', async () => {
    const t = setup({ active: false });
    await t.settle();
    assert.equal(t.urls.length, 0);
    t.el.classList.add('active');
    t.win.feedBack.emit('screen:changed', { id: SOLO_SCREEN_ID });
    await t.settle();
    assert.equal(t.urls.length, 1);
    t.win.feedBack.emit('screen:changed', { id: 'v3-songs' });
    t.win.feedBack.emit('screen:changed', { id: SOLO_SCREEN_ID });
    await t.settle();
    assert.equal(t.urls.length, 1, 'same filter and search: the list is kept');
    t.screen.dispose();
});

test('clicking a song plays it on the kit through playSolo', async () => {
    const t = setup({ solo: { instrument: 'kit', difficulty: 'medium' } });
    await t.settle();
    t.rows()[1].click();
    await t.settle();
    assert.deepEqual(t.plays, [['b.psarc', { kind: 'kit', difficulty: 'medium' }]]);
    assert.equal(t.screen.lastPlayed(), 'b.psarc');
    t.screen.dispose();
});

test('5-fret: the part filters the list (auto charts only with the plugin setting) and plays with it', async () => {
    const t = setup({ solo: { instrument: 'drums' }, controllers: { drums: [], five_fret: [{ controllerKey: 'x', kind: 'five_fret', connected: true, name: 'Les Paul' }] } });
    await t.settle();
    t.btn('instrument', 'five_fret').click();
    await t.settle();
    assert.equal(t.prefs().solo.instrument, 'five_fret');
    assert.equal(t.params().get('five_fret'), 'guitar:chart');
    assert.equal(t.fieldHidden('part'), false);
    assert.equal(t.fieldHidden('soundMode'), true);
    t.btn('part', 'bass').click();
    await t.settle();
    assert.equal(t.prefs().solo.part, 'bass');
    assert.equal(t.params().get('five_fret'), 'bass:chart');
    assert.match(t.status(), /Les Paul/);
    t.rows()[0].click();
    await t.settle();
    assert.deepEqual(t.plays[0], ['a.psarc', { kind: 'five_fret', part: 'bass', difficulty: 'expert' }]);
    t.screen.dispose();

    const auto = setup({ solo: { instrument: 'five_fret', part: 'rhythm' }, showAuto: true });
    await auto.settle();
    assert.equal(auto.params().get('five_fret'), 'rhythm');
    auto.screen.dispose();
});

test('real guitar: the arrangement filters the list and plays through playSongAs with resetView', async () => {
    const t = setup({ solo: { instrument: 'guitar', arrangement: 'Bass' } });
    await t.settle();
    assert.equal(t.params().get('arrangements_has'), 'Bass');
    assert.equal(t.fieldHidden('difficulty'), true);
    assert.equal(t.fieldHidden('arrangement'), false);
    t.rows()[0].click();
    await t.settle();
    assert.deepEqual(t.songsAs, [['a.psarc', { arrangement: 2, resetView: true }]]);
    assert.equal(t.plays.length, 0);
    assert.equal(t.screen.lastPlayed(), 'a.psarc');
    t.screen.dispose();
});

test('no MIDI kit: a clear message, the Drums controls offered, and no play', async () => {
    const t = setup({ solo: { instrument: 'kit' }, midi: { key: 'td', name: '', connected: false } });
    await t.settle();
    assert.match(t.status(), /No MIDI kit connected/);
    const ctl = t.root.querySelector('.rhs-solo-controls');
    assert.equal(ctl.hidden, false);
    assert.equal(ctl.textContent, 'Open Drums controls');
    ctl.click();
    assert.deepEqual(t.controls, [['drums', { returnTo: SOLO_SCREEN_ID }]]);
    t.rows()[0].click();
    await t.settle();
    assert.equal(t.plays.length, 0);
    assert.match(t.note(), /No MIDI kit connected/);
    t.screen.dispose();
});

test('no controller: drum and 5-fret controllers say so and offer their controls; no plugin, no controls', async () => {
    const t = setup({ solo: { instrument: 'drums' } });
    await t.settle();
    assert.match(t.status(), /No drum controller connected/);
    assert.equal(t.root.querySelector('.rhs-solo-controls').textContent, 'Open Drums controls');
    t.btn('instrument', 'five_fret').click();
    await t.settle();
    assert.match(t.status(), /No 5-fret controller connected/);
    t.root.querySelector('.rhs-solo-controls').click();
    assert.deepEqual(t.controls, [['five_fret', { returnTo: SOLO_SCREEN_ID }]]);
    t.screen.dispose();

    const none = setup({ solo: { instrument: 'five_fret' }, fiveFret: false });
    await none.settle();
    assert.match(none.status(), /5-Fret plugin/);
    assert.equal(none.root.querySelector('.rhs-solo-controls').hidden, true);
    none.screen.dispose();
});

test('search: debounced, sent as q, and an empty result says so', async () => {
    const t = setup({ songs: [] });
    await t.settle();
    const search = t.root.querySelector('.rhs-solo-search');
    search.value = 'green day';
    search.fire('input');
    search.fire('input');
    assert.equal(t.timers.pending(), 1);
    t.timers.run();
    await t.settle();
    assert.equal(t.params().get('q'), 'green day');
    assert.equal(t.params().get('has_drums'), '1');
    assert.equal(t.note(), 'No songs match that search.');
    t.screen.dispose();
});

test('more songs: the next page is appended', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ filename: 'f' + i, title: 'T' + i }));
    const t = setup({ songs: many });
    await t.settle();
    assert.equal(t.rows().length, 100);
    const more = t.root.querySelector('.rhs-solo-more');
    assert.equal(more.hidden, false);
    more.click();
    await t.settle();
    assert.equal(t.rows().length, 150);
    assert.equal(t.params().get('page'), '1');
    assert.equal(more.hidden, true);
    t.screen.dispose();
});

test('options: crowd meter, failing, auto-next and drum sound are saved', async () => {
    const t = setup({ solo: { instrument: 'drums' }, controllers: { drums: [{ controllerKey: 'p', kind: 'drums', connected: true }], five_fret: [] } });
    await t.settle();
    t.btn('crowd', 'off').click();
    t.btn('failMode', 'fail').click();
    t.btn('autoNext', 'on').click();
    t.btn('soundMode', 'song').click();
    const p = t.prefs();
    assert.equal(p.solo.crowd, false);
    assert.equal(p.solo.failMode, 'fail');
    assert.equal(p.solo.autoNext, true);
    assert.equal(p.solo.soundMode, 'song', 'a controller solo\'s sound');
    assert.equal(t.pressed('crowd'), 'off');
    assert.equal(t.pressed('soundMode'), 'song');
    t.btn('instrument', 'kit').click();
    t.btn('soundMode', 'kit').click();
    assert.equal(t.prefs().parts.drums.soundMode, 'kit', 'the kit\'s sound is the real drummer\'s');
    assert.equal(t.prefs().solo.soundMode, 'song');
    t.screen.dispose();
});

test('open({ next }) with auto-next plays the next song in the list; without it, only shows the screen', async () => {
    const t = setup({ solo: { instrument: 'kit', autoNext: true } });
    await t.settle();
    t.rows()[0].click();
    await t.settle();
    t.screen.open({ next: true });
    await t.settle();
    assert.deepEqual(t.plays.map((p) => p[0]), ['a.psarc', 'b.psarc']);
    t.screen.open({ next: true });
    await t.settle();
    t.screen.open({ next: true });
    await t.settle();
    assert.deepEqual(t.plays.map((p) => p[0]), ['a.psarc', 'b.psarc', 'c.psarc']);
    assert.equal(t.note(), 'That was the last song in the list.');
    t.screen.dispose();

    const off = setup({ solo: { instrument: 'kit', autoNext: false }, active: false });
    await off.settle();
    off.screen.open({ next: true });
    assert.deepEqual(off.shown, [SOLO_SCREEN_ID]);
    off.el.classList.add('active');
    off.win.feedBack.emit('screen:changed', { id: SOLO_SCREEN_ID });
    await off.settle();
    assert.equal(off.plays.length, 0);
    off.screen.dispose();
});

test('auto-next from Results waits for the Solo screen to show, then plays', async () => {
    const t = setup({ solo: { instrument: 'kit', autoNext: true } });
    await t.settle();
    t.rows()[0].click();
    await t.settle();
    t.el.classList.remove('active'); // the song played on the player screen
    t.screen.open({ next: true });
    await t.settle();
    assert.equal(t.plays.length, 1, 'not yet: the Solo screen isn\'t up');
    assert.deepEqual(t.shown, [SOLO_SCREEN_ID]);
    t.el.classList.add('active');
    t.win.feedBack.emit('screen:changed', { id: SOLO_SCREEN_ID });
    await t.settle();
    assert.deepEqual(t.plays.map((p) => p[0]), ['a.psarc', 'b.psarc']);
    t.screen.dispose();
});

test('a play that cannot start says so; a burst of clicks plays once', async () => {
    const t = setup({ playResult: false });
    await t.settle();
    t.rows()[0].click();
    t.rows()[0].click();
    await t.settle();
    assert.equal(t.plays.length, 1);
    assert.match(t.note(), /couldn't start/);
    t.screen.dispose();
});

test('Browse library: core\'s pick with the instrument chip, back to Solo, and the picked song plays', async () => {
    const calls = [];
    let resolve;
    const picker = { pick: (o) => { calls.push(o); return new Promise((r) => { resolve = r; }); } };
    const t = setup({ solo: { instrument: 'five_fret', part: 'rhythm' }, picker,
        controllers: { drums: [], five_fret: [{ controllerKey: 'x', kind: 'five_fret', connected: true }] } });
    await t.settle();
    t.root.querySelector('.rhs-solo-browse').click();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].returnTo, SOLO_SCREEN_ID);
    assert.deepEqual(calls[0].filters, [{ id: 'solo', label: '5-fret Rhythm chart', params: { five_fret: 'rhythm:chart' }, on: true }]);
    resolve({ item: { filename: 'c.psarc' }, filters: { solo: true } });
    await t.settle();
    assert.deepEqual(t.plays, [['c.psarc', { kind: 'five_fret', part: 'rhythm', difficulty: 'expert' }]]);
    t.screen.dispose();
});

test('Band setup goes to the band screen', async () => {
    const t = setup();
    await t.settle();
    t.root.querySelector('.rhs-solo-band').click();
    assert.deepEqual(t.shown, ['band']);
    t.screen.dispose();
});

test('dispose: no more loads on screen:changed', async () => {
    const t = setup();
    await t.settle();
    t.screen.dispose();
    t.win.feedBack.emit('screen:changed', { id: SOLO_SCREEN_ID });
    await t.settle();
    assert.equal(t.urls.length, 1);
});

test('openSolo: the Solo screen when built, else the band screen (its pick on next)', () => {
    const calls = [];
    const solo = { open: (o) => calls.push(['open', o]) };
    createOpenSolo({ getSoloScreen: () => solo, getScreen: () => null, showScreen: (id) => calls.push(id) })({ next: true });
    assert.deepEqual(calls, [['open', { next: true }]]);
    const band = [];
    const open = createOpenSolo({ getSoloScreen: () => null, getScreen: () => ({ nextSong: () => band.push('nextSong') }), showScreen: (id) => band.push(id) });
    open();
    open({ next: true });
    assert.deepEqual(band, ['plugin-rockherosmith', 'plugin-rockherosmith', 'nextSong']);
});

test('mountSoloScreenElement: one .screen after the band screen, reused (and refilled) on a re-run', () => {
    const doc = makeDoc();
    const band = makeEl('div', doc);
    band.setAttribute('id', 'plugin-rockherosmith');
    doc.body.appendChild(band);
    const player = makeEl('div', doc);
    doc.body.appendChild(player);
    doc.body.insertBefore = (el, ref) => {
        const kids = doc.body.children;
        el.parentNode = doc.body;
        kids.splice(ref ? kids.indexOf(ref) : kids.length, 0, el);
        return el;
    };
    Object.defineProperty(band, 'nextSibling', { get: () => player });
    const el = mountSoloScreenElement(doc, band);
    assert.equal(el.id, SOLO_SCREEN_ID);
    assert.equal(el.className, 'screen');
    assert.equal(el.getAttribute('data-plugin-id'), 'rockherosmith');
    assert.equal(doc.body.children.indexOf(el), 1, 'between the band screen and the player');
    assert.equal(el.innerHTML, SOLO_SCREEN_HTML);
    assert.equal(mountSoloScreenElement(doc, band), el);
    assert.equal(doc.body.querySelectorAll('#' + SOLO_SCREEN_ID).length, 1);
    assert.equal(mountSoloScreenElement(doc, null), null);
});
