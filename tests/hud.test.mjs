// createBandHud against the fake DOM and a fake stage exposing laneSlot / stripSlot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBandHud } from '../src/hud.js';
import { readFileSync } from 'node:fs';
import { makeDoc, makeEl } from './fake-dom.mjs';

const PREFS = {
    parts: {
        guitar: { on: true, arrangement: 'Lead', difficulty: 'hard' },
        drums: { on: true, difficulty: 'expert' },
        vocals: { on: true, difficulty: 'medium' },
    },
};

function setup({ parts = ['guitar', 'drums'], strip = false, oneLevel = false, lanes = parts } = {}) {
    const doc = makeDoc();
    const player = makeEl('div', doc);
    player.setAttribute('id', 'player');
    doc.body.appendChild(player);
    const slots = {};
    for (const p of lanes) {
        if (p === 'vocals') continue;
        slots[p] = makeEl('div', doc);
        player.appendChild(slots[p]);
    }
    const stripSlot = strip ? makeEl('div', doc) : null;
    if (stripSlot) player.appendChild(stripSlot);
    const stage = { laneSlot: (p) => slots[p] || null, stripSlot };
    const hud = createBandHud({
        doc, player, stage, parts, prefs: PREFS, song: { title: 'Holiday', artist: 'Green Day' }, oneLevel,
    });
    const partHud = (p) => player.querySelector(`.rhs-part-hud[data-part="${p}"]`);
    return { doc, player, slots, stripSlot, hud, partHud };
}

function part(over = {}) {
    return { score: 0, bonus: 0, multiplier: 1, streak: 0, crowd: 0.66, stars: null, ...over };
}

function snap(over = {}, parts = {}) {
    return {
        score: 0, bonus: 0, bandMultiplier: 1, stars: null,
        parts: { guitar: part(parts.guitar), drums: part(parts.drums), vocals: part(parts.vocals) },
        ...over,
    };
}

test('builds the bar and one HUD per playing part', () => {
    const { player, slots, hud, partHud } = setup();
    assert.equal(player.querySelectorAll('.rhs-hud').length, 1);
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 2);
    assert.equal(player.querySelector('.rhs-hud-song').textContent, 'Holiday · Green Day');
    assert.equal(partHud('guitar').parentNode, slots.guitar);
    assert.equal(partHud('drums').parentNode, slots.drums);
    assert.equal(partHud('guitar').style.props['--rhs-c'], '#f5c542');
    assert.equal(partHud('drums').style.props['--rhs-c'], '#e0533d');
    assert.equal(partHud('guitar').querySelector('.rhs-tag').textContent, 'Lead · Hard');
    assert.ok(partHud('guitar').querySelector('.rhs-tag').innerHTML.includes('<svg'), 'tag icon');
    assert.equal(partHud('drums').querySelector('.rhs-tag').textContent, 'Drums · Expert');
    assert.equal(partHud('guitar').querySelector('.rhs-od').querySelector('i').style.width, '0%');
    assert.equal(player.querySelectorAll('.rhs-star').length, 5);
    hud.destroy();
});

test('one-level guitar charts say so in the tag', () => {
    const { hud, partHud } = setup({ parts: ['guitar'], oneLevel: true });
    assert.equal(partHud('guitar').querySelector('.rhs-tag').textContent, 'Lead · One level');
    hud.destroy();
});

test('update shows score, band multiplier, bonus, crowd and multiplier', () => {
    const { player, hud, partHud } = setup();
    const mult = player.querySelector('.rhs-hud-mult');
    assert.equal(mult.textContent, 'BAND ×1');
    assert.equal(mult.classList.contains('rhs-hot'), false);
    assert.equal(player.querySelector('.rhs-hud-bonus').textContent, '');
    hud.update(snap({ score: 1234, bonus: 87, bandMultiplier: 2 }, { guitar: { multiplier: 3, crowd: 0.66 }, drums: { crowd: 0.1 } }));
    assert.equal(player.querySelector('.rhs-hud-score').textContent, '1,234');
    assert.equal(mult.textContent, 'BAND ×2');
    assert.ok(mult.classList.contains('rhs-hot'));
    assert.equal(player.querySelector('.rhs-hud-bonus').textContent, '+87 bonus');
    assert.equal(partHud('guitar').querySelector('.rhs-mult').textContent, '×3');
    const crowd = partHud('guitar').querySelector('.rhs-crowd').querySelector('i');
    assert.equal(crowd.style.bottom, '66%');
    assert.ok(crowd.classList.contains('rhs-crowd-green'));
    const drumsCrowd = partHud('drums').querySelector('.rhs-crowd').querySelector('i');
    assert.equal(drumsCrowd.style.bottom, '10%');
    assert.ok(drumsCrowd.classList.contains('rhs-crowd-red'));
    hud.update(snap({ bandMultiplier: 1 }, { drums: { crowd: 0.4 } }));
    assert.equal(mult.classList.contains('rhs-hot'), false);
    assert.equal(player.querySelector('.rhs-hud-bonus').textContent, '');
    assert.ok(drumsCrowd.classList.contains('rhs-crowd-yellow'));
    assert.equal(drumsCrowd.classList.contains('rhs-crowd-red'), false);
    hud.destroy();
});

