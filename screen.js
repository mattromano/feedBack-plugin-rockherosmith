// RockHeroSmith entry point. The stage and its player wiring live in src/*;
// this file only boots the runtime when a browser window exists, so importing
// it under node stays side-effect free.
import { loadPrefs, savePrefs, createPrefsCache } from './src/prefs.js';
import { mountStage } from './src/stage.js';
import { createBandRuntime } from './src/band-runtime.js';
import { createBandScreen } from './src/band-screen.js';
import { registerMainMode } from './src/main-mode.js';
import { createSoloPlay, createAdopt, soloKindFor, quickSettingPatch } from './src/solo.js';
import { createSoloScreen, createOpenSolo, mountSoloScreenElement } from './src/solo-screen.js';

export { loadPrefs, savePrefs };

const safe = (fn) => { try { return fn(); } catch (_) { return undefined; } };

function init() {
    const fb = window.feedBack;
    if (!fb || typeof fb.on !== 'function') return;
    // Re-running this module (plugin reload) must not stack listeners or
    // leave a stage behind: tear the previous runtime down first.
    // The prefs for hot-path readers (adoptsSolo); a re-run replaces the old cache.
    if (window.__rockherosmithPrefsCache) safe(() => window.__rockherosmithPrefsCache.dispose());
    const prefsCache = createPrefsCache({ win: window });
    window.__rockherosmithPrefsCache = prefsCache;
    const prev = window.__rockherosmithRuntime || window.__buildABandRuntime;
    if (prev && typeof prev.dispose === 'function') {
        try { prev.dispose(); } catch (_) { /* ignore */ }
    }
    // Inputs already handed to note_detect / drums, shared by the band screen
    // (device picks) and the runtime (Go), so neither re-applies the other's.
    const deviceMemo = {};
    const showScreen = (id) => window.showScreen && window.showScreen(id);
    // The Solo screen (contract §1, src/solo-screen.js); the band screen when it isn't built.
    const openSolo = createOpenSolo({
        getSoloScreen: () => window.__rockherosmithSoloScreen, getScreen: () => window.__rockherosmithScreen, showScreen,
    });
    const runtime = createBandRuntime({ win: window, doc: document, mountStage, loadPrefs, deviceMemo,
        // A plain drums / 5-fret play on the main highway becomes a one-player session (contract §2).
        adopt: createAdopt({ win: window, doc: document, loadPrefs }),
        // Next song after a playSolo session, and leaving one mid-song (adopted plays use core's exit).
        onShowSoloScreen: ({ next }) => openSolo({ next }),
        // A 5-fret lane's quick settings change: saved into that controller's entry
        // (band) or the Solo choices (solo), so it sticks for the next song.
        onQuickSetting: (detail, { solo }) => {
            const patch = quickSettingPatch(loadPrefs(), detail, { solo });
            if (patch) savePrefs(patch);
        },
        // Next song: the band screen opens the library pick (nextSong picks now or on its next show).
        onShowBandScreen: () => {
            const bs = window.__rockherosmithScreen;
            if (bs && typeof bs.nextSong === 'function') bs.nextSong();
        },
    });
    window.__rockherosmithRuntime = runtime;
    // Deprecated alias (one release, remove after 0.2.x): stale peers may still read the old name.
    window.__buildABandRuntime = runtime;

    const prevScreen = window.__rockherosmithScreen || window.__buildABandScreen;
    if (prevScreen && typeof prevScreen.dispose === 'function') {
        try { prevScreen.dispose(); } catch (_) { /* ignore */ }
    }
    window.__rockherosmithScreen = null;
    // Deprecated alias (one release, remove after 0.2.x): stale peers may still read the old name.
    window.__buildABandScreen = null;
    // screen.html is inserted before this module runs, so the root exists now.
    const root = document.getElementById('rockherosmith-root');
    if (root) {
        window.__rockherosmithScreen = createBandScreen({
            root, win: window, doc: document, loadPrefs, savePrefs, deviceMemo,
            onGo: (item, prefs) => {
                savePrefs(prefs);
                // false or a rejection releases the band screen's Go latch.
                return runtime.startSession({ song: item, prefs });
            },
        });
        // Deprecated alias (one release, remove after 0.2.x): stale peers may still read the old name.
        window.__buildABandScreen = window.__rockherosmithScreen;
    }

    // Solo play (a band of one): one entry for the drums / 5-Fret plugins' Play as and the Solo screen.
    const playSolo = createSoloPlay({
        getRuntime: () => window.__rockherosmithRuntime,
        getScreen: () => window.__rockherosmithScreen,
        loadPrefs,
        showScreen,
    });

    // The Solo screen: its own core screen next to the band screen, so the band
    // screen's device lights and controller joins stay off while it shows.
    if (window.__rockherosmithSoloScreen) safe(() => window.__rockherosmithSoloScreen.dispose());
    window.__rockherosmithSoloScreen = null;
    const soloEl = mountSoloScreenElement(document, document.getElementById('plugin-rockherosmith'));
    const soloRoot = soloEl && soloEl.querySelector('#rockherosmith-solo-root');
    if (soloRoot) {
        window.__rockherosmithSoloScreen = createSoloScreen({
            root: soloRoot, win: window, doc: document, loadPrefs, savePrefs, playSolo,
            openBand: () => {
                const bs = window.__rockherosmithScreen;
                if (bs && typeof bs.openSetup === 'function') bs.openSetup();
                showScreen('plugin-rockherosmith');
            },
        });
    }
    // The band screen's Solo link (screen.html persists across reloads, so the old listener goes first).
    if (typeof window.__rockherosmithSoloLink === 'function') safe(window.__rockherosmithSoloLink);
    window.__rockherosmithSoloLink = null;
    const soloLink = root && root.querySelector('.rhs-to-solo');
    if (soloLink) {
        const onSoloLink = () => openSolo();
        soloLink.addEventListener('click', onSoloLink);
        window.__rockherosmithSoloLink = () => soloLink.removeEventListener('click', onSoloLink);
    }

    // Home hero, library card and Press Start (core play modes); re-runs replace the old registration.
    if (typeof window.__rockherosmithMainMode === 'function') {
        try { window.__rockherosmithMainMode(); } catch (_) { /* ignore */ }
    }
    window.__rockherosmithMainMode = registerMainMode({
        win: window,
        getScreen: () => window.__rockherosmithScreen,
        getRuntime: () => window.__rockherosmithRuntime,
        showScreen,
        openSolo,
    });

    // Public API (version 1, play layer contract §1): solo play ("a band of one") for the
    // drums and 5-Fret plugins and the Solo screen. See src/solo.js.
    window.rockHeroSmith = Object.freeze({
        version: 1,
        playSolo,
        // Promise<'kit' | 'drums' | null>: what the drums Play-as should use.
        soloKindFor: (song) => soloKindFor(song, { win: window }),
        openSolo,
        // Whether RockHeroSmith scores this plain drums / 5-fret play on the main highway
        // (the plugins hide their own HUD only then): the pref is on, no splitscreen,
        // and an adopt is pending or a solo / adopted session runs.
        // Asked every frame: the prefs come from an in-memory cache, never storage.
        adoptsSolo: () => {
            const rt = window.__rockherosmithRuntime;
            if (!rt || typeof rt.canAdopt !== 'function' || rt.canAdopt() !== true) return false;
            if (typeof rt.soloActive !== 'function' || rt.soloActive() !== true) return false;
            if (safe(() => window.slopsmithSplitscreen && window.slopsmithSplitscreen.isActive()) === true) return false;
            return safe(() => prefsCache.get().adoptSolo === true) === true;
        },
    });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();
