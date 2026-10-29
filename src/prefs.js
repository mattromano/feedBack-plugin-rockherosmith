// RockHeroSmith per-viewer prefs, persisted in localStorage. Every storage
// access is guarded: private windows / blocked storage must never throw.
import { DIFFICULTIES } from './mappings.js';
import { CONTROLLER_KINDS, PART_AUDIO_MODES, isControllerId } from './controller-model.js';
import { DRUM_SOUND_MODES } from './drum-sound.js';

const KEY = 'rockherosmith.prefs.v1';
// Pre-rename key (the old Build-a-Band key): copied to KEY on first load, never removed.
export const LEGACY_KEY = 'build_a_band.prefs.v1';

// labelScale: the guitar lane's fret-number size in band mode, kept apart from
// core's solo-play `highwayLabelScale` so neither leaks into the other.
const DEFAULTS = Object.freeze({ split: 62, labelScale: 1, zoom: Object.freeze({ guitar: 1, drums: 1 }) });
const PART_DEFAULTS = Object.freeze({
    guitar: Object.freeze({ on: true, deviceKey: '', arrangement: 'Lead', difficulty: 'medium' }),
    drums: Object.freeze({ on: true, deviceKey: '', difficulty: 'medium', soundMode: 'song' }),
    vocals: Object.freeze({ on: true, deviceId: '', difficulty: 'medium', hearMyself: false, micHitDb: -30 }),
});
// The library pick's chips (query.js PICK_FILTERS), remembered from every pick.
export const PICK_FILTER_DEFAULTS = Object.freeze({
    playable: true, drumStem: false, drums: false, vocals: false, guitar: false, fiveFret: false, fiveFretReal: false,
});
const ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass'];
const SOUND_MODES = ['song', 'rockband', 'kit'];
const FAIL_MODES = ['nofail', 'fail'];
const MAX_RECENT = 10;
// The Solo screen's choices (play layer contract §7): the instrument, the 5-fret part,
// the real guitar's arrangement, and how a solo session plays.
export const SOLO_INSTRUMENTS = Object.freeze(['kit', 'drums', 'five_fret', 'guitar']);
export const SOLO_DEFAULTS = Object.freeze({
    instrument: 'kit', part: 'guitar', arrangement: 'Lead', difficulty: 'expert',
    soundMode: 'rockband', crowd: true, failMode: 'nofail', autoNext: false,
});
export const LABEL_SCALE_MIN = 0.75;
export const LABEL_SCALE_MAX = 2.5;
// Per-lane zoom (guitar and drum lanes; the vocal strip has none).
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.3;
export const ZOOM_STEP = 0.1;
// Mic-hit sensitivity (dBFS), shared with Lyrics Karaoke's detector range.
export const MIC_HIT_DB_MIN = -48;
export const MIC_HIT_DB_MAX = -12;
export const MIC_HIT_DB_STEP = 3;
export const MIC_HIT_DB_DEFAULT = -30;

// Rounded and clamped; non-numbers fall back to the default.
export function clampMicHitDb(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return MIC_HIT_DB_DEFAULT;
    return Math.min(MIC_HIT_DB_MAX, Math.max(MIC_HIT_DB_MIN, Math.round(v)));
}

// Same range core's setLabelScale clamps to. Non-numbers fall back to 1.
export function clampLabelScale(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS.labelScale;
    return Math.max(LABEL_SCALE_MIN, Math.min(LABEL_SCALE_MAX, v));
}

// Non-numbers fall back to 1; rounded to 2 decimals so 0.1 steps stay exact.
export function clampZoom(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
    return Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v)) * 100) / 100;
}

