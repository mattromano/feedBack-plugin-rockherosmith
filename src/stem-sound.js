// Part audio for controller players (Plan 3 Decision 10): a pure state machine for
// which song stems the band wants muted, one rule per stem. Nothing here touches
// audio; the runtime turns each changed stem into one claim operation.
//   - A stem drops on a miss or overstrum only when every player on it is a
//     controller set to Rock Band; an active controller's hit on it, or any seek,
//     brings it back. An Always play controller or a real part keeps it playing.
//   - Fail: a stem mutes when every player on it has failed out and at least one
//     of them is a controller (real parts alone keep their own fail claims). A
//     rescue clears that, and the stem's drop-out with it.
//   - Failed players' judgments never move a stem.
// Drummers (Plan 6 Decision 14, Ruling 9):
//   - A drums controller set to My kit only is a `kit` member. A stem whose players
//     are all `kit` controllers is muted all song, and ignores judgments and seeks.
//     Rock Band and My kit only controllers share drop-outs: any one's miss or
//     overhit drops the stem, any one's hit brings it back.
//   - A real drummer on the drums stem owns it: its v1 sound mode and fail claim
//     govern the stem, and this machine never mutes it.
// The full mix (an unsplit song: no stems, or only the `full` stem):
//   - With `fullMix`, every player with no stem of its own is on FULL_MIX, a
//     stem like any other: the same drop, restore and fail rules, so a real part
//     or an Always play controller on it keeps the song playing. The runtime
//     muffles the whole song for it instead of muting a stem.
//   - My kit only has no stem on an unsplit song, so it plays as Song drums
//     (as the band screen shows it): a kit member keeps the full mix playing.
//   - The real drummer in Rock Band with no drum stem (play layer contract §6) is a
//     `dropout` member: on the full mix it drops and restores like a Rock Band
//     controller, but its fail never mutes the mix (its own fail claim rules).
import { dropoutStep } from './drum-sound.js';

// The pseudo stem id of the whole song's mix (never a stems id).
export const FULL_MIX = '@full-mix';

// Whether a song plays one unsplit mix: no stems, or only the `full` stem.
export function isUnsplit(stemIds) {
    const ids = Array.isArray(stemIds) ? stemIds.filter((id) => typeof id === 'string') : [];
    return ids.every((id) => id.toLowerCase() === 'full');
}

// createStemSound({ members: [{ id, stemId, controller, dropout?, mode: 'rockband'|'always'|'kit'|'song' }], fullMix })
// Members with no stemId are ignored, or with fullMix put on FULL_MIX. judge,
// setFailed and seek return the stem ids whose muted() changed.
export function createStemSound({ members, fullMix = false } = {}) {
    // stemId -> { players: member[], rockband: bool (drops), kit: bool (muted all song), dropped: bool }
    const stems = new Map();
    const stemOf = new Map();
    for (const m of Array.isArray(members) ? members : []) {
        if (!m) continue;
        const own = typeof m.stemId === 'string' && m.stemId ? m.stemId : null;
        const stemId = own || (fullMix === true ? FULL_MIX : null);
        if (!stemId) continue;
        if (!stems.has(stemId)) stems.set(stemId, { players: [], rockband: true, kit: stemId !== FULL_MIX, dropped: false });
        const st = stems.get(stemId);
        st.players.push(m);
        const ctl = m.controller === true;
        // A real drummer's Rock Band, on the full mix only (it owns a drum stem).
        const drops = ctl || (m.dropout === true && stemId === FULL_MIX);
        const mode = stemId === FULL_MIX && m.mode === 'kit' ? 'always' : m.mode;
        if (!(drops && (mode === 'rockband' || mode === 'kit'))) st.rockband = false;
        if (!(ctl && mode === 'kit')) st.kit = false;
        if (drops) stemOf.set(m.id, stemId);
    }
    // The real drummer's stem is left alone (Ruling 9).
    for (const [stemId, st] of stems) {
        if (stemId === 'drums' && st.players.some((m) => m.controller !== true)) stems.delete(stemId);
    }
    let failed = new Set();
    const failMuted = (st) => st.players.every((m) => failed.has(m.id)) && st.players.some((m) => m.controller === true);
    const isMuted = (st) => st.kit || failMuted(st) || (st.rockband && st.dropped);
    // Runs `change` and returns the stems whose muted() moved.
    const changes = (change) => {
        const before = new Map([...stems].map(([id, st]) => [id, isMuted(st)]));
        change();
        return [...stems].filter(([id, st]) => isMuted(st) !== before.get(id)).map(([id]) => id);
    };
    return {
        stems: () => [...stems.keys()],
        muted: (stemId) => { const st = stems.get(stemId); return !!st && isMuted(st); },
        judge(id, kind) {
            const st = stems.get(stemOf.get(id));
            if (!st || failed.has(id) || !st.rockband || st.kit) return [];
            return changes(() => { st.dropped = dropoutStep(st.dropped, kind); });
        },
        setFailed(ids) {
            return changes(() => {
                const next = new Set(Array.isArray(ids) ? ids : []);
                for (const st of stems.values()) {
                    if (st.players.some((m) => failed.has(m.id) && !next.has(m.id))) st.dropped = false;
                }
                failed = next;
            });
        },
        seek() {
            return changes(() => { for (const st of stems.values()) st.dropped = false; });
        },
    };
}
