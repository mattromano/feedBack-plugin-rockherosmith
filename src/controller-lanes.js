// Controller lanes in a band song (Plan 3): which player a lane canvas belongs to,
// each lane's score HUD hidden, its engine state and full-chart stars, the
// connected controllers read at Go, and the kinds' lane events dispatched by
// `detail.canvas` to the owning player. The runtime injects everything it owns
// (the stage, the session, the ledger, pause and the leave prompt), so this has
// no DOM and plays nothing. Per-session state lives on the session object:
// s.ctl, s.ctlCanvas, s.hidden.ctl, s.connected.
import { kindFor, isControllerId } from './controller-model.js';
import { fullChartThresholds } from './stars.js';

const LANE_EVENTS = ['sp-activate', 'band-pause', 'band-back-hold'];

function safe(fn) {
    try { return fn(); } catch (e) { console.warn('[rockherosmith]', e); return undefined; }
}

// A controller's kind entry in the registry, or null.
export function kindOf(kinds, prefs, c) {
    const id = kindFor(prefs, c && c.key);
    return kinds && Object.prototype.hasOwnProperty.call(kinds, id) ? kinds[id] : null;
}

// createControllerLanes({ kinds, getStage, realDrumCanvas, getSession, isLive, displayTime, record, onDeploy, onPause, onBackHold, onJudgment })
//   getStage(): the mounted stage, or null; getSession(): the current session, or null
//   realDrumCanvas(s): the canvas the real drummer plays on (a stage lane, or #highway), or null
//   isLive(s): the session is playing with a ledger (its judgments score)
//   displayTime(s), record(s, entry): the runtime's clock and ledger
//   onDeploy(s, id), onPause(s), onBackHold(s): a live lane's sp-activate, Start and held Back
//   onJudgment(s, id, type): a live lane's judgment, after its ledger entry (part audio)
//   hudMode(s, api): what a lane's setScoreHudHidden gets (true | false | 'score'); default true
//   record(s, entry, detail) gets the lane event's detail too (play:judgment timing)
// -> { lanePlayer, laneApiOf, refreshLanes, laneOwner, adoptReplaced, laneState, readConnected, teardown, events, onEvent }
//   events: [{ name, type }], one per bus event name across every kind
export function createControllerLanes({
    kinds, getStage, realDrumCanvas, getSession, isLive, displayTime, record, onDeploy, onPause, onBackHold, onJudgment, hudMode,
}) {
    const laneCanvasOf = (id) => {
        const stage = getStage();
        return stage && typeof stage.getLaneCanvas === 'function' ? stage.getLaneCanvas(id) : null;
    };
    const hasLanes = () => { const stage = getStage(); return !!stage && typeof stage.getLaneCanvas === 'function'; };

    // A controller player's runtime state.
    function lanePlayer(s, id) {
        let p = s.ctl.get(id);
        if (!p) {
            const c = s.prefs.controllers.find((x) => x.id === id);
            p = { kind: c ? kindOf(kinds, s.prefs, c) : null, canvas: null, last: null, thresholds: null };
            s.ctl.set(id, p);
        }
        return p;
    }

    function laneApi(p) {
        return p.kind && typeof p.kind.api === 'function' ? safe(() => p.kind.api()) : null;
    }

    // The controller lanes' canvases from the stage (which follows a canvas
    // replacement), each one's score HUD hidden. A new canvas is a new engine
    // session, so its score delta starts over.
    function refreshLanes(s) {
        s.ctlCanvas.clear();
        if (!hasLanes()) return;
        for (const id of s.scoreParts) {
            if (!isControllerId(id)) continue;
            const canvas = safe(() => laneCanvasOf(id));
            if (!canvas) continue;
            const p = lanePlayer(s, id);
            if (p.canvas !== canvas) { p.canvas = canvas; p.last = null; }
            s.ctlCanvas.set(canvas, id);
            hideLaneHud(s, p, canvas);
        }
    }

    // The player whose lane `canvas` is, or null. The map is rebuilt on a miss
    // or a stale entry (the stage swapped a canvas without telling us).
    function laneOwner(s, canvas) {
        if (!canvas || !hasLanes()) return null;
        // The real drummer's canvas (the hottest drums path) is never a controller's:
        // the stage's drum lane beside a guitar, or #highway for drums alone.
        const stage = getStage();
        if (typeof stage.getDrumCanvas === 'function' && safe(() => stage.getDrumCanvas()) === canvas) return null;
        if (typeof realDrumCanvas === 'function' && safe(() => realDrumCanvas(s)) === canvas) return null;
        const id = s.ctlCanvas.get(canvas);
        if (id && safe(() => laneCanvasOf(id)) === canvas) return id;
        refreshLanes(s);
        return s.ctlCanvas.get(canvas) || null;
    }

    // A lane canvas core replaced (highway:canvas-replaced): the clone is the
    // lane's now, with its score HUD hidden at once (a plugin may not move the
    // hide, and the next judgment could be far off).
    function adoptReplaced(s, oldCanvas, newCanvas) {
        const id = s.ctlCanvas.get(oldCanvas);
        if (!id || !newCanvas) return;
        const p = lanePlayer(s, id);
        s.ctlCanvas.delete(oldCanvas);
        s.ctlCanvas.set(newCanvas, id);
        if (p.canvas !== newCanvas) { p.canvas = newCanvas; p.last = null; }
        hideLaneHud(s, p, newCanvas);
    }

    function hideLaneHud(s, p, canvas) {
        if (s.hidden.ctl.has(canvas)) return;
        const api = laneApi(p);
        if (!api || typeof api.setScoreHudHidden !== 'function') return;
        s.hidden.ctl.set(canvas, api);
        const mode = typeof hudMode === 'function' ? safe(() => hudMode(s, api)) : true;
        safe(() => api.setScoreHudHidden(canvas, mode === undefined ? true : mode));
    }

    // After the stage unmounts: the lanes' score HUDs come back (their canvases
    // went with it; a replay hides its own new lanes).
    function teardown(s) {
        for (const [canvas, api] of s.hidden.ctl) safe(() => api.setScoreHudHidden(canvas, false));
        s.hidden.ctl.clear();
        s.ctlCanvas.clear();
    }

    // The lane engine's state (getInstanceState), or null.
    function laneState(s, id) {
        const p = lanePlayer(s, id);
        const api = laneApi(p);
        const canvas = laneCanvasOf(id);
        if (!canvas || !api || typeof api.getInstanceState !== 'function') return null;
        return api.getInstanceState(canvas);
    }

    // Stars over the full chart (Decision 8): the engine's starThresholds. By
    // default set once the lane reports them; a kind with `thresholds: 'largest'`
    // (drums, whose engine rebuilds from a seek) re-reads them on every judgment
    // and keeps the set with the largest final value, as the real drummer does (M6).
    function syncLaneThresholds(s, id, p) {
        const largest = !!p.kind && p.kind.thresholds === 'largest';
        if (p.thresholds && !largest) return;
        const th = safe(() => { const st = laneState(s, id); return st && st.starThresholds; });
        const next = fullChartThresholds(largest ? p.thresholds : null, th);
        if (!next) return;
        p.thresholds = next;
        safe(() => s.score.setStarThresholds(id, next.slice()));
    }

    // The connected controllerKeys, read once per session through each kind's
    // API (a Promise, Ruling 4). Go never waits for it: the mount applies
    // whatever came back by then, and a list that hasn't (or failed) counts
    // as nobody connected.
    function readConnected(s) {
        const apis = new Set();
        for (const c of s.prefs.controllers) {
            if (c.on !== true) continue;
            const api = laneApi({ kind: kindOf(kinds, s.prefs, c) });
            if (api && typeof api.listControllers === 'function') apis.add(api);
        }
        if (!apis.size) return;
        const lists = [...apis].map((api) => Promise.resolve().then(() => api.listControllers()).catch((e) => {
            console.warn('[rockherosmith] could not list controllers', e);
            return [];
        }));
        Promise.all(lists).then((all) => {
            const keys = new Set();
            for (const list of all) {
                for (const e of Array.isArray(list) ? list : []) {
                    if (e && e.connected === true && typeof e.controllerKey === 'string') keys.add(e.controllerKey);
                }
            }
            s.connected = keys;
        });
    }

    // One handler per event name for every kind (Ruling 9), dispatching by
    // detail.canvas to the player whose lane it is; events from any other
    // canvas are ignored. Judgments score through the player's kind (`entry`),
    // its score delta tracked per lane on every judgment, even ones the ledger
    // ignores (a dropped-out player), so points scored while out never land
    // later. Start and a held Back are the band's pause and leave prompt
    // (Ruling 7): a pinned lane never pauses.
    function onEvent(type, e) {
        const s = getSession();
        const d = e && e.detail;
        if (!s || !d || typeof d !== 'object') return;
        const id = laneOwner(s, d.canvas);
        if (!id) return;
        const live = isLive(s);
        if (type === 'band-pause') {
            if (live) onPause(s);
            return;
        }
        if (type === 'band-back-hold') {
            if (live) onBackHold(s);
            return;
        }
        if (type === 'sp-activate') {
            if (live) onDeploy(s, id);
            return;
        }
        const p = lanePlayer(s, id);
        if (!p.kind || !Array.isArray(p.kind.judgments) || !p.kind.judgments.includes(type)) return;
        const entry = live && typeof p.kind.entry === 'function' ? safe(() => p.kind.entry(type, d, displayTime(s), id, p.last)) : null;
        if (Number.isFinite(d.score)) {
            if (!p.last) p.last = { score: 0, resets: undefined };
            p.last.score = d.score;
            p.last.resets = d.resets;
        }
        if (entry) {
            syncLaneThresholds(s, id, p);
            record(s, entry, d);
        }
        if (live && typeof onJudgment === 'function') onJudgment(s, id, type);
    }

    const events = [];
    const names = new Set();
    for (const kind of Object.values(kinds || {})) {
        const prefix = kind && kind.eventPrefix;
        if (typeof prefix !== 'string' || !prefix) continue;
        for (const type of [...(Array.isArray(kind.judgments) ? kind.judgments : []), ...LANE_EVENTS]) {
            const name = prefix + ':' + type;
            if (names.has(name)) continue;
            names.add(name);
            events.push({ name, type });
        }
    }

    // A controller player's plugin API (its kind's), or null.
    const laneApiOf = (s, id) => laneApi(lanePlayer(s, id));

    return { lanePlayer, laneApiOf, refreshLanes, laneOwner, adoptReplaced, laneState, readConnected, teardown, events, onEvent };
}
