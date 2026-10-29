// Per-section accuracy (drums & controllers plan, phase 7): the song's section
// markers as ranges, and each player's hits and misses in them, from the band
// score ledger's time-stamped entries. Pure: no DOM, no bus.
//
// The ranges follow core's section practice bar (static/js/section-practice.js
// _buildSectionParents): markers sorted by time, consecutive markers of one
// name merged, labels numbered per name ("Verse 1", "Verse 2"), each ending at
// the next marker or the song's end.

const finite = Number.isFinite;
// The last section's length when the song's duration is unknown (core's too).
const FALLBACK_LAST_S = 4;
// worstSections: a section needs this many judged notes to count as one of the worst.
const WORST_MIN_JUDGED = 4;
const WORST_COUNT = 2;

function startOf(s) {
    if (!s || typeof s !== 'object') return NaN;
    const n = Number(s.time ?? s.startTime ?? s.start_time ?? s.start);
    return finite(n) ? n : NaN;
}

function baseName(raw, index) {
    let s = (typeof raw === 'string' ? raw : '').trim();
    if (!s) s = 'Section ' + (index + 1);
    s = s.replace(/_/g, ' ').replace(/\s*\d+$/u, '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'Section';
}

// sectionRanges(raw: highway.getSections(), duration) -> [{ name, start, end }]
export function sectionRanges(raw, duration) {
    const list = (Array.isArray(raw) ? raw : [])
        .map((s, i) => ({ s, i, start: startOf(s) }))
        .filter((x) => finite(x.start))
        .sort((a, b) => a.start - b.start);
    const groups = [];
    for (const x of list) {
        const name = baseName(x.s.name, x.i);
        const prev = groups[groups.length - 1];
        if (prev && prev.base === name) continue;
        groups.push({ base: name, start: x.start });
    }
    const counters = Object.create(null);
    const dur = finite(duration) ? duration : NaN;
    return groups.map((g, gi) => {
        counters[g.base] = (counters[g.base] || 0) + 1;
        let end = gi + 1 < groups.length ? groups[gi + 1].start : dur;
        if (!finite(end) || end <= g.start) end = dur > g.start ? dur : g.start + FALLBACK_LAST_S;
        return { name: g.base + ' ' + counters[g.base], start: g.start, end };
    });
}

// When a ledger entry's note was due: its note time when it has one (guitar,
// 5-fret), else when it was judged.
export function entryTime(entry) {
    if (!entry) return NaN;
    if (finite(entry.noteTime)) return entry.noteTime;
    return finite(entry.t) ? entry.t : NaN;
}

// 'hit' | 'miss' | null, as band-score counts hits and misses.
export function judgedAs(entry) {
    if (!entry) return null;
    if (entry.kind === 'hit') return 'hit';
    if (entry.kind === 'phrase') return entry.passed ? 'hit' : 'miss';
    if (entry.kind === 'miss') return 'miss';
    return null;
}

// The players' hits and misses with a note time in [start, end).
// accuracy: hits / (hits + misses), null when nothing was judged.
export function rangeTally(entries, start, end, ids) {
    const want = new Set(Array.isArray(ids) ? ids : []);
    let hits = 0;
    let misses = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || !want.has(e.part)) continue;
        const t = entryTime(e);
        if (!(t >= start && t < end)) continue;
        const j = judgedAs(e);
        if (j === 'hit') hits++;
        else if (j === 'miss') misses++;
    }
    const judged = hits + misses;
    return { hits, misses, accuracy: judged ? hits / judged : null };
}

// play:result players[].sections (contract §3) per player id:
// { id: [{ name, start, end, hits, misses, accuracy }] }, only the sections the
// player was judged in.
export function playerSections(entries, ranges, ids) {
    const out = {};
    for (const id of Array.isArray(ids) ? ids : []) {
        out[id] = [];
        for (const r of Array.isArray(ranges) ? ranges : []) {
            const t = rangeTally(entries, r.start, r.end, [id]);
            if (t.accuracy === null) continue;
            out[id].push({ name: r.name, start: r.start, end: r.end, hits: t.hits, misses: t.misses, accuracy: t.accuracy });
        }
    }
    return out;
}

// The indices of up to n sections to point out: the lowest accuracy below 100%
// with at least minJudged notes, ties to the one with more misses.
export function worstSections(sections, { n = WORST_COUNT, minJudged = WORST_MIN_JUDGED } = {}) {
    return (Array.isArray(sections) ? sections : [])
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s && finite(s.accuracy) && s.accuracy < 1 && (s.hits + s.misses) >= minJudged)
        .sort((a, b) => a.s.accuracy - b.s.accuracy || b.s.misses - a.s.misses || a.i - b.i)
        .slice(0, n)
        .map(({ i }) => i);
}
