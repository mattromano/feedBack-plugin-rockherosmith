// Drum sound modes (plan 6 R2, R5, R16; play layer contract §6): a pure state machine
// for whether the song's drum stem should be muted. 'song' (Song + pads) never mutes,
// 'kit' (Kit only) always does, and 'rockband' (Rock Band) drops out on a miss or
// overhit and returns on the next hit or a seek; with no drum stem, Rock Band muffles
// the full mix instead (stem-sound.js), and its pads are silent (padsMuted).
// `judge` and `seek` return whether the wanted state changed; the runtime turns a
// change into one claim operation. Nothing here touches audio.
export const DRUM_SOUND_MODES = ['song', 'rockband', 'kit'];
// The modes' names (contract §6), for every UI that shows them.
export const DRUM_SOUND_MODE_LABELS = Object.freeze({ rockband: 'Rock Band', song: 'Song + pads', kit: 'Kit only' });
// The order every UI lists them in (contract §6).
export const DRUM_SOUND_MODE_ORDER = Object.freeze(['rockband', 'song', 'kit']);

// Rock Band plays without pad sounds: the drums plugin's pads are muted while every
// drums player (the real drummer and drums controllers) is in Rock Band. A band
// with any drummer on another mode keeps them (the pad mute is the plugin's, global).
export function padsMuted(modes) {
    const list = Array.isArray(modes) ? modes : [];
    return list.length > 0 && list.every((m) => m === 'rockband');
}

// The Rock Band drop-out rule, shared with the controllers' part audio
// (stem-sound.js): a miss, an overhit or an overstrum drops out, a hit comes
// back, anything else leaves `dropped` as it is.
export function dropoutStep(dropped, kind) {
    if (kind === 'miss' || kind === 'overhit' || kind === 'overstrum') return true;
    if (kind === 'hit') return false;
    return dropped;
}

export function createDrumSound(mode) {
    const m = DRUM_SOUND_MODES.includes(mode) ? mode : 'song';
    let muted = m === 'kit';
    const set = (next) => {
        if (next === muted) return false;
        muted = next;
        return true;
    };
    return {
        mode: m,
        muted: () => muted,
        judge(type) {
            return m === 'rockband' ? set(dropoutStep(muted, type)) : false;
        },
        seek() {
            return m === 'rockband' ? set(false) : false;
        },
    };
}
