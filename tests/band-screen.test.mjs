// createBandScreen against the real screen.html skeleton in a fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBandScreen } from '../src/band-screen.js';
import { loadPrefs, savePrefs } from '../src/prefs.js';
import { makeDoc, makeEl, parseHtml, flush } from './fake-dom.mjs';

const HTML = readFileSync(new URL('../screen.html', import.meta.url), 'utf8');
const holiday = {
    filename: 'sloppak/greeholi.sloppak', title: 'Holiday', artist: 'Green Day',
    arrangements: [{ name: 'Lead', index: 0 }], has_drum_tab: true, has_vocal_pitch: false, stem_ids: [],
};

function memStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// A fake core pick hook (feedBack.library): records each pick's options and
// keeps its resolver, so a test settles the pick as core would.
function fakePickLibrary() {
    const calls = [];
    const resolvers = [];
    return {
        calls, resolvers,
        resolveLast: (result) => resolvers[resolvers.length - 1](result),
        pick(opts) { calls.push(opts); return new Promise((r) => { resolvers.push(r); }); },
    };
}

// `library` is the /api/library rows; `picker` is the core pick hook (null: an old core).
function setup({ active = true, stored = null, library = [], picker = fakePickLibrary(), libraryOnWin = false, winExtra = {}, onGo = null, deviceMemo } = {}) {
    const doc = makeDoc();
    const screen = makeEl('div', doc);
    screen.setAttribute('id', 'plugin-rockherosmith');
    screen.classList.add('screen');
    if (active) screen.classList.add('active');
    doc.body.appendChild(screen);
    parseHtml(HTML, doc, screen);
    const root = doc.getElementById('rockherosmith-root');
    const storage = memStorage(stored ? { 'rockherosmith.prefs.v1': JSON.stringify(stored) } : {});
    const bus = new EventTarget();
    const fb = {
        on: (t, f) => bus.addEventListener(t, f),
        off: (t, f) => bus.removeEventListener(t, f),
        emit: (t, detail) => bus.dispatchEvent(new CustomEvent(t, { detail })),
    };
    const urls = [];
    const gos = [];
    const feedBack = { ...fb, ...(winExtra.feedBack || {}) };
    // libraryOnWin: the hook comes from window.feedBack.library (the default).
    if (libraryOnWin) feedBack.library = picker;
    const win = { ...winExtra, feedBack };
    // controller-model's CONTROLLER_KINDS read the plugin globals from window.
    globalThis.window = win;
    const bs = createBandScreen({
        root, doc, win, storage,
        loadPrefs: () => loadPrefs(storage), savePrefs: (p) => savePrefs(p, storage),
        onGo: (item, prefs) => { gos.push({ item, prefs }); return onGo ? onGo(item, prefs) : undefined; },
        fetchJson: async (url) => { urls.push(url); return { songs: library }; },
        deviceMemo, ...(libraryOnWin ? {} : { library: picker }),
    });
    const col = (id) => root.querySelector(`.rhs-col[data-part="${id}"]`);
    const part = (id) => root.querySelector(`.rhs-part[data-part="${id}"]`);
    const seg = (el, field) => el.querySelector(`.rhs-seg[data-field="${field}"]`);
    const btn = (el, field, v) => seg(el, field).querySelector(`button[data-value="${v}"]`);
    return { doc, screen, win, root, bs, fb, gos, urls, col, part, btn, picker, storage, prefs: () => loadPrefs(storage) };
}

// Puts a song on Confirm synchronously: nextSong() moves the view to Confirm
// (the library pick it opens stays pending).
function onConfirm(t, item) {
    t.bs.setSong(item);
    t.bs.nextSong();
}

test('skeleton: columns coloured from the registry, Go disabled until a song is picked', () => {
    const { root, col, bs } = setup();
    assert.equal(col('guitar').style.props['--rhs-c'], '#f5c542');
    assert.equal(col('drums').style.props['--rhs-c'], '#e0533d');
    assert.equal(col('vocals').style.props['--rhs-c'], '#a678ff');
    for (const id of ['guitar', 'drums', 'vocals']) {
        assert.ok(col(id).querySelector('.rhs-input'));
        assert.ok(col(id).querySelector('.rhs-signal'));
        assert.equal(col(id).querySelector('.rhs-toggle').getAttribute('aria-pressed'), 'true');
    }
    assert.equal(!!root.querySelector('.rhs-addslot'), false);
    assert.ok(root.querySelector('.rhs-joinslot'));
    assert.equal(root.querySelector('.rhs-joinslot').getAttribute('aria-live'), 'polite');
    assert.equal(root.querySelector('.rhs-go').disabled, true);
    assert.equal(root.querySelector('.rhs-hint').textContent, 'Pick a song');
    assert.equal(bs.isVisible(), true);
    bs.dispose();
});

test('column icons are Lucide SVGs', () => {
    const { root, bs } = setup();
    const icos = root.querySelectorAll('.rhs-col').map((c) => c.querySelector('.rhs-ico'));
    assert.equal(icos.length, 3);
    for (const ico of icos) {
        assert.ok(String(ico.innerHTML).includes('<svg'), 'Lucide SVG');
        assert.equal(ico.textContent, '', 'no emoji left');
    }
    bs.dispose();
});

test('setSong stores lastSong + recentSongs, renders chips and greys what the song lacks', () => {
    const { root, col, part, btn, bs, prefs } = setup({ winExtra: { lyricsKaraoke: karaokeFake() } });
    bs.setSong(holiday);
    assert.equal(bs.getSong(), holiday);
    assert.equal(prefs().lastSong.filename, holiday.filename);
    assert.equal(prefs().recentSongs[0].title, 'Holiday');
    assert.equal(root.querySelector('.rhs-title').textContent, 'Holiday');
    assert.equal(root.querySelectorAll('.rhs-chip').length, 5);
    assert.ok(col('vocals').classList.contains('rhs-unavailable'));
    assert.equal(col('vocals').querySelector('.rhs-note').textContent, 'No vocal pitch for this song');
    assert.ok(part('vocals').classList.contains('rhs-unavailable'));
    // An unsplit song: Rock Band muffles the whole mix, Kit only has no stem.
    assert.equal(btn(part('drums'), 'soundMode', 'rockband').disabled, false);
    assert.equal(btn(part('drums'), 'soundMode', 'kit').disabled, true);
    assert.equal(btn(part('drums'), 'soundMode', 'song').disabled, false);
    assert.equal(root.querySelector('.rhs-go').disabled, false);
    assert.equal(root.querySelector('.rhs-hint').textContent, 'Press Space or hit any pad to start');
    bs.dispose();
});

test('every control writes through savePrefs immediately', () => {
    const { root, col, part, btn, bs, prefs } = setup();
    btn(part('guitar'), 'arrangement', 'Bass').click();
    btn(part('guitar'), 'difficulty', 'expert').click();
    btn(part('drums'), 'soundMode', 'kit').click();
    btn(col('vocals'), 'hearMyself', 'on').click();
    col('vocals').querySelector('.rhs-toggle').click();
    btn(root, 'failMode', 'fail').click();
    assert.equal(btn(root, 'missSound', 'on').getAttribute('aria-pressed'), 'true', 'the miss sound starts on');
    btn(root, 'missSound', 'off').click();
    const fs = root.querySelector('input.rhs-fullscreen');
    fs.checked = false;
    fs.fire('change');
    const p = prefs();
    assert.equal(p.parts.guitar.arrangement, 'Bass');
    assert.equal(p.parts.guitar.difficulty, 'expert');
    assert.equal(p.parts.drums.soundMode, 'kit');
    assert.equal(p.parts.vocals.hearMyself, true);
    assert.equal(p.parts.vocals.on, false);
    assert.equal(p.failMode, 'fail');
    assert.equal(p.missSound, false);
    assert.equal(btn(root, 'missSound', 'off').getAttribute('aria-pressed'), 'true');
    assert.equal(p.fullScreenStage, false);
    assert.equal(btn(part('guitar'), 'difficulty', 'expert').getAttribute('aria-pressed'), 'true');
    assert.ok(col('vocals').classList.contains('rhs-off'));
    assert.ok(part('vocals').classList.contains('rhs-off'));
    assert.equal(col('vocals').querySelector('.rhs-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(part('vocals').querySelector('.rhs-toggle').getAttribute('aria-pressed'), 'false');
    part('vocals').querySelector('.rhs-toggle').click();
    assert.equal(prefs().parts.vocals.on, true, 'the Confirm toggle writes the same pref');
    assert.equal(col('vocals').querySelector('.rhs-toggle').getAttribute('aria-pressed'), 'true');
    bs.dispose();
});

test('Go button and Space call onGo only while visible and a part can play', () => {
    const t = setup();
    const { doc, root, fb, bs, gos } = t;
    doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 0, 'no song yet');
    onConfirm(t, holiday);
    doc.activeElement = { tagName: 'INPUT' };
    doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 0, 'typing in the search box');
    doc.activeElement = null;
    root.querySelector('.rhs-go').click();
    assert.equal(gos.length, 1);
    assert.equal(gos[0].item, holiday);
    doc.fire('keydown', { code: 'Space' });
    root.querySelector('.rhs-go').click();
    assert.equal(gos.length, 1, 'Go latches until the screen is shown again');
    fb.emit('screen:changed', { id: 'player', from: 'plugin-rockherosmith' });
    assert.equal(bs.isVisible(), false);
    doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 1, 'hidden');
    fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    const ev = doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 2, 'shown again: the latch resets');
    assert.equal(ev.defaultPrevented, true);
    fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    bs.dispose();
    doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 2, 'disposed');
    assert.equal(doc.listenerCount(), 0);
});

test('reopens on the last song through resolveRecent', async () => {
    const stored = { lastSong: { filename: holiday.filename, title: 'Holiday', artist: 'Green Day' } };
    const { root, bs, urls } = setup({ active: false, stored, library: [holiday] });
    assert.equal(bs.isVisible(), false);
    await flush();
    assert.deepEqual(urls, ['/api/library?q=Holiday&size=30']);
    assert.equal(bs.getSong(), holiday);
    assert.equal(root.querySelector('.rhs-title').textContent, 'Holiday');
    bs.dispose();
});

test('screen:changing away hides the screen before screen:changed arrives', () => {
    const t = setup();
    const { doc, fb, bs, gos } = t;
    onConfirm(t, holiday);
    fb.emit('screen:changing', { id: 'player', from: 'plugin-rockherosmith' });
    doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 0);
    assert.equal(bs.isVisible(), false);
    bs.dispose();
});

test('Space does nothing when the plugin screen is not .active', () => {
    const t = setup();
    const { doc, bs, gos } = t;
    onConfirm(t, holiday);
    doc.getElementById('plugin-rockherosmith').classList.remove('active');
    doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 0);
    bs.dispose();
});

// ── Input devices and signal lights (Task 10) ─────────────────────────────

function fakeAudio() {
    const connects = [];
    const contexts = [];
    class FakeAudioContext {
        constructor() { this.destination = { kind: 'destination' }; this.closed = 0; this.analysers = []; contexts.push(this); }
        createAnalyser() {
            const a = { kind: 'analyser', fftSize: 2048, connectCalls: 0, connect: (t) => { a.connectCalls++; connects.push({ from: a, to: t }); }, getFloatTimeDomainData(b) { b.fill(0.2); } };
            this.analysers.push(a);
            return a;
        }
        createMediaStreamSource() { const s = { kind: 'source', connect: (t) => { connects.push({ from: s, to: t }); } }; return s; }
        close() { this.closed++; return Promise.resolve(); }
    }
    return { FakeAudioContext, connects, contexts };
}

