// The results model (plan 4 R17): pure, from a band score snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultsModel, pickAwards, historyPart, historyUrl, historyView, createHistoryLoader } from '../src/results.js';

function prefsOn(on = { guitar: true, drums: true, vocals: true }) {
    return {
        parts: {
            guitar: { on: !!on.guitar, arrangement: 'Lead', difficulty: 'hard' },
            drums: { on: !!on.drums, difficulty: 'expert' },
            vocals: { on: !!on.vocals, difficulty: 'medium' },
        },
    };
}

const part = (p) => ({
    score: 0, bonus: 0, multiplier: 1, streak: 0, bestStreak: 0, hits: 0, misses: 0, overhits: 0,
    crowd: 0.66, stars: null, accuracy: null, phrases: [], ...p,
});

const SNAPSHOT = {
    score: 412880, bonus: 500, bandMultiplier: 2, stars: 4.2,
    parts: {
        // Vocals first: cards still come out in guitar, drums, vocals order.
        vocals: part({
            score: 9300, hits: 21, misses: 4, bestStreak: 7, accuracy: 0.79,
            phrases: [
                { rating: 'Strong', count: 9, meanAccuracy: 0.8 },
                { rating: 'Awesome', count: 12, meanAccuracy: 0.95 },
            ],
        }),
        guitar: part({ hits: 90, misses: 10, bestStreak: 40, score: 9000, bonus: 500, accuracy: 0.9 }),
        drums: part({ hits: 80, misses: 20, overhits: 3, bestStreak: 30, score: 7000, accuracy: 0.8 }),
    },
};

test('a full band card set in part order with R17 stats', () => {
    const m = resultsModel({
        snapshot: SNAPSHOT, prefs: prefsOn(), song: { title: 'Everlong', artist: 'Foo Fighters' },
        oneLevel: false, drumsExtra: { phrasesHit: 4, phrasesTotal: 5 },
    });
    assert.equal(m.score, 412880);
    assert.equal(m.stars, 4.2);
    assert.equal(m.starDisplay.full, 4);
    assert.equal(m.starDisplay.gold, false);
    assert.equal(m.title, 'Everlong');
    assert.equal(m.subtitle, 'Everlong · Foo Fighters');
    assert.deepEqual(m.cards.map((c) => c.part), ['guitar', 'drums', 'vocals']);
    const [g, d, v] = m.cards;
    assert.equal(g.name, 'Guitar · Lead');
    assert.equal(g.difficulty, 'Hard');
    assert.equal(g.color, '#f5c542');
    assert.equal(g.icon, 'guitar');
    assert.equal(g.accuracyPct, 90);
    assert.equal(g.score, 9000);
    assert.equal(g.bestStreak, 40);
    assert.deepEqual(g.stats, [['Score', '9,000'], ['Best streak', '40'], ['Notes hit', '90 / 100'], ['Band bonus', '500']]);
    assert.equal(d.name, 'Drums');
    assert.equal(d.difficulty, 'Expert');
    assert.equal(d.accuracyPct, 80);
    assert.deepEqual(d.stats, [['Score', '7,000'], ['Best streak', '30'], ['Notes hit', '80 / 100'], ['Overhits', '3'],
        ['Star power phrases', '4 / 5']]);
    assert.equal(v.name, 'Vocals');
    assert.equal(v.accuracyPct, 79);
    assert.deepEqual(v.stats, [['Score', '9,300'], ['Phrases', '12 Awesome · 9 Strong'], ['Best run', '7 phrases']]);
    for (const c of m.cards) assert.equal(typeof c.award, 'string');
});

test('drums without star power data has no star power row', () => {
    const m = resultsModel({ snapshot: SNAPSHOT, prefs: prefsOn({ drums: true }), song: {}, oneLevel: false, drumsExtra: null });
    assert.deepEqual(m.cards.map((c) => c.part), ['drums']);
    assert.ok(!m.cards[0].stats.some(([label]) => label === 'Star power phrases'));
    assert.equal(m.subtitle, '');
});

