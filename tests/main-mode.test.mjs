import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_ID, isBandReady, bandIsSetUp, registerMainMode } from '../src/main-mode.js';
import { makeDoc, makeEl } from './fake-dom.mjs';
import { normalizePrefs } from '../src/prefs.js';

test('MODE_ID is the plugin id', () => {
    assert.equal(MODE_ID, 'rockherosmith');
});

test('isBandReady: a real guitar part plus a five-fret chart or a drum chart', () => {
    assert.equal(isBandReady({ arrangements: [{ name: 'Lead' }], has_drum_tab: 1 }), true);
    assert.equal(isBandReady({ arrangements: [{ name: 'Rhythm' }, { name: 'Drums', type: 'drums' }] }), true);
    assert.equal(isBandReady({ arrangements: [{ name: 'Bass' }], five_fret_parts: ['bass:chart'] }), true);
});

test('isBandReady: guitar only, lyrics only, auto charts, five-fret-only packs and Combo do not qualify', () => {
    assert.equal(isBandReady({ arrangements: [{ name: 'Lead' }] }), false, 'guitar only');
    assert.equal(isBandReady({ arrangements: [{ name: 'Lead' }], has_vocal_pitch: true }), false, 'lyrics only');
    assert.equal(isBandReady({ arrangements: [{ name: 'Lead' }], five_fret_parts: ['guitar:auto'] }), false, 'auto chart only');
    assert.equal(isBandReady({ five_fret_only: true, arrangements: [{ name: 'Lead' }], five_fret_parts: ['guitar:chart'] }), false,
        'five-fret-only pack');
    assert.equal(isBandReady({ arrangements: [{ name: 'Combo' }], has_drum_tab: 1 }), false, 'Combo only');
    assert.equal(isBandReady(null), false);
});

test('bandIsSetUp: defaults are not a band', () => {
    assert.equal(bandIsSetUp(normalizePrefs({})), false);
});

test('bandIsSetUp: a fixed part that is on with a saved device', () => {
    assert.equal(bandIsSetUp(normalizePrefs({ parts: { guitar: { deviceKey: 'g' } } })), true);
    assert.equal(bandIsSetUp(normalizePrefs({ parts: { guitar: { on: false, deviceKey: 'g' } } })), false, 'guitar off');
    assert.equal(bandIsSetUp(normalizePrefs({ parts: { drums: { deviceKey: 'k' } } })), true, 'drums');
    assert.equal(bandIsSetUp(normalizePrefs({ parts: { vocals: { deviceId: 'm' } } })), true, 'vocals');
});

test('bandIsSetUp: a joined controller that is on', () => {
    const ctl = (on) => normalizePrefs({ controllers: [{ key: 'Xbox#1', id: 'ctl1', playsAs: 'five_fret', on }] });
    assert.equal(bandIsSetUp(ctl(true)), true);
    assert.equal(bandIsSetUp(ctl(false)), false);
});

test('bandIsSetUp: missing or partial prefs do not throw', () => {
    assert.equal(bandIsSetUp(null), false);
    assert.equal(bandIsSetUp({}), false);
    assert.equal(bandIsSetUp({ controllers: [{ key: 'a' }] }), true, 'on !== false');
});

// ---- registerMainMode (Task 11) ----

function fakeWin({ phase = 'idle', onScreen = false, noRegister = false, cardActions = null } = {}) {
    const calls = [];
    const specs = [];
    const listeners = [];
    let unregisters = 0;
    const screenEl = { classList: { contains: (c) => c === 'active' && onScreen } };
    const win = {
        document: { getElementById: (id) => (id === 'plugin-rockherosmith' ? screenEl : null) },
        feedBack: {
            ui: noRegister ? {} : { registerPlayMode(spec) { specs.push(spec); return () => { unregisters++; }; } },
            on(t, f) { listeners.push([t, f]); calls.push(['on', t]); },
            off(t, f) { calls.push(['off', t, listeners.some((l) => l[0] === t && l[1] === f)]); },
            ...(cardActions ? { libraryCardActions: cardActions } : {}),
        },
    };
    const screen = {
        openSetup() { calls.push(['openSetup']); },
        openWithSong(item) { calls.push(['openWithSong', item]); return 'setup'; },
        joinPad(pad) { calls.push(['joinPad', pad]); },
    };
    const runtime = { phase: () => phase };
    const dispose = registerMainMode({
        win, getScreen: () => screen, getRuntime: () => runtime,
        showScreen: (id) => calls.push(['showScreen', id]),
        openSolo: () => calls.push(['openSolo']),
    });
    const fire = (detail) => { for (const [t, f] of listeners) if (t === 'gamepad:start-pressed') f({ detail }); };
    return { win, calls, specs, listeners, dispose, fire, unregisters: () => unregisters };
}

test('registerMainMode registers one mode with the spec values', () => {
    const { specs, listeners } = fakeWin();
    assert.equal(specs.length, 1);
    const s = specs[0];
    assert.equal(s.id, 'rockherosmith');
    assert.equal(s.label, 'RockHeroSmith');
    assert.equal(s.startLabel, 'Play RockHeroSmith');
    assert.equal(s.order, 10);
    assert.equal(s.startPress, true);
    assert.equal(typeof s.renderHero, 'function');
    assert.equal(typeof s.start, 'function');
    assert.deepEqual(s.tour, {
        title: 'Play RockHeroSmith',
        content: 'Plug in your guitar, hand a friend a Guitar Hero or Rock Band controller, and press Start. You play the song together on one stage.',
    });
    assert.equal(s.cardAction.label, 'RockHeroSmith');
    assert.equal(s.cardAction.title, 'Play with RockHeroSmith');
    assert.equal(s.cardAction.isAvailable, isBandReady);
    assert.equal(typeof s.cardAction.run, 'function');
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0][0], 'gamepad:start-pressed');
});