function deviceWin({ midiSources = [{ logicalSourceKey: 'webmidi:kit', label: 'Kit' }], gumError = null, afterDiscover = null } = {}) {
    const audio = fakeAudio();
    const frames = new Map();
    let nextFrame = 1;
    const calls = { gum: [], enumerate: 0, noteDetect: [], drums: [], midiSelect: [], open: [], close: [], discover: 0 };
    const streams = [];
    const listeners = new Set();
    const handle = { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) };
    let midi = midiSources;
    const winExtra = {
        AudioContext: audio.FakeAudioContext,
        requestAnimationFrame: (fn) => { const id = nextFrame++; frames.set(id, fn); return id; },
        cancelAnimationFrame: (id) => { frames.delete(id); },
        navigator: {
            mediaDevices: {
                enumerateDevices: async () => {
                    calls.enumerate++;
                    return [
                        { kind: 'audioinput', deviceId: 'usb-guitar', label: 'USB Guitar' },
                        { kind: 'audioinput', deviceId: 'usb-mic', label: 'USB Mic' },
                        { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' },
                    ];
                },
                getUserMedia: async (c) => {
                    calls.gum.push(c.audio.deviceId.exact);
                    if (gumError) throw Object.assign(new Error('x'), { name: gumError });
                    const tracks = [{ stopped: 0, stop() { this.stopped++; } }];
                    const st = { id: c.audio.deviceId.exact, tracks, getTracks: () => tracks };
                    streams.push(st);
                    return st;
                },
            },
        },
        noteDetect: { setDevice: (id) => calls.noteDetect.push(id) },
        feedBackDrums: { setMidiInput: (k) => calls.drums.push(k) },
        feedBack: {
            midiInput: {
                listSources: () => midi,
                discover: async () => { calls.discover++; if (afterDiscover) midi = afterDiscover; },
                select: (k) => calls.midiSelect.push(k),
                open: async (o) => { calls.open.push(o); return { outcome: 'handled', handle }; },
                close: (o) => calls.close.push(o),
            },
        },
    };
    const runFrames = () => { const fns = [...frames.values()]; frames.clear(); fns.forEach((f) => f()); };
    const hit = (data) => { for (const f of [...listeners]) f(data, 0); };
    return { winExtra, audio, calls, streams, listeners, frames, runFrames, hit };
}

const withDevices = { parts: { guitar: { deviceKey: 'usb-guitar' }, drums: { deviceKey: 'webmidi:kit' }, vocals: { deviceId: 'usb-mic' } } };
const liveStreams = (d) => d.streams.filter((s) => s.tracks.every((t) => t.stopped === 0));

test('device lists load when the screen is visible, with a select per column', async () => {
    const d = deviceWin();
    const { col, bs } = setup({ winExtra: d.winExtra });
    await flush();
    const opts = (id) => col(id).querySelector('.rhs-input').querySelector('select').querySelectorAll('option').map((o) => [o.value, o.textContent]);
    assert.deepEqual(opts('guitar').slice(1), [['usb-guitar', 'USB Guitar'], ['usb-mic', 'USB Mic']]);
    assert.deepEqual(opts('vocals').slice(1), [['usb-guitar', 'USB Guitar'], ['usb-mic', 'USB Mic']]);
    assert.deepEqual(opts('drums').slice(1), [['webmidi:kit', 'Kit']]);
    assert.equal(col('guitar').querySelector('.rhs-signal').textContent, 'Signal');
    assert.equal(col('drums').querySelector('.rhs-signal').textContent, 'Hit a pad');
    assert.equal(col('vocals').querySelector('.rhs-signal').textContent, 'Level');
    assert.equal(d.calls.gum.length, 0, 'no device picked yet: no mic opened');
    bs.dispose();
});

test('a hidden screen loads nothing and opens nothing', async () => {
    const d = deviceWin();
    const { bs } = setup({ active: false, stored: withDevices, winExtra: d.winExtra });
    await flush();
    assert.equal(d.calls.enumerate, 0);
    assert.equal(d.calls.gum.length, 0);
    assert.equal(d.calls.open.length, 0);
    bs.dispose();
});

test('picking a device saves it and applies it at once', async () => {
    const d = deviceWin();
    const { col, bs, prefs, storage } = setup({ winExtra: d.winExtra });
    await flush();
    const pick = (id, v) => { const s = col(id).querySelector('select'); s.value = v; s.fire('change'); };
    pick('guitar', 'usb-guitar');
    pick('drums', 'webmidi:kit');
    pick('vocals', 'usb-mic');
    await flush();
    assert.equal(prefs().parts.guitar.deviceKey, 'usb-guitar');
    assert.equal(prefs().parts.drums.deviceKey, 'webmidi:kit');
    assert.equal(prefs().parts.vocals.deviceId, 'usb-mic');
    assert.deepEqual(d.calls.noteDetect, ['usb-guitar']);
    assert.deepEqual(d.calls.midiSelect, ['webmidi:kit']);
    assert.deepEqual(d.calls.drums, ['webmidi:kit']);
    assert.equal(storage.getItem('lyrics_karaoke.deviceId'), 'usb-mic');
    assert.deepEqual(d.calls.gum.sort(), ['usb-guitar', 'usb-mic']);
    assert.equal(d.calls.open.length, 1);
    bs.dispose();
});

test('a device picked on the band screen is not applied again at Go', async () => {
    const d = deviceWin();
    const memo = {};
    const { col, bs } = setup({ winExtra: d.winExtra, deviceMemo: memo });
    await flush();
    const pick = (id, v) => { const s = col(id).querySelector('select'); s.value = v; s.fire('change'); };
    pick('guitar', 'usb-guitar');
    pick('drums', 'webmidi:kit');
    await flush();
    const { applyDevices } = await import('../src/devices.js');
    await applyDevices({ parts: { guitar: { on: true, deviceKey: 'usb-guitar' }, drums: { on: true, deviceKey: 'webmidi:kit' } } },
        d.winExtra, undefined, memo);
    assert.deepEqual(d.calls.noteDetect, ['usb-guitar'], 'note_detect not restarted at Go');
    assert.deepEqual(d.calls.drums, ['webmidi:kit'], 'drums not reconnected at Go');
    bs.dispose();
});

test('lights run only while visible and never connect the analyser', async () => {
    const d = deviceWin();
    const { col, fb, bs } = setup({ stored: withDevices, winExtra: d.winExtra });
    await flush();
    await flush();
    assert.deepEqual(d.calls.gum.sort(), ['usb-guitar', 'usb-mic']);
    assert.deepEqual(d.calls.open, [{ logicalSourceKey: 'webmidi:kit', requester: 'rockherosmith' }]);
    d.runFrames();
    assert.ok(col('guitar').querySelector('.rhs-signal').classList.contains('rhs-lit'));
    for (const ctx of d.audio.contexts) {
        for (const a of ctx.analysers) assert.equal(a.connectCalls, 0);
        for (const c of d.audio.connects) assert.notEqual(c.to, ctx.destination);
    }
    assert.ok(d.audio.connects.every((c) => c.from.kind === 'source'));

    fb.emit('screen:changing', { id: 'player', from: 'plugin-rockherosmith' });
    assert.equal(liveStreams(d).length, 0, 'every track stopped on hide');
    assert.ok(d.audio.contexts.every((c) => c.closed === 1));
    assert.equal(d.frames.size, 0);
    assert.equal(d.listeners.size, 0);
    assert.deepEqual(d.calls.close, [{ logicalSourceKey: 'webmidi:kit', requester: 'rockherosmith' }]);

    fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    await flush();
    await flush();
    assert.equal(liveStreams(d).length, 2, 'meters back on show');
    assert.equal(d.listeners.size, 1);

    bs.dispose();
    assert.equal(liveStreams(d).length, 0, 'every track stopped on dispose');
    assert.equal(d.listeners.size, 0);
    assert.equal(d.calls.close.length, 2);
});

test('losing .active stops the lights at the next frame', async () => {
    const d = deviceWin();
    const { doc, bs } = setup({ stored: withDevices, winExtra: d.winExtra });
    await flush();
    await flush();
    doc.getElementById('plugin-rockherosmith').classList.remove('active');
    d.runFrames();
    assert.equal(liveStreams(d).length, 0);
    assert.equal(d.listeners.size, 0);
    bs.dispose();
});

test('a device change stops the old meter before the new one starts', async () => {
    const d = deviceWin();
    const { col, bs } = setup({ stored: withDevices, winExtra: d.winExtra });
    await flush();
    await flush();
    const old = d.streams.find((s) => s.id === 'usb-guitar');
    const sel = col('guitar').querySelector('select');
    sel.value = 'usb-mic';
    sel.fire('change');
    assert.equal(old.tracks[0].stopped, 1, 'stopped synchronously, before the new getUserMedia');
    await flush();
    assert.equal(d.streams.filter((s) => s.id === 'usb-mic').length, 2);
    assert.equal(liveStreams(d).length, 2);
    bs.dispose();
});

test('a pad hit flashes the drum light and starts the song when Go is enabled', async () => {
    const d = deviceWin();
    const t = setup({ stored: withDevices, winExtra: d.winExtra });
    const { col, bs, gos } = t;
    await flush();
    await flush();
    d.hit([0x99, 38, 100]);
    assert.ok(col('drums').querySelector('.rhs-signal').classList.contains('rhs-hit'));
    assert.equal(gos.length, 0, 'no song: Go disabled');
    onConfirm(t, holiday);
    d.hit([0x89, 38, 64]);
    assert.equal(gos.length, 0, 'note-off is not a hit');
    d.hit([0x99, 38, 100]);
    assert.equal(gos.length, 1);
    bs.dispose();
    assert.ok(!col('drums').querySelector('.rhs-signal').classList.contains('rhs-hit'));
});

test('denied mic permission shows no access', async () => {
    const d = deviceWin({ gumError: 'NotAllowedError' });
    const { col, bs } = setup({ stored: withDevices, winExtra: d.winExtra });
    await flush();
    await flush();
    assert.equal(col('vocals').querySelector('.rhs-signal').textContent, 'no access');
    assert.equal(col('guitar').querySelector('.rhs-signal').textContent, 'no access');
    bs.dispose();
});

test('a desktop session source shows check in game without opening the mic', async () => {
    const d = deviceWin();
    d.winExtra.feedBack.audioSession = {
        listInputSources: () => ({ payload: { sources: [{ logicalSourceKey: 'native::in1', label: 'Interface In 1' }] } }),
        selectInputSource: () => ({ outcome: 'handled' }),
    };
    const { col, bs } = setup({ stored: { parts: { guitar: { deviceKey: 'native::in1' }, drums: { on: false }, vocals: { on: false } } }, winExtra: d.winExtra });
    await flush();
    await flush();
    assert.equal(col('guitar').querySelector('.rhs-signal').textContent, 'check in game');
    assert.equal(d.calls.gum.length, 0);
    bs.dispose();
});

test('Find my kit discovers MIDI and lists the kit', async () => {
    const d = deviceWin({ midiSources: [], afterDiscover: [{ logicalSourceKey: 'webmidi:kit', label: 'Kit' }] });
    const { col, bs } = setup({ winExtra: d.winExtra });
    await flush();
    const find = col('drums').querySelector('button.rhs-findkit');
    assert.ok(find);
    assert.equal(find.hidden, false);
    find.click();
    await flush();
    assert.equal(d.calls.discover, 1);
    assert.deepEqual(col('drums').querySelector('select').querySelectorAll('option').slice(1).map((o) => o.value), ['webmidi:kit']);
    assert.equal(find.hidden, true);
    bs.dispose();
});

test('a burst of pad hits, or Space right after a pad Go, calls onGo once', async () => {
    const d = deviceWin();
    const t = setup({ stored: withDevices, winExtra: d.winExtra });
    const { doc, fb, bs, gos } = t;
    await flush();
    await flush();
    onConfirm(t, holiday);
    d.hit([0x99, 38, 100]);
    d.hit([0x99, 38, 100]);
    d.hit([0x99, 36, 90]);
    assert.equal(gos.length, 1);
    const ev = doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 1, 'Space after a pad Go');
    assert.equal(ev.defaultPrevented, false);
    assert.equal(d.listeners.size, 0, 'the drums light stops once Go fires');
    fb.emit('screen:changing', { id: 'player', from: 'plugin-rockherosmith' });
    fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    await flush();
    await flush();
    d.hit([0x99, 38, 100]);
    assert.equal(gos.length, 2, 'shown again: pads start the song again');
    bs.dispose();
});