test('a part that is off, or missing from the snapshot, has no card', () => {
    const snapshot = { ...SNAPSHOT, parts: { guitar: SNAPSHOT.parts.guitar } };
    const m = resultsModel({ snapshot, prefs: prefsOn({ guitar: true, vocals: true }), song: {}, oneLevel: false, drumsExtra: null });
    assert.deepEqual(m.cards.map((c) => c.part), ['guitar']);
});

test('nothing judged gives a dash, not NaN', () => {
    const snapshot = { score: 0, bonus: 0, bandMultiplier: 1, stars: null, parts: { guitar: part({}) } };
    const m = resultsModel({ snapshot, prefs: prefsOn({ guitar: true }), song: { title: 'T', artist: 'A' }, oneLevel: false, drumsExtra: null });
    const [g] = m.cards;
    assert.equal(g.accuracyPct, null);
    assert.equal(g.score, 0);
    assert.equal(m.score, 0);
    assert.deepEqual(m.starDisplay, { full: 0, partial: 0, gold: false });
    assert.ok(g.stats.every(([, value]) => !/NaN/.test(value)));
    assert.deepEqual(g.stats.find(([label]) => label === 'Notes hit'), ['Notes hit', '0 / 0']);
});

test('one level guitar', () => {
    const m = resultsModel({ snapshot: SNAPSHOT, prefs: prefsOn({ guitar: true }), song: {}, oneLevel: true, drumsExtra: null });
    assert.equal(m.cards[0].difficulty, 'One level');
});

test('gold stars at 6', () => {
    const m = resultsModel({ snapshot: { ...SNAPSHOT, stars: 6 }, prefs: prefsOn(), song: {}, oneLevel: false, drumsExtra: null });
    assert.equal(m.starDisplay.gold, true);
});

const card = (part, accuracy, judged, bestStreak, score = 100) => ({
    part, accuracy, accuracyPct: accuracy === null ? null : Math.round(accuracy * 100), judged, bestStreak, score,
});

test('awards', () => {
    assert.deepEqual(pickAwards([card('guitar', 1, 25, 30), card('drums', 0.8, 100, 40), card('vocals', 0.7, 20, 5)]),
        ['Flawless', 'Best streak in the band', 'Big voice']);
    assert.deepEqual(pickAwards([card('guitar', 0.5, 10, 3)]), ['Riff keeper']);
    // Tied best streaks: no streak award; the unique most accurate card gets its award.
    assert.deepEqual(pickAwards([card('guitar', 0.9, 50, 40), card('drums', 0.8, 50, 40)]), ['Most accurate', 'Held it down']);
});

test('awards: flawless needs 20 judged; streaks under 10 and tied accuracy give nothing', () => {
    assert.deepEqual(pickAwards([card('guitar', 1, 19, 5), card('drums', 1, 19, 9)]), ['Riff keeper', 'Held it down']);
    assert.deepEqual(pickAwards([card('drums', null, 0, 0), card('vocals', null, 0, 0)]), ['Held it down', 'Big voice']);
});

test('a part that scored nothing gets no award', () => {
    assert.deepEqual(pickAwards([card('guitar', 0.8, 30, 12, 500), card('drums', 0, 14, 0, 0)]),
        ['Best streak in the band', '']);
});

test('0% is never Most accurate', () => {
    assert.deepEqual(pickAwards([card('guitar', 0, 25, 0, 0), card('vocals', null, 0, 0, 0)]), ['', '']);
});

test('most accurate needs 20 judged, like flawless', () => {
    // Different accuracies, but both on 19 judgments: no Most accurate.
    assert.deepEqual(pickAwards([card('guitar', 0.8, 19, 5), card('drums', 0.95, 19, 5)]), ['Riff keeper', 'Held it down']);
    // Drums is the most accurate on 19 judgments: the top card that qualifies gets it.
    assert.deepEqual(pickAwards([card('guitar', 0.8, 100, 5), card('drums', 0.95, 19, 5), card('vocals', 0.7, 20, 2)]),
        ['Most accurate', 'Held it down', 'Big voice']);
});

