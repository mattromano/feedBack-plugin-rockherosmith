// The Solo screen's rules (plan phase 5): which songs each instrument lists, how a
// picked song is played, whether the instrument is ready, and the next song for
// auto-next. Pure, no DOM; solo-screen.js is the thin DOM layer.
import { DRUM_SOUND_MODES } from './drum-sound.js';
import { guitarArrIndex } from './mappings.js';

// Its own core screen (a `.screen` next to #plugin-rockherosmith), so the band
// screen's device lights and controller joins never run while Solo shows.
export const SOLO_SCREEN_ID = 'plugin-rockherosmith-solo';

export const SOLO_INSTRUMENT_OPTIONS = Object.freeze([
    Object.freeze({ id: 'kit', label: 'Drums (kit)', icon: 'drum' }),
    Object.freeze({ id: 'drums', label: 'Drum controller', icon: 'gamepad-2' }),
    Object.freeze({ id: 'five_fret', label: '5-fret controller', icon: 'gamepad-2' }),
    Object.freeze({ id: 'guitar', label: 'Guitar', icon: 'guitar' }),
]);

const FIVE_FRET_LABELS = Object.freeze({ guitar: 'Lead', rhythm: 'Rhythm', bass: 'Bass' });
const isDrums = (inst) => inst === 'kit' || inst === 'drums';

// The library filter for the picked instrument (core /api/library and library.pick
// params): a drum chart; the 5-fret part (real charts only unless the 5-Fret plugin
// shows auto charts); or the real guitar arrangement.
export function soloLibraryParams(solo, { showAuto = false } = {}) {
    const s = solo || {};
    if (s.instrument === 'five_fret') return { five_fret: showAuto ? s.part : s.part + ':chart' };
    if (s.instrument === 'guitar') return { arrangements_has: s.arrangement };
    return { has_drums: '1' };
}

function filterLabel(s) {
    if (s.instrument === 'five_fret') return '5-fret ' + (FIVE_FRET_LABELS[s.part] || s.part) + ' chart';
    if (s.instrument === 'guitar') return s.arrangement + ' part';
    return 'Drum chart';
}

// The one chip for core's library pick (Browse library): on, with the list's filter.
export function soloPickFilters(solo, opts) {
    const s = solo || {};
    return [{ id: 'solo', label: filterLabel(s), params: soloLibraryParams(s, opts), on: true }];
}

// The list's heading.
export function soloListLabel(solo) {
    const s = solo || {};
    const l = filterLabel(s);
    return 'Songs with a ' + (isDrums(s.instrument) ? 'drum chart' : l);
}

// One page of the filtered library, sorted by artist (core's default sort).
export function libraryUrl(params, { q = '', page = 0, size = 100 } = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (typeof v === 'string' && v) p.set(k, v);
    if (typeof q === 'string' && q.trim()) p.set('q', q.trim());
    p.set('sort', 'artist');
    p.set('page', String(Number.isInteger(page) && page > 0 ? page : 0));
    p.set('size', String(size));
    return '/api/library?' + p.toString();
}

// The real guitar arrangement's index: the exact name (smart name first), else the
// first whose name has the word ("Lead 2"); undefined: core's default arrangement.
function arrangementIndex(arrangements, name) {
    const exact = guitarArrIndex(arrangements, name);
    if (exact !== undefined) return exact;
    const re = new RegExp('\\b' + name + '\\b', 'i');
    const list = Array.isArray(arrangements) ? arrangements : [];
    for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a && re.test(String(a.smart_name || a.name || ''))) return a.index !== undefined ? a.index : i;
    }
    return undefined;
}

// How a picked song plays (contract §1):
//   kit / drum controller / 5-fret -> { via: 'playSolo', item, opts: { kind, part?, difficulty } }
//   real guitar -> { via: 'playSongAs', item, filename, opts: { arrangement?, resetView: true } }
// null without a file.
export function soloPlayRequest(solo, item) {
    if (!item || typeof item.filename !== 'string' || !item.filename) return null;
    const s = solo || {};
    if (s.instrument === 'guitar') {
        const arrangement = arrangementIndex(item.arrangements, s.arrangement);
        const opts = Number.isInteger(arrangement) ? { arrangement, resetView: true } : { resetView: true };
        return { via: 'playSongAs', item, filename: item.filename, opts };
    }
    const opts = { kind: s.instrument };
    if (s.instrument === 'five_fret') opts.part = s.part;
    opts.difficulty = s.difficulty;
    return { via: 'playSolo', item, opts };
}

// Whether the picked instrument can play now. env: { checking?, drums?, fiveFret?,
// midi?: { connected, name } | null, controller?: { name } | null }.
// -> { ok, message, controls: 'drums' | 'five_fret' | null, checking? }
// controls: the plugin whose controls screen fixes it (openControls).
export function soloAvailability(solo, env = {}) {
    const inst = (solo || {}).instrument;
    const e = env || {};
    if (inst === 'guitar') return { ok: true, message: '', controls: null };
    if (e.checking) return { ok: false, checking: true, message: 'Looking for your instrument…', controls: null };
    if (isDrums(inst) && !e.drums) {
        return { ok: false, message: 'The Drums plugin isn\'t installed, so drums can\'t play.', controls: null };
    }
    if (inst === 'five_fret' && !e.fiveFret) {
        return { ok: false, message: 'The 5-Fret plugin isn\'t installed, so 5-fret can\'t play.', controls: null };
    }
    if (inst === 'kit') {
        const m = e.midi;
        if (m && m.connected) return { ok: true, message: 'MIDI kit: ' + (m.name || 'connected'), controls: null };
        return {
            ok: false, controls: 'drums',
            message: 'No MIDI kit connected. Plug in your kit, or pick it in the Drums controls.',
        };
    }
    const c = e.controller;
    if (c) {
        const what = inst === 'drums' ? 'Drum controller' : '5-fret controller';
        return { ok: true, message: c.name ? what + ': ' + c.name : '', controls: null };
    }
    return inst === 'drums'
        ? { ok: false, controls: 'drums', message: 'No drum controller connected. Connect one, or set it up in the Drums controls.' }
        : { ok: false, controls: 'five_fret', message: 'No 5-fret controller connected. Connect one, or set it up in the 5-Fret controls.' };
}

// Auto-next: the song after `filename` in the list, or null (the end, or not listed).
export function nextSoloItem(list, filename) {
    const l = Array.isArray(list) ? list : [];
    const i = l.findIndex((it) => it && it.filename === filename);
    return i >= 0 && i + 1 < l.length ? l[i + 1] : null;
}

// The choices each instrument shows. Real guitar plays at core's own mastery, so it
// has no difficulty; the drum sound applies to drums only.
export function soloFields(instrument) {
    return {
        part: instrument === 'five_fret',
        arrangement: instrument === 'guitar',
        difficulty: instrument !== 'guitar',
        soundMode: isDrums(instrument),
    };
}

// The drum sound the screen shows: the kit plays with the real drummer's saved sound
// (parts.drums.soundMode); a drum controller solo with prefs.solo.soundMode.
export function soloSoundMode(prefs, instrument) {
    const p = prefs || {};
    if (instrument === 'kit') return p.parts && p.parts.drums ? p.parts.drums.soundMode : 'song';
    return p.solo ? p.solo.soundMode : 'rockband';
}

export function soloSoundModePatch(instrument, mode) {
    if (!DRUM_SOUND_MODES.includes(mode)) return null;
    if (instrument === 'kit') return { parts: { drums: { soundMode: mode } } };
    if (instrument === 'drums') return { solo: { soundMode: mode } };
    return null;
}
