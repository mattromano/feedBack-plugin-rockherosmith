// RockHeroSmith entry point. The stage and its player wiring live in src/*;
// this file only boots the runtime when a browser window exists, so importing
// it under node stays side-effect free.
import { loadPrefs, savePrefs, createPrefsCache } from './src/prefs.js';
import { mountStage } from './src/stage.js';
import { createBandRuntime } from './src/band-runtime.js';
import { createBandScreen } from './src/band-screen.js';
import { registerMainMode } from './src/main-mode.js';
import { createSoloPlay, createOpenSolo, createAdopt, soloKindFor, quickSettingPatch } from './src/solo.js';

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
    // The Solo screen (contract §1): a stub opening the band screen until stream B2's.
    const openSolo = createOpenSolo({ getScreen: () => window.__rockherosmithScreen, showScreen });
    const runtime = createBandRuntime({ win: window, doc: document, mountStage, loadPrefs, deviceMemo,
        // A plain drums / 5-fret play on the main highway becomes a one-player session (contract §2).
        adopt: createAdopt({ win: window, doc: document, loadPrefs }),
        // Next song after a solo or adopted session.
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

    // Home hero, library card and Press Start (core play modes); re-runs replace the old registration.
    if (typeof window.__rockherosmithMainMode === 'function') {
        try { window.__rockherosmithMainMode(); } catch (_) { /* ignore */ }
    }
    window.__rockherosmithMainMode = registerMainMode({
        win: window,
        getScreen: () => window.__rockherosmithScreen,
        getRuntime: () => window.__rockherosmithRuntime,
        showScreen,
    });

    // Public API (version 1, play layer contract §1): solo play ("a band of one") for the
    // drums and 5-Fret plugins and the Solo screen. See src/solo.js.
    window.rockHeroSmith = Object.freeze({
        version: 1,
        playSolo: createSoloPlay({
            getRuntime: () => window.__rockherosmithRuntime,
            getScreen: () => window.__rockherosmithScreen,
            loadPrefs,
            showScreen,
        }),
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