test('registerMainMode: start opens Setup then shows the screen', () => {
    const { specs, calls } = fakeWin();
    calls.length = 0;
    specs[0].start();
    assert.deepEqual(calls, [['openSetup'], ['showScreen', 'plugin-rockherosmith']]);
});

test('registerMainMode: the card opens the song', () => {
    const { specs, calls } = fakeWin();
    calls.length = 0;
    const item = { filename: 'a.psarc' };
    specs[0].cardAction.run(item);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'openWithSong');
    assert.equal(calls[0][1], item);
    assert.deepEqual(calls[1], ['showScreen', 'plugin-rockherosmith']);
});

test('registerMainMode: gamepad:start-pressed joins the pad', () => {
    const { fire, calls } = fakeWin();
    calls.length = 0;
    fire({ pad: 2, id: 'x', controllerKey: 'k' });
    assert.deepEqual(calls, [['openSetup'], ['joinPad', 2], ['showScreen', 'plugin-rockherosmith']]);
});

test('registerMainMode: a non-integer pad is ignored', () => {
    const { fire, listeners, calls } = fakeWin();
    calls.length = 0;
    fire({ pad: 1.5 });
    fire({ pad: '2' });
    fire({});
    listeners[0][1](null);
    assert.deepEqual(calls, []);
});

test('registerMainMode: not idle, start, card and Start all do nothing', () => {
    const { specs, fire, calls } = fakeWin({ phase: 'playing' });
    calls.length = 0;
    specs[0].start();
    specs[0].cardAction.run({ filename: 'a.psarc' });
    fire({ pad: 0 });
    assert.deepEqual(calls, []);
});

test('registerMainMode: Start while already on the screen does not open Setup', () => {
    const { fire, calls } = fakeWin({ onScreen: true });
    calls.length = 0;
    fire({ pad: 0 });
    assert.deepEqual(calls, []);
});

test('registerMainMode: no registerPlayMode (older core) is a no-op', () => {
    let r;
    assert.doesNotThrow(() => { r = fakeWin({ noRegister: true }); });
    assert.deepEqual(r.calls, []);
    assert.equal(typeof r.dispose, 'function');
    assert.doesNotThrow(() => r.dispose());
    assert.deepEqual(r.calls, []);
});

test('registerMainMode: dispose unregisters and offs once; a second dispose does nothing', () => {
    const { dispose, calls, unregisters } = fakeWin();
    calls.length = 0;
    dispose();
    assert.equal(unregisters(), 1);
    assert.deepEqual(calls, [['off', 'gamepad:start-pressed', true]]);
    dispose();
    assert.equal(unregisters(), 1);
    assert.equal(calls.length, 1);
});

test('registerMainMode: a Play as entry opens the band screen with the song; dispose removes it', () => {
    const acts = [];
    let removed = 0;
    const cardActions = { register(spec) { acts.push(spec); return () => { removed++; }; } };
    const { calls, dispose } = fakeWin({ cardActions });
    assert.equal(acts.length, 1);
    const a = acts[0];
    assert.equal(a.id, 'rockherosmith.play-as');
    assert.equal(a.placement, 'play-as');
    assert.equal(a.applies, isBandReady);
    assert.equal(a.enabled(), true);
    calls.length = 0;
    const item = { filename: 'a.sloppak' };
    a.run(item);
    assert.deepEqual(calls, [['openWithSong', item], ['showScreen', 'plugin-rockherosmith']]);
    dispose();
    assert.equal(removed, 1);
});

test('registerMainMode: the Play as entry is disabled while a session runs', () => {
    const acts = [];
    fakeWin({ phase: 'playing', cardActions: { register(spec) { acts.push(spec); return () => {}; } } });
    assert.equal(acts[0].enabled(), false);
});

test('registerMainMode: the Home hero has the art and a Play solo button that opens the Solo screen', () => {
    const { specs, calls } = fakeWin();
    calls.length = 0;
    const doc = makeDoc();
    const el = makeEl('div', doc);
    specs[0].renderHero(el);
    assert.match(el.innerHTML, /rhs-wordmark/, 'the art');
    const solo = el.querySelector('.rhs-hero-solo');
    assert.ok(solo, 'the Solo button');
    assert.equal(solo.textContent, 'Play solo');
    solo.click();
    assert.deepEqual(calls, [['openSolo']]);
    specs[0].renderHero(el);
    assert.equal(el.querySelectorAll('.rhs-hero-solo').length, 1, 'a re-render keeps one button');
    specs[0].renderHero(null);
});

test('registerMainMode: Play solo does nothing while a session runs', () => {
    const { specs, calls } = fakeWin({ phase: 'playing' });
    calls.length = 0;
    const doc = makeDoc();
    const el = makeEl('div', doc);
    specs[0].renderHero(el);
    el.querySelector('.rhs-hero-solo').click();
    assert.deepEqual(calls, []);
});
