// RockHeroSmith session runtime: Go plays the picked song, the band stage
// mounts on that song's song:ready, and the session ends on song end (the
// results, then Play again or Next song) or on leaving the player. The state
// machine lives in session.js; this file feeds it bus events and runs the
// effects it names.
// Everything is injected, so this is testable under node; screen.js passes
// the real window/document. Nothing here plays sound.
import { initialSession, reduceSession } from './session.js';
import { drumsDifficultyId, masteryFor, masteryFromPct } from './mappings.js';
import { drumArrIndex } from './arrangements.js';
import { applyDevices } from './devices.js';
import { planStage } from './stage.js';
import { PART_TYPES, getPart, hasChart, songFacts } from './parts.js';
import { karaokeApi, armVocals, startVocals, stopVocals, showKaraokeHud } from './vocals.js';
import { createBandScore } from './band-score.js';
import { guitarEntry, drumsEntry, drumsBonusEntry, vocalsEntry, vocalsTotals, onsetTime } from './part-events.js';
import { playerInfo, judgmentEvent, resultEvent, sessionIdFor } from './play-events.js';
import { chartPhrases } from './guitar-od.js';
import { createOverdriveSession } from './overdrive-session.js';
import { stemIdFor, muteStem, restoreStem, SOUND_CLAIM_ID, STEM_SOUND_CLAIM_PREFIX } from './stem-claims.js';
import { createDrumSound, padsMuted } from './drum-sound.js';
import { createStemSound, FULL_MIX, isUnsplit } from './stem-sound.js';
import { createMissSound } from './miss-sound.js';
import { createMixMuffle } from './mix-muffle.js';
import { OD_CALLOUT } from './hud-model.js';
import { guitarStarThresholds, fullChartThresholds } from './stars.js';
import { createBandHud } from './hud.js';
import { createToastStack } from './toasts.js';
import { createCountInOverlay } from './count-in-overlay.js';
import { resultsModel } from './results.js';
import { showResultsScreen, isTyping } from './results-screen.js';
import { createFullScreen } from './full-screen.js';
import { createStageChrome } from './stage-chrome.js';
import { createSidebarOverlay } from './sidebar-overlay.js';
import { openSettingsOverlay } from './settings-overlay.js';
import { otherModalOpen } from './modal-open.js';
import { CONTROLLER_KINDS, kindFor, isControllerId } from './controller-model.js';
import { createControllerLanes, kindOf } from './controller-lanes.js';
import { playingIds, playerStyle } from './players.js';

const BAND_SCREEN = 'plugin-rockherosmith';
const SPLIT_KEY = 'splitscreenActive';
const VIZ_KEY = 'vizSelection';
const TOAST_MS = 4000;
const ONE_DIFFICULTY = 'This chart has one difficulty';
const NO_PITCH = 'No vocal pitch for this song';
const VOCALS_FAILED = "Vocals couldn't start";
const STEM_SOUND_MODES = ['rockband', 'kit'];
// Splitscreen coming up mid-session is stopped and the stage remounted once it
// is down; the third time in one session ends the session (no stop/start loop).
const SPLIT_MAX_STARTS = 3;
const SPLIT_POLL_MS = 50;
const SPLIT_POLL_MAX = 100;
// A backward song:seek further than this rewinds the band score (plan 4 R2).
const REWIND_MIN_S = 0.05;
const BAND_SONG_CLASS = 'rhs-band-song';
const DRUM_JUDGMENTS = ['hit', 'miss', 'overhit'];
// A controller judgment that plays the Rock Band miss clunk.
const CLUNK_JUDGMENTS = ['miss', 'overstrum', 'overhit'];
// The overdrive tick while the song plays (plan 5 R16).
const OD_TICK_MS = 100;
// note_detect's input failure while it stays quiet in a band song (plan 7 R16).
const GUITAR_INPUT_FAILED = "Guitar input couldn't start";
// The sidebar's other items ask first (plan 7 R8).
const LEAVE_PROMPT = { title: 'Leave the song?', body: 'This ends the band song.', confirmText: 'Leave', cancelText: 'Stay' };

function safe(fn) {
    try { return fn(); } catch (e) { console.warn('[rockherosmith]', e); return undefined; }
}

// The prefs a session runs with: Rock Band / Kit only need a drum stem, so a
// song without one plays with the song's own drums; except Rock Band on an
// unsplit song, which muffles the full mix as controllers do (contract §6).
// stemIds: the song's stems (the library item's, or stems' own list).
function sessionPrefs(prefs, item, stemIds) {
    const drums = prefs && prefs.parts && prefs.parts.drums;
    if (!drums || !STEM_SOUND_MODES.includes(drums.soundMode)) return prefs;
    const ids = Array.isArray(stemIds) && stemIds.length ? stemIds : songFacts(item).stemIds;
    if (ids.includes('drums')) return prefs;
    if (drums.soundMode === 'rockband' && isUnsplit(ids)) return prefs;
    return { ...prefs, parts: { ...prefs.parts, drums: { ...drums, soundMode: 'song' } } };
}

const isOn = (prefs, id) => !!(prefs && prefs.parts && prefs.parts[id] && prefs.parts[id].on);

// The parts this session plays, decided once at Go: a part plays only when it
// is on AND the song has its chart (the band screen's rule for greying a
// column); vocals also needs the Lyrics Karaoke API. A controller plays when
// it is on and decided (playsAs not null), its kind's plugin API (able to pin
// a lane, canPin) and lane renderer are loaded and the song has a part for
// it; `part` becomes that part's instrument and `sourceKind`
// its chart kind. Whether it is connected is settled at mount
// (settleControllers). Every later step reads these `on` flags.
function effectivePrefs(prefs, item, win, kinds) {
    const parts = { ...((prefs && prefs.parts) || {}) };
    for (const part of PART_TYPES) {
        const pp = parts[part.id];
        if (!pp) continue;
        const usable = part.id !== 'vocals' || !!karaokeApi(win);
        parts[part.id] = { ...pp, on: !!pp.on && hasChart(part, item, pp) && usable };
    }
    const joined = Array.isArray(prefs && prefs.controllers) ? prefs.controllers : [];
    const controllers = joined.filter((c) => c && typeof c === 'object').map((c) => {
        const kind = kindOf(kinds, prefs, c);
        const api = kind && typeof kind.api === 'function' ? safe(() => kind.api()) : null;
        const pinnable = !!api && (typeof kind.canPin !== 'function' || safe(() => kind.canPin(api)) === true);
        const renderer = pinnable && typeof kind.laneRenderer === 'function' ? safe(() => kind.laneRenderer()) : null;
        const showAuto = !!api && typeof api.showAutoCharts === 'function' && safe(() => api.showAutoCharts()) === true;
        const plays = typeof renderer === 'function' && typeof kind.partFor === 'function'
            ? safe(() => kind.partFor(item, c, { showAuto })) : null;
        return { ...c, on: c.on !== false && c.playsAs !== null && !!plays, part: plays ? plays.instrument : c.part, sourceKind: plays ? plays.kind : null };
    });
    return { ...prefs, parts, controllers };
}

// A controller not in the connected list sits out (Review Focus 1). `connected`
// is a Set of controllerKeys, or null when the list never came back.
function settleControllers(prefs, connected) {
    const controllers = prefs.controllers.map((c) => (c.on === true && !(connected && connected.has(c.key)) ? { ...c, on: false } : c));
    return { ...prefs, controllers };
}

// The same prefs with vocals switched off (vocals sat out at Go).
function withoutVocals(prefs) {
    const vocals = prefs.parts.vocals;
    return { ...prefs, parts: { ...prefs.parts, vocals: { ...vocals, on: false } } };
}

