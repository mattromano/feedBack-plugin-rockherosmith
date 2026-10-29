// The Solo screen (plan phase 5, contract §1 openSolo): pick an instrument, then a
// song from the library filtered to that instrument, and it plays straight on that
// chart. Kit / drum controller / 5-fret go through playSolo (a band of one on the
// RockHeroSmith stage); real guitar through core's playSongAs. Thin DOM layer; the
// rules live in solo-screen-model.js. Every choice is kept in prefs.solo.
import { icon } from './icons.js';
import { CONTROLLER_KINDS } from './controller-model.js';
import { resolveRecent } from './query.js';
import { pickSoloController } from './solo.js';
import {
    SOLO_SCREEN_ID, SOLO_INSTRUMENT_OPTIONS, soloLibraryParams, soloPickFilters, soloListLabel, libraryUrl,
    soloPlayRequest, soloAvailability, nextSoloItem, soloFields, soloSoundMode, soloSoundModePatch,
} from './solo-screen-model.js';

export { SOLO_SCREEN_ID };

const PAGE_SIZE = 100;
const SEARCH_DELAY_MS = 250;
const PICK_TITLE = 'Solo: pick a song';

const seg = (field, pairs) => `<div class="rhs-seg" data-field="${field}">`
    + pairs.map(([v, l]) => `<button type="button" data-value="${v}">${l}</button>`).join('') + '</div>';
const field = (id, label, pairs) => `<div class="rhs-field" data-solo-field="${id}"><span class="rhs-label">${label}</span>${seg(id, pairs)}</div>`;

// The screen's skeleton, set as the solo screen element's innerHTML (screen.js).
export const SOLO_SCREEN_HTML = '<div id="rockherosmith-solo-root" class="rhs-screen rhs-solo">'
    + '<section class="rhs-solo-main">'
    + '<div class="rhs-solo-head"><h1 class="rhs-step">Solo</h1>'
    + '<button type="button" class="rhs-solo-band">Band setup</button></div>'
    + field('instrument', 'Instrument', SOLO_INSTRUMENT_OPTIONS.map((o) => [o.id, o.label]))
    + '<div class="rhs-solo-fields">'
    + field('part', 'Part', [['guitar', 'Lead'], ['rhythm', 'Rhythm'], ['bass', 'Bass']])
    + field('arrangement', 'Arrangement', [['Lead', 'Lead'], ['Rhythm', 'Rhythm'], ['Bass', 'Bass']])
    + field('difficulty', 'Difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert']])
    + field('soundMode', 'Drum sound', [['rockband', 'Rock Band'], ['song', 'Song + pads'], ['kit', 'Kit only']])
    + '</div>'
    + '<div class="rhs-solo-status" role="status"><span class="rhs-solo-status-text"></span>'
    + '<button type="button" class="rhs-solo-controls" hidden>Controls</button></div>'
    + '<div class="rhs-solo-opts">'
    + field('crowd', 'Crowd meter', [['on', 'On'], ['off', 'Off']])
    + field('failMode', 'Failing', [['nofail', 'No fail'], ['fail', 'Fail on']])
    + field('autoNext', 'Next song', [['off', 'Back to this list'], ['on', 'Play the next one']])
    + '</div>'
    + '<div class="rhs-solo-listhead"><h2 class="rhs-solo-listlabel"></h2>'
    + '<input type="search" class="rhs-solo-search" placeholder="Search songs" aria-label="Search songs">'
    + '<button type="button" class="rhs-solo-browse">Browse library</button></div>'
    + '<div class="rhs-solo-note" aria-live="polite"></div>'
    + '<ol class="rhs-solo-list"></ol>'
    + '<button type="button" class="rhs-solo-more" hidden>More songs</button>'
    + '</section></div>';

