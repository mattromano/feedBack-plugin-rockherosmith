// The play layer's events out (play layer contract §3): the payloads of
// play:judgment (every ledger record) and play:result (once, when the results
// open). Pure: the runtime emits them on core's bus. No DOM.
import { isControllerId } from './controller-model.js';

const finite = Number.isFinite;
const num = (v, d) => (finite(v) ? v : d);

// Unique per started or adopted session.
export function sessionIdFor(now, n) {
    return 'rhs-' + Math.floor(num(now, 0)).toString(36) + '-' + (n | 0).toString(36);
}

// Who a player id is: { player, instrument, part, input, difficulty }.
export function playerInfo(id, prefs) {
    const parts = (prefs && prefs.parts) || {};
    if (isControllerId(id)) {
        const c = ((prefs && prefs.controllers) || []).find((x) => x && x.id === id) || {};
        const drums = c.playsAs === 'drums';
        return {
            player: id,
            instrument: drums ? 'drums' : (c.playsAs === 'five_fret' ? 'five_fret' : null),
            part: drums ? 'drums' : (typeof c.part === 'string' ? c.part : null),
            input: 'controller',
            difficulty: typeof c.difficulty === 'string' ? c.difficulty : null,
        };
    }
    const p = parts[id] || {};
    const difficulty = typeof p.difficulty === 'string' ? p.difficulty : null;
    if (id === 'guitar') {
        const arr = typeof p.arrangement === 'string' && p.arrangement ? p.arrangement : 'Lead';
        return { player: id, instrument: 'guitar', part: arr.toLowerCase(), input: 'audio', difficulty };
    }
    if (id === 'drums') return { player: id, instrument: 'drums', part: 'drums', input: 'kit', difficulty };
    if (id === 'vocals') return { player: id, instrument: 'vocals', part: 'vocals', input: 'mic', difficulty };
    return { player: id, instrument: null, part: null, input: null, difficulty };
}

// play:judgment for one recorded ledger entry. points: what the ledger scores
// (points x factor). totals: the part's { multiplier, streak } after the entry,
// for entries that carry none (a deploy, a bonus).
export function judgmentEvent({ filename, sessionId, entry, info, totals }) {
    const e = entry || {};
    const tot = totals || {};
    return {
        filename, sessionId,
        player: info.player, instrument: info.instrument, part: info.part, input: info.input,
        kind: e.kind,
        points: Math.round(num(e.points, 0) * num(e.factor, 1)),
        multiplier: num(e.multiplier, num(tot.multiplier, 1)),
        streak: num(e.streak, num(tot.streak, 0)),
        t: num(e.t, 0),
        noteTime: finite(e.noteTime) ? e.noteTime : null,
    };
}

// play:result from the band score snapshot. arrangements: { playerId: arrangement
// index loaded } (missing: null); proDrums: { playerId: pro cymbals in effect } (drums
// players only; missing: false). failed: the player dropped out in fail mode at any
// point (rescued or not). practice: the session looped or slowed down (practice.js).
// difficulties: { playerId: difficulty at song end } where it differs from the prefs'.
// sections: { playerId: [{ name, start, end, hits, misses, accuracy }] } (sections.js).
export function resultEvent({ filename, sessionId, snapshot, prefs, arrangements = {}, proDrums = {}, difficulties = {}, practice = false, sections = {}, durationSec }) {
    const parts = (snapshot && snapshot.parts) || {};
    const players = Object.keys(parts).map((id) => {
        const p = parts[id];
        const info = playerInfo(id, prefs);
        const hits = num(p.hits, 0);
        const misses = num(p.misses, 0);
        const overhits = num(p.overhits, 0);
        const judged = hits + misses;
        return {
            ...info,
            difficulty: typeof difficulties[id] === 'string' ? difficulties[id] : info.difficulty,
            arrangement: Number.isInteger(arrangements[id]) ? arrangements[id] : null,
            score: num(p.score, 0) + num(p.bonus, 0),
            stars: finite(p.stars) ? p.stars : null,
            accuracy: judged ? hits / judged : 0,
            hits, misses, overhits,
            bestStreak: num(p.bestStreak, 0),
            fullCombo: hits > 0 && misses === 0 && overhits === 0,
            proDrums: info.instrument === 'drums' && proDrums[id] === true,
            failed: p.failed === true || num(p.drops, 0) > 0,
            sections: (Array.isArray(sections && sections[id]) ? sections[id] : []).map((x) => ({ ...x })),
        };
    });
    return {
        filename, sessionId, band: players.length > 1, practice: practice === true,
        players, durationSec: num(durationSec, 0),
    };
}