function defaultStorage() {
    try { return globalThis.localStorage; } catch (_) { return undefined; }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const str = (v, d) => (typeof v === 'string' ? v : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

function normalizePart(id, raw) {
    const d = PART_DEFAULTS[id];
    const r = isObj(raw) ? raw : {};
    const out = { on: bool(r.on, d.on) };
    if (id === 'vocals') out.deviceId = str(r.deviceId, d.deviceId);
    else out.deviceKey = str(r.deviceKey, d.deviceKey);
    if (id === 'guitar') out.arrangement = oneOf(r.arrangement, ARRANGEMENTS, d.arrangement);
    out.difficulty = oneOf(r.difficulty, DIFFICULTIES, d.difficulty);
    if (id === 'drums') out.soundMode = oneOf(r.soundMode, SOUND_MODES, d.soundMode);
    if (id === 'vocals') out.hearMyself = bool(r.hearMyself, d.hearMyself);
    if (id === 'vocals') out.micHitDb = 'micHitDb' in r ? clampMicHitDb(r.micHitDb) : d.micHitDb;
    return out;
}

function normalizeSong(v) {
    if (!isObj(v) || typeof v.filename !== 'string' || !v.filename) return null;
    return { filename: v.filename, title: str(v.title, ''), artist: str(v.artist, '') };
}

function normalizeRecent(v) {
    const out = [];
    const seen = new Set();
    for (const e of Array.isArray(v) ? v : []) {
        const song = normalizeSong(e);
        if (!song || seen.has(song.filename)) continue;
        seen.add(song.filename);
        out.push(song);
        if (out.length >= MAX_RECENT) break;
    }
    return out;
}

const isKind = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(CONTROLLER_KINDS, k);

// Joined controller players, in join order. Drops entries with no string key or a duplicate
// key; an invalid or duplicate id is re-issued (the smallest free ctl<N>); each field falls
// back to its default. playsAs is a registered kind or null (undecided, no part); the part
// must be one of that kind's parts; soundMode is a drum sound mode, default rockband.
function normalizeControllers(v) {
    const seenKeys = new Set();
    const kept = [];
    for (const e of Array.isArray(v) ? v : []) {
        if (!isObj(e) || typeof e.key !== 'string' || !e.key || seenKeys.has(e.key)) continue;
        seenKeys.add(e.key);
        kept.push(e);
    }
    const usedIds = new Set();
    const ids = kept.map((e) => {
        if (!isControllerId(e.id) || usedIds.has(e.id)) return null;
        usedIds.add(e.id);
        return e.id;
    });
    let n = 1;
    return kept.map((e, i) => {
        let id = ids[i];
        if (!id) {
            while (usedIds.has('ctl' + n)) n++;
            id = 'ctl' + n;
            usedIds.add(id);
        }
        const playsAs = isKind(e.playsAs) ? e.playsAs : null;
        const parts = playsAs ? CONTROLLER_KINDS[playsAs].parts : null;
        return {
            key: e.key, id, name: str(e.name, ''), playsAs,
            part: parts ? oneOf(e.part, parts, parts[0]) : null,
            difficulty: oneOf(e.difficulty, DIFFICULTIES, 'medium'),
            lefty: bool(e.lefty, false),
            partAudio: oneOf(e.partAudio, PART_AUDIO_MODES, PART_AUDIO_MODES[0]),
            soundMode: oneOf(e.soundMode, DRUM_SOUND_MODES, 'rockband'),
            on: bool(e.on, true),
        };
    });
}

// Explicit kind choices only, { controllerKey: kindId }; unregistered kinds are dropped.
function normalizeControllerKinds(v) {
    const out = {};
    if (isObj(v)) for (const k of Object.keys(v)) if (isKind(v[k])) out[k] = v[k];
    return out;
}

function normalizeZoom(v) {
    const z = isObj(v) ? v : DEFAULTS.zoom;
    return { guitar: clampZoom(z.guitar), drums: clampZoom(z.drums) };
}

function normalizeSolo(v) {
    const r = isObj(v) ? v : {};
    const d = SOLO_DEFAULTS;
    return {
        instrument: oneOf(r.instrument, SOLO_INSTRUMENTS, d.instrument),
        part: oneOf(r.part, CONTROLLER_KINDS.five_fret.parts, d.part),
        arrangement: oneOf(r.arrangement, ARRANGEMENTS, d.arrangement),
        difficulty: oneOf(r.difficulty, DIFFICULTIES, d.difficulty),
        soundMode: oneOf(r.soundMode, DRUM_SOUND_MODES, d.soundMode),
        crowd: bool(r.crowd, d.crowd),
        failMode: oneOf(r.failMode, FAIL_MODES, d.failMode),
        autoNext: bool(r.autoNext, d.autoNext),
    };
}

function normalizePickFilters(v) {
    const r = isObj(v) ? v : {};
    const out = {};
    for (const k of Object.keys(PICK_FILTER_DEFAULTS)) out[k] = bool(r[k], PICK_FILTER_DEFAULTS[k]);
    return out;
}

// Validates every field; a bad value falls back to that field's default.
export function normalizePrefs(raw) {
    const r = isObj(raw) ? raw : {};
    const parts = isObj(r.parts) ? r.parts : {};
    return {
        split: Number.isFinite(r.split) ? r.split : DEFAULTS.split,
        labelScale: 'labelScale' in r ? clampLabelScale(r.labelScale) : DEFAULTS.labelScale,
        zoom: normalizeZoom(r.zoom),
        parts: {
            guitar: normalizePart('guitar', parts.guitar),
            drums: normalizePart('drums', parts.drums),
            vocals: normalizePart('vocals', parts.vocals),
        },
        failMode: oneOf(r.failMode, FAIL_MODES, 'nofail'),
        // The Rock Band miss clunk for controller players in Rock Band part audio.
        missSound: bool(r.missSound, true),
        fullScreenStage: bool(r.fullScreenStage, true),
        lastSong: normalizeSong(r.lastSong),
        recentSongs: normalizeRecent(r.recentSongs),
        pickFilters: normalizePickFilters(r.pickFilters),
        controllers: normalizeControllers(r.controllers),
        controllerKinds: normalizeControllerKinds(r.controllerKinds),
        // A plain drums / 5-fret play becomes a one-player session (contract §2).
        adoptSolo: bool(r.adoptSolo, true),
        solo: normalizeSolo(r.solo),
    };
}

export function pushRecent(list, song) {
    const rest = (Array.isArray(list) ? list : []).filter((e) => e && e.filename !== song.filename);
    return [{ filename: song.filename, title: song.title, artist: song.artist }, ...rest].slice(0, MAX_RECENT);
}

// One-time move of saved setups from the old Build-a-Band key. Copies the raw
// string verbatim (even if it is not valid JSON) and keeps the old key.
export function migrateLegacyPrefs(storage = defaultStorage()) {
    try {
        if (!storage) return 'none';
        if (storage.getItem(KEY) !== null) return 'present';
        const legacy = storage.getItem(LEGACY_KEY);
        if (typeof legacy !== 'string') return 'none';
        storage.setItem(KEY, legacy);
        return 'migrated';
    } catch (_) { return 'none'; }
}

export function loadPrefs(storage = defaultStorage()) {
    let parsed = null;
    migrateLegacyPrefs(storage);
    try {
        const raw = storage && storage.getItem(KEY);
        parsed = raw ? JSON.parse(raw) : null;
    } catch (_) { /* fall back to defaults */ }
    return normalizePrefs(parsed);
}

export function savePrefs(patch, storage = defaultStorage()) {
    const cur = loadPrefs(storage);
    const p = isObj(patch) ? patch : {};
    const merged = {
        ...cur, ...p, parts: { ...cur.parts },
        zoom: { ...cur.zoom, ...(isObj(p.zoom) ? p.zoom : {}) },
        pickFilters: { ...cur.pickFilters, ...(isObj(p.pickFilters) ? p.pickFilters : {}) },
        solo: { ...cur.solo, ...(isObj(p.solo) ? p.solo : {}) },
    };
    if (isObj(p.parts)) {
        for (const id of Object.keys(p.parts)) {
            if (isObj(p.parts[id])) merged.parts[id] = { ...cur.parts[id], ...p.parts[id] };
        }
    }
    const next = normalizePrefs(merged);
    try {
        if (storage) storage.setItem(KEY, JSON.stringify(next));
    } catch (_) { /* quota / denied: keep in-memory result */ }
    return next;
}