test('phrase entries without a string rating are skipped', () => {
    const vocals = part({ accuracy: 0.8, hits: 3, bestStreak: 2, phrases: [
        { rating: 'Strong', count: 2, meanAccuracy: 0.8 },
        { rating: null, count: 5, meanAccuracy: 0.9 },
        { count: 1, meanAccuracy: 0.99 },
    ] });
    const m = resultsModel({ snapshot: { score: 0, parts: { vocals } }, prefs: prefsOn({ vocals: true }), song: {}, oneLevel: false, drumsExtra: null });
    assert.deepEqual(m.cards[0].stats.find(([label]) => label === 'Phrases'), ['Phrases', '2 Strong']);
});

test('band failed heading and overdrive stats', () => {
    const base = { snapshot: SNAPSHOT, prefs: prefsOn({ guitar: true }), song: {}, oneLevel: false, drumsExtra: null };
    const failed = resultsModel({ ...base, failed: true });
    assert.equal(failed.failed, true);
    assert.equal(failed.heading, 'Band failed');
    const ok = resultsModel(base);
    assert.equal(ok.failed, false);
    assert.equal(ok.heading, '');
    const snap = { ...SNAPSHOT, parts: { guitar: part({ hits: 9, misses: 1, deploys: 2, drops: 1 }) } };
    const g = resultsModel({ ...base, snapshot: snap }).cards[0];
    assert.deepEqual(g.stats.slice(-2), [['Overdrives', '2'], ['Dropped out', '1']]);
    const zero = { ...SNAPSHOT, parts: { guitar: part({ deploys: 0, drops: 0 }) } };
    const labels = resultsModel({ ...base, snapshot: zero }).cards[0].stats.map(([l]) => l);
    assert.ok(!labels.includes('Overdrives'));
    assert.ok(!labels.includes('Dropped out'));
    const v = resultsModel({ ...base, prefs: prefsOn({ vocals: true }),
        snapshot: { ...SNAPSHOT, parts: { vocals: part({ deploys: 1, drops: 3 }) } } }).cards[0];
    assert.deepEqual(v.stats.slice(-2), [['Overdrives', '1'], ['Dropped out', '3']]);
});

const CTLS = [
    { id: 'ctl1', key: 'a#1', name: 'Guitar Hero', part: 'bass', difficulty: 'expert', on: true },
    { id: 'ctl2', key: 'a#2', name: 'Xbox pad', part: 'bass', difficulty: 'easy', on: true },
];
const ctlPrefs = (on) => ({ ...prefsOn(on), controllers: CTLS });
const ctlSnap = (extra = {}) => ({
    ...SNAPSHOT,
    parts: {
        ...SNAPSHOT.parts,
        ctl1: part({ score: 5000, hits: 40, misses: 10, overhits: 4, bestStreak: 12, accuracy: 0.8, deploys: 2, drops: 1 }),
        ctl2: part({ score: 3000, hits: 20, misses: 20, overhits: 0, bestStreak: 5, accuracy: 0.5 }),
        ...extra,
    },
});

