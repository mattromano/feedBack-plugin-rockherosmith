// What the results screen shows (plan 4 R17): pure, from a band score snapshot. No DOM.
// Stream B3 adds each card's sections and the run history: historyView is pure;
// createHistoryLoader fetches it through the getJson and bus it is given.
import { PART_TYPES } from './parts.js';
import { worstSections } from './sections.js';
import { playerStyle } from './players.js';
import { starDisplay } from './stars.js';
import { formatScore, difficultyLabel } from './hud-model.js';
import { isControllerId } from './controller-model.js';

const NAMES = { drums: 'Drums', vocals: 'Vocals' };
const FALLBACK_AWARDS = { guitar: 'Riff keeper', drums: 'Held it down', vocals: 'Big voice', five_fret: 'Held the frets', drums_controller: 'Held it down' };
// Flawless and Most accurate both need this many judgments.
const ACCURACY_MIN_JUDGED = 20;
const STREAK_AWARD_MIN = 10;

const num = (v) => (Number.isFinite(v) ? v : 0);

function partName(id, partPrefs) {
    if (id !== 'guitar') return NAMES[id] || id;
    const arr = partPrefs && typeof partPrefs.arrangement === 'string' && partPrefs.arrangement ? partPrefs.arrangement : 'Lead';
    return 'Guitar · ' + arr;
}

function notesHit(p) {
    return formatScore(num(p.hits)) + ' / ' + formatScore(num(p.hits) + num(p.misses));
}

function baseStats(id, p, drumsExtra, sourceKind, drumsController) {
    const score = ['Score', formatScore(num(p.score))];
    if (id === 'vocals') {
        // Ratings are karaoke's own strings, ordered by mean phrase accuracy (R3, R17).
        const phrases = (Array.isArray(p.phrases) ? p.phrases : [])
            .filter((r) => r && typeof r.rating === 'string')
            .sort((a, b) => num(b.meanAccuracy) - num(a.meanAccuracy))
            .map((r) => formatScore(num(r.count)) + ' ' + r.rating);
        return [score, ['Phrases', phrases.length ? phrases.join(' · ') : '—'],
            ['Best run', formatScore(num(p.bestStreak)) + ' phrases']];
    }
    const stats = [score, ['Best streak', formatScore(num(p.bestStreak))], ['Notes hit', notesHit(p)]];
    if (isControllerId(id)) {
        stats.push([drumsController ? 'Overhits' : 'Overstrums', formatScore(num(p.overhits))]);
        if (sourceKind === 'auto' && !drumsController) stats.push(['Chart', 'Auto']);
    }
    if (id === 'guitar') stats.push(['Band bonus', formatScore(num(p.bonus))]);
    if (id === 'drums') {
        stats.push(['Overhits', formatScore(num(p.overhits))]);
        if (drumsExtra && Number.isFinite(drumsExtra.phrasesHit) && Number.isFinite(drumsExtra.phrasesTotal)) {
            stats.push(['Star power phrases', formatScore(drumsExtra.phrasesHit) + ' / ' + formatScore(drumsExtra.phrasesTotal)]);
        }
    }
    return stats;
}

// Plan 5 R22: every card adds its overdrive and drop-out counts, only when above 0.
function partStats(id, p, drumsExtra, sourceKind, drumsController) {
    const stats = baseStats(id, p, drumsExtra, sourceKind, drumsController);
    if (num(p.deploys) > 0) stats.push(['Overdrives', formatScore(num(p.deploys))]);
    if (num(p.drops) > 0) stats.push(['Dropped out', formatScore(num(p.drops))]);
    return stats;
}

// The card holding the unique highest finite value of `get`, or null on a tie or none.
function uniqueTop(cards, get) {
    let best = null;
    let top = -Infinity;
    let ties = 0;
    for (const c of cards) {
        const v = get(c);
        if (!Number.isFinite(v)) continue;
        if (v > top) { top = v; best = c; ties = 1; } else if (v === top) ties++;
    }
    return ties === 1 ? best : null;
}

