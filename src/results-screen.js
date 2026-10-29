// The band results screen (plan 4 R16, R17): a modal dialog over #player with the
// band's stars, score and song, one card per part, and Play again / Next song.
// Enter and Escape are Next song, R is Play again; the player's own keys are held
// off while it shows. Draws only: the caller decides what the buttons do.
// Stream B3: each card lists its sections (the worst highlighted; a click asks
// onPractice to loop it, at the speed and drill chosen in the practice bar),
// and setHistory(part, view) fills in its best and recent runs when they come.
import { icon } from './icons.js';
import { PRACTICE_SPEEDS, DRILL_GOAL, DRILL_REPS } from './practice.js';
import { formatScore } from './hud-model.js';
import { holdMediaKeys } from './media-keys.js';

const STAR_COUNT = 5;
const STAR_PX = 40;
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
// Core's player-scope shortcuts (play/pause, seek, speed, ...): never passed
// through to the player while the results show.
export const PLAYER_KEYS = new Set([' ', 'Spacebar', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '[', ']', '+', '-', '=']);

export function isTyping(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    return TYPING_TAGS.has(String(target.tagName || '').toUpperCase());
}

const isButton = (target) => !!target && String(target.tagName || '').toUpperCase() === 'BUTTON';

function focus(el) {
    if (el && typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch (_) { /* focus is a nicety */ }
    }
}

const TIMES = { 1: 'once', 2: 'two times', 3: 'three times' };

function historyRun(r) {
    const pct = Number.isFinite(r.accuracyPct) ? r.accuracyPct + '%' : '';
    return formatScore(r.score) + ' · ' + (r.fullCombo ? 'FC' : pct);
}