test('a card per controller, named by part, with overstrums and Auto chart', () => {
    const m = resultsModel({
        snapshot: ctlSnap(), prefs: ctlPrefs(), song: {}, oneLevel: false, drumsExtra: null,
        controllerInfo: { ctl1: { sourceKind: 'auto' }, ctl2: { sourceKind: 'chart' } },
    });
    assert.deepEqual(m.cards.map((c) => c.part), ['guitar', 'drums', 'vocals', 'ctl1', 'ctl2']);
    const c = m.cards[3];
    assert.equal(c.kind, 'five_fret');
    assert.equal(c.name, 'Bass (5-Fret)');
    assert.equal(c.subname, 'Guitar Hero');
    assert.equal(c.difficulty, 'Expert');
    assert.equal(c.color, '#2ecc40');
    assert.equal(c.icon, 'gamepad-2');
    assert.equal(c.accuracyPct, 80);
    assert.deepEqual(c.stats, [
        ['Score', '5,000'], ['Best streak', '12'], ['Notes hit', '40 / 50'], ['Overstrums', '4'],
        ['Chart', 'Auto'], ['Overdrives', '2'], ['Dropped out', '1'],
    ]);
    assert.ok(!m.cards[4].stats.some(([l]) => l === 'Chart'), 'a real chart shows no Chart row');
    assert.equal(m.cards[0].subname, undefined, 'fixed cards are unchanged');
});

test('two players on one part get two cards', () => {
    const m = resultsModel({ snapshot: ctlSnap(), prefs: ctlPrefs({}), song: {}, oneLevel: false, drumsExtra: null });
    assert.deepEqual(m.cards.map((c) => c.part), ['ctl1', 'ctl2']);
    assert.deepEqual(m.cards.map((c) => c.name), ['Bass (5-Fret)', 'Bass (5-Fret)']);
    assert.deepEqual(m.cards.map((c) => c.subname), ['Guitar Hero', 'Xbox pad']);
});

test('a controller missing from the snapshot, or sitting out, has no card', () => {
    const snap = ctlSnap();
    delete snap.parts.ctl2;
    const m = resultsModel({ snapshot: snap, prefs: ctlPrefs({}), song: {}, oneLevel: false, drumsExtra: null });
    assert.deepEqual(m.cards.map((c) => c.part), ['ctl1']);
});

test('awards weigh controller cards', () => {
    const m = resultsModel({ snapshot: ctlSnap(), prefs: ctlPrefs({}), song: {}, oneLevel: false, drumsExtra: null });
    // ctl1 has the unique best streak (12 >= 10) and ctl2 has no accuracy award: fallback by kind.
    assert.equal(m.cards[0].award, 'Best streak in the band');
    assert.equal(m.cards[1].award, 'Held the frets');
    const awards = pickAwards([{ part: 'ctl1', kind: 'five_fret', score: 10, bestStreak: 0, judged: 0, accuracy: null }]);
    assert.deepEqual(awards, ['Held the frets']);
});

const DRUM_CTLS = [
    { id: 'ctl1', key: 'a#1', name: 'Guitar Hero', part: 'bass', difficulty: 'expert', on: true },
    { id: 'ctl2', key: 'a#2', name: 'Rock Band kit', playsAs: 'drums', part: 'drums', difficulty: 'hard', on: true, sourceKind: 'chart' },
];
const drumCtlSnap = () => ctlSnap({
    ctl2: part({ score: 3000, hits: 20, misses: 20, overhits: 7, bestStreak: 5, accuracy: 0.5, deploys: 1, drops: 2 }),
});

test('a drums controller card with overhits, after the 5-fret cards in join order', () => {
    const m = resultsModel({
        snapshot: drumCtlSnap(), prefs: { ...prefsOn(), controllers: DRUM_CTLS }, song: {}, oneLevel: false, drumsExtra: null,
        controllerInfo: { ctl1: { sourceKind: 'chart' }, ctl2: { sourceKind: '' } },
    });
    assert.deepEqual(m.cards.map((c) => c.part), ['guitar', 'drums', 'vocals', 'ctl1', 'ctl2']);
    assert.equal(m.cards[3].name, 'Bass (5-Fret)', '5-fret cards unchanged');
    const c = m.cards[4];
    assert.equal(c.kind, 'drums_controller');
    assert.equal(c.name, 'Drums (Controller)');
    assert.equal(c.subname, 'Rock Band kit');
    assert.equal(c.difficulty, 'Hard');
    assert.equal(c.color, '#f28c28');
    assert.equal(c.icon, 'drum');
    assert.deepEqual(c.stats, [
        ['Score', '3,000'], ['Best streak', '5'], ['Notes hit', '20 / 40'], ['Overhits', '7'],
        ['Overdrives', '1'], ['Dropped out', '2'],
    ]);
});

