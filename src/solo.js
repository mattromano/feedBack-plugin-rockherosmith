// Solo play: "a band of one" (play layer contract §1, §2). One player on the
// RockHeroSmith stage, so a song played alone gets everything a band gets (stems
// dropping out on misses, the HUD, overdrive, results):
//   - the library's "Play as" entries and the Solo screen call playSolo,
//   - a plain drums / 5-fret play is adopted (createAdopt, run by the runtime).
// The solo band is built for that one session from the saved prefs and never
// saved: the viewer's band setup stays as it is.
import { normalizePrefs } from './prefs.js';
import { CONTROLLER_KINDS } from './controller-model.js';
import { DIFFICULTIES } from './mappings.js';
import { getPart, hasChart, controllerPartFor } from './parts.js';

const SOLO_ID = 'ctl1';
const BAND_SCREEN = 'plugin-rockherosmith';
const VIZ_KEY = 'vizSelection';
// The views a plain play can be adopted from (their window.feedBackViz_<id>).
const ADOPT_VIEWS = ['drums', 'five_fret'];

const drumsChart = (item) => hasChart(getPart('drums'), item, {});
const safe = (fn, d = null) => { try { return fn(); } catch (_) { return d; } };

// The session prefs for one player: every other part off, the saved look (split,
// zoom, full screen, miss sound) kept, and the Solo screen's fail mode.
// opts: { kind: 'kit' | 'five_fret' | 'drums', part?, difficulty?, controllerKey?, name?, deviceKey? }
//   kit: the real drummer (parts.drums) on the saved input, else `deviceKey` (the drums
//   plugin's MIDI input), with its saved sound mode, and no controllers.
//   A controller: its saved entry's sound mode, part audio and lefty, else the solo
//   sound mode; null without a key or with an unknown kind.
export function soloPrefs(saved, { kind, part, difficulty, controllerKey, name, deviceKey } = {}) {
    const base = normalizePrefs(saved);
    const off = (p) => ({ ...p, on: false });
    const common = { ...base, failMode: base.solo.failMode };
    if (kind === 'kit') {
        const drums = base.parts.drums;
        return normalizePrefs({
            ...common,
            parts: {
                guitar: off(base.parts.guitar), vocals: off(base.parts.vocals),
                drums: {
                    ...drums, on: true,
                    deviceKey: drums.deviceKey || (typeof deviceKey === 'string' ? deviceKey : ''),
                    difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : drums.difficulty,
                },
            },
            controllers: [],
        });
    }
    const def = CONTROLLER_KINDS[kind];
    if (!def || typeof controllerKey !== 'string' || !controllerKey) return null;
    const known = base.controllers.find((c) => c.key === controllerKey) || null;
    const wantPart = def.parts.includes(part) ? part : (def.parts.includes(base.solo.part) ? base.solo.part : def.parts[0]);
    return normalizePrefs({
        ...common,
        parts: { guitar: off(base.parts.guitar), drums: off(base.parts.drums), vocals: off(base.parts.vocals) },
        controllers: [{
            key: controllerKey, id: SOLO_ID, name: name || (known && known.name) || '', playsAs: kind,
            part: wantPart,
            difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : base.solo.difficulty,
            lefty: known ? known.lefty : false,
            partAudio: known ? known.partAudio : 'rockband',
            soundMode: known ? known.soundMode : base.solo.soundMode,
            on: true,
        }],
    });
}

// The controller to play on: the first connected one the kind's plugin can play
// (a saved binding or a standard pad), free ones first. -> { controllerKey, name } | null
export async function pickSoloController(kind, kinds = CONTROLLER_KINDS) {
    const def = kinds[kind];
    const api = def && def.api();
    if (!api || typeof api.listControllers !== 'function') return null;
    let list;
    try { list = await api.listControllers(); } catch (_) { return null; }
    const usable = (Array.isArray(list) ? list : []).filter((c) => c && c.connected && c.kind && c.controllerKey);
    const pick = usable.find((c) => !c.claimedBy) || usable[0];
    return pick ? { controllerKey: pick.controllerKey, name: pick.name || '' } : null;
}

// Waits for core's MIDI discovery (feedBackDrums.whenMidiReady, about 2 s at most):
// before it, midiInput() reports the saved kit as not connected. Never rejects.
async function midiReady(drums) {
    if (!drums || typeof drums.whenMidiReady !== 'function') return;
    try { await drums.whenMidiReady(); } catch (_) { /* ask midiInput anyway */ }
}