test('stars fill by share and turn gold at 6', () => {
    const { player, hud } = setup();
    const fills = () => player.querySelectorAll('.rhs-star-fill').map((f) => f.style.width);
    hud.update(snap({ stars: 2.5 }));
    assert.deepEqual(fills(), ['100%', '100%', '50%', '0%', '0%']);
    assert.equal(player.querySelector('.rhs-hud-stars').classList.contains('rhs-gold'), false);
    hud.update(snap({ stars: 6 }));
    assert.deepEqual(fills(), ['100%', '100%', '100%', '100%', '100%']);
    assert.ok(player.querySelector('.rhs-hud-stars').classList.contains('rhs-gold'));
    hud.update(snap({ stars: null }));
    assert.deepEqual(fills(), ['0%', '0%', '0%', '0%', '0%']);
    hud.destroy();
});

test('a streak milestone pops a callout', () => {
    const { hud, partHud } = setup();
    const co = partHud('guitar').querySelector('.rhs-callout');
    hud.update(snap({}, { guitar: { streak: 49 } }));
    assert.equal(co.textContent, '');
    assert.equal(co.classList.contains('rhs-show'), false);
    hud.update(snap({}, { guitar: { streak: 50 } }));
    assert.equal(co.textContent, '50 NOTE STREAK!');
    assert.ok(co.classList.contains('rhs-show'));
    assert.equal(partHud('drums').querySelector('.rhs-callout').textContent, '');
    hud.destroy();
});

test('the first update never pops a callout (a HUD rebuilt mid-song)', () => {
    const { hud, partHud } = setup();
    hud.update(snap({}, { guitar: { streak: 50 } }));
    assert.equal(partHud('guitar').querySelector('.rhs-callout').textContent, '');
    hud.destroy();
});

test('glow follows the streak and flashes when it breaks', () => {
    const { hud, partHud } = setup();
    const glow = partHud('guitar').querySelector('.rhs-glow');
    assert.equal(glow.style.props['--rhs-glow'], '0.15');
    hud.update(snap({}, { guitar: { streak: 25 } }));
    assert.equal(glow.style.props['--rhs-glow'], '0.575');
    assert.equal(glow.classList.contains('rhs-glow-miss'), false);
    hud.update(snap({}, { guitar: { streak: 0 } }));
    assert.equal(glow.style.props['--rhs-glow'], '0.15');
    assert.ok(glow.classList.contains('rhs-glow-miss'));
    hud.destroy();
});

test('callout() sets the text and shows it', () => {
    const { hud, partHud } = setup();
    hud.callout('drums', 'HELLO');
    const co = partHud('drums').querySelector('.rhs-callout');
    assert.equal(co.textContent, 'HELLO');
    assert.ok(co.classList.contains('rhs-show'));
    hud.callout('keys', 'nothing');
    hud.destroy();
});

test('setOverdrive fills the bar and writes only changes', () => {
    const { hud, partHud } = setup();
    hud.setOverdrive('guitar', 0.42, true);
    assert.equal(partHud('guitar').querySelector('.rhs-od').querySelector('i').style.width, '42%');
    assert.ok(partHud('guitar').classList.contains('rhs-od-active'));
    hud.setOverdrive('guitar', 2, false);
    assert.equal(partHud('guitar').querySelector('.rhs-od').querySelector('i').style.width, '100%');
    assert.equal(partHud('guitar').classList.contains('rhs-od-active'), false);
    hud.destroy();
});