// showResultsScreen({ doc, win, host, model, onAgain, onNext, onPractice? })
//   -> { hide(), setHistory(part, historyView) }
// onPractice({ part, section: { name, start, end }, speed, drill }): a section was
// picked; without it the sections are listed only.
export function showResultsScreen({ doc, win, host, model, onAgain, onNext, onPractice }) {
    const el = (tag, cls, parent) => {
        const e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (parent) parent.appendChild(e);
        return e;
    };
    const iconIn = (parent, cls, name, size) => {
        const span = el('span', cls, parent);
        span.innerHTML = icon(name, { size });
        return span;
    };
    const m = model || {};

    const root = el('div', 'rhs-results');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const label = m.title ? 'Results: ' + m.title : 'Results';
    root.setAttribute('aria-label', m.heading ? m.heading + '. ' + label : label);
    const inner = el('div', 'rhs-results-inner', root);

    // Header: the Band failed heading (plan 5 R12), band stars (the HUD's five-star display),
    // band score, song.
    const head = el('div', 'rhs-results-head', inner);
    if (m.heading) el('h2', 'rhs-results-failed', head).textContent = m.heading;
    const stars = el('div', 'rhs-results-stars', head);
    stars.setAttribute('aria-hidden', 'true');
    const sd = m.starDisplay || { full: 0, partial: 0, gold: false };
    for (let i = 0; i < STAR_COUNT; i++) {
        const star = el('span', 'rhs-star', stars);
        star.innerHTML = icon('star', { size: STAR_PX });
        const fill = el('span', 'rhs-star-fill', star);
        fill.innerHTML = icon('star', { size: STAR_PX });
        const share = i < sd.full ? 1 : i === sd.full ? sd.partial || 0 : 0;
        fill.style.width = Math.round(share * 100) + '%';
    }
    stars.classList.toggle('rhs-gold', !!sd.gold);
    el('div', 'rhs-results-score', head).textContent = formatScore(m.score);
    el('div', 'rhs-results-sub', head).textContent = m.subtitle || '';

    // The practice choices, read when a section is clicked.
    const practice = { speed: 1, drill: false };
    const canPractice = typeof onPractice === 'function';
    const sectionButtons = [];

    // One card per part.
    const grid = el('div', 'rhs-cards', inner);
    const cardEls = new Map();
    for (const c of Array.isArray(m.cards) ? m.cards : []) {
        const card = el('div', 'rhs-card', grid);
        card.setAttribute('data-part', c.part);
        cardEls.set(c.part, card);
        if (c.color) card.style.setProperty('--rhs-c', c.color);
        const top = el('div', 'rhs-card-top', card);
        iconIn(top, 'rhs-card-icon', c.icon, 28);
        el('h3', 'rhs-card-name', top).textContent = c.name || '';
        el('span', 'rhs-card-diff', top).textContent = c.difficulty || '';
        if (c.subname) el('div', 'rhs-card-sub', card).textContent = c.subname;
        el('div', 'rhs-card-pct', card).textContent = Number.isFinite(c.accuracyPct) ? c.accuracyPct + '%' : '—';
        for (const [label, value] of Array.isArray(c.stats) ? c.stats : []) {
            const row = el('div', 'rhs-stat', card);
            el('span', 'rhs-stat-label', row).textContent = label;
            el('span', 'rhs-stat-value', row).textContent = value;
        }
        const sections = Array.isArray(c.sections) ? c.sections : [];
        if (sections.length) {
            const list = el('div', 'rhs-sections', card);
            el('div', 'rhs-sections-label', list).textContent = 'Sections';
            for (const sec of sections) {
                const row = el(canPractice ? 'button' : 'span', 'rhs-section', list);
                if (sec.worst) row.classList.add('rhs-worst');
                el('span', 'rhs-section-name', row).textContent = sec.name;
                el('span', 'rhs-section-pct', row).textContent = sec.pct + '%';
                if (!canPractice) continue;
                row.type = 'button';
                row.setAttribute('aria-label', 'Practice ' + sec.name + ', ' + sec.pct + '%');
                row.setAttribute('title', 'Practice ' + sec.name);
                row.addEventListener('click', () => onPractice({
                    part: c.part, section: { name: sec.name, start: sec.start, end: sec.end },
                    speed: practice.speed, drill: practice.drill,
                }));
                sectionButtons.push(row);
            }
        }
        if (c.award) {
            const award = el('span', 'rhs-award', card);
            iconIn(award, 'rhs-award-icon', 'trophy', 14);
            el('span', 'rhs-award-text', award).textContent = c.award;
        }
    }

    // The practice bar: speed steps and the drill switch, for the section clicks.
    const practiceButtons = [];
    if (sectionButtons.length) {
        const bar = el('div', 'rhs-practice', inner);
        el('span', 'rhs-practice-label', bar).textContent = 'Practice a section';
        const speeds = el('div', 'rhs-speeds', bar);
        speeds.setAttribute('role', 'group');
        speeds.setAttribute('aria-label', 'Practice speed');
        const speedButtons = PRACTICE_SPEEDS.map((rate) => {
            const b = el('button', 'rhs-speed', speeds);
            b.type = 'button';
            b.textContent = Math.round(rate * 100) + '%';
            b.addEventListener('click', () => {
                practice.speed = rate;
                speedButtons.forEach((x, i) => x.setAttribute('aria-pressed', String(PRACTICE_SPEEDS[i] === rate)));
            });
            return b;
        });
        speedButtons.forEach((x, i) => x.setAttribute('aria-pressed', String(PRACTICE_SPEEDS[i] === practice.speed)));
        const drill = el('button', 'rhs-drill', bar);
        drill.type = 'button';
        drill.textContent = 'Drill: ' + Math.round(DRILL_GOAL * 100) + '% ' + (TIMES[DRILL_REPS] || DRILL_REPS + ' times');
        drill.setAttribute('aria-pressed', 'false');
        drill.addEventListener('click', () => {
            practice.drill = !practice.drill;
            drill.setAttribute('aria-pressed', String(practice.drill));
        });
        practiceButtons.push(...speedButtons, drill);
    }

    const btns = el('div', 'rhs-results-btns', inner);
    const again = el('button', 'rhs-again', btns);
    again.type = 'button';
    iconIn(again, 'rhs-btn-icon', 'rotate-ccw', 18);
    el('span', 'rhs-btn-text', again).textContent = 'Play again';
    const next = el('button', 'rhs-next', btns);
    next.type = 'button';
    el('span', 'rhs-btn-text', next).textContent = 'Next song';
    iconIn(next, 'rhs-btn-icon', 'arrow-right', 20);

    again.addEventListener('click', () => onAgain());
    next.addEventListener('click', () => onNext());

    // Keys, in the capture phase on win so core's player shortcuts (document
    // listeners) never see them while the results are up: Space would restart
    // the ended song behind the dialog. Browser shortcuts (Ctrl/Cmd/Alt) are
    // left alone.
    //   Space, arrows, [ ] + - =: swallowed, whatever has focus.
    //   Tab / Shift+Tab: wrap between the two buttons.
    //   Escape: Next song.
    //   Enter: a focused button activates natively; on the dialog or body it is
    //   Next song. R: Play again. Typing targets keep Enter and R.
    const focusables = [...sectionButtons, ...practiceButtons, again, next];
    function onKey(e) {
        if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
        const swallow = () => { e.preventDefault(); e.stopPropagation(); };
        if (PLAYER_KEYS.has(e.key) || e.code === 'Space') { swallow(); return; }
        if (e.key === 'Tab') {
            swallow();
            const i = focusables.indexOf(doc.activeElement);
            const last = focusables.length - 1;
            const to = e.shiftKey ? (i <= 0 ? last : i - 1) : (i < 0 || i === last ? 0 : i + 1);
            focus(focusables[to]);
            return;
        }
        if (e.key === 'Escape') { swallow(); onNext(); return; }
        if (isTyping(e.target)) return;
        if (e.key === 'Enter') {
            if (isButton(e.target)) { e.stopPropagation(); return; }
            if (e.target !== root && e.target !== doc.body) return;
            swallow();
            onNext();
            return;
        }
        if (e.key === 'r' || e.key === 'R') { swallow(); onAgain(); }
    }
    root.setAttribute('tabindex', '-1');
    host.appendChild(root);
    focus(next);
    if (doc.activeElement !== next) focus(root);

    // Registered last, so a throw above can't leak it.
    win.addEventListener('keydown', onKey, true);
    // Media keys would play the ended song behind the dialog (plan 7 R15).
    const releaseMedia = holdMediaKeys(win.navigator);
    let shown = true;
    // A card's run history (results.js historyView), replacing any shown before.
    function setHistory(part, view) {
        const card = shown && view ? cardEls.get(part) : null;
        if (!card) return;
        const old = card.querySelector('div.rhs-history');
        if (old) old.remove();
        const box = el('div', 'rhs-history');
        if (view.newBest) el('div', 'rhs-new-best', box).textContent = 'New best!';
        else if (view.firstRun) el('div', 'rhs-first-run', box).textContent = 'First run';
        if (view.best) {
            const row = el('div', 'rhs-hist-best', box);
            el('span', 'rhs-stat-label', row).textContent = 'Best';
            const pct = Number.isFinite(view.best.accuracyPct) ? ' · ' + view.best.accuracyPct + '%' : '';
            el('span', 'rhs-stat-value', row).textContent = formatScore(view.best.score) + pct;
        }
        const recent = Array.isArray(view.recent) ? view.recent : [];
        if (recent.length) {
            const runs = el('div', 'rhs-hist-runs', box);
            el('span', 'rhs-stat-label', runs).textContent = 'Last runs';
            for (const r of recent) el('span', 'rhs-hist-run', runs).textContent = historyRun(r);
        }
        if (!box.children.length) return;
        // Above the sections and award: after the stats.
        const anchor = card.querySelector('div.rhs-sections') || card.querySelector('span.rhs-award');
        if (anchor && typeof card.insertBefore === 'function') card.insertBefore(box, anchor);
        else card.appendChild(box);
    }
    return {
        setHistory,
        hide() {
            if (!shown) return;
            shown = false;
            win.removeEventListener('keydown', onKey, true);
            releaseMedia();
            root.remove();
        },
    };
}
