// Engine events to band score entries (plan 4 R3): note_detect's notedetect:hit/miss, the drums
// plugin's drums:* bus events, the 5-Fret plugin's five_fret:* lane events and karaoke's karaoke:phrase / karaoke:reset. Each returns null for
// an event that isn't the band's. Plan 5 adds the overdrive readers (R12, R18).
const finite = Number.isFinite;
const or = (v, fallback) => (finite(v) ? v : fallback);
const isObject = (v) => typeof v === 'object' && v !== null;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

const DRUM_JUDGMENTS = ['hit', 'miss', 'overhit'];

export function guitarEntry(detail, t) {
    if (!(detail && detail.isDefault === true && detail.counted === true)) return null;
    return {
        part: 'guitar', t, kind: detail.hit ? 'hit' : 'miss',
        points: detail.hit ? or(detail.points, 0) : 0,
        multiplier: or(detail.multiplier, 1), streak: or(detail.streak, 0),
        noteTime: finite(detail.noteTime) ? detail.noteTime : null,
    };
}

// The default detector's onset time (notedetect:onset), for guitar overdrive's Noodle it up.
export function onsetTime(detail) {
    if (!(detail && detail.isDefault === true && finite(detail.t))) return null;
    return detail.t;
}

// A drums lane's judgment on `bandCanvas`, for player `id` (the real drummer, or a
// drums controller's ctl<N>).
export function drumsEntry(type, detail, t, bandCanvas, id = 'drums') {
    if (!(bandCanvas && detail && detail.canvas === bandCanvas && DRUM_JUDGMENTS.includes(type))) return null;
    return {
        part: id, t, kind: type,
        points: type === 'hit' ? or(detail.points, 0) : 0,
        // Star power doubles the drums multiplier; the band multiplier leaves overdrive out (R4).
        multiplier: (or(detail.multiplier, 0) || 1) / (detail.spActive ? 2 : 1),
        streak: detail.combo | 0,
        stars: finite(detail.stars) ? detail.stars : null,
    };
}

// A drum solo's bonus paid on `bandCanvas` (drums:bonus, play layer contract §4), for
// player `id`: points only, so it carries no multiplier or streak.
export function drumsBonusEntry(detail, t, bandCanvas, id = 'drums') {
    if (!(bandCanvas && detail && detail.canvas === bandCanvas && finite(detail.points) && detail.points > 0)) return null;
    return { part: id, t, kind: 'bonus', points: detail.points, reason: typeof detail.reason === 'string' ? detail.reason : null };
}

// A 5-fret lane's band events (five_fret:<type>), for player `id`. The band scores the five-fret
// engine's numbers as they are (Decision 8): points are the engine score's delta since the lane's
// last event, `last = { score, resets }` (null before its first). The engine resets its scoring on
// a seek, which bumps `resets`; the delta then counts from the reset. Two judgments in one frame
// share one score read, so the first carries the whole delta and the second 0.
const FIVE_FRET_KINDS = Object.freeze({ hit: 'hit', miss: 'miss', overstrum: 'overhit', 'sustain-end': 'sustain' });

export function fiveFretEntry(type, detail, t, id, last) {
    if (!Object.prototype.hasOwnProperty.call(FIVE_FRET_KINDS, type) || !isObject(detail)) return null;
    const score = or(detail.score, 0);
    const counted = isObject(last) && last.resets === detail.resets ? or(last.score, 0) : 0;
    return {
        part: id, t, kind: FIVE_FRET_KINDS[type],
        points: Math.max(0, score - counted),
        // Star power doubles the lane multiplier; the band multiplier leaves overdrive out (R4).
        multiplier: (or(detail.multiplier, 0) || 1) / (detail.spActive ? 2 : 1),
        streak: detail.combo | 0,
        noteTime: finite(detail.noteTime) ? detail.noteTime : null,
    };
}

export function vocalsEntry(detail, t) {
    if (!isObject(detail)) return null;
    return {
        part: 'vocals', t, kind: 'phrase',
        points: or(detail.points, 0), multiplier: or(detail.multiplier, 1), streak: or(detail.streak, 0),
        stars: finite(detail.stars) ? detail.stars : null,
        accuracy: or(detail.accuracy, 0),
        rating: typeof detail.rating === 'string' ? detail.rating : null,
        // A phrase passed when karaoke's running phrase streak is still alive after it.
        passed: detail.streak > 0,
    };
}

export function vocalsTotals(detail) {
    if (!isObject(detail)) return null;
    return {
        multiplier: or(detail.multiplier, 1), streak: or(detail.streak, 0),
        stars: finite(detail.stars) ? detail.stars : null,
    };
}

// The drums meter from getInstanceState(canvas).starPower; canActivate kept when it's a boolean.
export function drumsOverdrive(state) {
    const sp = isObject(state) ? state.starPower : null;
    if (!isObject(sp)) return null;
    const od = { fill: clamp01(or(sp.amount, 0)), active: !!sp.active };
    if (typeof sp.canActivate === 'boolean') od.canActivate = sp.canActivate;
    return od;
}

// The vocals meter from karaoke's getOverdrive().
export function vocalsOverdrive(state) {
    if (!isObject(state)) return null;
    return { fill: clamp01(or(state.fill, 0)), active: !!state.active, ready: !!state.ready };
}
