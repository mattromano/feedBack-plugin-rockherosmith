// The band HUD: a bar across the top of #player (band score, stars, song, BAND ×N and
// the band bonus) and one overlay per playing part in its lane or the vocal strip
// (tag, overdrive bar, multiplier, crowd meter, edge glow, callouts).
// Every element is built once and cached; update() runs on ledger changes only and
// writes a value to the DOM only when it changed. No DOM queries after build.
import { icon } from './icons.js';
import { playerStyle } from './players.js';
import { CROWD } from './band-score.js';
import { starDisplay } from './stars.js';
import {
    formatScore, crowdZone, glowLevel, GLOW_MIN, streakCallout, bandMultiplierText,
} from './hud-model.js';

const STAR_COUNT = 5;
const ZONES = ['red', 'yellow', 'green'];

// Restarts a CSS animation class. The forced reflow only happens on a callout or a
// broken streak, never per frame.
function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
}

const pct = (v) => Math.round(v * 100) + '%';

// crowd: false leaves the crowd meters out (a solo with the Solo screen's crowd meter off).
// slim: a solo whose lane shows its own HUD (score, streak, multiplier, star power): the
// bar keeps the song and stars only (no score, no BAND ×N, no band bonus), and the lane
// overlay only the crowd meter (none when the crowd is off).
export function createBandHud({ doc, player, stage, parts, prefs, song, oneLevel, crowd: showCrowd = true, slim = false }) {
    const el = (tag, cls, parent) => {
        const e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (parent) parent.appendChild(e);
        return e;
    };
    // Last value written per element+key, so unchanged values never touch the DOM.
    const written = new Map();
    function put(node, key, value, write) {
        let seen = written.get(node);
        if (!seen) { seen = {}; written.set(node, seen); }
        if (seen[key] === value) return;
        seen[key] = value;
        write(value);
    }
    const text = (node, value) => put(node, 'text', value, (v) => { node.textContent = v; });
    const flag = (node, cls, on) => put(node, cls, on, (v) => { node.classList.toggle(cls, v); });

    // ── The bar ──
    const bar = el('div', slim ? 'rhs-hud rhs-hud-slim' : 'rhs-hud');
    const scoreEl = slim ? null : el('span', 'rhs-hud-score', bar);
    if (scoreEl) scoreEl.textContent = '0';
    const starsEl = el('span', 'rhs-hud-stars', bar);
    starsEl.setAttribute('aria-hidden', 'true');
    const fills = [];
    for (let i = 0; i < STAR_COUNT; i++) {
        const star = el('span', 'rhs-star', starsEl);
        star.innerHTML = icon('star', { size: 18 });
        const fill = el('span', 'rhs-star-fill', star);
        fill.innerHTML = icon('star', { size: 18 });
        fill.style.width = '0%';
        fills.push(fill);
    }
    const songEl = el('span', 'rhs-hud-song', bar);
    const s = song || {};
    songEl.textContent = [s.title, s.artist].filter((v) => typeof v === 'string' && v).join(' · ');
    const band = slim ? null : el('div', 'rhs-hud-band', bar);
    const multEl = band && el('span', 'rhs-hud-mult', band);
    if (multEl) multEl.textContent = bandMultiplierText(1);
    const bonusEl = band && el('span', 'rhs-hud-bonus', band);
    player.appendChild(bar);

    // ── Each part ──
    const huds = new Map();
    for (const part of Array.isArray(parts) ? parts : []) {
        const host = part === 'vocals' ? stage && stage.stripSlot : stage && stage.laneSlot && stage.laneSlot(part);
        if (!host || huds.has(part)) continue;
        // Slim: the lane draws its own tag-free HUD; only the crowd meter is the band's.
        if (slim) {
            if (!showCrowd) { huds.set(part, { slim: true, host }); continue; }
            const root = el('div', 'rhs-part-hud rhs-part-hud-slim');
            root.setAttribute('data-part', part);
            const marker = el('i', '', el('div', 'rhs-crowd', root));
            marker.style.bottom = pct(CROWD.start);
            marker.classList.add('rhs-crowd-' + crowdZone(CROWD.start));
            host.appendChild(root);
            huds.set(part, { slim: true, root, host, marker });
            continue;
        }
        const ctl = ((prefs && prefs.controllers) || []).find((c) => c && c.id === part);
        const style = playerStyle(part, prefs, { oneLevel, sourceKind: ctl && ctl.sourceKind });
        const root = el('div', 'rhs-part-hud');
        root.setAttribute('data-part', part);
        if (style.color) root.style.setProperty('--rhs-c', style.color);
        const glow = el('div', 'rhs-glow', root);
        glow.style.setProperty('--rhs-glow', String(GLOW_MIN));
        const lane = el('div', 'rhs-lanehud', root);
        const tag = el('span', 'rhs-tag', lane);
        tag.innerHTML = icon(style.icon, { size: 14 });
        el('span', 'rhs-tag-text', tag).textContent = style.tag;
        const od = el('span', 'rhs-od', lane);
        const odFill = el('i', '', od);
        odFill.style.width = '0%';
        const mult = el('span', 'rhs-mult', lane);
        mult.textContent = '×1';
        let marker = null;
        if (showCrowd) {
            const crowd = el('div', 'rhs-crowd', root);
            marker = el('i', '', crowd);
            // R6's starting crowd, so the marker doesn't sit at the floor and slide on the first update.
            marker.style.bottom = pct(CROWD.start);
            marker.classList.add('rhs-crowd-' + crowdZone(CROWD.start));
        }
        // Guitar only: the glowing band across the lower third while the Noodle it up zone is open.
        if (part === 'guitar') el('div', 'rhs-noodle-zone', root).setAttribute('aria-hidden', 'true');
        const callout = el('div', 'rhs-callout', root);
        callout.setAttribute('role', 'status');
        host.appendChild(root);
        huds.set(part, { calloutKind: style.calloutKind, root, host, glow, odFill, mult, marker, callout });
    }

    let prev = null;
    let alive = true;

    // opts.silent: write the values but fire no callouts and no miss flash (replays
    // and seek-driven updates, Task 12).
    function update(snapshot, opts) {
        if (!alive || !snapshot) return;
        const silent = !!(opts && opts.silent);
        if (scoreEl) text(scoreEl, formatScore(snapshot.score));
        const { full, partial, gold } = starDisplay(snapshot.stars);
        fills.forEach((fill, i) => {
            const share = i < full ? 1 : i === full ? partial : 0;
            put(fill, 'width', pct(share), (v) => { fill.style.width = v; });
        });
        flag(starsEl, 'rhs-gold', gold);
        if (band) {
            const n = Number.isFinite(snapshot.bandMultiplier) ? snapshot.bandMultiplier : 1;
            text(multEl, bandMultiplierText(n));
            flag(multEl, 'rhs-hot', n >= 2);
            text(bonusEl, snapshot.bonus > 0 ? '+' + formatScore(snapshot.bonus) + ' bonus' : '');
        }

        const sp = snapshot.parts || {};
        for (const [part, h] of huds) {
            const p = sp[part];
            if (!p) continue;
            if (h.slim) {
                if (h.marker) {
                    const c = Number.isFinite(p.crowd) ? Math.min(1, Math.max(0, p.crowd)) : 0;
                    put(h.marker, 'bottom', pct(c), (v) => { h.marker.style.bottom = v; });
                    const zone = crowdZone(c);
                    for (const z of ZONES) flag(h.marker, 'rhs-crowd-' + z, z === zone);
                }
                continue;
            }
            text(h.mult, '×' + (Number.isFinite(p.multiplier) ? p.multiplier : 1));
            if (h.marker) {
                const c = Number.isFinite(p.crowd) ? Math.min(1, Math.max(0, p.crowd)) : 0;
                put(h.marker, 'bottom', pct(c), (v) => { h.marker.style.bottom = v; });
                const zone = crowdZone(c);
                for (const z of ZONES) flag(h.marker, 'rhs-crowd-' + z, z === zone);
            }
            const streak = Number.isFinite(p.streak) ? p.streak : 0;
            put(h.glow, 'level', glowLevel(streak), (v) => { h.glow.style.setProperty('--rhs-glow', String(v)); });
            const before = prev && prev[part];
            if (!before || silent) continue;
            const was = Number.isFinite(before.streak) ? before.streak : 0;
            if (was > 0 && streak === 0) restart(h.glow, 'rhs-glow-miss');
            const line = streakCallout(h.calloutKind, was, streak);
            if (line) show(h, line);
        }
        prev = {};
        for (const part of huds.keys()) {
            if (sp[part]) prev[part] = { streak: sp[part].streak };
        }
    }

    function show(h, line) {
        h.callout.textContent = line;
        restart(h.callout, 'rhs-show');
    }

    return {
        update,
        callout(part, line) {
            const h = alive && huds.get(part);
            if (h && !h.slim) show(h, String(line));
        },
        // Overdrive meter for a part: fill 0..1 and whether it is deployed. Writes changes only.
        setOverdrive(part, fraction, active) {
            const h = alive && huds.get(part);
            if (!h || h.slim) return;
            const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
            put(h.odFill, 'width', pct(f), (v) => { h.odFill.style.width = v; });
            flag(h.root, 'rhs-od-active', !!active);
        },
        // Enough bar to deploy: the bar pulses.
        setReady(part, on) {
            const h = alive && huds.get(part);
            if (h && !h.slim) flag(h.root, 'rhs-od-ready', !!on);
        },
        // The Noodle it up zone on the guitar lane.
        setNoodle(on) {
            const h = alive && huds.get('guitar');
            if (h && !h.slim) flag(h.root, 'rhs-noodle', !!on);
        },
        // Fail mode: the part is out. Greys the lane (or strip) and marks the HUD tag.
        setFailed(part, on) {
            const h = alive && huds.get(part);
            if (!h) return;
            if (h.root) flag(h.root, 'rhs-failed', !!on);
            flag(h.host, 'rhs-failed', !!on);
        },
        destroy() {
            if (!alive) return;
            alive = false;
            bar.remove();
            for (const h of huds.values()) {
                if (h.root) h.root.remove();
                h.host.classList.remove('rhs-failed');
            }
            huds.clear();
            written.clear();
        },
    };
}