test('picking the vocals placeholder keeps karaoke\'s mic', async () => {
    const d = deviceWin();
    const { col, bs, storage, prefs } = setup({ stored: withDevices, winExtra: d.winExtra });
    storage.setItem('lyrics_karaoke.deviceId', 'usb-mic');
    await flush();
    const sel = col('vocals').querySelector('select');
    sel.value = '';
    sel.fire('change');
    assert.equal(prefs().parts.vocals.deviceId, '');
    assert.equal(storage.getItem('lyrics_karaoke.deviceId'), 'usb-mic');
    bs.dispose();
});

test('blank-id audio inputs ask for microphone access in the column note', async () => {
    const d = deviceWin();
    d.winExtra.navigator.mediaDevices.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: '', label: '' },
        { kind: 'audiooutput', deviceId: '', label: '' },
    ];
    const { col, bs } = setup({ winExtra: d.winExtra });
    await flush();
    await flush();
    assert.equal(col('guitar').querySelector('.rhs-note').textContent,
        'Pick an input to score your guitar \u00b7 Allow microphone access to list inputs');
    assert.ok(col('vocals').querySelector('.rhs-note').textContent.endsWith('Allow microphone access to list inputs'));
    assert.equal(col('drums').querySelector('.rhs-note').textContent, '');
    assert.equal(col('guitar').querySelector('select').querySelectorAll('option').length, 1, 'placeholder only');
    bs.dispose();
});

// A failed Go is logged with console.warn; keep test output clean.
async function quietWarn(fn) {
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a);
    try { await fn(); } finally { console.warn = warn; }
    return warned;
}

test('a failed Go releases the latch, restores the drums light and says so', async () => {
    const modes = {
        throw: () => { throw new Error('boom'); },
        reject: () => Promise.reject(new Error('load failed')),
        false: () => false,
        'resolves false': () => Promise.resolve(false),
    };
    for (const [mode, fail] of Object.entries(modes)) {
        const warned = await quietWarn(async () => {
            const d = deviceWin();
            let failing = true;
            const t = setup({
                stored: withDevices, winExtra: d.winExtra,
                onGo: () => (failing ? fail() : Promise.resolve(true)),
            });
            const { root, bs, gos } = t;
            await flush();
            await flush();
            onConfirm(t, holiday);
            const hint = root.querySelector('.rhs-hint');
            d.hit([0x99, 38, 100]);
            await flush();
            await flush();
            assert.equal(gos.length, 1, mode);
            assert.equal(hint.textContent, "Couldn't start the song", mode);
            assert.equal(d.listeners.size, 1, `${mode}: drums light back`);
            failing = false;
            d.hit([0x99, 38, 100]);
            assert.equal(gos.length, 2, `${mode}: the next Go works`);
            assert.equal(hint.textContent, 'Press Space or hit any pad to start', `${mode}: message cleared`);
            await flush();
            root.querySelector('.rhs-go').click();
            assert.equal(gos.length, 2, `${mode}: latched after a good Go`);
            assert.equal(d.listeners.size, 0);
            bs.dispose();
        });
        assert.equal(warned.length, mode === 'throw' || mode === 'reject' ? 1 : 0, mode);
    }
});

test('the drums light stays off after Go: device picks and in-flight list loads', async () => {
    const d = deviceWin();
    const t = setup({ stored: withDevices, winExtra: d.winExtra });
    const { root, col, bs, gos } = t;
    onConfirm(t, holiday);
    root.querySelector('.rhs-go').click(); // before the device lists finish loading
    assert.equal(gos.length, 1);
    await flush();
    await flush();
    assert.equal(d.calls.open.length, 0, 'in-flight loadDevices does not reopen the pad light');
    const sel = col('drums').querySelector('select');
    sel.value = 'webmidi:kit';
    sel.fire('change');
    await flush();
    assert.equal(d.calls.open.length, 0, 'a device pick does not reopen it either');
    assert.equal(d.listeners.size, 0);
    bs.dispose();
});

const karaokeFake = () => ({
    apiVersion: 1, mountStrip() {}, setKaraokeMode() {}, startMic() {}, stopMic() {}, setDifficulty() {}, setHearMyself() {},
});
const vocalsOnly = {
    parts: { guitar: { on: false }, drums: { on: false }, vocals: { on: true } },
};

test('without window.lyricsKaraoke the vocals column says to turn the plugin on', () => {
    const { col, bs } = setup();
    assert.equal(col('vocals').querySelector('.rhs-note').textContent, 'Turn on the Lyrics Karaoke plugin to sing');
    assert.ok(col('vocals').classList.contains('rhs-unavailable'));
    bs.dispose();
});

test('with only vocals on and a pitched song, Go is enabled', () => {
    const t = setup({ stored: vocalsOnly, winExtra: { lyricsKaraoke: karaokeFake() } });
    const { root, bs, gos } = t;
    onConfirm(t, { ...holiday, has_vocal_pitch: true });
    assert.equal(root.querySelector('.rhs-go').disabled, false);
    root.querySelector('.rhs-go').click();
    assert.equal(gos.length, 1);
    bs.dispose();
});

test('without karaoke, only vocals on leaves Go disabled', () => {
    const { root, bs } = setup({ stored: vocalsOnly });
    bs.setSong({ ...holiday, has_vocal_pitch: true });
    assert.equal(root.querySelector('.rhs-go').disabled, true);
    assert.equal(root.querySelector('.rhs-hint').textContent, 'Turn on a part');
    bs.dispose();
});

test('the guitar column note: Note Detection missing, then no input picked', async () => {
    const a = setup();
    assert.equal(a.col('guitar').querySelector('.rhs-note').textContent, 'Turn on Note Detection to score your guitar');
    a.bs.dispose();
    const b = setup({ winExtra: { noteDetect: {} } });
    assert.equal(b.col('guitar').querySelector('.rhs-note').textContent, 'Pick an input to score your guitar');
    b.bs.dispose();
});

// ── Mic-hit sensitivity check (Plan 5 Task 12) ────────────────────────────

// karaoke's real detector rule, minimal: level >= threshold, rise >= 25 dB, 0.3 s apart.
function fakeMicHit(created = []) {
    return {
        riseDb: 25, defaultDb: -30, minDb: -48, maxDb: -12,
        createDetector({ thresholdDb }) {
            let threshold = thresholdDb;
            let prev = null;
            const d = {
                pushes: [],
                push(db, t) {
                    d.pushes.push([db, t]);
                    const hit = prev !== null && db >= threshold && db - prev >= 25;
                    prev = db;
                    return hit;
                },
                setThreshold(db) { threshold = db; return true; },
                threshold: () => threshold,
                reset() { prev = null; },
            };
            created.push(d);
            return d;
        },
    };
}
const micKaraoke = (created) => ({ ...karaokeFake(), micHit: fakeMicHit(created) });

// The vocals meter's context is the second one opened (guitar's is first).
const vocalsCtx = (d) => d.audio.contexts[1];

// A vocals mic whose analyser reads the next level in `levels` each frame.
function micWin(levels) {
    const d = deviceWin();
    class Ctx extends d.audio.FakeAudioContext {
        constructor() { super(); this.sampleRate = 48000; this.currentTime = 0; }
        createAnalyser() {
            const a = super.createAnalyser();
            let i = 0; // per context: the guitar meter reads its own
            a.getFloatTimeDomainData = (b) => { b.fill(levels[Math.min(i++, levels.length - 1)]); };
            return a;
        }
    }
    d.winExtra.AudioContext = Ctx;
    return d;
}

test('the mic-hit check lights on a hit and saves the level', async () => {
    const created = [];
    const d = micWin([0.001, 0.03]);
    const { col, bs, prefs } = setup({ stored: withDevices, winExtra: { ...d.winExtra, lyricsKaraoke: micKaraoke(created) } });
    await flush();
    const block = col('vocals').querySelector('.rhs-michit');
    const slider = block.querySelector('.rhs-michit-db');
    const light = block.querySelector('.rhs-michit-light');
    assert.equal(slider.value, '-30');
    assert.equal(block.querySelector('.rhs-michit-text').textContent, 'Tap the mic');
    assert.equal(block.classList.contains('rhs-disabled'), false);
    slider.value = '-33';
    slider.fire('change');
    assert.equal(prefs().parts.vocals.micHitDb, -33);
    assert.equal(slider.value, '-33');
    assert.equal(block.querySelector('.rhs-michit-meter').querySelector('b').style.props.left, `${(27 / 60) * 100}%`);
    d.runFrames(); // -60 dB
    assert.equal(light.classList.contains('rhs-hit'), false);
    assert.ok(parseFloat(block.querySelector('.rhs-michit-meter').querySelector('i').style.props.width) < 0.001, 'silence is an empty bar');
    vocalsCtx(d).currentTime = 0.1;
    d.runFrames(); // -30.46 dB
    assert.ok(light.classList.contains('rhs-hit'));
    const [db] = created[0].pushes[1];
    assert.ok(Math.abs(db - 20 * Math.log10(0.03)) < 1e-6);
    assert.equal(created[0].pushes[1][1], 0.1, 'the ctx time goes to the detector');
    assert.equal(created[0].threshold(), -33, 'the slider updates the detector');
    const w = block.querySelector('.rhs-michit-meter').querySelector('i').style.props.width;
    assert.equal(w, `${((db + 60) / 60) * 100}%`);
    assert.equal(vocalsCtx(d).analysers[0].fftSize, 2048);
    assert.equal(vocalsCtx(d).analysers[0].connectCalls, 0);
    bs.dispose();
    assert.equal(light.classList.contains('rhs-hit'), false, 'dispose clears the flash');
});

test('without karaoke the check is disabled', () => {
    const { col, bs } = setup();
    const block = col('vocals').querySelector('.rhs-michit');
    assert.ok(block.classList.contains('rhs-disabled'));
    assert.equal(block.querySelector('.rhs-michit-db').disabled, true);
    assert.equal(block.querySelector('.rhs-michit-text').textContent, 'Needs Lyrics Karaoke');
    bs.dispose();
    const old = setup({ winExtra: { lyricsKaraoke: karaokeFake() } }); // karaoke without micHit
    const b2 = old.col('vocals').querySelector('.rhs-michit');
    assert.ok(b2.classList.contains('rhs-disabled'));
    assert.equal(b2.querySelector('.rhs-michit-db').disabled, true);
    old.bs.dispose();
});

test('leaving the screen stops the check', async () => {
    const created = [];
    const d = micWin([0.001, 0.03, 0.03]);
    const { col, fb, bs } = setup({ stored: withDevices, winExtra: { ...d.winExtra, lyricsKaraoke: micKaraoke(created) } });
    await flush();
    d.runFrames();
    assert.equal(created[0].pushes.length, 1);
    fb.emit('screen:changing', { id: 'some-other-screen' });
    vocalsCtx(d).currentTime = 1;
    d.runFrames();
    assert.equal(created[0].pushes.length, 1, 'no further reading reaches the check');
    assert.equal(col('vocals').querySelector('.rhs-michit-light').classList.contains('rhs-hit'), false);
    assert.deepEqual(liveStreams(d), []);
    bs.dispose();
});

test("a throwing karaoke detector doesn't stop the vocals meter", async () => {
    const created = [];
    const micHit = fakeMicHit(created);
    const make = micHit.createDetector;
    micHit.createDetector = (o) => {
        const det = make(o);
        det.push = () => { throw new Error('detector broke'); };
        return det;
    };
    const d = micWin([0.001, 0.03, 0.1]);
    const { col, bs } = setup({ stored: withDevices, winExtra: { ...d.winExtra, lyricsKaraoke: { ...karaokeFake(), micHit } } });
    await flush();
    const block = col('vocals').querySelector('.rhs-michit');
    const width = () => parseFloat(block.querySelector('.rhs-michit-meter').querySelector('i').style.props.width);
    const pct = (level) => ((20 * Math.log10(level) + 60) / 60) * 100;
    assert.doesNotThrow(() => d.runFrames()); // -60 dB: the detector throws
    vocalsCtx(d).currentTime = 0.1;
    d.runFrames(); // -30.46 dB
    assert.ok(Math.abs(width() - pct(0.03)) < 1e-4, 'the meter still moves');
    vocalsCtx(d).currentTime = 0.2;
    d.runFrames(); // -20 dB
    assert.ok(Math.abs(width() - pct(0.1)) < 1e-4);
    assert.equal(block.querySelector('.rhs-michit-light').classList.contains('rhs-hit'), false);
    bs.dispose();
});