// createBandRuntime({ win, doc, mountStage, loadPrefs, storage, fetchJson, setTimer, clearTimer, deviceMemo, onShowBandScreen, kinds, audioFactory })
//   kinds: the controller kinds registry (CONTROLLER_KINDS), also handed to mountStage.
//   audioFactory: optional; makes the miss clunk's AudioContext (default: win.AudioContext).
//   onShowBandScreen: optional; called after Next song returns to the band screen
//   (never for Play again or leaving), so the band screen can open its song pick.
//   deviceMemo: the inputs last handed to note_detect / drums (devices.js),
//   shared with the band screen so a Go doesn't re-apply a device just picked.
//   adopt: optional (play layer contract §2); adopt(song) -> prefs | null | Promise of
//   either: the one-player prefs a plain play (song:ready outside a session) becomes.
//   onShowSoloScreen({ next }): optional; Next song after a solo session (else the band screen).
//   onQuickSetting(detail, { solo }): optional; a 5-fret lane's quick settings change
//   (five_fret:quick-setting) on this session's lane, for the caller to save.
//   now: the clock for session ids (default Date.now).
//   -> { dispose(), isMounted(), startSession({ song, prefs }): false | Promise<true>, phase(),
//        snapshot(): the current session's band score snapshot, or null,
//        overdrive(): its overdrive meters (overdrive-session snapshot), or null,
//        again(), next(): Play again / Next song while the results show,
//        stageUi(): { full, fullScreen, sidebar, overlay } for the current session, or null }
// startSession returns false when it refuses (a session is running, no song);
// otherwise a promise of core's playSong that rejects, after the session went
// back to idle, when playSong throws or rejects.
export function createBandRuntime({
    win, doc, mountStage, loadPrefs, storage = win.localStorage, fetchJson,
    setTimer = win.setTimeout, clearTimer = win.clearTimeout, deviceMemo = {}, onShowBandScreen,
    kinds = CONTROLLER_KINDS, audioFactory, adopt, onShowSoloScreen, onQuickSetting, now = Date.now,
}) {
    const fb = win.feedBack;
    const getJson = fetchJson || ((url) => win.fetch(url).then((r) => r.json()));
    // loadPrefs is kept in the signature for screen.js; a session runs with
    // the prefs Go hands it.
    void loadPrefs;

    let state = initialSession();
    // Session ids (play:* events) and the adopt in flight: a song change, a stop or
    // a started session drops a pending adopt (its generation moves on).
    let sessionCount = 0;
    let adoptGen = 0;
    // Per-session runtime data the pure reducer does not hold.
    let session = null;
    let stage = null;
    let release = null;
    // One toast stack per runtime, over the player (R18).
    const toasts = createToastStack({
        doc, getHost: () => doc.getElementById('player'), setTimer, clearTimer, ttlMs: TOAST_MS,
    });
    // note_detect hands each judgment to window twice (its own dispatch, then
    // the same detail bubbling from its instance root): count each once.
    const seenGuitar = new WeakSet();
    // notedetect:onset arrives twice the same way.
    const seenOnset = new WeakSet();
    // Each part's stem claim operations, in order (fix 5): a restore or release
    // always follows the mute it undoes, even across Play again (claim ids are
    // per part, not per session). part -> { promise, done }.
    const stemOps = new Map();
    // Window full screen for full mode (plan 7 R2, R20): one per runtime, so a
    // Play again finds the full screen the session before asked for.
    const fullScreen = createFullScreen({ doc, win });
    const offFullScreen = fullScreen.onChange(onFullScreenChange);
    // notedetect:input-error arrives twice with one detail, as its judgments do.
    const seenInputError = new WeakSet();
    // Rock Band part audio's miss clunk (one AudioContext, made on the first
    // clunk) and the whole-song muffle for players with no stem of their own.
    const missSound = createMissSound({ win, audioFactory });
    const mixMuffle = createMixMuffle({ win, doc });

    function sliderMastery() {
        const slider = doc.getElementById('mastery-slider');
        return slider ? masteryFromPct(parseFloat(slider.value)) : null;
    }

    function newSession(item, prefs, goPrefs, { solo = false, adopted = false } = {}) {
        const guitarOn = isOn(prefs, 'guitar');
        const drumsOnly = !guitarOn && isOn(prefs, 'drums');
        const drumIndex = drumsOnly ? drumArrIndex(item.arrangements, { hasDrumTab: songFacts(item).hasDrumTab }) : -1;
        return {
            item, prefs,
            // The prefs Go was given (Play again replays with them).
            goPrefs,
            // Play layer (contract §2, §3): the play:* session id, a one-player
            // session (playSolo or adopted), a plain play adopted (its song was
            // already loading), the arrangement the song loaded on (read at mount),
            // whether play:result went out, and whether the band muted the pads.
            sessionId: sessionIdFor(now(), ++sessionCount),
            solo: solo || adopted,
            adopted,
            loadedArrangement: null,
            resultSent: false,
            padsMuted: false,
            // The guitar part's arrangement, with the Lead fallback.
            guitarIndex: guitarOn ? getPart('guitar').chartFrom(item, prefs.parts.guitar) : undefined,
            drumsOnly,
            drumIndex,
            // Drums only on a drum-tab-only pack: the drums view draws the tab
            // on whatever arrangement the main highway opens.
            drumView: drumsOnly && drumIndex < 0,
            viewSwitched: false,
            savedSplit: null,
            savedMastery: null,
            readyDetail: null,
            drumCanvas: null,
            canvasListener: false,
            // The results screen while the session is ending.
            results: null,
            played: null,
            setReturn: false,
            splitStarts: 0,
            splitWaiting: false,
            splitTimer: null,
            splitPolls: 0,
            vocals: isOn(prefs, 'vocals'),
            vocalsArmed: false,
            vocalsStarted: false,
            // Hear-myself off couldn't be applied: vocals sits out (no mic).
            vocalsFailed: false,
            karaoke: null,
            // The band score ledger, kept past teardown for the results.
            score: null,
            scoreParts: [],
            guitarThresholds: null,
            hud: null,
            countIn: null,
            lastT: 0,
            // Karaoke's totals from its latest karaoke:reset, until a phrase
            // supersedes them: re-applied after a rewind replays the ledger.
            vocalsReset: undefined,
            // The plugins' own score displays this session hid (a replay
            // inherits them from the session before). ctl: controller lane
            // canvas -> the kind API that hid it (always undone at teardown:
            // the lanes go with the stage).
            hidden: { nd: false, drums: new Set(), scorecard: false, ctl: new Map() },
            // Controller players (Plan 3): the connected controllerKeys read at
            // Go (null until listControllers answers), whether they were
            // applied, lane canvas -> player id, and per player { kind,
            // canvas, last: { score, resets } | null, thresholds: the stars kept | null }.
            connected: null,
            controllersSettled: false,
            ctlCanvas: new Map(),
            ctl: new Map(),
            // Play again: teardown leaves the hides for the replayed session.
            keepHides: false,
            // Karaoke whose HUD stayed hidden for the replay.
            vocalsKept: null,
            countInOverride: false,
            // The band turned note_detect's detection on (restored at teardown).
            ndEnabled: false,
            // Overdrive (plan 5): the per-song session and its tick.
            od: null,
            odTimer: null,
            // Without overdrive, a tick that only tracks the chart stall.
            stallTimer: null,
            // Chart time at the last OD or stall tick, and whether it stood still
            // since the tick before (the paused fallback).
            lastChartT: null,
            chartStalled: false,
            // Drums stars over the full chart (M6, R20): the largest thresholds seen.
            drumsThresholds: null,
            // Fail mode (plan 5 R12, R13): the parts shown dropped out, the parts
            // whose stem the band muted (restored at rescue and teardown), and
            // whether everyone was out (the results say Band failed).
            failed: new Set(),
            stemClaims: new Set(),
            bandFailed: false,
            // Drum sound mode (plan 6): the session's createDrumSound, and whether
            // a sound mute was sent and not yet restored.
            drumSound: null,
            soundClaim: false,
            // Controller part audio (Plan 3 Decision 10): the session's
            // createStemSound, whether it was built before stems listed any
            // stem (rebuilt on provider-ready), and the stem ids whose sound
            // mute was sent and not yet restored.
            stemSound: null,
            stemSoundEmpty: false,
            stemSoundClaims: new Set(),
            // Plan 7: full mode (the stored pref sets where it starts), the hover
            // chrome, the sidebar overlay (one per session, as its click takeover
            // starts at create), the overlay over the paused song ({ kind }), the
            // pause token it resumes with, and note_detect's quiet value before
            // the band set it (null: untouched).
            full: !!prefs.fullScreenStage,
            chrome: null,
            sidebar: null,
            overlay: null,
            pauseToken: null,
            ndQuiet: null,
        };
    }

    // The chrome sits on the stage, so it goes with every unmount: full mode's
    // CSS (#player.rhs-full) never outlives the stage into solo play.
    function unmountStage(s) {
        if (s) destroyChrome(s);
        if (!stage) return;
        const st = stage;
        stage = null;
        try { st.unmount(); } catch (e) { console.error('[rockherosmith] unmount failed', e); }
    }

    function showToast(s, text) {
        void s;
        safe(() => toasts.show(text));
    }

    // The canvas the band's drums play on: the stage's drum lane, else (drums
    // alone) #highway, following canvas replacement.
    function bandDrumCanvas(s) {
        if (!isOn(s.prefs, 'drums')) return null;
        const lane = stage && typeof stage.getDrumCanvas === 'function' ? safe(() => stage.getDrumCanvas()) : null;
        if (lane) return lane;
        if (!s.drumsOnly) return null;
        return s.drumCanvas || doc.getElementById('highway');
    }

    function hideDrumHud(s, canvas) {
        const api = win.feedBackDrums;
        if (!canvas || s.hidden.drums.has(canvas) || !api || typeof api.setScoreHudHidden !== 'function') return;
        s.hidden.drums.add(canvas);
        safe(() => api.setScoreHudHidden(canvas, true));
    }

    // ---- Controller lanes (Plan 3): controller-lanes.js ----
    const lanes = createControllerLanes({
        kinds,
        getStage: () => stage,
        realDrumCanvas: (s) => bandDrumCanvas(s),
        getSession: () => session,
        isLive: (s) => scoring() === s,
        displayTime,
        record,
        onDeploy: (s, id) => {
            if (s.od && !s.failed.has(id)) { const od = s.od; safe(() => od.deployed(id)); }
            record(s, { part: id, t: displayTime(s), kind: 'deploy' });
        },
        // Under the leave prompt a controller answers it (its claim keeps core's
        // pad menus off): Start is Stay, holding Back again is Leave. Under
        // Settings, Start does nothing.
        onPause: (s) => {
            if (!s.overlay) callTogglePlay();
            else if (typeof s.overlay.answer === 'function') s.overlay.answer(false);
        },
        onBackHold: (s) => {
            if (s.overlay && typeof s.overlay.answer === 'function') { s.overlay.answer(true); return; }
            confirmLeave(s, () => { if (typeof win.showScreen === 'function') safe(() => win.showScreen(BAND_SCREEN)); });
        },
        // An overhit while paused is a stray pad tap on a pinned drum lane (R10).
        onJudgment: (s, id, type) => {
            if (type === 'overhit' && songPaused(s)) return;
            if (CLUNK_JUDGMENTS.includes(type) && s.prefs.missSound !== false && !s.failed.has(id)
                && controllerStemMode(s, id) === 'rockband') safe(() => missSound.play());
            if (!s.stemSound) return;
            syncStemSound(s, s.stemSound.judge(id, type));
        },
    });

    // A controller player's name for toasts: its part, then the controller's name.
    function playerLabel(s, id) {
        if (!isControllerId(id)) { const type = getPart(id); return type ? type.label : id; }
        const c = s.prefs.controllers.find((x) => x.id === id);
        return [playerStyle(id, s.prefs).name, c && c.name].filter(Boolean).join(' · ');
    }

    function listenCanvas(s) {
        if (s.canvasListener) return;
        fb.on('highway:canvas-replaced', onCanvasReplaced);
        s.canvasListener = true;
    }

    // The band HUD replaces the plugins' own score displays (R13). Each switch
    // set here is undone at teardown.
    function applyHides(s) {
        if (isOn(s.prefs, 'guitar') && !s.hidden.nd) {
            const nd = win.noteDetect;
            if (nd && typeof nd.setScoreHudHidden === 'function') {
                s.hidden.nd = true;
                safe(() => nd.setScoreHudHidden(true));
            }
        }
        if (isOn(s.prefs, 'drums')) {
            hideDrumHud(s, bandDrumCanvas(s));
            listenCanvas(s);
        }
        lanes.refreshLanes(s);
        // A controller lane's replaced canvas gets its score HUD hidden again.
        if (s.ctlCanvas.size) listenCanvas(s);
        const sc = win.feedBackScorecard;
        if (!s.hidden.scorecard && sc && typeof sc.setHudHidden === 'function') {
            s.hidden.scorecard = true;
            safe(() => sc.setHudHidden(true));
        }
    }

    function undoHides(s) {
        if (s.hidden.nd) {
            s.hidden.nd = false;
            const nd = win.noteDetect;
            if (nd && typeof nd.setScoreHudHidden === 'function') safe(() => nd.setScoreHudHidden(false));
        }
        const drums = win.feedBackDrums;
        for (const canvas of s.hidden.drums) {
            if (drums && typeof drums.setScoreHudHidden === 'function') safe(() => drums.setScoreHudHidden(canvas, false));
        }
        s.hidden.drums.clear();
        if (s.hidden.scorecard) {
            s.hidden.scorecard = false;
            const sc = win.feedBackScorecard;
            if (sc && typeof sc.setHudHidden === 'function') safe(() => sc.setHudHidden(false));
        }
    }

    // The band HUD on the current stage (a remount re-hosts it).
    function mountHud(s, song) {
        if (s.hud) { const old = s.hud; s.hud = null; safe(() => old.destroy()); }
        const player = doc.getElementById('player');
        if (!player || !stage || !s.score) return;
        const cur = song || fb.currentSong || {};
        s.hud = safe(() => createBandHud({
            doc, player, stage, parts: s.scoreParts, prefs: s.prefs,
            song: { title: cur.title || s.item.title, artist: cur.artist || s.item.artist },
            oneLevel: !(s.readyDetail && s.readyDetail.hasPhraseData),
        })) || null;
        if (s.hud) safe(() => s.hud.update(s.score.snapshot()));
        // A remount keeps the dropped-out lanes grey.
        for (const id of s.failed) hudCall(s, 'setFailed', id, true);
    }

    function hudCall(s, method, ...args) {
        const hud = s.hud;
        if (hud && typeof hud[method] === 'function') safe(() => hud[method](...args));
    }

    function startCountIn(s) {
        safe(() => doc.body.classList.add(BAND_SONG_CLASS));
        if (s.countIn) return;
        s.countIn = safe(() => createCountInOverlay({
            doc, bus: fb, getHost: () => doc.getElementById('player'), setTimer, clearTimer,
        })) || null;
    }

    // A part that can't play leaves the band score (the ledger holds only the
    // parts actually playing, so it never pins the band multiplier at x1),
    // and its HUD goes with it; the results then have no card for it.
    function dropPart(s, id) {
        if (!s.score || !s.scoreParts.includes(id)) return;
        s.scoreParts = s.scoreParts.filter((p) => p !== id);
        s.score.dropPart(id);
        // The drop replays the ledger: karaoke's latest reset applies again.
        if (s.vocalsReset !== undefined) s.score.syncTotals('vocals', s.vocalsReset);
        if (s.hud) mountHud(s);
        // The part's own claim goes with it; with it gone, everyone left may be out.
        syncFailures(s, { silent: true });
        if (id === 'drums') releaseDrumSound(s);
    }

    // Vocals that couldn't start leave the band unless they have judged
    // phrases of their own, whatever the other parts have judged.
    function dropVocals(s) {
        const v = s.score && s.score.snapshot().parts.vocals;
        if (!v || v.hits + v.misses + v.overhits > 0) return;
        dropPart(s, 'vocals');
    }

    // Guitar scores through note_detect's detection. With a guitar input
    // picked and detection off, the band turns it on (input analysis: its
    // processor outputs silence) and teardown turns it off again, silently so
    // its summary never shows. A user who had it on keeps it on.
    function enableGuitarDetect(s) {
        const nd = win.noteDetect;
        if (s.ndEnabled || !s.scoreParts.includes('guitar') || !s.prefs.parts.guitar.deviceKey) return;
        if (!nd || typeof nd.enable !== 'function' || typeof nd.isEnabled !== 'function') return;
        if (safe(() => nd.isEnabled()) !== false) return;
        s.ndEnabled = true;
        safe(() => Promise.resolve(nd.enable())
            .catch((e) => console.warn('[rockherosmith] note detection failed to start', e)));
    }

    function restoreGuitarDetect(s) {
        if (!s.ndEnabled) return;
        s.ndEnabled = false;
        const nd = win.noteDetect;
        if (nd && typeof nd.disable === 'function') safe(() => nd.disable({ silent: true }));
    }

    // The drums plugin is loaded (its API or its renderer is there).
    const drumsPluginLoaded = () => !!win.feedBackDrums || typeof win.feedBackViz_drums === 'function';

    // Drums' star power phrases for the results, from the band's drum canvas.
    function drumsStarPower(s) {
        const api = win.feedBackDrums;
        const canvas = bandDrumCanvas(s);
        if (!canvas || !api || typeof api.getInstanceState !== 'function') return null;
        const sp = safe(() => { const st = api.getInstanceState(canvas); return st && st.starPower; });
        if (!sp || !Number.isFinite(sp.phrasesHit) || !Number.isFinite(sp.phrasesTotal)) return null;
        return { phrasesHit: sp.phrasesHit, phrasesTotal: sp.phrasesTotal };
    }

    // Each controller player's chart source for the results, read from its lane's
    // engine state now (the lane may be gone: the prefs' value is the fallback).
    function controllerInfo(s) {
        const info = {};
        for (const id of s.scoreParts) {
            if (!isControllerId(id)) continue;
            const st = safe(() => lanes.laneState(s, id));
            const c = s.prefs.controllers.find((x) => x.id === id);
            const sourceKind = (st && typeof st.sourceKind === 'string' && st.sourceKind) || (c && c.sourceKind) || '';
            info[id] = { sourceKind };
        }
        return info;
    }

    // The session whose judgments score: playing, with a ledger.
    function scoring() {
        const s = session;
        return s && state.phase === 'playing' && s.score ? s : null;
    }

    // The song's display time for a ledger entry, always finite.
    function displayTime(s) {
        let t = typeof fb.getDisplayTime === 'function' ? safe(() => fb.getDisplayTime()) : undefined;
        if (!Number.isFinite(t)) {
            const audio = doc.getElementById('audio');
            t = audio ? Number(audio.currentTime) : undefined;
        }
        if (Number.isFinite(t)) s.lastT = t;
        return s.lastT;
    }

    function refreshHud(s, silent) {
        if (s.hud) safe(() => s.hud.update(s.score.snapshot(), silent ? { silent: true } : undefined));
    }

    function record(s, entry) {
        if (!entry) return;
        s.score.record(entry);
        emitJudgment(s, entry);
        refreshHud(s, false);
        syncFailures(s);
    }

    // play:judgment (contract §3) for every entry the ledger took (a part still in
    // the band); a listener that throws never breaks scoring.
    function emitJudgment(s, entry) {
        if (typeof fb.emit !== 'function' || !s.scoreParts.includes(entry.part)) return;
        const part = s.score.snapshot().parts[entry.part];
        const detail = judgmentEvent({
            filename: s.item.filename, sessionId: s.sessionId, entry,
            info: playerInfo(entry.part, s.prefs), totals: part,
        });
        safe(() => fb.emit('play:judgment', detail));
    }

    // play:result (contract §3), once per session, when the results open.
    function emitResult(s) {
        if (s.resultSent || typeof fb.emit !== 'function') return;
        s.resultSent = true;
        const arrangements = {};
        for (const id of s.scoreParts) {
            if (id === 'vocals') continue;
            if (id === 'guitar' && Number.isInteger(s.guitarIndex)) arrangements[id] = s.guitarIndex;
            else if (Number.isInteger(s.loadedArrangement)) arrangements[id] = s.loadedArrangement;
        }
        const detail = resultEvent({
            filename: s.item.filename, sessionId: s.sessionId,
            snapshot: s.score ? s.score.snapshot() : null, prefs: s.prefs, arrangements,
            practice: false, durationSec: displayTime(s),
        });
        safe(() => fb.emit('play:result', detail));
    }

    // The drums players' sound modes (the real drummer, drums controllers).
    function drumModes(s) {
        const modes = [];
        if (s.scoreParts.includes('drums')) modes.push(s.prefs.parts.drums.soundMode);
        for (const id of s.scoreParts) {
            const c = isControllerId(id) ? s.prefs.controllers.find((x) => x.id === id) : null;
            if (c && c.playsAs === 'drums') modes.push(c.soundMode);
        }
        return modes;
    }

    // Rock Band plays without pad sounds (contract §6): the drums plugin's pads are
    // muted while every drums player is in Rock Band, and unmuted at teardown.
    // setPadSound is feature-detected; an older drums plugin has window.__drumsMutePads.
    function setPads(muted) {
        const api = win.feedBackDrums;
        if (api && typeof api.setPadSound === 'function') { safe(() => api.setPadSound({ muted })); return true; }
        if (!api) return false;
        win.__drumsMutePads = muted;
        return true;
    }

    function startPadSound(s) {
        if (s.padsMuted || !s.score || !padsMuted(drumModes(s))) return;
        s.padsMuted = setPads(true);
    }

    function releasePadSound(s) {
        if (!s.padsMuted) return;
        s.padsMuted = false;
        setPads(false);
    }

    // The stem ids of the song playing (stems' own list).
    function songStemIds() {
        const stems = win.stems;
        const list = stems && typeof stems.getState === 'function' ? safe(() => stems.getState()) : null;
        return Array.isArray(list) ? list.map((st) => st && st.id).filter((id) => typeof id === 'string') : [];
    }

    // Runs `op` now when the part has nothing in flight (so a mute's claim and
    // dispatch stay synchronous), else after the previous op settles.
    function queueStemOp(part, op) {
        const prev = stemOps.get(part);
        const p = prev && !prev.done ? prev.promise.then(op, op) : new Promise((r) => r(op()));
        const entry = { promise: p, done: false };
        stemOps.set(part, entry);
        const settle = () => {
            entry.done = true;
            if (stemOps.get(part) === entry) stemOps.delete(part);
        };
        p.then(settle, settle);
    }

    function muteFailedStem(s, id) {
        const stemId = stemIdFor(id, s.prefs.parts[id], songStemIds());
        const caps = fb.capabilities;
        if (!stemId || !caps) return;
        s.stemClaims.add(id);
        safe(() => queueStemOp(id, () => muteStem({ caps, part: id, stemId })));
    }

    function restoreFailedStem(s, id) {
        if (!s.stemClaims.has(id)) return;
        s.stemClaims.delete(id);
        const caps = fb.capabilities;
        safe(() => queueStemOp(id, () => restoreStem({ caps, part: id })));
    }

    // Drum sound mode (plan 6 R4, R8): only while drums is a playing band part,
    // and never for Song drums. Idempotent.
    function startDrumSound(s) {
        if (s.drumSound || !s.score || !s.scoreParts.includes('drums')) return;
        const mode = s.prefs.parts.drums.soundMode;
        if (mode === 'song') return;
        s.drumSound = createDrumSound(mode);
        syncDrumSound(s);
    }

    // Brings the sound claim in line with the mode's wanted state. force re-mutes
    // a held claim (stems rebuilt its graph, R4). With no drum stem or no
    // capability host nothing is sent; a later provider-ready retries.
    function syncDrumSound(s, { force = false } = {}) {
        const want = !!(s.drumSound && s.drumSound.muted());
        const caps = fb.capabilities;
        if (want) {
            const stemId = stemIdFor('drums', s.prefs.parts.drums, songStemIds());
            if (!stemId || !caps) return;
            if (s.soundClaim && !force) return;
            s.soundClaim = true;
            safe(() => queueStemOp('sound:drums', () => muteStem({ caps, part: 'drums', stemId, claimId: SOUND_CLAIM_ID })));
        } else if (s.soundClaim) {
            s.soundClaim = false;
            safe(() => queueStemOp('sound:drums', () => restoreStem({ caps, part: 'drums', claimId: SOUND_CLAIM_ID })));
        }
    }

    // The mode goes: a held claim is restored and released (R12).
    function releaseDrumSound(s) {
        s.drumSound = null;
        syncDrumSound(s);
    }

    // A controller player's part audio mode ('rockband' | 'always' | 'kit'), or null.
    function controllerStemMode(s, id) {
        const c = isControllerId(id) ? s.prefs.controllers.find((x) => x.id === id) : null;
        if (!c) return null;
        const kind = kindOf(kinds, s.prefs, c);
        return kind && typeof kind.stemMode === 'function' ? safe(() => kind.stemMode(c)) : c.partAudio;
    }

    // Controller part audio (Plan 3 Decision 10), once the ledger exists: every
    // playing player on the stem it plays, a controller through its kind's
    // stemIdFor. On an unsplit song (no stems, or only `full`; the library's
    // stem list until stems lists its own) players with no stem share the full
    // mix. Idempotent.
    function startStemSound(s) {
        if (s.stemSound || !s.score) return;
        const ids = songStemIds();
        const members = s.scoreParts.map((id) => {
            if (!isControllerId(id)) {
                const stemId = stemIdFor(id, s.prefs.parts[id], ids);
                // The real drummer in Rock Band with no drum stem shares the full mix's drop-outs.
                if (id === 'drums' && !stemId && s.prefs.parts.drums.soundMode === 'rockband') {
                    return { id, stemId, controller: false, dropout: true, mode: 'rockband' };
                }
                return { id, stemId, controller: false };
            }
            const c = s.prefs.controllers.find((x) => x.id === id);
            if (!c) return null;
            return { id, stemId: stemIdFor(kindFor(s.prefs, c.key), c, ids), controller: true, mode: controllerStemMode(s, id) };
        }).filter(Boolean);
        const fullMix = isUnsplit(ids.length ? ids : songFacts(s.item).stemIds);
        s.stemSound = createStemSound({ members, fullMix });
        s.stemSoundEmpty = ids.length === 0;
        s.stemSound.setFailed([...s.failed]);
        // Every stem: a My kit only stem is muted from the start.
        syncStemSound(s, s.stemSound.stems());
    }

    // Each changed stem becomes one queued claim op under its own claim. force:
    // every held mute is sent again (stems rebuilt its graph).
    // The full mix has no claim: its op muffles or restores the whole song.
    function syncStemSound(s, changed, { force = false } = {}) {
        const caps = fb.capabilities;
        const op = (stemId, mute) => {
            if (stemId === FULL_MIX) {
                safe(() => queueStemOp('sound:mix', () => (mute ? mixMuffle.duck() : mixMuffle.restore())));
                return;
            }
            const claimId = STEM_SOUND_CLAIM_PREFIX + stemId;
            safe(() => queueStemOp('sound:stem:' + stemId, () => (mute
                ? muteStem({ caps, part: stemId, stemId, claimId })
                : restoreStem({ caps, part: stemId, claimId }))));
        };
        if (force) for (const stemId of s.stemSoundClaims) op(stemId, true);
        for (const stemId of changed) {
            const want = !!(s.stemSound && s.stemSound.muted(stemId));
            if (want === s.stemSoundClaims.has(stemId) || (want && !caps && stemId !== FULL_MIX)) continue;
            if (want) s.stemSoundClaims.add(stemId); else s.stemSoundClaims.delete(stemId);
            op(stemId, want);
        }
    }

    // The session ends: every held stem mute is restored and released, and the
    // full mix's filter comes out (after any restore still queued).
    function releaseStemSound(s) {
        const held = [...s.stemSoundClaims];
        s.stemSound = null;
        syncStemSound(s, held);
        safe(() => queueStemOp('sound:mix', () => mixMuffle.release()));
    }

    // Fail mode (R12, R13): brings the lanes and stem claims in line with the
    // ledger after it changed (a judgment, a deploy, a rewind or a dropped part),
    // and ends the song when everyone is out (R15). silent: no callouts or toasts
    // (a rewind replays the drops and rescues, a dropped part just leaves).
    function syncFailures(s, { silent = false } = {}) {
        if (!s.score) return;
        const snap = s.score.snapshot();
        const ids = new Set([...s.failed, ...Object.keys(snap.parts)]);
        for (const id of ids) {
            const failed = !!(snap.parts[id] && snap.parts[id].failed);
            if (failed === s.failed.has(id)) continue;
            if (failed) {
                s.failed.add(id);
                hudCall(s, 'setFailed', id, true);
                if (!silent) {
                    hudCall(s, 'callout', id, OD_CALLOUT.out);
                    showToast(s, `${playerLabel(s, id)} dropped out: overdrive brings them back`);
                }
                muteFailedStem(s, id);
            } else {
                s.failed.delete(id);
                hudCall(s, 'setFailed', id, false);
                if (!silent && snap.parts[id]) hudCall(s, 'callout', id, OD_CALLOUT.saved);
                restoreFailedStem(s, id);
            }
        }
        if (s.stemSound) syncStemSound(s, s.stemSound.setFailed([...s.failed]));
        if (snap.bandFailed && !s.bandFailed && session === s && state.phase === 'playing') {
            s.bandFailed = true;
            dispatch({ type: 'failed' });
        }
    }

    // The drums engine's state on the band's drum canvas, or null.
    function drumsState(s) {
        const api = win.feedBackDrums;
        const canvas = bandDrumCanvas(s);
        if (!canvas || !api || typeof api.getInstanceState !== 'function') return null;
        return api.getInstanceState(canvas);
    }

    // Overdrive for the ledger's parts (R16), once the ledger exists and the
    // band mastery is applied. Idempotent.
    function startOverdrive(s) {
        if (s.od || !s.score) return;
        const hw = win.highway;
        const call = (name) => (hw && typeof hw[name] === 'function' ? safe(() => hw[name]()) : null);
        const guitar = s.scoreParts.includes('guitar') && hw
            ? { phrases: chartPhrases(hw), notes: call('getFilteredNotes'), chords: call('getFilteredChords') }
            : null;
        s.od = safe(() => createOverdriveSession({
            parts: s.scoreParts.slice(),
            beats: call('getBeats'),
            guitar,
            getHud: () => s.hud,
            readDrums: () => drumsState(s),
            readVocals: () => (s.karaoke && typeof s.karaoke.getOverdrive === 'function' ? s.karaoke.getOverdrive() : null),
            controllers: s.scoreParts.filter(isControllerId).map((id) => ({ id, read: () => lanes.laneState(s, id) })),
        })) || null;
        if (s.od) s.odTimer = setTimer(() => odTick(s), OD_TICK_MS);
        else if (s.score && s.stallTimer === null) s.stallTimer = setTimer(() => stallTick(s), OD_TICK_MS);
    }

    // Paused fallback: the chart clock stood still between the last two ticks.
    // Returns the chart time read.
    function trackStall(s) {
        const chartT = chartNow();
        s.chartStalled = Number.isFinite(chartT) && Number.isFinite(s.lastChartT) && !(chartT > s.lastChartT);
        if (Number.isFinite(chartT)) s.lastChartT = chartT;
        return chartT;
    }

    // With no overdrive session, only the stall is tracked (songPaused).
    function stallTick(s) {
        s.stallTimer = null;
        if (session !== s || state.phase !== 'playing') return;
        trackStall(s);
        s.stallTimer = setTimer(() => stallTick(s), OD_TICK_MS);
    }

    function odTick(s) {
        s.odTimer = null;
        if (session !== s || state.phase !== 'playing' || !s.od) return;
        const t = displayTime(s);
        const chartT = trackStall(s);
        const od = s.od;
        safe(() => od.tick(Number.isFinite(chartT) ? chartT : t, t));
        syncDrumsThresholds(s);
        s.odTimer = setTimer(() => odTick(s), OD_TICK_MS);
    }

    // M6 (R20): after a seek the drums engine's thresholds cover only the
    // rest of the chart, so the band keeps the ones with the largest final
    // value (the full chart) and measures the ledger's drums score with them.
    function syncDrumsThresholds(s) {
        const th = safe(() => { const st = drumsState(s); return st && st.starThresholds; });
        const next = fullChartThresholds(s.drumsThresholds, th);
        if (!next) return;
        s.drumsThresholds = next;
        safe(() => s.score.setStarThresholds('drums', s.drumsThresholds));
        refreshHud(s, true);
    }

    const splitscreen = () => win.slopsmithSplitscreen;
    function splitActive() {
        const ss = splitscreen();
        try { return !!(ss && typeof ss.isActive === 'function' && ss.isActive()); } catch (_) { return false; }
    }

    // Splitscreen came up during the session (its playSong wrapper on Always
    // Split, or a start after mount). Stop it, as the user toggling it off
    // would, and remount the stage once it is down: stopSplitScreen restores
    // #highway, so the stage's sizing and drum lane must be re-established.
    function onSplitStarted(s) {
        if (s.splitWaiting) return; // the same start announcing again
        s.splitStarts++;
        if (s.splitStarts >= SPLIT_MAX_STARTS) {
            console.warn('[rockherosmith] splitscreen keeps starting; ending the band session');
            dispatch({ type: 'left' });
            return;
        }
        s.splitWaiting = true;
        s.splitPolls = 0;
        unmountStage(s);
        const ss = splitscreen();
        safe(() => ss && typeof ss.stop === 'function' && ss.stop());
        waitForSplitDown(s);
    }

    function waitForSplitDown(s) {
        if (session !== s || !s.splitWaiting) return;
        if (!splitActive()) {
            s.splitWaiting = false;
            if (state.phase === 'playing') {
                EFFECTS.mount(s);
                // The ledger came with this mount: overdrive starts now.
                startOverdrive(s);
                startDrumSound(s);
                startStemSound(s);
                startPadSound(s);
                // Splitscreen was still up at song:ready, so vocals had no
                // strip slot then: start them now the stage is up.
                if (s.vocals && !s.vocalsStarted && !s.vocalsFailed) EFFECTS.startVocals(s);
            }
            return;
        }
        if (++s.splitPolls > SPLIT_POLL_MAX) {
            console.warn('[rockherosmith] splitscreen did not stop; ending the band session');
            dispatch({ type: 'left' });
            return;
        }
        s.splitTimer = setTimer(() => { s.splitTimer = null; waitForSplitDown(s); }, SPLIT_POLL_MS);
    }

    // Drums-only: the main highway shows the drum chart, so the band drum
    // difficulty goes on #highway and follows a canvas replacement.
    function onCanvasReplaced(e) {
        const d = e && e.detail;
        const s = session;
        if (!s || state.phase !== 'playing' || !d || !d.newCanvas) return;
        // A drum canvas this session hid was replaced: hide the clone too
        // (the stage's lane canvas, or #highway for drums alone).
        if (d.oldCanvas && s.hidden.drums.has(d.oldCanvas)) hideDrumHud(s, d.newCanvas);
        // A controller lane's clone: its plugin doesn't move the score HUD hide.
        if (d.oldCanvas) lanes.adoptReplaced(s, d.oldCanvas, d.newCanvas);
        if (!s.drumsOnly) return;
        if (d.oldCanvas && s.drumCanvas && d.oldCanvas !== s.drumCanvas) return;
        s.drumCanvas = d.newCanvas;
        pinDrums(s);
        if (s.hidden.drums.size) hideDrumHud(s, s.drumCanvas);
    }

    // Core's Auto view and its instrument takeover both leave a guitar part on
    // a guitar view, so the drums renderer is installed straight onto the main
    // highway, as core's takeover does (viz.js _installVizRenderer): nothing
    // is saved, so a crash mid-session leaves the user's view as it was. Runs
    // on the band song's song:ready, after core's own viz pick for it (core
    // subscribes at app.js load, before any plugin).
    function showDrumView(s) {
        const hw = win.highway;
        if (!s.drumView || !hw || typeof hw.setRenderer !== 'function' || typeof win.feedBackViz_drums !== 'function') return;
        let renderer = null;
        try { renderer = win.feedBackViz_drums(); } catch (e) { console.warn('[rockherosmith] drums view failed', e); }
        if (!renderer || typeof renderer.draw !== 'function') return;
        if (safe(() => { hw.setRenderer(renderer); return true; })) s.viewSwitched = true;
    }

    // Re-apply the user's view the way the picker does. setViz saves its id,
    // so it is replayed with the saved id itself (an unchanged value); with
    // nothing saved, the picker's view is replayed and the key removed again.
    function restoreView(s) {
        if (!s.viewSwitched) return;
        s.viewSwitched = false;
        const saved = safe(() => storage.getItem(VIZ_KEY)) ?? null;
        if (typeof win.setViz !== 'function') return;
        if (saved !== null) { safe(() => win.setViz(saved)); return; }
        const picker = doc.getElementById('viz-picker');
        const picked = picker && picker.value;
        if (picked) {
            safe(() => win.setViz(picked));
            safe(() => storage.removeItem(VIZ_KEY));
        } else {
            safe(() => win.highway.setRenderer(null));
        }
    }

    // Drums only: #highway takes kit input and holds the band's drums pin, as
    // the stage's drum lane does beside a guitar (stage.js pinDrums). Without
    // it the drums free source would play any unjoined pad as the real drummer.
    function pinDrums(s) {
        const api = win.feedBackDrums;
        if (!api || !s.drumCanvas) return;
        if (typeof api.setInputTarget === 'function') safe(() => api.setInputTarget(s.drumCanvas));
        if (typeof api.setDifficulty === 'function') safe(() => api.setDifficulty(drumsDifficultyId(s.prefs.parts.drums.difficulty), s.drumCanvas));
    }

    // ---- Plan 7: full mode, the hover chrome, the sidebar and Settings ----

    const refit = () => { if (stage && typeof stage.refit === 'function') safe(() => stage.refit()); };

    function destroyChrome(s) {
        if (!s.chrome) return;
        const c = s.chrome;
        s.chrome = null;
        safe(() => c.destroy());
    }

    // The band chrome on the current stage (R5), and the session's sidebar (R7).
    function mountChrome(s) {
        destroyChrome(s);
        const player = doc.getElementById('player');
        if (!player) return;
        // The sidebar opens only while this session plays (R21).
        const openSidebar = (via) => { if (scoring() === s && s.sidebar) s.sidebar.open(via); };
        s.chrome = safe(() => createStageChrome({
            doc, player, full: s.full,
            // open, not toggle: the click lands after the sidebar's own
            // outside-pointerdown close, so a toggle would fight it.
            onMenu: () => openSidebar('menu'),
            onEdge: () => openSidebar('edge'),
            onLoop: () => cycleLoop(s),
            onFullScreen: () => setFull(s, !s.full),
            onEnd: () => { if (typeof win.requestExitSong === 'function') safe(() => win.requestExitSong()); },
        })) || null;
        if (s.chrome) { const c = s.chrome; const st = loopState(); safe(() => c.setLoop(st)); }
        if (!s.sidebar) {
            s.sidebar = safe(() => createSidebarOverlay({ doc, onNavigate: (link, key) => onSidebarNav(s, link, key) })) || null;
        }
        refit();
        quietGuitarErrors(s);
    }

    // The chrome's Full screen button (R20): full mode and window full screen together.
    function setFull(s, on) {
        s.full = !!on;
        safe(() => (s.full ? fullScreen.request() : fullScreen.exit()));
        if (s.chrome) { const c = s.chrome; safe(() => c.setFull(s.full)); }
        refit();
    }

    // Leaving window full screen (Esc in Electron, the OS) turns full mode off.
    function onFullScreenChange() {
        const s = scoring();
        if (s && s.full && !fullScreen.isOn()) setFull(s, false);
    }

    // Core's A-B loop: 'none' | 'a' | 'ab'.
    function loopState() {
        const l = typeof fb.getLoop === 'function' ? safe(() => fb.getLoop()) : null;
        const set = (v) => v !== null && v !== undefined;
        if (!l || !set(l.loopA)) return 'none';
        return set(l.loopB) ? 'ab' : 'a';
    }

    // The loop button: start, then end, then clear, through core's own functions.
    function cycleLoop(s) {
        const st = loopState();
        const name = st === 'none' ? 'setLoopStart' : st === 'a' ? 'setLoopEnd' : 'clearLoop';
        if (typeof win[name] === 'function') safe(() => win[name]());
        if (s.chrome) { const c = s.chrome; const next = loopState(); safe(() => c.setLoop(next)); }
    }

    // M toggles the sidebar; Esc closes an open one and stays in the song (R4,
    // R7). A window capture listener, so core's document shortcuts never see a
    // key it takes. Settings and the leave prompt own the keys while they show.
    function onStageKey(e) {
        const s = scoring();
        if (!e || !s || s.overlay || !s.sidebar) return;
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        const isM = e.code === 'KeyM' || e.key === 'm' || e.key === 'M';
        const isEsc = e.key === 'Escape' && s.sidebar.isOpen();
        if (!isM && !isEsc) return;
        // Another dialog (core's exit confirm) keeps its keys.
        if (otherModalOpen(doc, win, doc.getElementById('v3-sidebar'))) return;
        e.preventDefault();
        // A held M is consumed but toggles once, so the sidebar doesn't flicker.
        if (isM && e.repeat) return;
        if (isM) { s.sidebar.toggle('key'); return; }
        e.stopPropagation();
        s.sidebar.close();
    }

    // A sidebar item during the band song (R8): Settings over the paused song,
    // anything else asks first. close(), not follow(): an open sidebar is a
    // modal, and Settings' keys stand down under another modal.
    function onSidebarNav(s, link, key) {
        if (s.sidebar) s.sidebar.close();
        if (scoring() !== s) return;
        if (key === 'settings') openSettings(s);
        else confirmLeave(s, () => { if (s.sidebar) s.sidebar.follow(link); });
    }

    function openSettings(s) {
        if (s.overlay) return;
        s.pauseToken = pausePlayback();
        s.overlay = safe(() => openSettingsOverlay({
            doc, win, onClose: () => { s.overlay = null; afterOverlay(s); },
        })) || null;
        if (!s.overlay) { afterOverlay(s); return; }
        // Core's loadSettings ends in _applyMastery (the solo mastery). If it
        // settles after the close re-applied the band one, re-apply again.
        const ov = s.overlay;
        if (ov.loaded && typeof ov.loaded.then === 'function') {
            ov.loaded.then(() => { if (session === s && state.phase === 'playing') reapplyMastery(s); });
        }
    }

    // leave: what Leave does (follow a sidebar link, or back to the band screen).
    function confirmLeave(s, leave) {
        if (s.overlay) return;
        s.pauseToken = pausePlayback();
        if (typeof win._confirmDialog !== 'function') {
            leave();
            return;
        }
        const overlay = { kind: 'confirm' };
        s.overlay = overlay;
        // A prompt answered after the session ended (or after teardown closed
        // it) does nothing.
        const settle = (yes) => {
            if (session !== s || state.phase !== 'playing' || s.overlay !== overlay) return;
            s.overlay = null;
            if (yes === true) leave(); else afterOverlay(s);
        };
        let answer;
        try { answer = Promise.resolve(win._confirmDialog({ ...LEAVE_PROMPT })); } catch (e) { answer = Promise.reject(e); }
        // Core appends its modal synchronously. A teardown closes it through
        // its own Cancel, which also drops the modal's document key listener.
        const modal = lastModal();
        overlay.close = () => {
            const b = modal && modal.parentNode && safe(() => modal.querySelector('[data-cancel]'));
            if (b) safe(() => b.click());
        };
        // Answered from a controller: core's modal goes through its own Cancel
        // (dropping its key listener), and the answer settles now; the
        // promise's later Cancel answer finds the prompt already settled.
        overlay.answer = (yes) => {
            if (s.overlay !== overlay) return;
            overlay.close();
            settle(yes === true);
        };
        answer.then(settle, () => settle(false));
    }

    // Settings or the leave prompt goes without a resume or a focus move.
    function closeOverlaySilently(s) {
        if (s.overlay) {
            const o = s.overlay;
            s.overlay = null;
            if (typeof o.close === 'function') safe(() => o.close({ silent: true }));
        }
        s.pauseToken = null;
    }

    function lastModal() {
        const kids = doc.body && doc.body.children;
        const last = kids && kids.length ? kids[kids.length - 1] : null;
        return last && last.classList && last.classList.contains('feedBack-modal') ? last : null;
    }

    // Back to the song (R11): the band guitar mastery first (core's
    // loadSettings re-applied the solo one), then the resume.
    function afterOverlay(s) {
        if (session !== s || state.phase !== 'playing') return;
        reapplyMastery(s);
        const token = s.pauseToken;
        s.pauseToken = null;
        resumePlayback(token);
    }

    function reapplyMastery(s) {
        const hw = win.highway;
        if (!isOn(s.prefs, 'guitar') || !(s.readyDetail && s.readyDetail.hasPhraseData)) return;
        if (hw && typeof hw.setMastery === 'function') safe(() => hw.setMastery(masteryFor(s.prefs.parts.guitar.difficulty)));
    }

    // Core's overlay pause (R10); without it, the transport's togglePlay.
    function pausePlayback() {
        if (typeof fb.pauseForOverlay === 'function') return safe(() => fb.pauseForOverlay()) || null;
        const wasPlaying = fb.isPlaying === true;
        if (wasPlaying) callTogglePlay();
        return { wasPlaying };
    }

    // resumeAfterOverlay's answer is ignored: true can mean a resume still queued.
    function resumePlayback(token) {
        if (typeof fb.resumeAfterOverlay === 'function') { safe(() => { fb.resumeAfterOverlay(token); }); return; }
        if (token && token.wasPlaying && fb.isPlaying === false) callTogglePlay();
    }

    function callTogglePlay() {
        if (typeof win.togglePlay !== 'function') return;
        safe(() => Promise.resolve(win.togglePlay()).catch((e) => console.warn('[rockherosmith] togglePlay failed', e)));
    }

    // note_detect never blocks the band song with an alert (R16): quiet while
    // guitar scores, its previous value back at teardown.
    function quietGuitarErrors(s) {
        const nd = win.noteDetect;
        if (s.ndQuiet !== null || !s.scoreParts.includes('guitar')) return;
        if (!nd || typeof nd.setInputErrorsQuiet !== 'function') return;
        s.ndQuiet = !!(typeof nd.isInputErrorsQuiet === 'function' && safe(() => nd.isInputErrorsQuiet()));
        safe(() => nd.setInputErrorsQuiet(true));
    }

    function onInputError(e) {
        const d = e && e.detail;
        if (!d || typeof d !== 'object' || seenInputError.has(d)) return;
        seenInputError.add(d);
        if (d.isDefault === false) return;
        const s = scoring();
        if (s && s.scoreParts.includes('guitar')) showToast(s, GUITAR_INPUT_FAILED);
    }

    const EFFECTS = {
        saveRestorePoint(s) {
            s.savedSplit = safe(() => storage.getItem(SPLIT_KEY)) ?? null;
            s.savedMastery = sliderMastery();
            if (s.savedMastery !== null) return;
            Promise.resolve()
                .then(() => getJson('/api/settings'))
                .then((settings) => {
                    if (s.savedMastery !== null) return;
                    // No saved master_difficulty means core's default, full mastery.
                    s.savedMastery = masteryFromPct(settings && settings.master_difficulty) ?? 1;
                })
                .catch(() => { /* keep null: nothing to restore */ });
        },
        // Before playSong, so the scorer karaoke builds on song load already
        // uses the band difficulty. Teardown clears these overrides.
        armVocals(s) {
            if (!s.vocals) return;
            const api = karaokeApi(win);
            if (!api) { s.vocals = false; s.prefs = withoutVocals(s.prefs); return; }
            s.karaoke = api;
            s.vocalsArmed = true;
            if (armVocals(api, s.prefs.parts.vocals)) return;
            // Karaoke's default is hear-myself on: opening the mic would put the
            // singer through the speakers. Sit vocals out for this session.
            console.warn('[rockherosmith] hear-myself off could not be applied; vocals skipped');
            s.vocals = false;
            s.vocalsFailed = true;
            s.prefs = withoutVocals(s.prefs);
        },
        play(s) {
            let arrIndex;
            if (isOn(s.prefs, 'guitar')) arrIndex = s.guitarIndex;
            else if (s.drumsOnly && s.drumIndex >= 0) arrIndex = s.drumIndex;
            // Play again on an adopted play: the arrangement it was playing.
            if (arrIndex === undefined && Number.isInteger(s.replayArrangement)) arrIndex = s.replayArrangement;
            safe(() => fb.setReturnScreen(BAND_SCREEN));
            s.setReturn = true;
            // Splitscreen's playSong wrapper auto-starts from this pref; a band
            // session runs without it (teardown puts the saved value back).
            safe(() => storage.setItem(SPLIT_KEY, 'false'));
            // Band songs always count in (R15), drawn by the band's overlay
            // over core's own, which body.rhs-band-song hides. Core counts in
            // from its song:ready listener, before the stage mounts, so both
            // are up from the start of the session.
            if (typeof fb.setSongCountInOverride === 'function') {
                safe(() => fb.setSongCountInOverride(true));
                s.countInOverride = true;
            }
            startCountIn(s);
            try {
                s.played = Promise.resolve(win.playSong(encodeURIComponent(s.item.filename), arrIndex));
            } catch (e) {
                s.played = Promise.reject(e);
            }
        },
        mount(s) {
            const player = doc.getElementById('player');
            const song = fb.currentSong;
            if (!player || !song) return;
            // Controllers not connected by now sit out, decided once per session.
            if (!s.controllersSettled) {
                s.controllersSettled = true;
                s.prefs = settleControllers(s.prefs, s.connected);
            }
            if (Number.isInteger(song.arrangementIndex)) s.loadedArrangement = song.arrangementIndex;
            const plan = planStage(song, s.prefs.parts, s.prefs.controllers);
            // Every session with a playable lane or the strip has a stage (R10).
            if (!plan.strip && plan.lanes.length === 0) return;
            if (s.splitWaiting) return; // mounted once splitscreen is down
            unmountStage(s);
            try {
                stage = mountStage({ player, song, prefs: s.prefs, deps: { kinds } });
            } catch (e) {
                console.error('[rockherosmith] stage failed to mount', e);
                stage = null;
                // No strip slot: vocals can't start (startVocals bails silently).
                if (s.vocals && !s.vocalsStarted) showToast(s, VOCALS_FAILED);
                return;
            }
            // A remount (splitscreen) re-hosts the running strip in the new slot.
            if (s.vocalsStarted && stage && stage.stripSlot && s.karaoke) {
                const api = s.karaoke;
                safe(() => api.mountStrip(stage.stripSlot));
            }
            // The band score survives a remount; the HUD moves to the new slots.
            if (!s.score) {
                // Only the players playing: an absent part would pin the band multiplier at x1.
                s.scoreParts = playingIds(s.prefs);
                s.score = createBandScore({ parts: s.scoreParts, failMode: s.prefs.failMode });
                if (s.guitarThresholds) s.score.setStarThresholds('guitar', s.guitarThresholds);
            }
            // Drums that can't play leave the band: beside guitar, the lane
            // fell back to guitar only; alone, the drums plugin is missing.
            if (s.scoreParts.includes('drums')) {
                const lost = s.drumsOnly ? !drumsPluginLoaded() : !bandDrumCanvas(s);
                if (lost) dropPart(s, 'drums');
            }
            // A controller lane that failed to start leaves the band, as drums does.
            for (const id of s.scoreParts.filter(isControllerId)) {
                const canvas = stage && typeof stage.getLaneCanvas === 'function' ? safe(() => stage.getLaneCanvas(id)) : null;
                if (!canvas) dropPart(s, id);
            }
            mountHud(s, song);
            startCountIn(s);
            applyHides(s);
            enableGuitarDetect(s);
            mountChrome(s);
        },
        applyDifficulties(s) {
            if (isOn(s.prefs, 'guitar')) {
                if (s.readyDetail && s.readyDetail.hasPhraseData) {
                    safe(() => win.highway.setMastery(masteryFor(s.prefs.parts.guitar.difficulty)));
                } else {
                    showToast(s, ONE_DIFFICULTY);
                }
                // Guitar stars: note_detect's full combo of the notes shown
                // at the band mastery (R5), read after it is applied. A stage
                // mounted later (splitscreen was up) picks them up from s.
                const hw = win.highway;
                if (hw && typeof hw.getFilteredNotes === 'function' && typeof hw.getFilteredChords === 'function') {
                    s.guitarThresholds = safe(() => guitarStarThresholds(hw.getFilteredNotes(), hw.getFilteredChords())) || null;
                    if (s.score) {
                        safe(() => s.score.setStarThresholds('guitar', s.guitarThresholds));
                        refreshHud(s, true);
                    }
                }
            }
            if (s.drumsOnly) {
                showDrumView(s);
                s.drumCanvas = doc.getElementById('highway');
                pinDrums(s);
                listenCanvas(s);
            }
            startOverdrive(s);
            startDrumSound(s);
            startStemSound(s);
            startPadSound(s);
        },
        applyDevices(s) {
            Promise.resolve()
                .then(() => applyDevices(s.prefs, win, storage, deviceMemo))
                .catch((e) => console.warn('[rockherosmith] device routing failed', e));
        },
        // After the band song's song:ready and the mount (R9): karaoke mode,
        // the band mic, then karaoke's mic. A session that ended meanwhile
        // never opens the mic (startVocals re-checks after every await).
        startVocals(s) {
            if (s.vocalsFailed) { showToast(s, VOCALS_FAILED); return; }
            if (!s.vocals || s.vocalsStarted || !s.karaoke || !stage || !stage.stripSlot) return;
            s.vocalsStarted = true;
            const isCurrent = () => session === s && state.phase === 'playing';
            startVocals({
                api: s.karaoke, slot: stage.stripSlot, deviceId: s.prefs.parts.vocals.deviceId, storage, isCurrent,
            }).then((result) => {
                // Karaoke refused a song the library lists with pitch: a failure.
                if (!isCurrent()) return;
                if (result === 'no-pitch' || result === 'mic-error') dropVocals(s);
                if (result === 'no-pitch') {
                    showToast(s, songFacts(s.item).hasVocalPitch ? VOCALS_FAILED : NO_PITCH);
                } else if (result === 'mic-error') {
                    // Karaoke no longer prompts for an API start: the band says so.
                    showToast(s, VOCALS_FAILED);
                }
            }, (e) => console.warn('[rockherosmith] vocals failed to start', e));
        },
        holdExit() {
            release = (typeof fb.holdAutoExit === 'function') ? safe(() => fb.holdAutoExit()) || null : null;
        },
        // Band failed (R15): the song never ended, so no exit is held (Next song
        // shows the band screen and core's screen change stops the song). Core's
        // playback pause first; #audio itself when that is missing, throws or
        // doesn't answer 'paused', unless the session moved on meanwhile.
        pauseSong(s) {
            const pauseAudio = () => {
                if (session !== s || state.phase !== 'ending') return;
                const audio = doc.getElementById('audio');
                if (audio && !audio.paused && typeof audio.pause === 'function') safe(() => audio.pause());
            };
            const caps = fb.capabilities;
            if (!caps || typeof caps.dispatch !== 'function') { pauseAudio(); return; }
            let result;
            try {
                result = caps.dispatch({
                    capability: 'playback', command: 'pause', requester: 'rockherosmith', args: { requesterId: 'rockherosmith' },
                });
            } catch (_) {
                pauseAudio();
                return;
            }
            Promise.resolve(result).then((r) => { if (!r || r.status !== 'paused') pauseAudio(); }, pauseAudio);
        },
        // The results over the stage (R16, R17), with this session's numbers.
        // A session with no ledger (the stage never mounted) still gets them,
        // empty; if they can't show at all, Next song runs so core's held
        // exit is never stuck (autoNext: nobody asked for the next song, so
        // the band screen shows without opening the library pick).
        showResults(s) {
            const player = doc.getElementById('player');
            if (s.results) return;
            emitResult(s);
            // The sidebar is for the playing song only (plan 7 R21).
            if (s.sidebar) { const sb = s.sidebar; safe(() => sb.close()); }
            // So are Settings and the leave prompt: closed, resuming nothing.
            closeOverlaySilently(s);
            const model = player && safe(() => resultsModel({
                snapshot: s.score ? s.score.snapshot() : null,
                prefs: s.prefs,
                song: { title: s.item.title, artist: s.item.artist },
                oneLevel: !(s.readyDetail && s.readyDetail.hasPhraseData),
                drumsExtra: drumsStarPower(s),
                failed: s.bandFailed,
                controllerInfo: controllerInfo(s),
            }));
            s.results = model ? safe(() => showResultsScreen({
                doc, win, host: player, model,
                onAgain: () => dispatch({ type: 'again' }),
                onNext: () => dispatch({ type: 'next' }),
            })) || null : null;
            if (!s.results) { s.autoNext = true; dispatch({ type: 'next' }); }
        },
        hideResults(s) {
            if (!s.results) return;
            const r = s.results;
            s.results = null;
            safe(() => r.hide());
        },
        // Play again or leaving: core's held exit is never released. Core's
        // next playSong bumps its auto-exit generation, so it can't navigate.
        dropExit() {
            release = null;
        },
        teardown(s) {
            // Plan 7, first and silently: nothing resumes, every class and
            // attribute is undone, and full screen is left (Play again keeps it).
            closeOverlaySilently(s);
            if (s.sidebar) { const sb = s.sidebar; s.sidebar = null; safe(() => sb.destroy()); }
            destroyChrome(s);
            if (!s.keepHides) safe(() => fullScreen.exit());
            if (s.ndQuiet !== null) {
                const prev = s.ndQuiet;
                s.ndQuiet = null;
                const nd = win.noteDetect;
                if (nd && typeof nd.setInputErrorsQuiet === 'function') safe(() => nd.setInputErrorsQuiet(prev));
            }
            // 0. Karaoke, before its strip's slot goes: mic off, karaoke mode
            // off, strip back to its own place, band overrides cleared.
            if (s.vocalsArmed && s.karaoke) {
                s.vocalsArmed = false;
                s.vocalsStarted = false;
                const api = s.karaoke;
                safe(() => stopVocals(api, { keepHud: s.keepHides }));
                if (s.keepHides) s.vocalsKept = api;
            }
            // 0b. The band HUD, count-in and toasts go; each plugin's own
            // score display comes back; core's count-in pref rules again.
            // s.score is kept for the results.
            if (s.hud) { const hud = s.hud; s.hud = null; safe(() => hud.destroy()); }
            if (s.countIn) { const c = s.countIn; s.countIn = null; safe(() => c.destroy()); }
            safe(() => doc.body.classList.remove(BAND_SONG_CLASS));
            // Detection off before note_detect's HUD comes back.
            restoreGuitarDetect(s);
            if (!s.keepHides) undoHides(s);
            if (s.countInOverride) {
                s.countInOverride = false;
                if (typeof fb.setSongCountInOverride === 'function') safe(() => fb.setSongCountInOverride(null));
            }
            safe(() => toasts.clear());
            // 1. Stage, then the controller lanes' score HUDs (their canvases
            // went with it; a replay hides its own new lanes).
            unmountStage(s);
            lanes.teardown(s);
            // 2. Drums-only: the main highway's input target and band difficulty.
            if (s.drumsOnly) {
                const api = win.feedBackDrums;
                if (api && typeof api.setInputTarget === 'function') safe(() => api.setInputTarget(null));
                if (api && typeof api.clearDifficulty === 'function') {
                    const canvases = new Set([doc.getElementById('highway'), s.drumCanvas].filter(Boolean));
                    for (const c of canvases) safe(() => api.clearDifficulty(c));
                }
            }
            // The user's own view, when drums only switched it.
            restoreView(s);
            // 3. The user's mastery, unpersisted (window.setMastery would save
            // it): the slider's current value, else the one saved at Go.
            const mastery = sliderMastery() ?? s.savedMastery;
            if (mastery !== null) safe(() => win.highway.setMastery(mastery));
            // 4. The user's splitscreen pref, without starting splitscreen.
            safe(() => {
                if (s.savedSplit === null) storage.removeItem(SPLIT_KEY);
                else storage.setItem(SPLIT_KEY, s.savedSplit);
            });
            // 5. The canvas-replaced listener.
            if (s.canvasListener) { safe(() => fb.off('highway:canvas-replaced', onCanvasReplaced)); s.canvasListener = false; }
            if (s.splitTimer !== null) { clearTimer(s.splitTimer); s.splitTimer = null; }
            s.splitWaiting = false;
            // 6. Overdrive.
            if (s.odTimer !== null) { clearTimer(s.odTimer); s.odTimer = null; }
            if (s.stallTimer !== null) { clearTimer(s.stallTimer); s.stallTimer = null; }
            s.od = null;
            s.drumCanvas = null;
            // 7. Every stem the band muted comes back, and its claim is released.
            for (const id of [...s.stemClaims]) restoreFailedStem(s, id);
            releaseDrumSound(s);
            releaseStemSound(s);
            releasePadSound(s);
        },
        releaseExit() {
            const r = release;
            release = null;
            if (typeof r === 'function') safe(r);
        },
        showBandScreen(s) {
            const el = doc.getElementById(BAND_SCREEN);
            if (!(el && el.classList.contains('active')) && typeof win.showScreen === 'function') {
                safe(() => win.showScreen(BAND_SCREEN));
            }
            if (!(s && s.autoNext)) safe(() => onShowBandScreen && onShowBandScreen());
        },
        // Next song after a solo session (contract §2): the Solo screen; without
        // that hook, the band screen as before.
        showSoloScreen(s) {
            if (typeof onShowSoloScreen !== 'function') { EFFECTS.showBandScreen(s); return; }
            safe(() => onShowSoloScreen({ next: !(s && s.autoNext) }));
        },
        // Play again: teardown left the plugins' displays hidden, so the
        // replayed session takes them over (no flash of their own HUDs).
        keepHides(s) {
            s.keepHides = true;
        },
        // Play again: the same library item with the prefs Go was given, through
        // the normal Go path. Always the last effect: the session is idle by now.
        replay(s) {
            const started = begin(s.item, s.goPrefs, s.keepHides ? s.hidden : null,
                { solo: s.solo, replayArrangement: s.adopted ? s.loadedArrangement : null });
            // Refused: nothing took the hides over, so they're undone here,
            // and nothing keeps the full screen the session before asked for.
            if (!started && s.keepHides) undoHides(s);
            if (!started) safe(() => fullScreen.exit());
            // Karaoke's hide passes on only when the replay armed karaoke again.
            const next = started ? session : null;
            if (s.keepHides && s.vocalsKept && !(next && next.vocalsArmed && next.karaoke === s.vocalsKept)) {
                const api = s.vocalsKept;
                safe(() => showKaraokeHud(api));
            }
            if (started && typeof started.then === 'function') {
                started.catch((e) => console.warn('[rockherosmith] Play again failed to start the song', e));
            }
        },
    };

    // State is committed before effects run, so an effect that re-enters
    // (release() closes the player and announces screen:changing) sees it.
    function dispatch(event) {
        const { state: next, effects } = reduceSession(state, event);
        state = next;
        const s = session;
        if (state.phase === 'idle') session = null;
        if (!s) return;
        for (const name of effects) {
            const fn = EFFECTS[name];
            if (!fn) continue;
            try { fn(s); } catch (e) { console.error(`[rockherosmith] session effect ${name} failed`, e); }
        }
    }

    // solo: a one-player session (playSolo), whose Next song goes to the Solo screen.
    function startSession({ song, prefs, solo = false } = {}) {
        return begin(song, prefs, null, { solo: solo === true });
    }

    // hidden: the hides a replayed session inherits (undone at its teardown).
    // replayArrangement: Play again on an adopted play loads the arrangement it played.
    function begin(song, prefs, hidden, { solo = false, replayArrangement = null } = {}) {
        if (state.phase !== 'idle' || !song || !song.filename) return false;
        adoptGen++;
        const s = newSession(song, effectivePrefs(sessionPrefs(prefs, song), song, win, kinds), prefs, { solo });
        s.replayArrangement = replayArrangement;
        if (hidden) s.hidden = hidden;
        session = s;
        lanes.readConnected(s);
        dispatch({ type: 'go', filename: song.filename, solo });
        if (state.phase === 'idle') return false;
        // Inside the Go (or Play again) click, so the request has user activation.
        if (s.full) safe(() => fullScreen.request());
        return (s.played || Promise.resolve()).then(() => true, (e) => {
            // The song never started: undo this session, then report it. A
            // late rejection never tears down a session that is playing.
            if (session === s && state.phase === 'armed') {
                dispatch({ type: 'left' });
                // Our one-shot return override must not steer the next song.
                if (s.setReturn && fb._nextReturnScreen === BAND_SCREEN) fb._nextReturnScreen = null;
            }
            throw e;
        });
    }

    // Adopting a plain play (contract §2): a song ready outside a session asks
    // `adopt` what it becomes; the answer applies only if nothing moved on meanwhile
    // (no other song, no stop, no session started). Splitscreen plays are left alone.
    function maybeAdopt(detail) {
        if (typeof adopt !== 'function' || state.phase !== 'idle' || session || splitActive()) return;
        const song = fb.currentSong;
        if (!song || typeof song.filename !== 'string' || !song.filename) return;
        const gen = ++adoptGen;
        Promise.resolve().then(() => adopt(song)).then((prefs) => {
            if (!prefs || gen !== adoptGen || state.phase !== 'idle' || session) return;
            const cur = fb.currentSong;
            if (!cur || cur.filename !== song.filename) return;
            beginAdopted(song, prefs, detail);
        }, (e) => console.warn('[rockherosmith] adopting the song failed', e));
    }

    function beginAdopted(song, prefs, detail) {
        const s = newSession(song, effectivePrefs(sessionPrefs(prefs, song, songStemIds()), song, win, kinds), prefs, { adopted: true });
        // The song already shows on the drum view; the band never switches it.
        s.drumView = false;
        s.readyDetail = detail;
        // An adopted play counts in with core's own count-in (it already ran).
        session = s;
        lanes.readConnected(s);
        dispatch({ type: 'adopt', filename: song.filename });
    }

    const handlers = {
        'song:loading': () => { adoptGen++; dispatch({ type: 'loading' }); },
        'song:ready': (e) => {
            const detail = (e && e.detail) || {};
            if (state.phase === 'idle' && !session) { maybeAdopt(detail); return; }
            if (session) session.readyDetail = detail;
            const cur = fb.currentSong;
            dispatch({ type: 'ready', filename: cur && cur.filename, hasPhraseData: !!detail.hasPhraseData });
        },
        'song:ended': () => dispatch({ type: 'ended' }),
        'song:stop': () => { adoptGen++; dispatch({ type: 'left' }); },
        'screen:changing': (e) => {
            const d = (e && e.detail) || {};
            if (d.from === 'player' && d.id !== 'player') { adoptGen++; dispatch({ type: 'left' }); }
        },
        // A 5-fret lane's quick settings change on this session's lane (A4): the
        // caller saves it (a band controller's entry, or the Solo choices).
        'five_fret:quick-setting': (e) => {
            const s = session;
            const d = e && e.detail;
            if (!s || !d || typeof onQuickSetting !== 'function' || !lanes.laneOwner(s, d.canvas)) return;
            safe(() => onQuickSetting(d, { solo: s.solo }));
        },
        // Band mode and splitscreen never run at once. Armed or playing,
        // splitscreen is stopped and the stage comes back; while ending, the
        // session simply ends.
        'splitscreen:panels-changed': () => {
            if (!splitActive()) return;
            if (session && (state.phase === 'armed' || state.phase === 'playing')) onSplitStarted(session);
            else dispatch({ type: 'left' });
        },
    };
    // Judgments into the band score (R3): each acts only while the session
    // plays, then refreshes the HUD. Judgments on the band's drum canvas also
    // drive the Rock Band drum stem (plan 6 R9), a dropped-out drummer's too;
    // an overhit while paused is a stray pad tap and is ignored (R10).
    const drumHandler = (type) => (e) => {
        const s = scoring();
        if (!s) return;
        const canvas = bandDrumCanvas(s);
        // A canvas the stage adopted without an announcement is hidden here.
        if (canvas && s.hidden.drums.size) hideDrumHud(s, canvas);
        // Drums never take an overdrive factor (R4): their points already
        // include the drums engine's own star-power doubling.
        record(s, drumsEntry(type, e && e.detail, displayTime(s), canvas));
        const d = e && e.detail;
        if (!d || !canvas || d.canvas !== canvas || !s.scoreParts.includes('drums')) return;
        if (type === 'overhit' && songPaused(s)) return;
        if (s.drumSound && s.drumSound.judge(type)) syncDrumSound(s);
        // Rock Band with no drum stem: the full mix drops out, and a miss clunks
        // (the pads are silent), as for a Rock Band controller (contract §6).
        if (s.stemSound && s.stemSound.stems().includes(FULL_MIX) && s.prefs.parts.drums.soundMode === 'rockband') {
            if (CLUNK_JUDGMENTS.includes(type) && s.prefs.missSound !== false && !s.failed.has('drums')) safe(() => missSound.play());
            syncStemSound(s, s.stemSound.judge('drums', type));
        }
    };
    for (const type of DRUM_JUDGMENTS) handlers['drums:' + type] = drumHandler(type);
    // A drum solo's bonus (contract §4): points only, on the real drummer's canvas
    // or a drums controller's lane.
    handlers['drums:bonus'] = (e) => {
        const s = scoring();
        const d = e && e.detail;
        if (!s || !d || !d.canvas) return;
        const canvas = bandDrumCanvas(s);
        if (canvas && d.canvas === canvas) { record(s, drumsBonusEntry(d, displayTime(s), canvas)); return; }
        const id = lanes.laneOwner(s, d.canvas);
        if (id) record(s, drumsBonusEntry(d, displayTime(s), d.canvas, id));
    };
    // Deploys (R18): drums star power on the band's drum canvas, karaoke's overdrive.
    // A dropped-out part's deploy is recorded but ignored by the ledger (R12), so its
    // greyed lane gets no OVERDRIVE! callout.
    // The deploy is recorded even with no overdrive session (its data failed to
    // build), so fail mode can still rescue; only the callout needs s.od.
    // Karaoke runs outside the band too: its deploy counts only with a vocals part.
    handlers['drums:sp-activate'] = (e) => {
        const s = scoring();
        const d = e && e.detail;
        if (!s || !d || !d.canvas || d.canvas !== bandDrumCanvas(s)) return;
        if (s.od && !s.failed.has('drums')) { const od = s.od; safe(() => od.deployed('drums')); }
        record(s, { part: 'drums', t: displayTime(s), kind: 'deploy' });
    };
    handlers['karaoke:od-activate'] = () => {
        const s = scoring();
        if (!s || !s.scoreParts.includes('vocals')) return;
        if (s.od && !s.failed.has('vocals')) { const od = s.od; safe(() => od.deployed('vocals')); }
        record(s, { part: 'vocals', t: displayTime(s), kind: 'deploy' });
    };
    handlers['karaoke:phrase'] = (e) => {
        const s = scoring();
        if (!s) return;
        const entry = vocalsEntry(e && e.detail, displayTime(s));
        if (entry) s.vocalsReset = undefined;
        record(s, entry);
    };
    handlers['karaoke:reset'] = (e) => {
        const s = scoring();
        if (!s) return;
        s.vocalsReset = vocalsTotals(e && e.detail);
        s.score.syncTotals('vocals', s.vocalsReset);
        refreshHud(s, true);
    };
    // Rewind on a backward seek (R2): the ledger first, then karaoke's reset
    // totals (karaoke may announce its reset before or after this listener).
    handlers['song:seek'] = (e) => {
        const s = scoring();
        const d = (e && e.detail) || {};
        if (!s || !Number.isFinite(d.from) || !Number.isFinite(d.to)) return;
        // Any seek brings Rock Band drums back (plan 6 R11): the drums engine
        // starts clean from the seek time.
        if (s.drumSound && s.drumSound.seek()) syncDrumSound(s);
        // So do controllers' dropped stems (Review Focus 5).
        if (s.stemSound) syncStemSound(s, s.stemSound.seek());
        // A loop wrap keeps the ledger; the looped phrases earn again (R8).
        if (d.reason === 'loop-wrap') {
            if (s.od) { const od = s.od; safe(() => od.loopWrap(d.to)); }
            return;
        }
        if (!(d.to < d.from - REWIND_MIN_S)) return;
        s.score.rewindTo(d.to);
        s.lastT = d.to;
        if (s.vocalsReset !== undefined) s.score.syncTotals('vocals', s.vocalsReset);
        if (s.od) { const od = s.od; safe(() => od.rewindTo(d.to)); }
        refreshHud(s, true);
        syncFailures(s, { silent: true });
    };
    // Controller lanes (Ruling 9): one listener per event name for every kind.
    // A real part's handler on the same name (Plan 6's drums:*) keeps running first.
    for (const { name, type } of lanes.events) {
        const prev = handlers[name];
        handlers[name] = prev ? (e) => { prev(e); lanes.onEvent(type, e); } : (e) => lanes.onEvent(type, e);
    }

    function onGuitarJudgment(e) {
        const s = scoring();
        const d = e && e.detail;
        if (!s || !d || typeof d !== 'object' || seenGuitar.has(d)) return;
        seenGuitar.add(d);
        const entry = guitarEntry(d, displayTime(s));
        if (!entry) return;
        const od = s.od;
        // A dropped-out guitar earns nothing (R19): checked before this entry.
        const before = od ? s.score.snapshot().parts.guitar : null;
        const failed = !!(before && before.failed);
        record(s, { ...entry, factor: od ? od.factorFor('guitar', entry.t) : 1 });
        if (od && !failed) safe(() => od.guitarJudgment(entry.noteTime, entry.kind === 'hit', entry.t));
    }
    // Whether the song is paused (fix 6): core's transport flag says so
    // (window.feedBack.isPlaying === false), or the chart clock stood still
    // between the last two OD or stall ticks. The flag alone isn't enough: an ordinary
    // browser-audio pause can leave it true (core transport.js togglePlay).
    function songPaused(s) {
        return fb.isPlaying === false || s.chartStalled;
    }

    function chartNow() {
        const hw = win.highway;
        return hw && typeof hw.getTime === 'function' ? safe(() => hw.getTime()) : undefined;
    }

    // Noodle it up (R9, R10): an onset that deploys is the guitar's deploy entry.
    // A dropped-out guitar never spends its bar (its deploy would be ignored, R12),
    // and a paused song never deploys (fix 6).
    function onOnset(e) {
        const s = scoring();
        const d = e && e.detail;
        if (!s || !d || typeof d !== 'object' || seenOnset.has(d)) return;
        seenOnset.add(d);
        const t = onsetTime(d);
        if (!s.od || s.failed.has('guitar') || !Number.isFinite(t)) return;
        if (songPaused(s)) return;
        const od = s.od;
        if (safe(() => od.onset(t, displayTime(s))) === true) record(s, { part: 'guitar', t: displayTime(s), kind: 'deploy' });
    }
    // Stems built a new stem graph (R4): its claims are gone, so a held sound
    // mute is sent again. Part audio built before any stem was listed is
    // built again now there are stems.
    function onStemsState(e) {
        const d = e && e.detail;
        if (!d || d.event !== 'provider-ready') return;
        const s = scoring();
        if (!s) return;
        if (s.drumSound) syncDrumSound(s, { force: true });
        if (s.stemSound && s.stemSoundEmpty && songStemIds().length) {
            releaseStemSound(s);
            startStemSound(s);
        } else if (s.stemSound) {
            syncStemSound(s, s.stemSound.stems(), { force: true });
        }
    }
    const winHandlers = {
        'notedetect:hit': onGuitarJudgment, 'notedetect:miss': onGuitarJudgment, 'notedetect:onset': onOnset,
        'stems:state': onStemsState,
        'notedetect:input-error': onInputError,
    };

    for (const [ev, fn] of Object.entries(handlers)) fb.on(ev, fn);
    const winEvents = typeof win.addEventListener === 'function';
    if (winEvents) for (const [ev, fn] of Object.entries(winHandlers)) win.addEventListener(ev, fn);
    if (winEvents) win.addEventListener('keydown', onStageKey, true);

    return {
        dispose() {
            // A pending adopt never lands on a disposed runtime.
            adoptGen++;
            adopt = null;
            dispatch({ type: 'left' });
            for (const [ev, fn] of Object.entries(handlers)) fb.off(ev, fn);
            if (winEvents) for (const [ev, fn] of Object.entries(winHandlers)) safe(() => win.removeEventListener(ev, fn));
            if (winEvents) safe(() => win.removeEventListener('keydown', onStageKey, true));
            safe(offFullScreen);
            safe(() => toasts.clear());
        },
        isMounted: () => !!stage,
        startSession,
        phase: () => state.phase,
        snapshot: () => (session && session.score ? session.score.snapshot() : null),
        // The current session's overdrive meters, or null.
        overdrive: () => (session && session.od ? session.od.snapshot(displayTime(session)) : null),
        // The current session's drum sound mode (R17): { mode, muted }, or null.
        drumSound: () => (session && session.drumSound ? { mode: session.drumSound.mode, muted: session.soundClaim } : null),
        again: () => dispatch({ type: 'again' }),
        next: () => dispatch({ type: 'next' }),
        // The stage's overlays for the current session (R22), or null.
        stageUi() {
            const s = session;
            if (!s) return null;
            return {
                full: s.full,
                fullScreen: fullScreen.isOn(),
                sidebar: !!(s.sidebar && s.sidebar.isOpen()),
                overlay: s.overlay ? s.overlay.kind : null,
            };
        },
    };
}