test('a drums controller never gets a Chart: Auto row', () => {
    const m = resultsModel({
        snapshot: drumCtlSnap(), prefs: { ...prefsOn({}), controllers: DRUM_CTLS }, song: {}, oneLevel: false, drumsExtra: null,
        controllerInfo: { ctl2: { sourceKind: 'auto' } },
    });
    assert.ok(!m.cards[1].stats.some(([l]) => l === 'Chart'));
});

test('fallback award Held it down', () => {
    const m = resultsModel({ snapshot: drumCtlSnap(), prefs: { ...prefsOn({}), controllers: DRUM_CTLS }, song: {}, oneLevel: false, drumsExtra: null });
    assert.equal(m.cards[1].award, 'Held it down');
    assert.deepEqual(pickAwards([{ part: 'ctl2', kind: 'drums_controller', score: 10, bestStreak: 0, judged: 0, accuracy: null }]), ['Held it down']);
});

// ── Stream B3: per-section accuracy and run history ─────────────────────

test('cards carry their sections with a percent, the worst flagged; none is []', () => {
    const sec = (name, start, hits, misses) => ({ name, start, end: start + 10, hits, misses, accuracy: hits / (hits + misses) });
    const m = resultsModel({
        snapshot: SNAPSHOT, prefs: prefsOn(), song: {}, oneLevel: false, drumsExtra: null,
        sections: { drums: [sec('Intro 1', 0, 10, 0), sec('Verse 1', 10, 6, 4), sec('Chorus 1', 20, 9, 1), sec('Bridge 1', 30, 2, 8)] },
    });
    const [g, d] = m.cards;
    assert.deepEqual(g.sections, []);
    assert.deepEqual(d.sections, [
        { name: 'Intro 1', start: 0, end: 10, pct: 100, worst: false },
        { name: 'Verse 1', start: 10, end: 20, pct: 60, worst: true },
        { name: 'Chorus 1', start: 20, end: 30, pct: 90, worst: false },
        { name: 'Bridge 1', start: 30, end: 40, pct: 20, worst: true },
    ]);
});

test('historyPart: the recorder\'s part key; real guitar and unknown players have none', () => {
    assert.equal(historyPart({ instrument: 'drums', part: 'drums' }), 'drums');
    assert.equal(historyPart({ instrument: 'vocals', part: '' }), 'vocals');
    assert.equal(historyPart({ instrument: 'five_fret', part: 'Rhythm' }), 'five_fret:rhythm');
    assert.equal(historyPart({ instrument: 'guitar', part: 'lead' }), null);
    assert.equal(historyPart({ instrument: null, part: null }), null);
    assert.equal(historyPart(null), null);
});

test('historyUrl: filename, part, difficulty, limit', () => {
    assert.equal(historyUrl('My Song.sloppak', { instrument: 'five_fret', part: 'bass', difficulty: 'hard' }),
        '/api/stats/history?filename=My%20Song.sloppak&part=five_fret%3Abass&difficulty=hard&limit=5');
    assert.equal(historyUrl('a', { instrument: 'drums', part: 'drums', difficulty: null }, 3),
        '/api/stats/history?filename=a&part=drums&difficulty=&limit=3');
    assert.equal(historyUrl('a', { instrument: 'guitar', part: 'lead' }), null);
});

const run = (o) => ({ id: 1, score: 1000, accuracy: 0.9, full_combo: false, session_id: 'old', player: 'drums', played_at: 1, ...o });
const best = (o) => ({ plays: 3, best_score: 5000, best_accuracy: 0.95, ...o });