test('a song without a drum stem shows Song + pads pressed and keeps the stored mode', () => {
    const stored = { parts: { drums: { soundMode: 'kit' } } };
    const { part, btn, bs, prefs } = setup({ stored });
    bs.setSong(holiday);
    assert.equal(btn(part('drums'), 'soundMode', 'song').getAttribute('aria-pressed'), 'true');
    assert.equal(btn(part('drums'), 'soundMode', 'kit').getAttribute('aria-pressed'), 'false');
    assert.equal(prefs().parts.drums.soundMode, 'kit');
    bs.setSong({ ...holiday, stem_ids: ['drums'] });
    assert.equal(btn(part('drums'), 'soundMode', 'kit').getAttribute('aria-pressed'), 'true');
    assert.equal(btn(part('drums'), 'soundMode', 'kit').disabled, false);
    bs.dispose();
});

// ── Band setup, the Song Library pick and Confirm (Plan 8 Task 4) ─────────

// A grouped grid row, as core's library pick resolves it: no chart facts.
const holidayGrouped = { filename: holiday.filename, title: 'Holiday', artist: 'Green Day', group_count: 2 };
const view = (root) => root.getAttribute('data-view');
const esc = (doc, extra = {}) => doc.fire('keydown', { key: 'Escape', code: 'Escape', ...extra });

// Picks `item` through the library and lets the re-resolve settle.
async function pickSong(t, item, filters = { playable: true }) {
    t.bs.openLibrary();
    t.picker.resolveLast({ item, filters, reason: 'picked' });
    await flush();
}

test('opens on Band setup with no song controls', () => {
    const { root, col, part, bs } = setup();
    assert.equal(view(root), 'setup');
    assert.equal(bs.view(), 'setup');
    assert.equal(root.querySelector('.rhs-search'), null);
    assert.equal(root.querySelector('.rhs-picker'), null);
    for (const id of ['guitar', 'drums', 'vocals']) {
        for (const f of ['difficulty', 'arrangement', 'soundMode']) {
            assert.equal(col(id).querySelector(`.rhs-seg[data-field="${f}"]`), null, `${id} ${f}`);
        }
    }
    const fields = (id) => part(id).querySelectorAll('.rhs-seg[data-field]').map((x) => x.getAttribute('data-field'));
    assert.deepEqual(fields('guitar'), ['arrangement', 'difficulty']);
    assert.deepEqual(fields('drums'), ['difficulty', 'soundMode']);
    assert.deepEqual(fields('vocals'), ['difficulty']);
    assert.ok(col('vocals').querySelector('.rhs-seg[data-field="hearMyself"]'));
    assert.ok(col('vocals').querySelector('.rhs-michit'));
    assert.equal(root.querySelector('.rhs-choose').disabled, false);
    assert.equal(root.querySelector('.rhs-setup-hint').textContent, '');
    assert.equal(root.querySelector('.rhs-continue').hidden, true);
    bs.dispose();
});

test('Choose a song asks core with the band chips', () => {
    const { root, picker, bs } = setup({ stored: { pickFilters: { drumStem: true } } });
    root.querySelector('.rhs-choose').click();
    assert.equal(picker.calls.length, 1);
    const o = picker.calls[0];
    assert.equal(o.title, 'Pick a song for the band');
    assert.equal(o.returnTo, 'plugin-rockherosmith');
    assert.equal(o.confirmLabel, 'Use this song');
    assert.equal(o.backLabel, 'Back to the band');
    assert.equal(o.selected, null);
    assert.deepEqual(o.filters.map((f) => f.id), ['playable', 'drumStem', 'drums', 'vocals', 'guitar', 'fiveFret', 'fiveFretReal']);
    const playable = o.filters[0];
    assert.equal(playable.on, true);
    assert.equal(playable.params.has_drums, '1');
    assert.equal(playable.params.arrangements_has, 'Lead,Rhythm,Bass');
    assert.equal('has_lyrics' in playable.params, false, 'karaoke absent: vocals left out');
    assert.equal(o.filters[1].on, true, 'the stored chip flags');
    assert.equal(o.filters[2].on, false);
    bs.dispose();
});

test('the screen drops vocals from the parts it passes when karaoke is missing', () => {
    const playable = (t) => { t.root.querySelector('.rhs-choose').click(); return t.picker.calls[0].filters[0].params; };
    const without = setup({ stored: vocalsOnly });
    // Vocals is the only part on, so without karaoke no part can play.
    assert.equal(without.root.querySelector('.rhs-choose').disabled, true);
    without.bs.dispose();
    const a = setup();
    assert.equal(a.prefs().parts.vocals.on, true);
    assert.deepEqual(playable(a), { arrangements_has: 'Lead,Rhythm,Bass', has_drums: '1' });
    assert.equal(a.prefs().parts.vocals.on, true, 'the stored part is not changed');
    a.bs.dispose();
    const b = setup({ winExtra: { lyricsKaraoke: karaokeFake() } });
    assert.deepEqual(playable(b), { arrangements_has: 'Lead,Rhythm,Bass', has_drums: '1', has_lyrics: 'pitch' });
    b.bs.dispose();
});

test('a picked song lands on Confirm, re-resolved', async () => {
    const t = setup({ library: [holiday] });
    const { root, bs, picker, urls, prefs } = t;
    root.querySelector('.rhs-choose').click();
    picker.resolveLast({ item: holidayGrouped, filters: { playable: true, drumStem: true }, reason: 'picked' });
    await flush();
    assert.equal(view(root), 'confirm');
    assert.equal(root.querySelector('.rhs-title').textContent, 'Holiday');
    assert.ok(root.querySelector('.rhs-art-img').src.endsWith('/api/song/sloppak%2Fgreeholi.sloppak/art'));
    assert.equal(prefs().lastSong.filename, holiday.filename);
    assert.equal(prefs().pickFilters.drumStem, true);
    assert.ok(urls.includes('/api/library?q=Holiday&size=30'));
    assert.equal(bs.getSong(), holiday, 'the full row replaces the grouped one');
    assert.equal(root.querySelectorAll('.rhs-chip').length, 5);
    bs.dispose();
});

test('a picked row the library cannot re-resolve stays as picked', async () => {
    const t = setup({ library: [] });
    await pickSong(t, holidayGrouped);
    assert.equal(t.bs.getSong(), holidayGrouped);
    assert.equal(t.bs.view(), 'confirm');
    t.bs.dispose();
});

test('the art hides when it fails to load and comes back for the next song', async () => {
    const t = setup();
    await pickSong(t, holiday);
    const img = t.root.querySelector('.rhs-art-img');
    assert.equal(img.hidden, false);
    img.fire('error');
    assert.equal(img.hidden, true);
    t.bs.setSong({ ...holiday }); // same file: still hidden
    assert.equal(img.hidden, true);
    await pickSong(t, { ...holiday, filename: 'other.psarc', title: 'Other' });
    assert.equal(img.hidden, false);
    assert.ok(img.src.endsWith('/api/song/other.psarc/art'));
    t.bs.dispose();
});

test('Back from the library keeps the view and song', async () => {
    const t = setup({ library: [holiday] });
    const { root, bs, picker, prefs } = t;
    await pickSong(t, holiday);
    root.querySelector('.rhs-change').click();
    assert.equal(picker.calls.length, 2);
    assert.equal(picker.calls[1].selected, holiday, 'the whole current row');
    picker.resolveLast({ item: null, filters: { playable: false, drumStem: true }, reason: 'back' });
    await flush();
    assert.equal(view(root), 'confirm');
    assert.equal(bs.getSong(), holiday);
    assert.equal(prefs().pickFilters.playable, false, 'the chips are remembered on Back');
    bs.dispose();
});

test('a pick from Setup that comes back empty stays on Setup', async () => {
    const t = setup();
    t.root.querySelector('.rhs-choose').click();
    t.picker.resolveLast({ item: null, filters: { playable: true }, reason: 'left' });
    await flush();
    assert.equal(t.bs.view(), 'setup');
    assert.equal(t.bs.getSong(), null);
    t.bs.dispose();
});

test('Esc on Confirm opens the library; Esc on Setup does nothing', async () => {
    const t = setup();
    const { doc, root, picker, bs } = t;
    let ev = esc(doc);
    assert.equal(picker.calls.length, 0, 'Setup');
    assert.equal(ev.defaultPrevented, false);
    await pickSong(t, holiday);
    assert.equal(picker.calls.length, 1);
    for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
        esc(doc, extra);
    }
    doc.activeElement = { tagName: 'SELECT' };
    esc(doc);
    doc.activeElement = null;
    assert.equal(picker.calls.length, 1, 'modifiers, repeats and form fields');
    ev = esc(doc);
    assert.equal(picker.calls.length, 2);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(picker.calls[1].selected, holiday, 'the whole current row');
    assert.equal(view(root), 'confirm');
    doc.getElementById('plugin-rockherosmith').classList.remove('active');
    esc(doc);
    assert.equal(picker.calls.length, 2, 'not the active screen');
    bs.dispose();
});

test('Go only on Confirm', async () => {
    const d = deviceWin();
    const t = setup({ stored: withDevices, winExtra: d.winExtra });
    const { doc, root, col, bs, gos } = t;
    await flush();
    await flush();
    bs.setSong(holiday);
    assert.equal(bs.view(), 'setup');
    let ev = doc.fire('keydown', { code: 'Space' });
    assert.equal(ev.defaultPrevented, false);
    d.hit([0x99, 38, 100]);
    assert.ok(col('drums').querySelector('.rhs-signal').classList.contains('rhs-hit'), 'the pad still flashes on Setup');
    root.querySelector('.rhs-go').click();
    assert.equal(gos.length, 0);
    bs.nextSong();
    assert.equal(bs.view(), 'confirm');
    ev = doc.fire('keydown', { code: 'Space' });
    assert.equal(gos.length, 1);
    assert.equal(ev.defaultPrevented, true);
    bs.dispose();
});

test('Band setup returns to Setup and Continue with goes to Confirm', async () => {
    const stored = { lastSong: { filename: holiday.filename, title: 'Holiday', artist: 'Green Day' } };
    const { root, bs } = setup({ stored, library: [holiday] });
    const cont = root.querySelector('.rhs-continue');
    assert.equal(cont.hidden, true, 'not resolved yet');
    await flush();
    assert.equal(cont.hidden, false);
    assert.equal(cont.textContent, 'Continue with Holiday');
    cont.click();
    assert.equal(view(root), 'confirm');
    root.querySelector('.rhs-setup-btn').click();
    assert.equal(view(root), 'setup');
    bs.setSong(null);
    assert.equal(cont.hidden, true, 'no song');
    bs.dispose();
});

test('Continue with stays hidden when the last song is gone', async () => {
    const stored = { lastSong: { filename: holiday.filename, title: 'Holiday', artist: 'Green Day' } };
    const { root, bs } = setup({ stored, library: [] });
    await flush();
    assert.equal(root.querySelector('.rhs-continue').hidden, true);
    bs.dispose();
});

test('Confirm greys what the song lacks', () => {
    const { part, btn, bs } = setup({ winExtra: { lyricsKaraoke: karaokeFake() } });
    bs.setSong({ ...holiday, arrangements: [{ name: 'Rhythm', index: 0 }] });
    const g = part('guitar');
    assert.equal(btn(g, 'arrangement', 'Lead').disabled, true);
    assert.equal(btn(g, 'arrangement', 'Bass').disabled, true);
    assert.equal(btn(g, 'arrangement', 'Rhythm').disabled, false);
    assert.equal(btn(g, 'arrangement', 'Rhythm').getAttribute('aria-pressed'), 'true');
    assert.equal(btn(g, 'arrangement', 'Lead').getAttribute('aria-pressed'), 'false');
    assert.equal(btn(part('drums'), 'soundMode', 'rockband').disabled, false, 'unsplit: Rock Band muffles the mix');
    assert.equal(btn(part('drums'), 'soundMode', 'kit').disabled, true);
    bs.setSong({ ...holiday, arrangements: [{ name: 'Rhythm', index: 0 }], stem_ids: ['guitar'] });
    assert.equal(btn(part('drums'), 'soundMode', 'rockband').disabled, true, 'split, no drum stem');
    assert.ok(part('vocals').classList.contains('rhs-unavailable'));
    assert.equal(part('vocals').querySelector('.rhs-note').textContent, 'No vocal pitch for this song');
    bs.dispose();
});