// The drums plugin's saved MIDI input ({ key, name, connected }), or null (none, or
// a drums plugin without midiInput yet).
function midiInput(drums) {
    if (!drums || typeof drums.midiInput !== 'function') return null;
    const m = safe(() => drums.midiInput());
    return m && typeof m === 'object' ? m : null;
}

// Whether core's gamepad input lists a connected controller (synchronous; the drums
// plugin's own listing needs its bindings loaded, so it is a Promise).
function anyGamepad(win) {
    const gi = win && win.feedBack && win.feedBack.gamepadInput;
    if (!gi || gi.version !== 1 || typeof gi.list !== 'function') return false;
    const list = safe(() => gi.list());
    return Array.isArray(list) && list.some((e) => e && e.connected);
}

// What the drums Play-as should use (contract §1): 'kit' when the drums plugin's
// MIDI input is connected, else 'drums' when a game controller is connected (playSolo
// then finds the drums one, or opens setup), else null. null too without the drums
// plugin or when `song` (if given) has no drum chart. A Promise: it waits for the
// drums plugin's MIDI discovery (whenMidiReady) first.
export async function soloKindFor(song, { win = globalThis.window } = {}) {
    const drums = win && win.feedBackDrums;
    if (!drums) return null;
    if (song && !drumsChart(song)) return null;
    await midiReady(drums);
    const m = midiInput(drums);
    if (m && m.connected) return 'kit';
    return anyGamepad(win) ? 'drums' : null;
}

// Whether the song has a chart for the kind (5-fret: its part, else any 5-fret part).
function playable(item, kind, part, kinds) {
    if (kind === 'kit' || kind === 'drums') return drumsChart(item);
    if (kind !== 'five_fret') return false;
    const api = kinds[kind] && safe(() => kinds[kind].api());
    const showAuto = !!api && typeof api.showAutoCharts === 'function' && safe(() => api.showAutoCharts()) === true;
    return !!controllerPartFor(item, { playsAs: kind, part }, { showAuto });
}

// createSoloPlay({ getRuntime, getScreen, loadPrefs, showScreen, win?, kinds? })
//   -> playSolo(item, { kind, part?, difficulty? }) -> Promise<'started' | 'setup' | false>
// 'setup': no chart for the kind, no usable controller, or the runtime refused, so the
// band screen opened with the song; false: a session is already running or the item
// has no file.
export function createSoloPlay({ getRuntime, getScreen, loadPrefs, showScreen, win = globalThis.window, kinds = CONTROLLER_KINDS }) {
    function toSetup(item) {
        const screen = getScreen();
        if (screen && typeof screen.openWithSong === 'function') screen.openWithSong(item);
        showScreen(BAND_SCREEN);
        return 'setup';
    }
    return async function playSolo(item, opts = {}) {
        if (!item || typeof item.filename !== 'string' || !item.filename) return false;
        const rt = getRuntime();
        if (!rt || typeof rt.startSession !== 'function') return false;
        if (typeof rt.phase === 'function' && rt.phase() !== 'idle') return false;
        const kind = opts.kind;
        if (!playable(item, kind, opts.part, kinds)) return toSetup(item);
        let prefs;
        if (kind === 'kit') {
            await midiReady(win && win.feedBackDrums);
            const m = midiInput(win && win.feedBackDrums);
            prefs = soloPrefs(loadPrefs(), { ...opts, deviceKey: m && typeof m.key === 'string' ? m.key : '' });
        } else {
            const ctl = await pickSoloController(kind, kinds);
            if (!ctl) return toSetup(item);
            prefs = soloPrefs(loadPrefs(), { ...opts, ...ctl });
        }
        if (!prefs) return toSetup(item);
        const started = rt.startSession({ song: item, prefs, solo: true });
        if (started === false) return toSetup(item);
        await started;
        return 'started';
    };
}

// The Solo screen (contract §1). A stub until stream B2's Solo screen replaces it:
// the band screen, with its library pick on { next: true } (Results' Next song).
export function createOpenSolo({ getScreen, showScreen }) {
    return function openSolo(opts = {}) {
        showScreen(BAND_SCREEN);
        if (opts && opts.next) {
            const screen = getScreen();
            if (screen && typeof screen.nextSong === 'function') screen.nextSong();
        }
    };
}

