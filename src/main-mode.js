// RockHeroSmith as a core play mode: which songs the band can play, whether a band is
// set up, and the registration with core (Home hero, library card, Press Start, tour).
// Everything about songs comes from parts.js.
import { songFacts, hasChart, getPart, drumsControllerPartFor } from './parts.js';
import { renderHeroArt } from './hero-art.js';

export const MODE_ID = 'rockherosmith';

// Band-ready (R11): a real guitar arrangement (Lead / Rhythm / Bass, not a five-fret-only
// pack; Combo-only doesn't count) and a five-fret chart or a drum chart. Lyrics alone don't.
export function isBandReady(item) {
    return !!item && hasChart(getPart('guitar'), item)
        && (songFacts(item).fiveFret.some((p) => p.kind === 'chart') || drumsControllerPartFor(item) !== null);
}

// The saved device field of each fixed part.
const DEVICE_FIELD = { guitar: 'deviceKey', drums: 'deviceKey', vocals: 'deviceId' };

// A band is set up (R12): a joined controller that is on, or a fixed part that is on
// with a saved device.
export function bandIsSetUp(prefs) {
    const p = prefs || {};
    if (Array.isArray(p.controllers) && p.controllers.some((c) => c && c.on !== false)) return true;
    const parts = p.parts || {};
    return Object.keys(DEVICE_FIELD).some((id) => {
        const part = parts[id];
        return !!part && part.on === true && typeof part[DEVICE_FIELD[id]] === 'string' && part[DEVICE_FIELD[id]] !== '';
    });
}

const SCREEN_ID = 'plugin-rockherosmith';
const TOUR_CONTENT = 'Plug in your guitar, hand a friend a Guitar Hero or Rock Band controller, and press Start.'
    + ' You play the song together on one stage.';

// Register RockHeroSmith with core's play-mode registry and subscribe to Press Start.
// openSolo: opens the Solo screen (the hero's Play solo button).
// -> dispose(): unregisters and unsubscribes, once. Older core (no registerPlayMode): a no-op.
export function registerMainMode({ win, getScreen, getRuntime, showScreen, openSolo }) {
    const fb = win && win.feedBack;
    if (!fb || !fb.ui || typeof fb.ui.registerPlayMode !== 'function') return () => {};

    // R14: no entry point while a session runs.
    function idle() {
        const rt = getRuntime();
        return !rt || typeof rt.phase !== 'function' || rt.phase() === 'idle';
    }
    function onScreen() {
        const el = win.document && win.document.getElementById(SCREEN_ID);
        return !!(el && el.classList.contains('active'));
    }

    // R13: Play RockHeroSmith opens Setup.
    function openSetupEntry() {
        if (!idle()) return false;
        getScreen()?.openSetup();
        showScreen(SCREEN_ID);
        return true;
    }
    // R13: the card opens Confirm or Setup with the song (band-screen decides).
    function openSongEntry(item) {
        if (!idle()) return false;
        getScreen()?.openWithSong(item);
        showScreen(SCREEN_ID);
        return true;
    }
    // The Home hero: the art, plus Play solo beside core's Play RockHeroSmith (the band).
    function renderHero(el) {
        if (!el) return;
        renderHeroArt(el);
        const old = typeof el.querySelector === 'function' ? el.querySelector('.rhs-hero-solo') : null;
        if (old) old.remove();
        const doc = el.ownerDocument || win.document;
        if (typeof openSolo !== 'function' || !doc || typeof doc.createElement !== 'function') return;
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'rhs-hero-solo';
        b.textContent = 'Play solo';
        b.setAttribute('title', 'Play a song alone on drums, a controller or guitar');
        b.addEventListener('click', () => { if (idle()) openSolo(); });
        el.appendChild(b);
    }
    // Press Start: Setup with that pad joined. Core never emits on plugin screens;
    // the on-screen check is a backstop.
    function onStart(e) {
        const pad = e && e.detail && e.detail.pad;
        if (!Number.isInteger(pad) || !idle() || onScreen()) return;
        const screen = getScreen();
        screen?.openSetup();
        screen?.joinPad(pad);
        showScreen(SCREEN_ID);
    }

    const unregister = fb.ui.registerPlayMode({
        id: MODE_ID, label: 'RockHeroSmith', startLabel: 'Play RockHeroSmith', order: 10,
        startPress: true, renderHero, start: openSetupEntry,
        tour: { title: 'Play RockHeroSmith', content: TOUR_CONTENT },
        cardAction: { label: 'RockHeroSmith', title: 'Play with RockHeroSmith', isAvailable: isBandReady, run: openSongEntry },
    });
    // Core's "Play as" menus (libraryCardActions, placement 'play-as'): the band screen with this
    // song, on band-ready songs; greyed out while a session runs.
    const cardActions = fb.libraryCardActions;
    const unregisterPlayAs = cardActions && typeof cardActions.register === 'function'
        ? cardActions.register({
            id: 'rockherosmith.play-as', pluginId: MODE_ID, label: 'RockHeroSmith', hint: 'band screen',
            group: 'Band', placement: 'play-as', order: 50,
            applies: isBandReady, enabled: idle, run: openSongEntry,
        })
        : null;
    const hasBus = typeof fb.on === 'function';
    if (hasBus) fb.on('gamepad:start-pressed', onStart);

    let disposed = false;
    return function dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof unregister === 'function') unregister();
        if (typeof unregisterPlayAs === 'function') unregisterPlayAs();
        if (hasBus && typeof fb.off === 'function') fb.off('gamepad:start-pressed', onStart);
    };
}