test('Confirm parts are coloured and carry their icons', () => {
    const { part, bs } = setup();
    assert.equal(part('guitar').style.props['--rhs-c'], '#f5c542');
    assert.equal(part('drums').querySelector('.rhs-part-name').textContent, 'Drums');
    assert.ok(String(part('vocals').querySelector('.rhs-ico').innerHTML).includes('<svg'));
    bs.dispose();
});

test("the device line names each part's device", async () => {
    const d = deviceWin();
    const a = setup({ stored: withDevices, winExtra: d.winExtra });
    await flush();
    await flush();
    const line = (t, id) => t.part(id).querySelector('.rhs-part-device').textContent;
    assert.equal(line(a, 'guitar'), 'Input: USB Guitar');
    assert.equal(line(a, 'drums'), 'Kit: Kit');
    assert.equal(line(a, 'vocals'), 'Mic: USB Mic');
    a.bs.dispose();
    const d2 = deviceWin();
    const b = setup({ stored: { parts: { drums: { deviceKey: 'webmidi:gone' } } }, winExtra: d2.winExtra });
    await flush();
    await flush();
    assert.equal(line(b, 'guitar'), 'Input: none picked');
    assert.equal(line(b, 'drums'), 'Kit: Saved device (not found)');
    b.bs.dispose();
});

test('without the core hook, picking is off', async () => {
    const stored = { lastSong: { filename: holiday.filename, title: 'Holiday', artist: 'Green Day' } };
    const { root, bs } = setup({ picker: null, stored, library: [holiday] });
    assert.equal(root.querySelector('.rhs-choose').disabled, true);
    assert.equal(root.querySelector('.rhs-change').disabled, true);
    assert.equal(root.querySelector('.rhs-setup-hint').textContent, 'Update feedBack to pick songs here');
    assert.doesNotThrow(() => bs.openLibrary());
    await flush();
    root.querySelector('.rhs-continue').click();
    assert.equal(bs.view(), 'confirm', 'Continue with still works');
    bs.dispose();
});

test('the pick hook defaults to window.feedBack.library', () => {
    const { root, picker, bs } = setup({ libraryOnWin: true });
    root.querySelector('.rhs-choose').click();
    assert.equal(picker.calls.length, 1);
    bs.dispose();
});

test('nextSong opens the library now when visible, else on the next show', () => {
    const a = setup();
    a.bs.nextSong();
    assert.equal(a.bs.view(), 'confirm');
    assert.equal(a.picker.calls.length, 1);
    a.bs.dispose();
    const b = setup({ active: false });
    b.bs.nextSong();
    assert.equal(b.bs.view(), 'confirm');
    assert.equal(b.picker.calls.length, 0, 'hidden: waits');
    b.doc.getElementById('plugin-rockherosmith').classList.add('active');
    b.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    assert.equal(b.picker.calls.length, 1);
    b.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    assert.equal(b.picker.calls.length, 1, 'once');
    b.bs.dispose();
});

test('a stale pick result is ignored', async () => {
    const { bs, picker } = setup();
    bs.openLibrary();
    bs.openLibrary();
    picker.resolvers[1]({ item: null, filters: { playable: true }, reason: 'back' });
    picker.resolvers[0]({ item: holiday, filters: { playable: false }, reason: 'replaced' });
    await flush();
    assert.equal(bs.getSong(), null);
    assert.equal(bs.view(), 'setup');
    bs.dispose();
});

test('a pick after dispose does nothing, and a failing hook is logged', async () => {
    const a = setup();
    a.bs.openLibrary();
    a.bs.dispose();
    a.picker.resolveLast({ item: holiday, filters: {}, reason: 'picked' });
    await flush();
    assert.equal(a.bs.getSong(), null);
    a.bs.openLibrary();
    assert.equal(a.picker.calls.length, 1, 'disposed: no pick');
    for (const pick of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('nope'))]) {
        const warned = await quietWarn(async () => {
            const b = setup({ picker: { pick } });
            assert.doesNotThrow(() => b.bs.openLibrary());
            await flush();
            b.bs.dispose();
        });
        assert.equal(warned.length, 1);
        assert.equal(warned[0][0], '[rockherosmith] library pick failed');
    }
});

// ── Fix round 1 ────────────────────────────────────────────────────────────

test('Change song, then Use this song on the same song keeps Confirm intact', async () => {
    const t = setup({ library: [holiday] });
    const { root, bs, picker, prefs, urls } = t;
    await pickSong(t, holiday);
    const before = urls.length;
    root.querySelector('.rhs-change').click();
    // Core hands the preset selection back as the item.
    picker.resolveLast({ item: picker.calls[1].selected, filters: { playable: true }, reason: 'picked' });
    await flush();
    assert.equal(bs.view(), 'confirm');
    assert.equal(bs.getSong(), holiday);
    assert.equal(root.querySelector('.rhs-title').textContent, 'Holiday');
    assert.equal(root.querySelector('.rhs-go').disabled, false);
    assert.equal(prefs().lastSong.title, 'Holiday');
    assert.equal(urls.length, before, 'no re-resolve');
    // Even a bare { filename } for the current song keeps it.
    root.querySelector('.rhs-change').click();
    picker.resolveLast({ item: { filename: holiday.filename }, filters: {}, reason: 'picked' });
    await flush();
    assert.equal(bs.getSong(), holiday);
    assert.equal(prefs().lastSong.title, 'Holiday');
    bs.dispose();
});

test('a title-less item skips the re-resolve', async () => {
    const t = setup({ library: [holiday] });
    const searches = () => t.urls.filter((u) => u.startsWith('/api/library?q=')).length;
    const before = searches();
    await pickSong(t, { filename: holiday.filename });
    assert.equal(t.bs.view(), 'confirm');
    assert.equal(searches(), before, 'no /api/library?q= re-resolve');
    assert.equal(t.prefs().lastSong.filename, holiday.filename);
    t.bs.dispose();
});

test('Next song opens the pick before loading devices: no mic opens', async () => {
    const d = deviceWin();
    const t = setup({ active: false, stored: withDevices, winExtra: d.winExtra });
    t.bs.setSong(holiday);
    t.bs.nextSong();
    t.doc.getElementById('plugin-rockherosmith').classList.add('active');
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'player' });
    await flush();
    await flush();
    assert.equal(t.picker.calls.length, 1);
    assert.equal(d.calls.enumerate, 0, 'no device list');
    assert.equal(d.calls.gum.length, 0, 'no mic');
    assert.equal(d.calls.open.length, 0, 'no pad light');
    t.bs.dispose();
});

test('a pending Next song pick is dropped when the screen hides', () => {
    const t = setup({ active: false });
    t.bs.nextSong();
    t.fb.emit('screen:changing', { id: 'v3-settings' });
    t.doc.getElementById('plugin-rockherosmith').classList.add('active');
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'v3-settings' });
    assert.equal(t.picker.calls.length, 0);
    t.bs.dispose();
});

test('Esc already handled elsewhere does not open the library', async () => {
    const t = setup();
    await pickSong(t, holiday);
    esc(t.doc, { defaultPrevented: true });
    assert.equal(t.picker.calls.length, 1);
    t.bs.dispose();
});

test('the art is hidden until there is a song', () => {
    const t = setup();
    assert.equal(t.root.querySelector('.rhs-art-img').hidden, true);
    t.bs.dispose();
});

test('the Confirm key listener runs in the capture phase, ahead of core gamepad-nav', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/band-screen.js', import.meta.url), 'utf8');
    assert.match(src, /listen\(doc, 'keydown', \(e\) => \{\s*if \(!visible \|\| !isActive\(\) \|\| view !== 'confirm'\) return;[\s\S]*?\}, true\);/);
    assert.match(src, /const listen = \(target, type, fn, capture = false\) => \{/);
});

// ── Controller players: Start-to-join and the controller columns ──────────
const BTN = { green: 0, red: 1, yellow: 2, blue: 3, orange: 4, strum: 5, back: 8, start: 9 };
const ACTION_OF = { 0: 'green', 1: 'red', 2: 'yellow', 3: 'blue', 4: 'orange', 5: 'strum_down', 9: 'pause' };
const SCREEN = 'plugin-rockherosmith';

// core's gamepadInput: passive watch, change events and claims. Event times are seconds.
function fakeGamepadInput(pads) {
    const f = {
        pads, watchers: [], changeFns: [], claims: new Map(),
        watch(fn) { f.watchers.push(fn); return () => { f.watchers = f.watchers.filter((w) => w !== fn); }; },
        on(name, fn) { f.changeFns.push(fn); return () => { f.changeFns = f.changeFns.filter((w) => w !== fn); }; },
        claim(index, owner) {
            const pad = f.pads[index];
            if (!pad || !pad.connected || pad.claimedBy) return null;
            pad.claimedBy = owner;
            const h = {
                listeners: [],
                addListener(fn) { h.listeners.push(fn); },
                removeListener(fn) { h.listeners = h.listeners.filter((l) => l !== fn); },
                release() { pad.claimedBy = null; f.claims.delete(pad.controllerKey); },
            };
            f.claims.set(pad.controllerKey, h);
            return h;
        },
        press(pad, index, pressed = true, t = 1) {
            for (const w of [...f.watchers]) w({ pad, type: 'button', index, value: pressed ? 1 : 0, pressed, t });
        },
        send(key, index, pressed = true, t = 1) {
            for (const l of [...f.claims.get(key).listeners]) l({ type: 'button', index, value: pressed ? 1 : 0, pressed, t });
        },
    };
    return f;
}
const gpad = (index, id, n, extra = {}) => ({
    index, controllerKey: `${id}#${n}`, id, mapping: 'standard', name: id.split(' (')[0], kind: 'gamepad',
    connected: true, claimedBy: null, ...extra,
});
// window.feedBackFiveFret: the band API the join manager and the columns use.
function fakeFiveFretApi(input, { showAuto = false } = {}) {
    const api = {
        opened: [],
        listCalls: 0,
        listControllers: async () => { api.listCalls++; return input.pads.map((p) => ({ ...p })); },
        createMapper: async (key) => {
            const p = input.pads.find((x) => x.controllerKey === key);
            if (!p || p.kind === null) return null;
            return { map: (ev) => (ACTION_OF[ev.index] ? [{ action: ACTION_OF[ev.index], value: ev.pressed ? 1 : 0 }] : []) };
        },
        showAutoCharts: () => showAuto,
        openControls: (opts) => { api.opened.push(opts); },
    };
    return api;
}
// window.feedBackDrums' controller half: each pad's drums listing kind is its `drumsKind`.
function fakeDrumsControllerApi(input) {
    const api = {
        opened: [],
        listControllers: async () => input.pads.map((p) => ({ ...p, kind: p.drumsKind || null })),
        createMapper: async (key) => {
            const p = input.pads.find((x) => x.controllerKey === key);
            if (!p || !p.drumsKind) return null;
            return { map: (ev) => (DRUM_ACTION_OF[ev.index] ? [{ action: DRUM_ACTION_OF[ev.index], value: ev.pressed ? 1 : 0 }] : []) };
        },
        openControls: (opts) => { api.opened.push(opts); },
    };
    return api;
}
// The spec's Xbox drums defaults: red LB, yellow RB, blue LT, green RT, kick A, pause Start.
const DRUM_ACTION_OF = { 4: 'red_pad', 5: 'yellow_pad', 6: 'blue_pad', 7: 'green_pad', 0: 'kick', 9: 'pause' };
function ctlSetup({ pads = [gpad(0, 'Xbox', 1)], plugin = true, drums = false, watch = true, showAuto = false, ...rest } = {}) {
    const input = fakeGamepadInput(pads);
    if (!watch) delete input.watch;
    const api = plugin ? fakeFiveFretApi(input, { showAuto }) : null;
    const drumsApi = drums ? fakeDrumsControllerApi(input) : null;
    const winExtra = { ...(rest.winExtra || {}), feedBack: { gamepadInput: input } };
    if (api) winExtra.feedBackFiveFret = api;
    if (drumsApi) winExtra.feedBackDrums = { ...(winExtra.feedBackDrums || {}), ...drumsApi };
    const t = setup({ ...rest, winExtra });
    const setupCols = () => t.root.querySelectorAll('.rhs-col.rhs-ctl');
    const confirmRows = () => t.root.querySelectorAll('.rhs-part.rhs-ctl');
    const joinslot = () => t.root.querySelector('.rhs-joinslot');
    return { ...t, input, api, drumsApi: drumsApi && t.win.feedBackDrums, setupCols, confirmRows, joinslot };
}
const ctlPrefs = (controllers, extra = {}) => ({
    controllers: controllers.map((c, i) => ({ id: `ctl${i + 1}`, name: c.key.split('#')[0], playsAs: 'five_fret', ...c })), ...extra,
});
const noParts = { parts: { guitar: { on: false }, drums: { on: false }, vocals: { on: false } } };
const ffSong = {
    filename: 'sloppak/ff.sloppak', title: 'Five', artist: 'Band', arrangements: [{ name: 'Lead', index: 0 }],
    has_drum_tab: false, has_vocal_pitch: false, stem_ids: ['guitar'], five_fret_parts: ['guitar:chart', 'bass:auto'],
};
const segBtn = (el, field, v) => el.querySelector(`.rhs-seg[data-field="${field}"]`).querySelector(`button[data-value="${v}"]`);