// One award per card, in R17's priority order. Cards carry `accuracy` (0-1 or null),
// `judged` and `bestStreak`.
export function pickAwards(cards) {
    const list = Array.isArray(cards) ? cards : [];
    const band = list.length >= 2;
    const streakTop = band ? uniqueTop(list, (c) => c.bestStreak) : null;
    const streakCard = streakTop && streakTop.bestStreak >= STREAK_AWARD_MIN ? streakTop : null;
    const accurateCard = band ? uniqueTop(list, (c) => (num(c.judged) >= ACCURACY_MIN_JUDGED && c.accuracy > 0 ? c.accuracy : null)) : null;
    return list.map((c) => {
        if (c.accuracy === 1 && num(c.judged) >= ACCURACY_MIN_JUDGED) return 'Flawless';
        if (c === streakCard) return 'Best streak in the band';
        if (c === accurateCard) return 'Most accurate';
        // A part that scored nothing gets no award (plan 7 R17).
        return num(c.score) > 0 ? FALLBACK_AWARDS[c.kind || c.part] || '' : '';
    });
}

// One results row per judged section: its percent, and whether it is one of the worst.
function sectionRows(list) {
    const rows = Array.isArray(list) ? list.filter((x) => x && Number.isFinite(x.accuracy)) : [];
    const worst = new Set(worstSections(rows));
    return rows.map((x, i) => ({ name: String(x.name || ''), start: x.start, end: x.end, pct: Math.round(x.accuracy * 100), worst: worst.has(i) }));
}

// resultsModel({ snapshot, prefs, song: {title, artist}, oneLevel, drumsExtra: {phrasesHit, phrasesTotal} | null,
//   failed, controllerInfo: { [id]: { sourceKind } } }) -> { stars, starDisplay, score, title, subtitle, failed, heading, cards }
// One card per part that is on and in the snapshot, in part order (guitar, drums, vocals).
// sections: { id: play:result sections (sections.js) }; each card gets
// sections: [{ name, start, end, pct, worst }], the worst flagged (worstSections).
export function resultsModel({ snapshot, prefs, song, oneLevel, drumsExtra, failed = false, controllerInfo = {}, sections = {} }) {
    const snap = snapshot || {};
    const parts = snap.parts || {};
    const pp = (prefs && prefs.parts) || {};
    const s = song || {};
    const text = (v) => (typeof v === 'string' ? v : '');
    const cards = [];
    for (const type of PART_TYPES) {
        const id = type.id;
        const p = parts[id];
        if (!p || !(pp[id] && pp[id].on)) continue;
        const accuracy = Number.isFinite(p.accuracy) ? p.accuracy : null;
        cards.push({
            part: id,
            name: partName(id, pp[id]),
            difficulty: id === 'guitar' && oneLevel ? 'One level' : difficultyLabel(pp[id].difficulty),
            color: type.color,
            icon: type.icon,
            accuracy,
            accuracyPct: accuracy === null ? null : Math.round(accuracy * 100),
            judged: num(p.hits) + num(p.misses),
            score: num(p.score),
            bestStreak: num(p.bestStreak),
            stats: partStats(id, p, drumsExtra),
            sections: sectionRows(sections && sections[id]),
            award: '',
        });
    }
    // Then one card per controller player in the snapshot, in join order.
    const info = controllerInfo || {};
    for (const c of Array.isArray(prefs && prefs.controllers) ? prefs.controllers : []) {
        const p = c && parts[c.id];
        if (!p || c.on === false) continue;
        const sourceKind = info[c.id] && info[c.id].sourceKind;
        const style = playerStyle(c.id, prefs);
        const drumsController = c.playsAs === 'drums';
        const accuracy = Number.isFinite(p.accuracy) ? p.accuracy : null;
        cards.push({
            part: c.id,
            kind: drumsController ? 'drums_controller' : c.playsAs || 'five_fret',
            name: style.name,
            subname: typeof c.name === 'string' ? c.name : '',
            difficulty: difficultyLabel(c.difficulty),
            color: style.color,
            icon: style.icon,
            accuracy,
            accuracyPct: accuracy === null ? null : Math.round(accuracy * 100),
            judged: num(p.hits) + num(p.misses),
            score: num(p.score),
            bestStreak: num(p.bestStreak),
            stats: partStats(c.id, p, drumsExtra, sourceKind, drumsController),
            sections: sectionRows(sections && sections[c.id]),
            award: '',
        });
    }
    pickAwards(cards).forEach((award, i) => { cards[i].award = award; });
    const stars = Number.isFinite(snap.stars) ? snap.stars : null;
    return {
        stars,
        starDisplay: starDisplay(stars),
        score: num(snap.score),
        title: text(s.title),
        subtitle: [text(s.title), text(s.artist)].filter(Boolean).join(' · '),
        failed: !!failed,
        heading: failed ? 'Band failed' : '',
        cards,
    };
}

// ── Run history and bests (stream B3; core's GET /api/stats/history, A5) ──