// The solo screen's `.screen` element next to the band screen (#plugin-rockherosmith),
// created once; a re-run (plugin reload) reuses it. -> the element, or null.
export function mountSoloScreenElement(doc, bandEl) {
    if (!doc || !bandEl || !bandEl.parentNode) return null;
    let el = doc.getElementById(SOLO_SCREEN_ID);
    if (!el) {
        el = doc.createElement('div');
        el.id = SOLO_SCREEN_ID;
        el.className = 'screen';
        el.setAttribute('data-plugin-id', 'rockherosmith');
        bandEl.parentNode.insertBefore(el, bandEl.nextSibling || null);
    }
    el.innerHTML = SOLO_SCREEN_HTML;
    return el;
}

const BOOL_FIELDS = ['crowd', 'autoNext'];
const CONTROLS_LABEL = { drums: 'Open Drums controls', five_fret: 'Open 5-Fret controls' };

// createSoloScreen({ root, win, doc, loadPrefs, savePrefs, playSolo, openBand, fetchJson?,
//   library?, kinds?, setTimer?, clearTimer? }) -> { open({ next }), playNext(), dispose(), ... }
//   root      the skeleton's #rockherosmith-solo-root
//   playSolo  rockHeroSmith.playSolo (kit / controllers)
//   openBand  shows the band screen's setup
//   library   core's feedBack.library (pick), for Browse library
export function createSoloScreen({
    root, win, doc, loadPrefs, savePrefs, playSolo, openBand, fetchJson,
    library = win && win.feedBack && win.feedBack.library,
    kinds = CONTROLLER_KINDS,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
    const fb = win && win.feedBack;
    const getJson = fetchJson || ((url) => win.fetch(url).then((r) => r.json()));
    const $ = (sel, el = root) => el.querySelector(sel);
    const cleanups = [];
    const listen = (target, type, fn) => {
        target.addEventListener(type, fn);
        cleanups.push(() => target.removeEventListener(type, fn));
    };
    const safe = (fn, d = null) => { try { return fn(); } catch (_) { return d; } };

    let prefs = loadPrefs();
    let disposed = false;
    let list = [];           // the loaded rows: the remembered list auto-next walks
    let total = 0;
    let page = 0;
    let loadedKey = null;    // the filter + search the list was loaded for
    let listGen = 0;
    let loading = false;
    let listError = '';
    let status = soloAvailability(prefs.solo, { checking: true });
    let checkGen = 0;
    let lastPlayed = null;   // the filename the last solo play started
    let playing = false;     // a play is starting: a burst of clicks / A presses plays once
    let note = '';
    let searchTimer = null;
    let focusOnLoad = false;
    let pendingNext = false; // open({ next }) with auto-next: play once the screen shows

    const showAuto = () => {
        const api = safe(() => kinds.five_fret.api());
        return !!api && typeof api.showAutoCharts === 'function' && safe(() => api.showAutoCharts()) === true;
    };
    const query = () => { const s = $('.rhs-solo-search'); return s ? String(s.value || '') : ''; };
    const params = () => soloLibraryParams(prefs.solo, { showAuto: showAuto() });
    const listKey = () => JSON.stringify([params(), query().trim()]);
    const isActive = () => {
        const el = doc.getElementById(SOLO_SCREEN_ID);
        return !!(el && el.classList.contains('active'));
    };

    // ── Rendering ───────────────────────────────────────────────────────
    function segValue(f) {
        const s = prefs.solo;
        if (f === 'soundMode') return soloSoundMode(prefs, s.instrument);
        if (BOOL_FIELDS.includes(f)) return s[f] ? 'on' : 'off';
        return String(s[f]);
    }

    function render() {
        if (disposed) return;
        const shown = soloFields(prefs.solo.instrument);
        for (const f of root.querySelectorAll('[data-solo-field]')) {
            const id = f.getAttribute('data-solo-field');
            if (Object.prototype.hasOwnProperty.call(shown, id)) f.hidden = !shown[id];
        }
        for (const s of root.querySelectorAll('.rhs-seg')) {
            const v = segValue(s.getAttribute('data-field'));
            for (const b of s.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.getAttribute('data-value') === v));
        }
        const st = $('.rhs-solo-status');
        $('.rhs-solo-status-text').textContent = status.message;
        st.classList.toggle('rhs-warn', !status.ok && !status.checking);
        st.classList.toggle('rhs-ok', status.ok && !!status.message);
        const ctl = $('.rhs-solo-controls');
        ctl.hidden = !status.controls || !controlsApi(status.controls);
        ctl.textContent = CONTROLS_LABEL[status.controls] || 'Controls';
        $('.rhs-solo-listlabel').textContent = soloListLabel(prefs.solo);
        $('.rhs-solo-browse').hidden = !(library && typeof library.pick === 'function');
        $('.rhs-solo-list').classList.toggle('rhs-solo-blocked', blocked());
        let n = note;
        if (!n && loading && !list.length) n = 'Loading songs…';
        if (!n && listError) n = listError;
        if (!n && !loading && !list.length && loadedKey !== null) n = query().trim() ? 'No songs match that search.' : 'No songs with this part yet.';
        $('.rhs-solo-note').textContent = n;
        $('.rhs-solo-more').hidden = loading || list.length >= total;
    }

    function renderList() {
        const ol = $('.rhs-solo-list');
        const rows = list.map((item) => {
            const li = doc.createElement('li');
            const b = doc.createElement('button');
            b.type = 'button';
            b.className = 'rhs-solo-song';
            b.setAttribute('data-filename', item.filename);
            const t = doc.createElement('span');
            t.className = 'rhs-solo-title';
            t.textContent = item.title || item.filename;
            const a = doc.createElement('span');
            a.className = 'rhs-solo-artist';
            a.textContent = item.artist || '';
            b.append(t, a);
            b.addEventListener('click', () => { play(item); });
            li.appendChild(b);
            return li;
        });
        ol.replaceChildren(...rows);
    }

    // ── The song list ───────────────────────────────────────────────────
    // -> Promise; page 0 replaces the list, a later page appends to it.
    function loadList(nextPage = 0) {
        const gen = ++listGen;
        const key = listKey();
        loading = true;
        listError = '';
        if (nextPage === 0) { list = []; total = 0; renderList(); }
        render();
        return Promise.resolve()
            .then(() => getJson(libraryUrl(params(), { q: query(), page: nextPage, size: PAGE_SIZE })))
            .then((json) => {
                if (gen !== listGen || disposed) return;
                const rows = (json && Array.isArray(json.songs) ? json.songs : [])
                    .filter((s) => s && typeof s.filename === 'string' && s.filename);
                list = nextPage === 0 ? rows : list.concat(rows);
                total = json && Number.isFinite(json.total) ? json.total : list.length;
                page = nextPage;
                loadedKey = key;
            })
            .catch((err) => {
                if (gen !== listGen || disposed) return;
                console.warn('[rockherosmith] solo song list failed', err);
                listError = 'The song list couldn\'t load.';
                loadedKey = key;
            })
            .then(() => {
                if (gen !== listGen || disposed) return;
                loading = false;
                renderList();
                render();
                if (focusOnLoad) {
                    focusOnLoad = false;
                    focusFirstSong();
                }
            });
    }

    // Gamepad / keyboard: the first song is focused on arrival, so A or Enter plays it.
    function focusFirstSong() {
        if (!isActive()) return;
        const active = doc.activeElement;
        if (active && active !== doc.body && typeof active.closest === 'function' && active.closest('#rockherosmith-solo-root')) return;
        const first = $('.rhs-solo-song');
        if (first && typeof first.focus === 'function') first.focus();
    }

    // ── Is the instrument there ─────────────────────────────────────────
    const controlsApi = (id) => {
        const api = id === 'drums' ? win && win.feedBackDrums : id === 'five_fret' ? win && win.feedBackFiveFret : null;
        return api && typeof api.openControls === 'function' ? api : null;
    };

    function checkInstrument() {
        const gen = ++checkGen;
        const solo = prefs.solo;
        status = soloAvailability(solo, { checking: true });
        render();
        const drums = win && win.feedBackDrums;
        const env = { drums: !!drums, fiveFret: !!(win && win.feedBackFiveFret) };
        const work = (async () => {
            if (solo.instrument === 'kit' && drums) {
                if (typeof drums.whenMidiReady === 'function') {
                    try { await drums.whenMidiReady(); } catch (_) { /* ask midiInput anyway */ }
                }
                env.midi = typeof drums.midiInput === 'function' ? safe(() => drums.midiInput()) : null;
            } else if (solo.instrument === 'drums' || solo.instrument === 'five_fret') {
                env.controller = await pickSoloController(solo.instrument, kinds);
            }
        })();
        return work.catch(() => {}).then(() => {
            if (gen !== checkGen || disposed) return;
            status = soloAvailability(solo, env);
            render();
        });
    }

    // Playing waits for nothing but a missing instrument (real guitar always plays; a
    // check still running doesn't block: playSolo waits for MIDI itself).
    const blocked = () => !status.ok && !status.checking;

    // ── Playing ─────────────────────────────────────────────────────────
    // -> Promise<'started' | 'setup' | false>
    async function play(item) {
        if (disposed || playing) return false;
        if (blocked()) { note = status.message; render(); return false; }
        const req = soloPlayRequest(prefs.solo, item);
        if (!req) return false;
        note = '';
        playing = true;
        try {
            if (req.via === 'playSongAs') {
                const ui = fb && fb.ui;
                let ok = false;
                if (ui && typeof ui.playSongAs === 'function') ok = safe(() => ui.playSongAs(req.filename, req.opts)) !== false;
                else if (typeof win.playSong === 'function') {
                    const target = encodeURIComponent(req.filename);
                    ok = safe(() => (Number.isInteger(req.opts.arrangement) ? win.playSong(target, req.opts.arrangement) : win.playSong(target)), false) !== false;
                }
                if (ok) lastPlayed = req.filename;
                else { note = 'That song couldn\'t start.'; render(); }
                return ok ? 'started' : false;
            }
            let r = false;
            try { r = await playSolo(req.item, req.opts); } catch (err) { console.warn('[rockherosmith] solo play failed', err); }
            if (r === 'started') lastPlayed = req.item.filename;
            if (r === false && !disposed) { note = 'That song couldn\'t start (is a song already playing?).'; render(); }
            return r;
        } finally {
            playing = false;
        }
    }

    // Auto-next: the song after the last one played, from the remembered list (one
    // more page is fetched when it ends there). -> Promise<'started' | 'setup' | false>
    async function playNext() {
        if (disposed || !lastPlayed) return false;
        let next = nextSoloItem(list, lastPlayed);
        const atEnd = list.length > 0 && list[list.length - 1].filename === lastPlayed;
        if (!next && atEnd && list.length < total) {
            await loadList(page + 1);
            next = nextSoloItem(list, lastPlayed);
        }
        if (!next) {
            note = list.some((it) => it.filename === lastPlayed) ? 'That was the last song in the list.' : '';
            render();
            return false;
        }
        return play(next);
    }

    // ── Choices ─────────────────────────────────────────────────────────
    function choose(f, value) {
        let patch;
        if (f === 'soundMode') patch = soloSoundModePatch(prefs.solo.instrument, value);
        else if (BOOL_FIELDS.includes(f)) patch = { solo: { [f]: value === 'on' } };
        else patch = { solo: { [f]: value } };
        if (!patch) return;
        prefs = savePrefs(patch) || loadPrefs();
        note = '';
        if (f === 'instrument') checkInstrument();
        if (listKey() !== loadedKey) loadList(0);
        render();
    }

    for (const s of root.querySelectorAll('.rhs-seg')) {
        const f = s.getAttribute('data-field');
        for (const b of s.querySelectorAll('button')) listen(b, 'click', () => choose(f, b.getAttribute('data-value')));
    }
    // Instrument icons.
    for (const o of SOLO_INSTRUMENT_OPTIONS) {
        const b = root.querySelector(`.rhs-seg[data-field="instrument"]`).querySelector(`button[data-value="${o.id}"]`);
        if (!b) continue;
        const i = doc.createElement('span');
        i.className = 'rhs-solo-ico';
        i.innerHTML = icon(o.icon, { size: 18 });
        b.prepend(i);
    }

    listen($('.rhs-solo-search'), 'input', () => {
        if (searchTimer !== null) clearTimer(searchTimer);
        searchTimer = setTimer(() => { searchTimer = null; if (listKey() !== loadedKey) loadList(0); }, SEARCH_DELAY_MS);
    });
    listen($('.rhs-solo-more'), 'click', () => { if (!loading) loadList(page + 1); });
    listen($('.rhs-solo-band'), 'click', () => { if (typeof openBand === 'function') openBand(); });
    listen($('.rhs-solo-controls'), 'click', () => {
        const api = controlsApi(status.controls);
        if (api) safe(() => api.openControls({ returnTo: SOLO_SCREEN_ID }));
    });

    // Browse library: core's Song Library in pick mode, filtered the same way; the
    // picked song plays straight away (its full row first, as the band pick does).
    let pickGen = 0;
    listen($('.rhs-solo-browse'), 'click', () => {
        if (!library || typeof library.pick !== 'function') return;
        const gen = ++pickGen;
        let pending;
        try {
            pending = library.pick({
                title: PICK_TITLE,
                filters: soloPickFilters(prefs.solo, { showAuto: showAuto() }),
                returnTo: SOLO_SCREEN_ID, confirmLabel: 'Play', backLabel: 'Back to Solo',
            });
        } catch (err) {
            console.warn('[rockherosmith] library pick failed', err);
            return;
        }
        Promise.resolve(pending).then(async (result) => {
            const item = result && result.item;
            if (gen !== pickGen || disposed || !item) return;
            const full = item.title ? await resolveRecent({ filename: item.filename, title: item.title }, getJson) : null;
            if (gen !== pickGen || disposed) return;
            await play(full || item);
        }).catch((err) => console.warn('[rockherosmith] library pick failed', err));
    });

    // ── Showing ─────────────────────────────────────────────────────────
    // Auto-next waits for the screen: the session's teardown and this screen's switch
    // are done before the next song starts its own.
    function onShow() {
        prefs = loadPrefs();
        note = '';
        checkInstrument();
        const next = pendingNext;
        pendingNext = false;
        if (listKey() !== loadedKey) {
            focusOnLoad = !next;
            const loaded = loadList(0);
            if (next) loaded.then(() => playNext());
            return;
        }
        render();
        if (next) playNext(); else focusFirstSong();
    }
    const onChanged = (e) => {
        const d = (e && e.detail) || {};
        if (d.id === SOLO_SCREEN_ID) onShow();
    };
    if (fb && typeof fb.on === 'function') {
        fb.on('screen:changed', onChanged);
        cleanups.push(() => { if (typeof fb.off === 'function') fb.off('screen:changed', onChanged); });
    }
    render();
    if (isActive()) onShow();

    return {
        // Shows the Solo screen; { next: true } (Results' Next song) plays the next song
        // in the list when auto-next is on.
        open(opts = {}) {
            if (disposed) return;
            pendingNext = !!(opts && opts.next) && loadPrefs().solo.autoNext === true && !!lastPlayed;
            if (isActive()) { onShow(); return; }
            if (typeof win.showScreen === 'function') safe(() => win.showScreen(SOLO_SCREEN_ID));
        },
        play,
        playNext,
        lastPlayed: () => lastPlayed,
        list: () => list.slice(),
        status: () => status,
        dispose() {
            if (disposed) return;
            disposed = true;
            listGen++;
            checkGen++;
            pickGen++;
            if (searchTimer !== null) clearTimer(searchTimer);
            for (const fn of cleanups.splice(0)) safe(fn);
        },
    };
}

// rockHeroSmith.openSolo (contract §1): the Solo screen, else (not built: no screen
// element) the band screen as before.
export function createOpenSolo({ getSoloScreen, getScreen, showScreen }) {
    return function openSolo(opts = {}) {
        const solo = getSoloScreen();
        if (solo && typeof solo.open === 'function') { solo.open(opts || {}); return; }
        showScreen('plugin-rockherosmith');
        if (opts && opts.next) {
            const screen = getScreen();
            if (screen && typeof screen.nextSong === 'function') screen.nextSong();
        }
    };
}