test('historyView: this run recorded and at the best is New best; recent runs leave it out', () => {
    const data = { best: best({ best_score: 6000 }), runs: [run({ id: 9, score: 6000, session_id: 's1' }), run({ id: 8, score: 5000, accuracy: 0.955 }), run({ id: 7, score: 4000, full_combo: true })] };
    const v = historyView({ data, score: 6000, sessionId: 's1', player: 'drums' });
    assert.deepEqual(v, {
        newBest: true, firstRun: false, recorded: true,
        best: { score: 6000, accuracyPct: 95 },
        recent: [{ score: 5000, accuracyPct: 96, fullCombo: false }, { score: 4000, accuracyPct: 90, fullCombo: true }],
    });
});

test('historyView: recorded but under the best; a first run is no New best', () => {
    const data = { best: best(), runs: [run({ score: 3000, session_id: 's1' })] };
    assert.equal(historyView({ data, score: 3000, sessionId: 's1', player: 'drums' }).newBest, false);
    const first = { best: best({ plays: 1, best_score: 3000 }), runs: [run({ score: 3000, session_id: 's1' })] };
    const v = historyView({ data: first, score: 3000, sessionId: 's1', player: 'drums' });
    assert.equal(v.newBest, false);
    assert.equal(v.firstRun, true);
    assert.deepEqual(v.recent, []);
});

test('historyView: not recorded yet compares with the stored best', () => {
    const data = { best: best(), runs: [run({ score: 4000 })] };
    let v = historyView({ data, score: 5200, sessionId: 's1', player: 'drums' });
    assert.equal(v.newBest, true);
    assert.equal(v.recorded, false);
    assert.equal(v.recent.length, 1);
    v = historyView({ data, score: 5000, sessionId: 's1', player: 'drums' });
    assert.equal(v.newBest, false, 'a tie with a best already stored is not new');
    v = historyView({ data: { best: null, bests: [], runs: [] }, score: 10, sessionId: 's1', player: 'drums' });
    assert.deepEqual(v, { newBest: false, firstRun: true, recorded: false, best: null, recent: [] });
});

test('historyView: another player\'s row with this session id is not this run', () => {
    const data = { best: best(), runs: [run({ score: 9000, session_id: 's1', player: 'ctl1' })] };
    const v = historyView({ data, score: 100, sessionId: 's1', player: 'drums' });
    assert.equal(v.recorded, false);
    assert.equal(v.recent.length, 1);
});

test('historyView: practice never says New best or First run', () => {
    const data = { best: best(), runs: [] };
    const v = historyView({ data, score: 99999, sessionId: 's1', player: 'drums', practice: true });
    assert.equal(v.newBest, false);
    assert.equal(historyView({ data: { best: null, runs: [] }, score: 1, sessionId: 's', player: 'drums', practice: true }).firstRun, false);
});

test('historyView: an older core (no runs list, an error body) gives null', () => {
    for (const data of [null, undefined, { detail: 'Not Found' }, { best: null, runs: 'x' }, 'html']) {
        assert.equal(historyView({ data, score: 1, sessionId: 's', player: 'drums' }), null);
    }
});

function fakeBus() {
    const map = new Map();
    return {
        on: (ev, fn) => { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); },
        off: (ev, fn) => { if (map.has(ev)) map.get(ev).delete(fn); },
        emit: (ev, detail) => { for (const fn of [...(map.get(ev) || [])]) fn({ detail }); },
        count: (ev) => (map.get(ev) ? map.get(ev).size : 0),
    };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const RESULT = {
    filename: 'a.sloppak', sessionId: 's1', practice: false,
    players: [
        { player: 'drums', instrument: 'drums', part: 'drums', difficulty: 'expert', score: 6000 },
        { player: 'guitar', instrument: 'guitar', part: 'lead', difficulty: 'hard', score: 10 },
        { player: 'ctl1', instrument: 'five_fret', part: 'bass', difficulty: 'easy', score: 300 },
    ],
};