test('Start on a new pad adds a Setup column and a Confirm row', async () => {
    const t = ctlSetup();
    await flush();
    assert.equal(t.setupCols().length, 0);
    t.input.press(0, BTN.start);
    await flush();
    assert.deepEqual(t.prefs().controllers.map((c) => [c.key, c.id, c.name]), [['Xbox#1', 'ctl1', 'Xbox']]);
    const col = t.setupCols();
    assert.equal(col.length, 1);
    assert.equal(col[0].getAttribute('data-ctl'), 'Xbox#1');
    assert.equal(col[0].querySelector('.rhs-part-name').textContent, 'Xbox');
    assert.equal(col[0].querySelectorAll('.rhs-fret').length, 5);
    assert.ok(col[0].querySelector('.rhs-ctl-controls'));
    assert.ok(col[0].querySelector('.rhs-ctl-leave'));
    assert.ok(String(col[0].querySelector('.rhs-ico').innerHTML).includes('<svg'), 'Lucide icon');
    assert.equal(col[0].style.props['--rhs-c'], '#2ecc40');
    assert.equal(!!col[0].querySelector('.rhs-seg[data-field="playsAs"]'), false, 'one kind: no plays-as choice');
    const row = t.confirmRows();
    assert.equal(row.length, 1);
    assert.deepEqual(row[0].querySelectorAll('.rhs-seg[data-field]').map((s) => s.getAttribute('data-field')),
        ['part', 'difficulty', 'lefty', 'partAudio']);
    assert.equal(segBtn(row[0], 'part', 'guitar').getAttribute('aria-pressed'), 'true');
    assert.equal(segBtn(row[0], 'difficulty', 'medium').getAttribute('aria-pressed'), 'true');
    assert.equal(t.input.pads[0].claimedBy, 'rockherosmith');
    // A second Start on the same (now joined) pad does not add another.
    t.input.send('Xbox#1', BTN.start);
    assert.equal(t.prefs().controllers.length, 1);
    t.bs.dispose();
});

test('Confirm row controls write the controller prefs', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    const row = t.confirmRows()[0];
    segBtn(row, 'part', 'bass').click();
    segBtn(row, 'difficulty', 'expert').click();
    segBtn(row, 'lefty', 'on').click();
    segBtn(row, 'partAudio', 'always').click();
    const c = t.prefs().controllers[0];
    assert.deepEqual([c.part, c.difficulty, c.lefty, c.partAudio], ['bass', 'expert', true, 'always']);
    assert.equal(segBtn(t.confirmRows()[0], 'lefty', 'on').getAttribute('aria-pressed'), 'true');
    t.bs.dispose();
});

test('Leave removes them; the join slot explains how to join', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    assert.equal(t.setupCols().length, 1);
    assert.equal(t.input.pads[0].claimedBy, 'rockherosmith');
    t.setupCols()[0].querySelector('.rhs-ctl-leave').click();
    assert.deepEqual(t.prefs().controllers, []);
    assert.equal(t.setupCols().length, 0);
    assert.equal(t.confirmRows().length, 0);
    assert.equal(t.input.pads[0].claimedBy, null, 'the claim is released');
    assert.match(t.joinslot().textContent, /Press Start on a controller to join/);
    // It can join again.
    t.input.press(0, BTN.start);
    await flush();
    assert.equal(t.setupCols().length, 1);
    t.bs.dispose();
});

test('holding Back leaves through the join manager', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    t.input.send('Xbox#1', BTN.back, true);
    await new Promise((r) => setTimeout(r, 1050));
    assert.deepEqual(t.prefs().controllers, []);
    assert.equal(t.setupCols().length, 0);
    t.bs.dispose();
});

test('a joined controller that is not connected says so', async () => {
    const t = ctlSetup({ pads: [], stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    const col = t.setupCols()[0];
    assert.equal(col.querySelector('.rhs-note').textContent, 'Not connected');
    assert.ok(col.classList.contains('rhs-unavailable'));
    t.bs.dispose();
});

test('Confirm part segment: missing parts greyed, real/auto tags, also: names', async () => {
    const t = ctlSetup({
        showAuto: true, pads: [gpad(0, 'Xbox', 1), gpad(1, 'Xbox', 2)],
        stored: ctlPrefs([{ key: 'Xbox#1', part: 'guitar' }, { key: 'Xbox#2', name: 'Xbox 2', part: 'guitar' }]),
    });
    await flush();
    onConfirm(t, ffSong);
    const [a, b] = t.confirmRows();
    assert.equal(segBtn(a, 'part', 'rhythm').disabled, true, 'the song has no rhythm part');
    assert.equal(segBtn(a, 'part', 'guitar').disabled, false);
    assert.equal(segBtn(a, 'part', 'bass').disabled, false);
    assert.equal(segBtn(a, 'part', 'guitar').querySelector('.rhs-tag').textContent, 'real');
    assert.equal(segBtn(a, 'part', 'bass').querySelector('.rhs-tag').textContent, 'auto');
    assert.equal(segBtn(a, 'part', 'rhythm').querySelector('.rhs-tag').textContent, '');
    assert.equal(segBtn(a, 'part', 'guitar').querySelector('.rhs-also').textContent, 'also: Xbox 2');
    assert.equal(segBtn(b, 'part', 'guitar').querySelector('.rhs-also').textContent, 'also: Xbox');
    assert.equal(segBtn(a, 'part', 'bass').querySelector('.rhs-also').textContent, '');
    assert.match(segBtn(a, 'part', 'guitar').textContent, /^Lead/);
    t.bs.dispose();
    // Without the 5-Fret "show auto charts" setting the auto bass is greyed too.
    const u = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1', part: 'guitar' }]) });
    await flush();
    onConfirm(u, ffSong);
    assert.equal(segBtn(u.confirmRows()[0], 'part', 'bass').disabled, true);
    assert.deepEqual(u.root.querySelectorAll('.rhs-chip').at(-1).textContent, '5-fret: Lead');
    u.bs.dispose();
});

test('part audio greyed without the stem', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1', part: 'guitar' }]) });
    await flush();
    // A split song without the part's stem (an unsplit one keeps Rock Band: it muffles the mix).
    onConfirm(t, { ...ffSong, stem_ids: ['drums'] });
    let row = t.confirmRows()[0];
    assert.equal(segBtn(row, 'partAudio', 'rockband').disabled, true);
    assert.equal(segBtn(row, 'partAudio', 'always').disabled, true);
    assert.match(row.querySelector('.rhs-note').textContent, /stem/);
    t.bs.setSong(ffSong);
    row = t.confirmRows()[0];
    assert.equal(segBtn(row, 'partAudio', 'rockband').disabled, false);
    assert.equal(segBtn(row, 'partAudio', 'rockband').getAttribute('aria-pressed'), 'true');
    t.bs.dispose();
});

test('Start on a joined pad: Choose a song on Setup, GO on Confirm', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    t.input.send('Xbox#1', BTN.start);
    assert.equal(t.picker.calls.length, 1, 'Setup: Choose a song');
    assert.equal(t.gos.length, 0);
    t.picker.resolveLast({ item: ffSong });
    await flush();
    assert.equal(t.bs.view(), 'confirm');
    t.input.send('Xbox#1', BTN.start);
    assert.equal(t.gos.length, 1, 'Confirm: GO');
    assert.equal(t.picker.calls.length, 1);
    t.bs.dispose();
});

test('fret presses on a joined pad never press GO', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    onConfirm(t, ffSong);
    for (const b of [BTN.green, BTN.red, BTN.yellow, BTN.blue, BTN.orange, BTN.strum]) {
        t.input.send('Xbox#1', b, true);
    }
    assert.equal(t.gos.length, 0);
    const fret = (name) => t.setupCols()[0].querySelector(`.rhs-fret[data-fret="${name}"]`);
    for (const name of ['green', 'red', 'yellow', 'blue', 'orange']) assert.ok(fret(name).classList.contains('rhs-lit'), name);
    t.input.send('Xbox#1', BTN.orange, false);
    assert.equal(fret('orange').classList.contains('rhs-lit'), false);
    assert.ok(fret('green').classList.contains('rhs-lit'));
    for (const b of [BTN.green, BTN.red, BTN.yellow, BTN.blue, BTN.strum]) t.input.send('Xbox#1', b, false);
    assert.equal(t.gos.length, 0);
    assert.equal(t.picker.calls.length, 1, 'only the onConfirm helper pick');
    t.bs.dispose();
});

test('hiding for the library pick releases claims; Confirm re-claims', async () => {
    const t = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    onConfirm(t, ffSong);
    assert.equal(t.input.pads[0].claimedBy, 'rockherosmith');
    t.root.querySelector('.rhs-change').click();
    t.screen.classList.remove('active');
    t.fb.emit('screen:changing', { id: 'songs' });
    assert.equal(t.input.pads[0].claimedBy, null, 'the library gets the controller');
    assert.equal(t.input.watchers.length, 0, 'nothing is watched while hidden');
    t.screen.classList.add('active');
    t.fb.emit('screen:changed', { id: SCREEN });
    await flush();
    assert.equal(t.input.pads[0].claimedBy, 'rockherosmith', 'back on Confirm: claimed again');
    assert.equal(t.input.watchers.length, 1);
    t.bs.dispose();
    assert.equal(t.input.pads[0].claimedBy, null, 'dispose releases');
    assert.equal(t.input.watchers.length, 0);
});

test('Controls opens the 5-Fret controls screen returning to the band screen', async () => {
    const t = ctlSetup({
        pads: [gpad(0, 'Xbox', 1), gpad(1, 'Mystery', 1, { kind: null, mapping: '' })],
        stored: ctlPrefs([{ key: 'Xbox#1' }]),
    });
    await flush();
    t.setupCols()[0].querySelector('.rhs-ctl-controls').click();
    assert.deepEqual(t.api.opened, [{ returnTo: SCREEN }]);
    const links = t.joinslot().querySelectorAll('.rhs-setup-link');
    assert.equal(links.length, 1);
    assert.match(links[0].textContent, /Set up/);
    assert.match(links[0].textContent, /Mystery/);
    links[0].click();
    assert.deepEqual(t.api.opened, [{ returnTo: SCREEN }, { returnTo: SCREEN }]);
    t.bs.dispose();
});