// The main highway's view id: the picker (core's source of truth), else the saved
// one; Auto resolves through the adoptable views whose matchesArrangement takes the
// loaded part (as core's tour engine does). null for the default or any other view.
export function currentViz(win, doc) {
    const picker = doc && typeof doc.getElementById === 'function' ? doc.getElementById('viz-picker') : null;
    let sel = picker && picker.value ? picker.value : null;
    if (!sel) sel = safe(() => win.localStorage.getItem(VIZ_KEY));
    if (!sel || sel === 'default') return null;
    if (sel !== 'auto') return sel;
    const info = safe(() => win.highway.getSongInfo()) || {};
    return ADOPT_VIEWS.find((id) => matches(win, id, info)) || null;
}

function matches(win, id, info) {
    const f = win && win['feedBackViz_' + id];
    return !!f && typeof f.matchesArrangement === 'function' && safe(() => f.matchesArrangement(info)) === true;
}

// What a plain play on the main highway would be adopted as: the drum view on a drum
// part -> { kind: 'drums' }; the 5-fret view -> { kind: 'five_fret', controllerKey?, part? }
// (the controller playing it, when its instance reports one); else null.
export function adoptTarget(win, doc) {
    const viz = currentViz(win, doc);
    if (viz === 'drums') {
        const info = safe(() => win.highway.getSongInfo()) || {};
        return matches(win, 'drums', info) ? { kind: 'drums' } : null;
    }
    if (viz === 'five_fret') {
        const api = win && win.feedBackFiveFret;
        const canvas = doc && typeof doc.getElementById === 'function' ? doc.getElementById('highway') : null;
        const st = api && typeof api.getInstanceState === 'function' && canvas ? safe(() => api.getInstanceState(canvas)) : null;
        const out = { kind: 'five_fret' };
        if (st && typeof st.controllerKey === 'string' && st.controllerKey) out.controllerKey = st.controllerKey;
        if (st && CONTROLLER_KINDS.five_fret.parts.includes(st.instrument)) out.part = st.instrument;
        return out;
    }
    return null;
}

// createAdopt({ win, doc, loadPrefs, kinds }) -> adopt(song) -> Promise<prefs | null>
// The one-player prefs a plain play becomes (contract §2), or null (adoptSolo off, a
// view that isn't adoptable, or nobody to play it). The drum view is the kit when the
// MIDI input is connected, else a connected drums controller, else the kit (keyboard,
// or the plugin's own input); the 5-fret view is the controller playing it, else the
// first connected one.
export function createAdopt({ win, doc, loadPrefs, kinds = CONTROLLER_KINDS }) {
    return async function adopt() {
        const saved = loadPrefs();
        if (!saved || saved.adoptSolo !== true) return null;
        const target = adoptTarget(win, doc);
        if (!target) return null;
        if (target.kind === 'drums') {
            await midiReady(win.feedBackDrums);
            const m = midiInput(win.feedBackDrums);
            const kit = () => soloPrefs(saved, { kind: 'kit', deviceKey: m && typeof m.key === 'string' ? m.key : '' });
            if (m && m.connected) return kit();
            const ctl = await pickSoloController('drums', kinds);
            return ctl ? soloPrefs(saved, { kind: 'drums', ...ctl }) : kit();
        }
        const ctl = target.controllerKey ? { controllerKey: target.controllerKey } : await pickSoloController('five_fret', kinds);
        if (!ctl) return null;
        return soloPrefs(saved, { kind: 'five_fret', part: target.part, ...ctl });
    };
}

// A 5-fret quick settings change on a pinned lane (five_fret:quick-setting
// { controllerKey, key, value, lane }) as a savePrefs patch, or null: a band lane's
// difficulty / part / lefty goes into that controller's saved entry; a solo session's
// difficulty / part into the Solo screen's choices.
const QUICK_KEYS = {
    difficulty: (v) => DIFFICULTIES.includes(v),
    part: (v) => CONTROLLER_KINDS.five_fret.parts.includes(v),
    lefty: (v) => typeof v === 'boolean',
};
export function quickSettingPatch(prefs, detail, { solo = false } = {}) {
    const d = detail || {};
    if (d.lane !== true || !Object.prototype.hasOwnProperty.call(QUICK_KEYS, d.key) || !QUICK_KEYS[d.key](d.value)) return null;
    if (solo) return d.key === 'lefty' ? null : { solo: { [d.key]: d.value } };
    const list = (prefs && Array.isArray(prefs.controllers)) ? prefs.controllers : [];
    if (!list.some((c) => c && c.key === d.controllerKey)) return null;
    return { controllers: list.map((c) => (c.key === d.controllerKey ? { ...c, [d.key]: d.value } : c)) };
}