test('overdrive bar, ready pulse and active glow', () => {
    const { hud, partHud } = setup();
    const fill = partHud('guitar').querySelector('.rhs-od').querySelector('i');
    hud.setOverdrive('guitar', 0.5, false);
    assert.equal(fill.style.width, '50%');
    assert.equal(partHud('guitar').classList.contains('rhs-od-active'), false);
    hud.setReady('guitar', true);
    assert.ok(partHud('guitar').classList.contains('rhs-od-ready'));
    hud.setOverdrive('guitar', 0.4, true);
    assert.ok(partHud('guitar').classList.contains('rhs-od-active'));
    hud.setReady('guitar', false);
    assert.equal(partHud('guitar').classList.contains('rhs-od-ready'), false);
    assert.equal(partHud('drums').classList.contains('rhs-od-ready'), false);
    hud.destroy();
});

test('noodle zone only on guitar', () => {
    const { hud, partHud } = setup();
    assert.equal(partHud('guitar').querySelectorAll('.rhs-noodle-zone').length, 1);
    assert.equal(partHud('guitar').querySelector('.rhs-noodle-zone').getAttribute('aria-hidden'), 'true');
    assert.equal(partHud('drums').querySelectorAll('.rhs-noodle-zone').length, 0);
    hud.setNoodle(true);
    assert.ok(partHud('guitar').classList.contains('rhs-noodle'));
    assert.equal(partHud('drums').classList.contains('rhs-noodle'), false);
    hud.setNoodle(false);
    assert.equal(partHud('guitar').classList.contains('rhs-noodle'), false);
    hud.destroy();
});

test('dropped out greys the lane and the HUD; destroy clears it', () => {
    const { slots, hud, partHud } = setup();
    hud.setFailed('drums', true);
    assert.ok(partHud('drums').classList.contains('rhs-failed'));
    assert.ok(slots.drums.classList.contains('rhs-failed'));
    assert.equal(slots.guitar.classList.contains('rhs-failed'), false);
    hud.setFailed('drums', false);
    assert.equal(slots.drums.classList.contains('rhs-failed'), false);
    hud.setFailed('drums', true);
    hud.setFailed('guitar', true);
    hud.destroy();
    assert.equal(slots.drums.classList.contains('rhs-failed'), false);
    assert.equal(slots.guitar.classList.contains('rhs-failed'), false);
});

test('unknown parts and a destroyed HUD are ignored', () => {
    const { hud } = setup();
    hud.setFailed('bass', true);
    hud.setReady('bass', true);
    hud.setNoodle(true);
    hud.destroy();
    hud.setFailed('drums', true);
    hud.setReady('guitar', true);
    hud.setNoodle(true);
    hud.setOverdrive('guitar', 1, true);
});

test('guitar-less band: setNoodle is a no-op', () => {
    const { hud } = setup({ parts: ['drums'] });
    hud.setNoodle(true);
    hud.destroy();
});

test('CSS: overdrive blue, noodle zone, dropped-out grey and reduced motion', () => {
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    assert.match(css, /\.rhs-od-ready \.rhs-od \{[^}]*#5cc8ff/);
    assert.match(css, /\.rhs-noodle-zone \{[^}]*display: none/);
    assert.match(css, /\.rhs-noodle \.rhs-noodle-zone \{[^}]*display: block/);
    assert.match(css, /\.rhs-lane\.rhs-failed, #player \.rhs-strip\.rhs-failed \{[^}]*filter: grayscale\(1\) brightness\(0\.6\)/);
    assert.match(css, /\.rhs-part-hud\.rhs-failed \.rhs-tag::after \{[^}]*content: ' · OUT'/);
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n    #player .rhs-callout'));
    assert.match(rm.slice(0, rm.indexOf('@keyframes rhs-fade')), /rhs-od-ready[^}]*animation: none/);
});

test('the vocals HUD lives in the strip slot', () => {
    const { stripSlot, hud, partHud } = setup({ parts: ['guitar', 'vocals'], strip: true });
    assert.equal(partHud('vocals').parentNode, stripSlot);
    assert.equal(partHud('vocals').style.props['--rhs-c'], '#a678ff');
    assert.equal(partHud('vocals').querySelector('.rhs-tag').textContent, 'Vocals · Medium');
    hud.update(snap({}, { vocals: { streak: 4 } }));
    hud.update(snap({}, { vocals: { streak: 5 } }));
    assert.equal(partHud('vocals').querySelector('.rhs-callout').textContent, '5 PHRASE STREAK!');
    hud.destroy();
});

test('parts without a host element are skipped', () => {
    const { player, hud } = setup({ parts: ['guitar', 'drums', 'vocals'], lanes: ['guitar'] });
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 1);
    hud.update(snap({}, { drums: { streak: 50 } }));
    hud.callout('drums', 'x');
    hud.setOverdrive('vocals', 1, true);
    hud.destroy();
});