test('returning from the controls screen refreshes the Set up list', async () => {
    const pads = [gpad(0, 'Mystery', 1, { kind: null, mapping: '' })];
    const t = ctlSetup({ pads });
    await flush();
    assert.equal(t.joinslot().querySelectorAll('.rhs-setup-link').length, 1);
    t.screen.classList.remove('active');
    t.fb.emit('screen:changing', { id: 'plugin-five_fret' });
    pads[0].kind = 'guitar'; // set up on the controls screen
    t.screen.classList.add('active');
    t.fb.emit('screen:changed', { id: SCREEN });
    await flush();
    assert.equal(t.joinslot().querySelectorAll('.rhs-setup-link').length, 0);
    t.input.press(0, BTN.start);
    await flush();
    assert.equal(t.prefs().controllers.length, 1, 'now it can join');
    t.bs.dispose();
});

test('no five-fret plugin: the join slot says so and nothing is watched', async () => {
    const t = ctlSetup({ plugin: false, stored: ctlPrefs([{ key: 'Xbox#1' }]) });
    await flush();
    assert.equal(t.joinslot().textContent, 'Install the 5-Fret or Drums plugin to play on a controller');
    assert.equal(t.input.watchers.length, 0);
    assert.equal(t.input.pads[0].claimedBy, null);
    t.input.press(0, BTN.start);
    assert.equal(t.prefs().controllers.length, 1);
    assert.equal(t.setupCols()[0].querySelector('.rhs-note').textContent, 'Install the 5-Fret or Drums plugin to play on a controller');
    t.bs.dispose();
    const old = ctlSetup({ watch: false });
    await flush();
    assert.equal(old.joinslot().textContent, 'Update feedBack to join with a controller');
    old.bs.dispose();
});

test('a band of controllers only can Go and open the song pick', async () => {
    const t = ctlSetup({ stored: { ...noParts, ...ctlPrefs([{ key: 'Xbox#1', part: 'bass' }]) } });
    await flush();
    assert.equal(t.root.querySelector('.rhs-choose').disabled, false);
    t.root.querySelector('.rhs-choose').click();
    assert.equal(t.picker.calls.length, 1);
    const f = t.picker.calls[0].filters;
    assert.deepEqual(f[0].params, { five_fret: 'bass:chart' }, 'playable by band asks for the controller part');
    assert.deepEqual(f.find((x) => x.id === 'fiveFret').params, { five_fret: 'any:chart' });
    t.picker.resolveLast({ item: { ...ffSong, five_fret_parts: ['bass:chart'] } });
    await flush();
    assert.equal(t.root.querySelector('.rhs-go').disabled, false);
    t.root.querySelector('.rhs-go').click();
    assert.equal(t.gos.length, 1);
    t.bs.dispose();
});

test('an Xbox pad with both plugins joins undecided; X plays 5-Fret and is remembered', async () => {
    const t = ctlSetup({ drums: true, pads: [gpad(0, 'Xbox', 1, { drumsKind: 'gamepad' })] });
    await flush();
    t.input.press(0, BTN.start);
    await flush();
    const c = t.prefs().controllers[0];
    assert.deepEqual([c.key, c.playsAs, c.part], ['Xbox#1', null, null], 'two kinds, nothing remembered: undecided');
    t.input.send('Xbox#1', 2); // X
    await flush();
    assert.deepEqual([t.prefs().controllers[0].playsAs, t.prefs().controllers[0].part], ['five_fret', 'guitar']);
    assert.deepEqual(t.prefs().controllerKinds, { 'Xbox#1': 'five_fret' });
    // The manager now plays it as 5-Fret: X is the yellow fret, B no longer picks.
    t.input.send('Xbox#1', 1); // B
    await flush();
    assert.equal(t.prefs().controllers[0].playsAs, 'five_fret');
    assert.equal(t.setupCols()[0].querySelector('.rhs-fret.rhs-lit') !== null, true);
    // Leave and rejoin: the remembered choice joins at once.
    t.setupCols()[0].querySelector('.rhs-ctl-leave').click();
    assert.equal(t.prefs().controllers.length, 0);
    assert.equal(t.input.pads[0].claimedBy, null);
    t.input.press(0, BTN.start, true, 5);
    await flush();
    assert.equal(t.prefs().controllers[0].playsAs, 'five_fret');
    t.bs.dispose();
});

test('a remembered kind the pad cannot play is dropped; a kit joins as drums', async () => {
    const t = ctlSetup({
        drums: true,
        pads: [gpad(0, 'Xbox', 1), gpad(1, 'Kit', 1, { kind: null, mapping: '', drumsKind: 'kit' })],
        stored: { controllerKinds: { 'Xbox#1': 'drums', 'Kit#1': 'five_fret' } },
    });
    await flush();
    t.input.press(0, BTN.start, true, 1);
    t.input.press(1, BTN.start, true, 2);
    await flush();
    assert.deepEqual(t.prefs().controllers.map((c) => [c.key, c.playsAs, c.part]),
        [['Xbox#1', 'five_fret', 'guitar'], ['Kit#1', 'drums', 'drums']]);
    // The kit's Controls opens the Drums controls screen.
    const kitCol = [...t.setupCols()].find((col) => col.getAttribute('data-ctl') === 'Kit#1');
    kitCol.querySelector('.rhs-ctl-controls').click();
    assert.deepEqual(t.drumsApi.opened, [{ returnTo: SCREEN }]);
    t.bs.dispose();
});

test('a pad set up nowhere offers setup with the first plugin present', async () => {
    const t = ctlSetup({ plugin: false, drums: true, pads: [gpad(0, 'Mystery', 1, { kind: null, mapping: '' })] });
    await flush();
    const links = t.joinslot().querySelectorAll('.rhs-setup-link');
    assert.equal(links.length, 1);
    links[0].click();
    assert.deepEqual(t.drumsApi.opened, [{ returnTo: SCREEN }]);
    t.bs.dispose();
});

// ── Plan 6 B4: drums controller columns and the plays-as choice ──────────
const drumSong = {
    filename: 'sloppak/dr.sloppak', title: 'Drum', artist: 'Band', arrangements: [{ name: 'Lead', index: 0 }],
    has_drum_tab: true, has_vocal_pitch: false, stem_ids: ['drums', 'guitar'], five_fret_parts: [],
};
const fields = (el) => el.querySelectorAll('.rhs-seg[data-field]').map((s) => s.getAttribute('data-field'));
const lit = (col, sel) => col.querySelectorAll(sel).filter((e) => e.classList.contains('rhs-lit')).map((e) => e.getAttribute('data-light'));
const xboxBoth = () => ctlSetup({ drums: true, pads: [gpad(0, 'Xbox', 1, { drumsKind: 'gamepad' })] });

test("an Xbox pad's column asks plays-as; choosing Drums swaps the lights and the Confirm row", async () => {
    const t = xboxBoth();
    await flush();
    t.input.press(0, BTN.start);
    await flush();
    let col = t.setupCols()[0];
    // Undecided: the segment and its pad hint, no lights, no part fields.
    assert.equal(segBtn(col, 'playsAs', 'five_fret').textContent, '5-Fret');
    assert.equal(segBtn(col, 'playsAs', 'drums').textContent, 'Drums');
    assert.equal(segBtn(col, 'playsAs', 'five_fret').getAttribute('aria-pressed'), 'false');
    assert.equal(segBtn(col, 'playsAs', 'drums').getAttribute('aria-pressed'), 'false');
    assert.equal(col.querySelector('.rhs-playsas-hint').textContent, 'X: 5-Fret \u00b7 B: Drums');
    assert.equal(col.querySelector('.rhs-note').textContent, 'Choose 5-Fret or Drums');
    assert.equal(col.querySelectorAll('[data-light]').length, 0);
    assert.deepEqual(fields(t.confirmRows()[0]), ['difficulty']);
    // It sits out, but the question it asks (and Leave / Controls) isn't dimmed.
    assert.ok(col.classList.contains('rhs-unavailable'));
    assert.ok(col.classList.contains('rhs-asking'));
    assert.ok(t.confirmRows()[0].classList.contains('rhs-unavailable'));
    assert.equal(t.confirmRows()[0].classList.contains('rhs-asking'), false);
    assert.ok(col.querySelector('.rhs-seg[data-field="playsAs"]').parentNode.classList.contains('rhs-playsas'));

    segBtn(col, 'playsAs', 'five_fret').click();
    await flush();
    col = t.setupCols()[0];
    assert.deepEqual([t.prefs().controllers[0].playsAs, t.prefs().controllers[0].part], ['five_fret', 'guitar']);
    assert.deepEqual(t.prefs().controllerKinds, { 'Xbox#1': 'five_fret' });
    assert.equal(segBtn(col, 'playsAs', 'five_fret').getAttribute('aria-pressed'), 'true');
    assert.equal(col.classList.contains('rhs-asking'), false, 'decided: nothing left to ask');
    assert.equal(col.querySelectorAll('.rhs-fret').length, 5);
    assert.deepEqual(fields(t.confirmRows()[0]), ['part', 'difficulty', 'lefty', 'partAudio']);
    t.input.send('Xbox#1', BTN.red);
    assert.deepEqual(lit(col, '.rhs-fret'), ['red']);

    segBtn(col, 'playsAs', 'drums').click();
    await flush();
    col = t.setupCols()[0];
    assert.deepEqual([t.prefs().controllers[0].playsAs, t.prefs().controllers[0].part], ['drums', 'drums']);
    assert.deepEqual(t.prefs().controllerKinds, { 'Xbox#1': 'drums' });
    assert.equal(segBtn(col, 'playsAs', 'drums').getAttribute('aria-pressed'), 'true');
    assert.equal(col.querySelectorAll('.rhs-fret').length, 0, 'the fret lights are gone');
    assert.deepEqual(col.querySelectorAll('.rhs-drumpad').map((e) => e.getAttribute('data-light')),
        ['red', 'yellow', 'blue', 'green', 'kick']);
    assert.equal(col.style.props['--rhs-c'], '#f28c28');
    assert.equal(t.confirmRows()[0].style.props['--rhs-c'], '#f28c28');
    const row = t.confirmRows()[0];
    assert.deepEqual(fields(row), ['drumPart', 'difficulty', 'soundMode']);
    assert.match(segBtn(row, 'drumPart', 'drums').textContent, /^Drums/);
    assert.equal(segBtn(row, 'drumPart', 'drums').getAttribute('aria-pressed'), 'true');
    // The drum lights: LB red, A kick; a released pad goes dark.
    t.input.send('Xbox#1', 4);
    t.input.send('Xbox#1', 0);
    assert.deepEqual(lit(col, '.rhs-drumpad'), ['red', 'kick']);
    t.input.send('Xbox#1', 4, false);
    assert.deepEqual(lit(col, '.rhs-drumpad'), ['kick']);
    t.bs.dispose();
});

test('B on an undecided pad chooses Drums and remembers it after leave and rejoin', async () => {
    const t = xboxBoth();
    await flush();
    t.input.press(0, BTN.start);
    await flush();
    assert.equal(t.prefs().controllers[0].playsAs, null);
    // Start on an undecided pad waits for X / B: no Choose a song.
    t.input.send('Xbox#1', BTN.start);
    assert.equal(t.picker.calls.length, 0, 'undecided Start is not the primary button');
    t.input.send('Xbox#1', 1); // B
    await flush();
    assert.deepEqual([t.prefs().controllers[0].playsAs, t.prefs().controllers[0].part], ['drums', 'drums']);
    assert.deepEqual(t.prefs().controllerKinds, { 'Xbox#1': 'drums' });
    assert.equal(t.setupCols()[0].querySelectorAll('.rhs-drumpad').length, 5);
    t.setupCols()[0].querySelector('.rhs-ctl-leave').click();
    assert.equal(t.prefs().controllers.length, 0);
    t.input.press(0, BTN.start, true, 5);
    await flush();
    assert.deepEqual([t.prefs().controllers[0].playsAs, t.prefs().controllers[0].part], ['drums', 'drums']);
    // Decided: Start is the primary button again.
    t.input.send('Xbox#1', BTN.start, true, 6);
    assert.equal(t.picker.calls.length, 1, 'Choose a song');
    t.bs.dispose();
});

