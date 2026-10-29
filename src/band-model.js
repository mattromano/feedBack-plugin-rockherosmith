// Band screen view model and the Go key test. Pure, no DOM: band-screen.js
// renders whatever this returns.
import { PART_TYPES, hasChart, songFacts, controllerPartFor } from './parts.js';
import { stemIdFor } from './stem-claims.js';
import { isUnsplit } from './stem-sound.js';
import { guitarArrIndex } from './mappings.js';

const UNAVAILABLE_NOTE = {
    guitar: 'No guitar part in this song',
    drums: 'No drum chart for this song',
    vocals: 'No vocal pitch for this song',
};
const KARAOKE_OFF_NOTE = 'Turn on the Lyrics Karaoke plugin to sing';
const SOUND_MODES_NOTE = 'Rock Band and Kit only need a drum stem';
// An unsplit song: Rock Band muffles the whole song, Kit only has no stem.
const KIT_NOTE = 'Kit only needs a drum stem';
// A real drummer owns the drum stem (Ruling 9): a drums controller's Sound doesn't apply.
const REAL_DRUMMER_SOUND_NOTE = "The drummer's sound mode sets the drum stem";
// Guitar scores through note_detect, which the band turns on with an input picked.
const NOTE_DETECT_OFF_NOTE = 'Turn on Note Detection to score your guitar';
const PICK_GUITAR_INPUT_NOTE = 'Pick an input to score your guitar';
// The chartFrom fallback order (parts.js).
const GUITAR_ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass'];

// The drum sound modes a song's stems can't play (contract §6), for the real drummer
// and drums controllers alike: Kit only needs a drum stem; Rock Band needs a drum
// stem, or an unsplit song (no stems, or only `full`), whose whole mix it muffles.
// A greyed mode plays as Song + pads.
export function soundModesOff(stemIds) {
    const ids = Array.isArray(stemIds) ? stemIds : [];
    if (ids.includes('drums')) return [];
    return isUnsplit(ids) ? ['kit'] : ['rockband', 'kit'];
}

// bandScreenModel({ prefs, item, vocalsSupported, noteDetectLoaded, pickAvailable })
//   -> { goEnabled, goHint, pickEnabled, setupHint, columns: { guitar, drums, vocals } }
// A column is unavailable only when a song is picked and has no chart for it;
// the stored part settings are never changed here. Vocals is also unavailable
// (with or without a song) when the Lyrics Karaoke plugin isn't loaded. An
// available guitar part that is on notes what it needs to score. The guitar
// column also says which arrangements the song has and the one that will play.
// Setup shows setupHint (the library pick needs core's hook and a part on);
// Confirm shows goHint.
export function bandScreenModel({
    prefs, item, vocalsSupported = true, noteDetectLoaded = true, pickAvailable = true,
    fiveFretLoaded = false, drumsLoaded = false, controllerStatus = { available: false, reason: null, connected: new Set() }, showAuto = false,
}) {
    const parts = (prefs && prefs.parts) || {};
    const columns = {};
    for (const part of PART_TYPES) {
        const pp = parts[part.id] || {};
        const noKaraoke = part.id === 'vocals' && !vocalsSupported;
        const unavailable = noKaraoke || (!!item && !hasChart(part, item, pp));
        const col = { on: !!pp.on, unavailable, note: unavailable ? (noKaraoke ? KARAOKE_OFF_NOTE : UNAVAILABLE_NOTE[part.id]) : '' };
        if (part.id === 'drums') {
            const ids = item ? songFacts(item).stemIds : null;
            col.soundModeDisabled = ids ? soundModesOff(ids) : [];
            col.soundModesDisabled = col.soundModeDisabled.length > 0;
            if (!unavailable && col.soundModesDisabled) col.note = isUnsplit(ids) ? KIT_NOTE : SOUND_MODES_NOTE;
            // The mode that will play: a greyed one plays Song + pads.
            const stored = pp.soundMode || 'song';
            col.soundMode = col.soundModeDisabled.includes(stored) ? 'song' : stored;
        }
        if (part.id === 'guitar') {
            const facts = songFacts(item);
            col.arrangements = {};
            for (const n of GUITAR_ARRANGEMENTS) {
                col.arrangements[n] = !item || (!facts.fiveFretOnly && guitarArrIndex(facts.arrangements, n) !== undefined);
            }
            const stored = pp.arrangement || 'Lead';
            col.arrangement = col.arrangements[stored] ? stored
                : (GUITAR_ARRANGEMENTS.find((n) => col.arrangements[n]) || stored);
        }
        if (part.id === 'guitar' && !unavailable && col.on) {
            if (!noteDetectLoaded) col.note = NOTE_DETECT_OFF_NOTE;
            else if (!pp.deviceKey) col.note = PICK_GUITAR_INPUT_NOTE;
        }
        columns[part.id] = col;
    }
    const controllers = controllerRows({ prefs, item, fiveFretLoaded, drumsLoaded, controllerStatus, showAuto, realDrumsOn: !!(parts.drums && parts.drums.on) });
    const playable = (c) => c.on && !c.unavailable;
    const controllerPlays = (c) => c.on && !c.unavailable;
    const goEnabled = !!item && (['guitar', 'drums', 'vocals'].some((id) => playable(columns[id]))
        || controllers.some(controllerPlays));
    let goHint = 'Press Space or hit any pad to start';
    if (!item) goHint = 'Pick a song';
    else if (!goEnabled) goHint = 'Turn on a part';
    const anyOn = ['guitar', 'drums', 'vocals'].some((id) => !!(parts[id] && parts[id].on) && (id !== 'vocals' || vocalsSupported));
    // A controller counts for the pick once it is on, connected and its plugin is there.
    const anyController = controllers.some((c) => c.on && c.connected && c.available && c.playsAs);
    const pickEnabled = !!pickAvailable && (anyOn || anyController);
    let setupHint = '';
    if (!pickAvailable) setupHint = 'Update feedBack to pick songs here';
    else if (!pickEnabled) setupHint = 'Turn on a part';
    return { goEnabled, goHint, pickEnabled, setupHint, columns, controllers };
}