test('createHistoryLoader: fetches each player now, again after stats:recorded for this song, then stops listening', async () => {
    const fb = fakeBus();
    const urls = [];
    let recorded = false;
    const getJson = (url) => {
        urls.push(url);
        const mine = recorded ? [run({ score: 6000, session_id: 's1' })] : [];
        return Promise.resolve({ best: best({ best_score: recorded ? 6000 : 5000, plays: recorded ? 4 : 3 }), runs: [...mine, run()] });
    };
    const views = [];
    const loader = createHistoryLoader({ getJson, fb, result: RESULT, onView: (id, v) => views.push([id, v]) });
    await flush();
    assert.deepEqual(urls, [
        '/api/stats/history?filename=a.sloppak&part=drums&difficulty=expert&limit=5',
        '/api/stats/history?filename=a.sloppak&part=five_fret%3Abass&difficulty=easy&limit=5',
    ]);
    assert.deepEqual(views.map(([id, v]) => [id, v.recorded, v.newBest]), [['drums', false, true], ['ctl1', false, false]]);
    fb.emit('stats:recorded', { filename: 'other.sloppak' });
    await flush();
    assert.equal(urls.length, 2, 'another song\'s stats are not ours');
    recorded = true;
    fb.emit('stats:recorded', { filename: 'a.sloppak' });
    await flush();
    assert.equal(urls.length, 4);
    assert.deepEqual(views.slice(2).map(([id, v]) => [id, v.recorded, v.newBest]), [['drums', true, true], ['ctl1', false, false]]);
    assert.equal(fb.count('stats:recorded'), 0);
    loader.dispose();
});

test('createHistoryLoader: a stale answer never replaces a newer one', async () => {
    const fb = fakeBus();
    const pending = [];
    const getJson = () => new Promise((resolve) => pending.push(resolve));
    const views = [];
    const result = { ...RESULT, players: [RESULT.players[0]] };
    createHistoryLoader({ getJson, fb, result, onView: (id, v) => views.push(v.recorded) });
    fb.emit('stats:recorded', { filename: 'a.sloppak' });
    await flush();
    assert.equal(pending.length, 2);
    pending[1]({ best: best({ best_score: 6000 }), runs: [run({ score: 6000, session_id: 's1' })] });
    await flush();
    pending[0]({ best: best(), runs: [] });
    await flush();
    assert.deepEqual(views, [true]);
});

test('createHistoryLoader: practice fetches once and never waits; failures and dispose are silent', async () => {
    const fb = fakeBus();
    let calls = 0;
    const views = [];
    createHistoryLoader({ getJson: () => { calls++; return Promise.reject(new Error('404')); }, fb, result: { ...RESULT, practice: true }, onView: (id, v) => views.push(v) });
    await flush();
    assert.equal(calls, 2);
    assert.equal(fb.count('stats:recorded'), 0);
    assert.deepEqual(views, []);
    // A getJson that throws, and one answering after dispose.
    const loader = createHistoryLoader({ getJson: () => { throw new Error('no fetch'); }, fb, result: RESULT, onView: () => views.push(1) });
    await flush();
    loader.dispose();
    assert.equal(fb.count('stats:recorded'), 0);
    let resolve;
    let asked = 0;
    const result = { ...RESULT, players: [RESULT.players[0]] };
    const getJson = () => { asked++; return new Promise((r) => { resolve = r; }); };
    createHistoryLoader({ getJson, fb, result, onView: () => views.push(2) }).dispose();
    await flush();
    assert.equal(asked, 0, 'disposed before it asked: never asks');
    const late = createHistoryLoader({ getJson, fb, result, onView: () => views.push(3) });
    await flush();
    late.dispose();
    resolve({ best: best(), runs: [] });
    await flush();
    assert.deepEqual(views, []);
    // No bus, no players: nothing to do.
    assert.doesNotThrow(() => createHistoryLoader({ getJson: () => Promise.resolve({}), fb: null, result: null, onView: () => {} }).dispose());
});