test('the crowd marker starts at R6\'s 0.66 before any update', () => {
    const { hud, partHud } = setup();
    const marker = partHud('drums').querySelector('.rhs-crowd').querySelector('i');
    assert.equal(marker.style.bottom, '66%');
    assert.ok(marker.classList.contains('rhs-crowd-green'));
    hud.destroy();
});

test('a silent update writes values but pops no callout and no miss flash', () => {
    const { player, hud, partHud } = setup();
    const co = partHud('guitar').querySelector('.rhs-callout');
    const glow = partHud('drums').querySelector('.rhs-glow');
    hud.update(snap({}, { guitar: { streak: 49 }, drums: { streak: 12 } }));
    hud.update(snap({ score: 900 }, { guitar: { streak: 50 }, drums: { streak: 0 } }), { silent: true });
    assert.equal(player.querySelector('.rhs-hud-score').textContent, '900');
    assert.equal(glow.style.props['--rhs-glow'], '0.15');
    assert.equal(co.textContent, '');
    assert.equal(co.classList.contains('rhs-show'), false);
    assert.equal(glow.classList.contains('rhs-glow-miss'), false);
    // The next live update compares against the silent snapshot.
    hud.update(snap({}, { guitar: { streak: 51 }, drums: { streak: 0 } }));
    assert.equal(co.textContent, '');
    assert.equal(glow.classList.contains('rhs-glow-miss'), false);
    hud.destroy();
});