test('drums Confirm row: difficulty and sound mode saved; modes greyed without a drum stem', async () => {
    const t = ctlSetup({
        drums: true, pads: [gpad(0, 'Kit', 1, { kind: null, mapping: '', drumsKind: 'kit' })],
        stored: ctlPrefs([{ key: 'Kit#1', playsAs: 'drums', part: 'drums' }]),
    });
    await flush();
    onConfirm(t, drumSong);
    let row = t.confirmRows()[0];
    assert.equal(t.setupCols()[0].querySelector('.rhs-seg[data-field="playsAs"]'), null, 'a kit plays drums only');
    assert.equal(segBtn(row, 'drumPart', 'drums').querySelector('.rhs-also').textContent, 'also: Drums', 'the real drummer is on');
    assert.equal(segBtn(row, 'soundMode', 'rockband').getAttribute('aria-pressed'), 'true', 'default Rock Band');
    assert.deepEqual(row.querySelector('.rhs-seg[data-field="soundMode"]').querySelectorAll('button').map((b) => [b.getAttribute('data-value'), b.textContent]),
        [['rockband', 'Rock Band'], ['song', 'Song + pads'], ['kit', 'Kit only']]);
    segBtn(row, 'difficulty', 'expert').click();
    segBtn(row, 'soundMode', 'kit').click();
    let c = t.prefs().controllers[0];
    assert.deepEqual([c.difficulty, c.soundMode], ['expert', 'kit']);
    row = t.confirmRows()[0];
    assert.equal(segBtn(row, 'difficulty', 'expert').getAttribute('aria-pressed'), 'true');
    assert.equal(segBtn(row, 'soundMode', 'kit').getAttribute('aria-pressed'), 'true');
    assert.equal(row.querySelector('.rhs-note').textContent, "The drummer's sound mode sets the drum stem", 'the real drummer is on');
    // No drum stem: Rock Band and Kit only are greyed, Song + pads plays, the stored mode stays.
    t.bs.setSong({ ...drumSong, stem_ids: ['guitar'] });
    row = t.confirmRows()[0];
    assert.equal(segBtn(row, 'soundMode', 'rockband').disabled, true);
    assert.equal(segBtn(row, 'soundMode', 'kit').disabled, true);
    assert.equal(segBtn(row, 'soundMode', 'song').disabled, false);
    assert.equal(segBtn(row, 'soundMode', 'song').getAttribute('aria-pressed'), 'true');
    assert.equal(row.querySelector('.rhs-note').textContent, 'Rock Band and Kit only need a drum stem');
    c = t.prefs().controllers[0];
    assert.equal(c.soundMode, 'kit');
    t.bs.dispose();
});

test('Controls on a drums controller opens the Drums screen returning to the band', async () => {
    const t = ctlSetup({
        drums: true, pads: [gpad(0, 'Xbox', 1, { drumsKind: 'gamepad' })],
        stored: ctlPrefs([{ key: 'Xbox#1', playsAs: 'drums', part: 'drums' }]),
    });
    await flush();
    t.setupCols()[0].querySelector('.rhs-ctl-controls').click();
    assert.deepEqual(t.drumsApi.opened, [{ returnTo: SCREEN }]);
    assert.deepEqual(t.api.opened, []);
    segBtn(t.setupCols()[0], 'playsAs', 'five_fret').click();
    t.setupCols()[0].querySelector('.rhs-ctl-controls').click();
    assert.deepEqual(t.api.opened, [{ returnTo: SCREEN }], '5-Fret: the 5-Fret controls');
    assert.equal(t.drumsApi.opened.length, 1);
    t.bs.dispose();
});

test('Set up offers guitar and drum kit', async () => {
    const t = ctlSetup({ drums: true, pads: [gpad(0, 'Mystery', 1, { kind: null, mapping: '' })] });
    await flush();
    const links = t.joinslot().querySelectorAll('.rhs-setup-link');
    assert.deepEqual(links.map((l) => l.textContent), ['Set up Mystery as guitar', 'Set up Mystery as drum kit']);
    links[0].click();
    assert.deepEqual([t.api.opened.length, t.drumsApi.opened.length], [1, 0]);
    links[1].click();
    assert.deepEqual(t.api.opened, [{ returnTo: SCREEN }]);
    assert.deepEqual(t.drumsApi.opened, [{ returnTo: SCREEN }]);
    t.bs.dispose();
});

test('an asking column keeps Plays as, Leave and Controls at full strength', () => {
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    assert.match(css, /\.rhs-col\.rhs-unavailable\.rhs-asking\s*\{[^}]*opacity:\s*1[^}]*filter:\s*none/);
    assert.match(css, /\.rhs-col\.rhs-unavailable\.rhs-asking > :not\(\.rhs-playsas\):not\(\.rhs-ctl-actions\)\s*\{[^}]*opacity:\s*0\.35/);
});

// ── Entry points: openWithSong, openSetup, joinPad ─────────────────────────
const searchUrls = (t) => t.urls.filter((u) => u.startsWith('/api/library?q='));

test('openWithSong goes to Confirm when a band is set up', async () => {
    const t = setup({ stored: { parts: { guitar: { deviceKey: 'g' } } }, library: [holiday] });
    const row = { ...holiday, arrangements: undefined }; // a grouped grid row
    assert.equal(t.bs.openWithSong(row), 'confirm');
    assert.equal(t.bs.view(), 'confirm');
    assert.equal(t.root.querySelector('.rhs-title').textContent, 'Holiday');
    assert.equal(t.prefs().lastSong.filename, holiday.filename);
    await flush();
    assert.deepEqual(searchUrls(t), ['/api/library?q=Holiday&size=30']);
    assert.equal(t.bs.getSong(), holiday, 're-resolved to the flat row');
    t.bs.dispose();
});

test('openWithSong goes to Setup on first run, with Continue', () => {
    const t = setup();
    assert.equal(t.bs.openWithSong(holiday), 'setup');
    assert.equal(t.bs.view(), 'setup');
    const cont = t.root.querySelector('.rhs-continue');
    assert.equal(cont.hidden, false);
    assert.equal(cont.textContent, 'Continue with Holiday');
    cont.click();
    assert.equal(t.bs.view(), 'confirm');
    t.bs.dispose();
});

test('openWithSong ignores a bad item and does nothing once disposed', () => {
    const t = setup();
    assert.equal(t.bs.openWithSong(null), null);
    assert.equal(t.bs.openWithSong({ title: 'x' }), null);
    assert.equal(t.bs.openWithSong({ filename: '' }), null);
    assert.equal(t.bs.getSong(), null);
    t.bs.dispose();
    assert.equal(t.bs.openWithSong(holiday), null);
});

test('openWithSong drops a pending Next song pick', async () => {
    const t = setup({ active: false });
    t.bs.nextSong();
    assert.equal(t.bs.openWithSong(holiday), 'setup');
    t.screen.classList.add('active');
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'home' });
    assert.equal(t.picker.calls.length, 0, 'no pick on show');
    t.bs.dispose();
    // A pick already open: its late result no longer replaces the song.
    const u = setup();
    u.bs.nextSong();
    assert.equal(u.picker.calls.length, 1);
    u.bs.openWithSong(holiday);
    u.picker.resolveLast({ item: { ...holiday, filename: 'other.sloppak', title: 'Other' } });
    await flush();
    assert.equal(u.bs.getSong().filename, holiday.filename);
    u.bs.dispose();
});

test('openSetup returns to Setup from Confirm', () => {
    const t = setup();
    onConfirm(t, holiday);
    assert.equal(t.bs.view(), 'confirm');
    t.bs.openSetup();
    assert.equal(t.bs.view(), 'setup');
    t.bs.dispose();
});

test('openSetup drops a pending Next song pick', () => {
    const t = setup({ active: false });
    t.bs.nextSong();
    t.bs.openSetup();
    t.screen.classList.add('active');
    t.fb.emit('screen:changed', { id: 'plugin-rockherosmith', from: 'home' });
    assert.equal(t.picker.calls.length, 0);
    assert.equal(t.bs.view(), 'setup');
    t.bs.dispose();
});

test('joinPad while hidden joins on the next show', async () => {
    const t = ctlSetup({ active: false });
    t.bs.joinPad(0);
    await flush();
    assert.equal(t.prefs().controllers.length, 0, 'hidden: waits');
    t.screen.classList.add('active');
    t.fb.emit('screen:changed', { id: SCREEN, from: 'home' });
    await flush();
    assert.deepEqual(t.prefs().controllers.map((c) => c.key), ['Xbox#1']);
    assert.equal(t.input.pads[0].claimedBy, 'rockherosmith');
    t.bs.dispose();
});

test('joinPad while shown joins now', async () => {
    const t = ctlSetup();
    await flush();
    t.bs.joinPad(0);
    assert.deepEqual(t.prefs().controllers.map((c) => c.key), ['Xbox#1']);
    assert.equal(t.input.pads[0].claimedBy, 'rockherosmith');
    t.bs.dispose();
});

test('joinPad ignores a non-integer pad; leaving drops a pending join', async () => {
    const t = ctlSetup({ active: false });
    t.bs.joinPad('0');
    t.bs.joinPad(0.5);
    t.screen.classList.add('active');
    t.fb.emit('screen:changed', { id: SCREEN, from: 'home' });
    await flush();
    assert.equal(t.prefs().controllers.length, 0);
    t.bs.dispose();
    const u = ctlSetup({ active: false });
    u.bs.joinPad(0);
    u.fb.emit('screen:changed', { id: 'home', from: 'library' }); // the user went elsewhere
    u.screen.classList.add('active');
    u.fb.emit('screen:changed', { id: SCREEN, from: 'home' });
    await flush();
    assert.equal(u.prefs().controllers.length, 0);
    u.bs.dispose();
});

// ---- Part sheet stream (B1): sound-mode labels and the pad volume ----

const padDrums = (volume = 0.8) => {
    const sets = [];
    return { sets, api: {
        getPadSound: () => ({ muted: false, volume }),
        setPadSound: (o) => { sets.push(o); if (typeof o.volume === 'number') volume = o.volume; return { muted: false, volume }; },
    } };
};

test("the real drummer's sound modes read Rock Band / Song + pads / Kit only, with the pad volume beside them", () => {
    const pads = padDrums(0.7);
    const { part, bs } = setup({ winExtra: { feedBackDrums: pads.api } });
    const seg = part('drums').querySelector('.rhs-seg[data-field="soundMode"]');
    assert.deepEqual(seg.querySelectorAll('button').map((b) => [b.getAttribute('data-value'), b.textContent]),
        [['rockband', 'Rock Band'], ['song', 'Song + pads'], ['kit', 'Kit only']]);
    const field = part('drums').querySelector('.rhs-padvol');
    assert.ok(field, 'a pad volume field on the drums row');
    assert.equal(field.parentNode, seg.parentNode.parentNode, 'beside the sound mode');
    assert.equal(field.hidden, false);
    const input = field.querySelector('.rhs-padvol-input');
    assert.equal(input.value, '70');
    input.value = '45';
    input.fire('input');
    assert.deepEqual(pads.sets, [{ volume: 0.45 }]);
    bs.dispose();
});

test('without the pad sound API the pad volume hides', () => {
    const { part, bs } = setup();
    assert.equal(part('drums').querySelector('.rhs-padvol').hidden, true);
    bs.dispose();
});

test('a drums controller row has the pad volume beside its sound mode; a 5-fret row has none', async () => {
    const pads = padDrums(0.5);
    const t = ctlSetup({
        drums: true, pads: [gpad(0, 'Kit', 1, { kind: null, mapping: '', drumsKind: 'kit' })],
        stored: ctlPrefs([{ key: 'Kit#1', playsAs: 'drums', part: 'drums' }]),
        winExtra: { feedBackDrums: pads.api },
    });
    await flush();
    onConfirm(t, drumSong);
    const row = t.confirmRows()[0];
    const field = row.querySelector('.rhs-padvol');
    assert.ok(field);
    assert.equal(field.hidden, false);
    const input = field.querySelector('.rhs-padvol-input');
    assert.equal(input.value, '50');
    input.value = '90';
    input.fire('input');
    assert.deepEqual(pads.sets, [{ volume: 0.9 }]);
    t.bs.dispose();
    const ff = ctlSetup({ stored: ctlPrefs([{ key: 'Xbox#1', part: 'guitar' }]) });
    await flush();
    onConfirm(ff, ffSong);
    assert.equal(ff.confirmRows()[0].querySelector('.rhs-padvol'), null);
    ff.bs.dispose();
});