const CONTROLLER_NOTES = {
    disconnected: 'Not connected',
    noChart: 'No 5-fret chart for this song',
    noDrumChart: UNAVAILABLE_NOTE.drums,
    chooseKind: 'Choose 5-Fret or Drums',
    noFiveFret: 'Install the 5-Fret plugin to play on a controller',
    noDrums: 'Install the Drums plugin to play on a controller',
    noPlugins: 'Install the 5-Fret or Drums plugin to play on a controller',
};
const FIVE_FRET_INSTRUMENTS = ['guitar', 'rhythm', 'bass'];

// One row per joined controller, in join order. `playsAs` is the kind it plays (null =
// undecided: it sits out, its part fields are null and it never counts for Go or the pick).
// `kinds` is what it could play, from controllerStatus.kinds (a Map of key -> kinds; the
// default is the row's own playsAs, or none while undecided); `standard` says the pad has
// the standard mapping (controllerStatus.standard), so X / B answer plays-as. `parts[p]`
// is what the song has for p (a real chart beats an auto one; auto counts only with
// showAuto) and who else holds p; `part` is the one that will play (the stored part when the song has it, else a
// fallback). A drums row's `soundMode` is the one that will play: a greyed mode plays
// Song + pads, and soundModeDisabled lists the greyed ones (soundModesOff).
function controllerRows({ prefs, item, fiveFretLoaded, drumsLoaded, controllerStatus, showAuto, realDrumsOn }) {
    const list = ((prefs && prefs.controllers) || []).filter(Boolean);
    const status = controllerStatus || {};
    const connected = status.connected instanceof Set ? status.connected : new Set(status.connected || []);
    const kindsByKey = status.kinds instanceof Map ? status.kinds : new Map();
    const standard = status.standard instanceof Set ? status.standard : new Set(status.standard || []);
    const loaded = { five_fret: !!fiveFretLoaded, drums: !!drumsLoaded };
    const anyLoaded = loaded.five_fret || loaded.drums;
    const facts = item ? songFacts(item).fiveFret.filter((p) => showAuto || p.kind !== 'auto') : null;
    // An unsplit song (no stems, or only `full`): Rock Band part audio muffles the whole mix.
    const unsplit = !!item && isUnsplit(songFacts(item).stemIds);
    const effective = (c) => {
        if (!c.playsAs) return null;
        if (!item) return c.part;
        const hit = controllerPartFor(item, c, { showAuto });
        return hit ? hit.instrument : null;
    };
    const sits = (o) => o.on !== false && !!o.playsAs;
    return list.map((c) => {
        const playsAs = c.playsAs || null;
        const isConnected = connected.has(c.key);
        const kinds = kindsByKey.has(c.key) ? kindsByKey.get(c.key) : (playsAs ? [playsAs] : []);
        const available = (playsAs ? loaded[playsAs] : anyLoaded) && status.available !== false;
        const part = effective(c);
        let parts = null;
        if (playsAs) {
            parts = {};
            for (const inst of FIVE_FRET_INSTRUMENTS) {
                const mine = facts ? facts.filter((p) => p.instrument === inst) : null;
                const kind = !mine || !mine.length ? null : (mine.some((p) => p.kind !== 'auto') ? 'chart' : 'auto');
                parts[inst] = {
                    has: !mine || mine.length > 0, kind,
                    takenBy: list.filter((o) => o !== c && sits(o) && o.playsAs === 'five_fret' && effective(o) === inst).map((o) => o.name),
                };
            }
            const chart = item ? !!controllerPartFor(item, { playsAs: 'drums' }) : true;
            parts.drums = {
                has: chart, kind: item ? (chart ? 'chart' : null) : null,
                takenBy: [
                    ...list.filter((o) => o !== c && sits(o) && o.playsAs === 'drums').map((o) => o.name),
                    ...(realDrumsOn ? ['Drums'] : []),
                ],
            };
        }
        const isDrums = playsAs === 'drums';
        const stemId = !isDrums && item && part ? stemIdFor('five_fret', { part }, songFacts(item).stemIds) : null;
        const partAudioDisabled = !isDrums && !!item && !!part && !stemId && !unsplit;
        const soundModeDisabled = isDrums && item ? soundModesOff(songFacts(item).stemIds) : [];
        const storedMode = c.soundMode || 'rockband';
        const soundMode = soundModeDisabled.includes(storedMode) ? 'song' : storedMode;
        let note = '';
        if (!available) {
            if (!anyLoaded) note = CONTROLLER_NOTES.noPlugins;
            else if (playsAs && !loaded[playsAs]) note = isDrums ? CONTROLLER_NOTES.noDrums : CONTROLLER_NOTES.noFiveFret;
            else note = status.reason || CONTROLLER_NOTES.noPlugins;
        } else if (!isConnected) note = CONTROLLER_NOTES.disconnected;
        else if (!playsAs) note = CONTROLLER_NOTES.chooseKind;
        else if (item && !part) note = isDrums ? CONTROLLER_NOTES.noDrumChart : CONTROLLER_NOTES.noChart;
        else if (partAudioDisabled) note = 'Part audio needs a ' + part + ' stem';
        else if (isDrums && soundModeDisabled.includes(storedMode)) note = unsplit ? KIT_NOTE : SOUND_MODES_NOTE;
        else if (isDrums && realDrumsOn) note = REAL_DRUMMER_SOUND_NOTE;
        const unavailable = !available || !isConnected || !playsAs || (!!item && !part);
        return {
            key: c.key, id: c.id, name: c.name, on: c.on !== false, available, connected: isConnected, unavailable, note,
            kinds, playsAs, standard: standard.has(c.key), part: playsAs ? (part || c.part) : null, parts, partAudio: c.partAudio, partAudioDisabled,
            soundMode, soundModeDisabled,
            difficulty: c.difficulty, lefty: !!c.lefty,
        };
    });
}

const TEXT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

// Space starts the song, unless it is a key repeat or the user is typing.
export function isGoKey(event, activeElement) {
    const e = event || {};
    if (e.repeat) return false;
    if (e.code !== 'Space' && e.key !== ' ') return false;
    const a = activeElement;
    if (a && (TEXT_TAGS.includes(String(a.tagName || '').toUpperCase()) || a.isContentEditable)) return false;
    return true;
}