const HISTORY_LIMIT = 5;
const RECENT_MAX = 4;

// The part key core's stats recorder posts a play:result player under:
// the instrument when the part is empty or the same, else 'instrument:part'.
// Real guitar (recorded by note detection, not by part) has none here.
export function historyPart(player) {
    const inst = String((player && player.instrument) || '').toLowerCase();
    const part = String((player && player.part) || '').toLowerCase();
    if (!inst || inst === 'guitar') return null;
    return !part || part === inst ? inst : inst + ':' + part;
}

export function historyUrl(filename, player, limit = HISTORY_LIMIT) {
    const part = historyPart(player);
    if (!part) return null;
    const q = (v) => encodeURIComponent(v === null || v === undefined ? '' : String(v));
    return '/api/stats/history?filename=' + q(filename) + '&part=' + q(part)
        + '&difficulty=' + q(player.difficulty) + '&limit=' + q(limit);
}

const pctOf = (v) => (Number.isFinite(v) ? Math.round(v * 100) : null);

// historyView({ data: the history answer, score: this run's play:result score,
//   sessionId, player: its id, practice }) ->
//   { newBest, firstRun, recorded, best: { score, accuracyPct } | null,
//     recent: [{ score, accuracyPct, fullCombo }] (newest first, this run left out) } | null
// recorded: this run is in the answer (stats:recorded came first). New best is
// this run at or over the best with plays before it (A5's rule), or, not recorded
// yet, over the stored best. Practice is never a New best or a First run.
// null for anything that isn't a history answer (an older core).
export function historyView({ data, score, sessionId, player, practice = false }) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.runs)) return null;
    const runs = data.runs.filter((r) => r && typeof r === 'object');
    const mine = sessionId ? runs.find((r) => r.session_id === sessionId && (!r.player || r.player === player)) : null;
    const b = data.best && typeof data.best === 'object' && Number.isFinite(data.best.best_score) ? data.best : null;
    const plays = b && Number.isFinite(b.plays) ? b.plays : 0;
    let newBest = false;
    let firstRun = false;
    if (!practice) {
        if (mine) {
            newBest = !!b && plays > 1 && Number(mine.score) >= b.best_score;
            firstRun = !b || plays <= 1;
        } else {
            newBest = !!b && Number.isFinite(score) && Math.round(score) > b.best_score;
            firstRun = !b;
        }
    }
    return {
        newBest, firstRun, recorded: !!mine,
        best: b ? { score: b.best_score, accuracyPct: pctOf(b.best_accuracy) } : null,
        recent: runs.filter((r) => r !== mine).slice(0, RECENT_MAX)
            .map((r) => ({ score: Number.isFinite(r.score) ? r.score : 0, accuracyPct: pctOf(r.accuracy), fullCombo: r.full_combo === true })),
    };
}

// createHistoryLoader({ getJson(url) -> Promise, fb: core's bus, result: the
//   play:result detail, onView(playerId, historyView) }) -> { dispose() }
// Fetches every player's history now (the previous best), and once more after
// core's stats:recorded for this song (this run is in it then). A scored-off
// practice run never waits. Every failure (no endpoint on an older core, no
// network) is silent; an answer older than one already shown is dropped.
export function createHistoryLoader({ getJson, fb, result, onView }) {
    const r = result || {};
    const players = (Array.isArray(r.players) ? r.players : []).filter((p) => p && historyUrl(r.filename, p));
    let disposed = false;
    let gen = 0;
    const shown = new Map();
    const load = () => {
        const g = ++gen;
        for (const p of players) {
            Promise.resolve().then(() => (disposed ? null : getJson(historyUrl(r.filename, p)))).then((data) => {
                if (disposed || (shown.get(p.player) || 0) > g) return;
                const view = historyView({ data, score: p.score, sessionId: r.sessionId, player: p.player, practice: r.practice === true });
                if (!view) return;
                shown.set(p.player, g);
                onView(p.player, view);
            }).catch(() => {});
        }
    };
    let off = null;
    if (players.length && r.practice !== true && fb && typeof fb.on === 'function') {
        const onRecorded = (e) => {
            const d = (e && e.detail) || {};
            if (disposed || d.filename !== r.filename) return;
            if (off) off();
            load();
        };
        fb.on('stats:recorded', onRecorded);
        off = () => { off = null; if (typeof fb.off === 'function') fb.off('stats:recorded', onRecorded); };
    }
    if (players.length) load();
    return {
        dispose() {
            disposed = true;
            if (off) off();
        },
    };
}