test('CSS: the bar sits at z-index 20 and core\'s section map is click-through on the stage until the hover chrome shows', () => {
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    const map = css.match(/#player\.rhs-stage #section-map \{[^}]*\}/);
    assert.ok(map && /opacity: 0;/.test(map[0]) && /pointer-events: none;/.test(map[0]), 'section map hidden and click-through');
    const bar = css.match(/#player \.rhs-hud \{[^}]*\}/);
    assert.ok(bar && /z-index: 20;/.test(bar[0]), 'bar z-index 20');
});

test('destroy removes everything', () => {
    const { player, slots, hud } = setup();
    const before = player.querySelectorAll('*').length;
    assert.ok(before > 2);
    hud.destroy();
    assert.equal(player.querySelector('.rhs-hud'), null);
    assert.equal(player.querySelectorAll('.rhs-part-hud').length, 0);
    assert.equal(slots.guitar.children.length, 0);
    assert.equal(slots.drums.children.length, 0);
    hud.destroy();
    hud.update(snap({ score: 5 }));
});

const CTL_PREFS = {
    ...PREFS,
    controllers: [
        { id: 'ctl1', key: 'a#1', name: 'Guitar Hero', part: 'bass', difficulty: 'expert', on: true, sourceKind: 'auto' },
        { id: 'ctl2', key: 'a#2', name: 'Xbox pad', part: 'guitar', difficulty: 'easy', on: true, sourceKind: 'chart' },
    ],
};

function ctlSetup() {
    const doc = makeDoc();
    const player = makeEl('div', doc);
    doc.body.appendChild(player);
    const slots = { guitar: makeEl('div', doc), ctl1: makeEl('div', doc), ctl2: makeEl('div', doc) };
    for (const s of Object.values(slots)) player.appendChild(s);
    const stage = { laneSlot: (p) => slots[p] || null, stripSlot: null };
    const parts = ['guitar', 'ctl1', 'ctl2'];
    const hud = createBandHud({ doc, player, stage, parts, prefs: CTL_PREFS, song: {}, oneLevel: false });
    return { player, slots, hud, partHud: (p) => player.querySelector(`.rhs-part-hud[data-part="${p}"]`) };
}

test('controller lane tag and colour', () => {
    const { partHud, slots, hud } = ctlSetup();
    assert.equal(partHud('ctl1').parentNode, slots.ctl1);
    assert.equal(partHud('ctl1').querySelector('.rhs-tag').textContent, 'Bass (5-Fret) · Expert · Guitar Hero · AUTO CHART');
    assert.equal(partHud('ctl2').querySelector('.rhs-tag').textContent, 'Lead (5-Fret) · Easy · Xbox pad');
    assert.equal(partHud('ctl1').style.props['--rhs-c'], '#2ecc40');
    assert.ok(partHud('ctl1').querySelector('.rhs-tag').innerHTML.includes('<svg'), 'tag icon');
    hud.destroy();
});

test('controller streak callouts every 50', () => {
    const { partHud, hud } = ctlSetup();
    const s = (n) => ({
        score: 0, bonus: 0, bandMultiplier: 1, stars: null,
        parts: { guitar: part(), ctl1: part({ streak: n }), ctl2: part() },
    });
    hud.update(s(49));
    hud.update(s(50));
    assert.equal(partHud('ctl1').querySelector('.rhs-callout').textContent, '50 NOTE STREAK!');
    assert.equal(partHud('ctl2').querySelector('.rhs-callout').textContent, '');
    hud.destroy();
});

test('fixed-part labels unchanged', () => {
    const { partHud, hud } = ctlSetup();
    assert.equal(partHud('guitar').querySelector('.rhs-tag').textContent, 'Lead · Hard');
    hud.destroy();
    const v = setup({ parts: ['guitar', 'drums', 'vocals'], strip: true });
    assert.equal(v.partHud('vocals').querySelector('.rhs-tag').textContent, 'Vocals · Medium');
    assert.equal(v.partHud('drums').querySelector('.rhs-tag').textContent, 'Drums · Expert');
    v.hud.destroy();
});

const DRUM_CTL_PREFS = {
    ...PREFS,
    controllers: [
        { id: 'ctl1', key: 'a#1', name: 'Guitar Hero', part: 'bass', difficulty: 'expert', on: true },
        { id: 'ctl2', key: 'a#2', name: 'Rock Band kit', playsAs: 'drums', part: 'drums', difficulty: 'hard', on: true },
    ],
};

function drumCtlSetup() {
    const doc = makeDoc();
    const player = makeEl('div', doc);
    doc.body.appendChild(player);
    const slots = { ctl1: makeEl('div', doc), ctl2: makeEl('div', doc) };
    for (const s of Object.values(slots)) player.appendChild(s);
    const stage = { laneSlot: (p) => slots[p] || null, stripSlot: null };
    const hud = createBandHud({ doc, player, stage, parts: ['ctl1', 'ctl2'], prefs: DRUM_CTL_PREFS, song: {}, oneLevel: false });
    return { hud, partHud: (p) => player.querySelector(`.rhs-part-hud[data-part="${p}"]`) };
}

test('drums controller lane tag and colour', () => {
    const { partHud, hud } = drumCtlSetup();
    assert.equal(partHud('ctl2').querySelector('.rhs-tag').textContent, 'Drums (Controller) · Hard · Rock Band kit');
    assert.equal(partHud('ctl2').style.props['--rhs-c'], '#f28c28');
    assert.ok(partHud('ctl2').querySelector('.rhs-tag').innerHTML.includes('<svg'), 'tag icon');
    assert.equal(partHud('ctl1').style.props['--rhs-c'], '#2ecc40', '5-fret unchanged');
    hud.destroy();
});

test('drums controller streak callouts every 50', () => {
    const { partHud, hud } = drumCtlSetup();
    const s = (n) => ({
        score: 0, bonus: 0, bandMultiplier: 1, stars: null,
        parts: { ctl1: part(), ctl2: part({ streak: n }) },
    });
    hud.update(s(49));
    hud.update(s(50));
    assert.equal(partHud('ctl2').querySelector('.rhs-callout').textContent, '50 NOTE STREAK!');
    assert.equal(partHud('ctl1').querySelector('.rhs-callout').textContent, '');
    hud.destroy();
});

test('crowd: false builds no crowd meter (a solo with the crowd meter off), and updates still run', () => {
    const doc = makeDoc();
    const player = makeEl('div', doc);
    doc.body.appendChild(player);
    const slot = makeEl('div', doc);
    player.appendChild(slot);
    const stage = { laneSlot: (p) => (p === 'drums' ? slot : null), stripSlot: null };
    const hud = createBandHud({ doc, player, stage, parts: ['drums'], prefs: PREFS, song: {}, crowd: false });
    assert.equal(player.querySelectorAll('.rhs-crowd').length, 0);
    hud.update(snap({}, { drums: { crowd: 0.1, multiplier: 2 } }));
    assert.equal(player.querySelector('.rhs-mult').textContent, '×2');
    hud.destroy();
    const withCrowd = createBandHud({ doc, player, stage, parts: ['drums'], prefs: PREFS, song: {} });
    assert.equal(player.querySelectorAll('.rhs-crowd').length, 1, 'shown by default');
    withCrowd.destroy();
});
