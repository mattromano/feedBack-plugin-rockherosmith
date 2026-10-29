// The in-song Part sheet (drums & controllers plan phase 4): who gets quick settings,
// the sound-mode patch, and the sheet on the fake DOM with fake plugin mounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    partSheetPlayers, sheetSoundModes, withSoundMode, soundModePatch, openPartSheet, isPartSheetKey,
} from '../src/part-sheet.js';
import { makeDoc } from './fake-dom.mjs';

const KIT = { key: 'Kit#1', id: 'ctl1', name: 'Rock Band kit', playsAs: 'drums', part: 'drums', soundMode: 'rockband', on: true };
const PAD = { key: 'Xbox#1', id: 'ctl2', name: 'Xbox', playsAs: 'five_fret', part: 'bass', on: true };
const prefs = (o = {}) => ({
    parts: { guitar: { on: true }, drums: { on: true, soundMode: 'song' }, vocals: { on: false } },
    controllers: [KIT, PAD], ...o,
});

test('sheetSoundModes: the modes a song can play, in the contract order', () => {
    assert.deepEqual(sheetSoundModes(['guitar', 'drums']), ['rockband', 'song', 'kit']);
    assert.deepEqual(sheetSoundModes([]), ['rockband', 'song']);
    assert.deepEqual(sheetSoundModes(['guitar']), ['song']);
});

test('partSheetPlayers: the real drummer, drums controllers and 5-fret controllers, in play order', () => {
    const canvases = { drums: { id: 'highway' }, ctl1: { id: 'c1' }, ctl2: { id: 'c2' } };
    const list = partSheetPlayers({
        prefs: prefs(), scoreParts: ['guitar', 'drums', 'ctl1', 'ctl2'], stemIds: ['guitar', 'drums'],
        canvasFor: (id) => canvases[id] || null,
    });
    assert.deepEqual(list.map((p) => [p.id, p.kind, p.input, p.name, p.controllerKey]), [
        ['drums', 'drums', 'kit', 'Drums', null],
        ['ctl1', 'drums', 'controller', 'Rock Band kit', 'Kit#1'],
        ['ctl2', 'five_fret', 'controller', 'Xbox', 'Xbox#1'],
    ]);
    assert.equal(list[0].canvas, canvases.drums);
    assert.deepEqual([list[0].soundMode, list[1].soundMode], ['song', 'rockband']);
    assert.deepEqual(list[0].soundModes, ['rockband', 'song', 'kit']);
    assert.equal(list[2].soundModes, undefined, '5-fret has no sound mode');
});

test('partSheetPlayers: guitar and vocals have no sheet; no canvas or not playing means left out', () => {
    assert.deepEqual(partSheetPlayers({ prefs: prefs(), scoreParts: ['guitar', 'vocals'], canvasFor: () => ({}) }), []);
    const list = partSheetPlayers({ prefs: prefs(), scoreParts: ['drums', 'ctl1'], canvasFor: (id) => (id === 'ctl1' ? {} : null) });
    assert.deepEqual(list.map((p) => p.id), ['ctl1']);
    assert.deepEqual(partSheetPlayers({ prefs: prefs(), scoreParts: ['ctl9'], canvasFor: () => ({}) }), []);
    assert.deepEqual(partSheetPlayers({}), []);
});

test('partSheetPlayers: a greyed stored mode shows as Song + pads; one playable mode means no switch', () => {
    const p = prefs({ parts: { drums: { on: true, soundMode: 'kit' } } });
    const [real, ctl] = partSheetPlayers({ prefs: p, scoreParts: ['drums', 'ctl1'], stemIds: [], canvasFor: () => ({}) });
    assert.deepEqual([real.soundMode, real.soundModes], ['song', ['rockband', 'song']]);
    assert.equal(ctl.soundMode, 'rockband');
    const split = partSheetPlayers({ prefs: p, scoreParts: ['drums'], stemIds: ['guitar'], canvasFor: () => ({}) });
    assert.deepEqual(split[0].soundModes, ['song']);
});

test('withSoundMode: the real drummer or one controller; anything else is null', () => {
    const p = prefs();
    const a = withSoundMode(p, 'drums', 'kit');
    assert.equal(a.parts.drums.soundMode, 'kit');
    assert.equal(a.parts.drums.on, true);
    assert.equal(p.parts.drums.soundMode, 'song', 'not mutated');
    const b = withSoundMode(p, 'ctl1', 'song');
    assert.deepEqual(b.controllers.map((c) => c.soundMode), ['song', undefined]);
    assert.equal(withSoundMode(p, 'ctl2', 'kit'), null, 'a 5-fret controller has no sound mode');
    assert.equal(withSoundMode(p, 'drums', 'loud'), null);
    assert.equal(withSoundMode(p, 'ctl7', 'kit'), null);
    assert.equal(withSoundMode(null, 'drums', 'kit'), null);
});

test("soundModePatch: the drummer's part, the controller's saved entry, else a solo's choice", () => {
    const saved = { parts: { drums: { soundMode: 'song' } }, controllers: [{ ...KIT, difficulty: 'hard' }] };
    assert.deepEqual(soundModePatch(saved, { id: 'drums' }, 'kit'), { parts: { drums: { soundMode: 'kit' } } });
    assert.deepEqual(soundModePatch(saved, { id: 'ctl1', controllerKey: 'Kit#1' }, 'song'),
        { controllers: [{ ...KIT, difficulty: 'hard', soundMode: 'song' }] });
    assert.deepEqual(soundModePatch(saved, { id: 'ctl1', controllerKey: 'Kit#9' }, 'song', { solo: true }), { solo: { soundMode: 'song' } });
    assert.equal(soundModePatch(saved, { id: 'ctl1', controllerKey: 'Kit#9' }, 'song'), null, 'a band controller not saved: nothing');
    assert.equal(soundModePatch(saved, { id: 'drums' }, 'nope'), null);
});

test('isPartSheetKey: P without modifiers', () => {
    assert.equal(isPartSheetKey({ code: 'KeyP', key: 'p' }), true);
    assert.equal(isPartSheetKey({ key: 'P' }), true);
    assert.equal(isPartSheetKey({ code: 'KeyP', key: 'p', ctrlKey: true }), false);
    assert.equal(isPartSheetKey({ code: 'KeyM', key: 'm' }), false);
    assert.equal(isPartSheetKey(null), false);
});

// ---- the sheet on the fake DOM ----

function env({ drums = true, fiveFret = true } = {}) {
    const doc = makeDoc();
    const player = doc.createElement('div');
    player.id = 'player';
    doc.body.appendChild(player);
    const stageBtn = doc.createElement('button');
    player.appendChild(stageBtn);
    stageBtn.focus();
    const mounts = [];
    const listeners = new EventTarget();
    const win = {
        // Node's EventTarget doesn't match a boolean capture on remove: dropped, as band-runtime's tests do.
        addEventListener: (t, f) => listeners.addEventListener(t, f),
        removeEventListener: (t, f) => listeners.removeEventListener(t, f),
        dispatchEvent: (e) => listeners.dispatchEvent(e),
    };
    const fakeMount = (plugin) => (el, opts) => {
        const m = { plugin, el, opts, destroyed: 0 };
        const b = doc.createElement('button');
        b.className = 'qs-' + plugin;
        el.appendChild(b);
        mounts.push(m);
        return { destroy() { m.destroyed++; el.replaceChildren(); } };
    };
    if (drums) win.feedBackDrums = { mountQuickSettings: fakeMount('drums') };
    if (fiveFret) win.feedBackFiveFret = { mountQuickSettings: fakeMount('five_fret') };
    const key = (k, extra = {}) => {
        const e = new Event('keydown', { cancelable: true });
        let stopped = false;
        Object.assign(e, { key: k, code: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
        const stop = e.stopPropagation.bind(e);
        e.stopPropagation = () => { stopped = true; stop(); };
        win.dispatchEvent(e);
        return { e, stopped: () => stopped };
    };
    return { doc, player, win, mounts, key, stageBtn, listeners };
}

const PLAYERS = [
    { id: 'drums', kind: 'drums', input: 'kit', name: 'Drums', canvas: { id: 'highway' }, controllerKey: null,
        soundMode: 'song', soundModes: ['rockband', 'song', 'kit'] },
    { id: 'ctl2', kind: 'five_fret', input: 'controller', name: 'Xbox', canvas: { id: 'c2' }, controllerKey: 'Xbox#1' },
];

test("the sheet mounts each player's quick settings on its lane canvas, as a modal dialog", () => {
    const t = env();
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS, onSoundMode() {} });
    const el = t.player.querySelector('.rhs-part-sheet');
    assert.ok(el);
    assert.equal(sheet.el, el);
    assert.equal(el.getAttribute('role'), 'dialog');
    assert.equal(el.getAttribute('aria-modal'), 'true');
    assert.equal(el.getAttribute('aria-label'), 'Part');
    const sections = el.querySelectorAll('.rhs-part-sheet-player');
    assert.deepEqual(sections.map((s) => s.getAttribute('data-player')), ['drums', 'ctl2']);
    assert.deepEqual(sections.map((s) => s.querySelector('h3').textContent), ['Drums', 'Xbox']);
    assert.deepEqual(t.mounts.map((m) => m.plugin), ['drums', 'five_fret']);
    const [d, f] = t.mounts;
    assert.equal(d.opts.canvas, PLAYERS[0].canvas);
    assert.deepEqual(d.opts.soundModes, [{ id: 'rockband', label: 'Rock Band' }, { id: 'song', label: 'Song + pads' }, { id: 'kit', label: 'Kit only' }]);
    assert.equal(d.opts.soundMode, 'song');
    assert.equal(typeof d.opts.onSoundMode, 'function');
    assert.deepEqual(f.opts, { canvas: PLAYERS[1].canvas, controllerKey: 'Xbox#1' });
    // Focus goes to the sheet's first control, so a gamepad's arrows move inside it.
    assert.equal(t.doc.activeElement, el.querySelector('.rhs-part-sheet-close'));
    assert.equal(sheet.isOpen(), true);
    sheet.close();
});

test('a sound-mode pick calls onSoundMode with the player', () => {
    const t = env();
    const got = [];
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS, onSoundMode: (p, m) => got.push([p.id, m]) });
    t.mounts[0].opts.onSoundMode('kit');
    assert.deepEqual(got, [['drums', 'kit']]);
    sheet.close();
});

test('one playable sound mode: no switch is offered', () => {
    const t = env();
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player,
        players: [{ ...PLAYERS[0], soundModes: ['song'] }], onSoundMode() {} });
    assert.equal(t.mounts[0].opts.soundModes, undefined);
    assert.equal(t.mounts[0].opts.onSoundMode, undefined);
    sheet.close();
});

test('Esc or Back to the song closes it: mounts destroyed, focus back, onClose once', () => {
    const t = env();
    let closed = 0;
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS, onClose: () => closed++ });
    const k = t.key('Escape');
    assert.equal(k.e.defaultPrevented, true);
    assert.equal(k.stopped(), true, "core's Escape (leave the song) never sees it");
    assert.equal(sheet.isOpen(), false);
    assert.equal(t.player.querySelector('.rhs-part-sheet'), null);
    assert.deepEqual(t.mounts.map((m) => m.destroyed), [1, 1]);
    assert.equal(t.doc.activeElement, t.stageBtn);
    assert.equal(closed, 1);
    sheet.close();
    assert.equal(closed, 1);
    assert.equal(t.key('Escape').e.defaultPrevented, false, 'the key listener is gone');

    const u = env();
    const again = openPartSheet({ doc: u.doc, win: u.win, host: u.player, players: PLAYERS, onClose: () => closed++ });
    u.player.querySelector('.rhs-part-sheet-close').click();
    assert.equal(again.isOpen(), false);
    assert.equal(closed, 2);
});

test('a silent close (teardown) skips onClose and focus; other keys pass through', () => {
    const t = env();
    let closed = 0;
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS, onClose: () => closed++ });
    const space = t.key(' ', { code: 'Space' });
    assert.equal(space.e.defaultPrevented, false, 'the song keeps its keys');
    const other = t.doc.createElement('button');
    t.doc.body.appendChild(other);
    other.focus();
    sheet.close({ silent: true });
    assert.equal(closed, 0);
    assert.equal(t.doc.activeElement, other);
});

test('another modal over it keeps its Esc', () => {
    const t = env();
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS });
    const modal = t.doc.createElement('div');
    modal.className = 'feedBack-modal';
    modal.offsetParent = t.doc.body;
    t.doc.body.appendChild(modal);
    assert.equal(t.key('Escape').e.defaultPrevented, false);
    assert.equal(sheet.isOpen(), true);
    sheet.close();
});

test('a missing plugin API says so instead of mounting; a throwing mount does too', () => {
    const t = env({ drums: false });
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS });
    const notes = t.player.querySelectorAll('.rhs-part-sheet-note').map((n) => n.textContent);
    assert.deepEqual(notes, ['Update the Drums plugin to change these settings in the song']);
    assert.deepEqual(t.mounts.map((m) => m.plugin), ['five_fret']);
    sheet.close();
    const u = env();
    u.win.feedBackFiveFret.mountQuickSettings = () => { throw new Error('boom'); };
    const s2 = openPartSheet({ doc: u.doc, win: u.win, host: u.player, players: PLAYERS });
    assert.deepEqual(u.player.querySelectorAll('.rhs-part-sheet-note').map((n) => n.textContent),
        ["The 5-Fret settings couldn't open"]);
    s2.close();
});

test('no host or no players: nothing opens', () => {
    const t = env();
    assert.equal(openPartSheet({ doc: t.doc, win: t.win, host: null, players: PLAYERS }), null);
    assert.equal(openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: [] }), null);
});

// ---- Stop practice (B3's section practice loop) ----

test('while a practice loop runs the sheet offers Stop practice; a click stops it and the button goes', () => {
    const t = env();
    let on = true;
    let stops = 0;
    const practice = { active: () => on, stop: () => { stops++; on = false; } };
    const sheet = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS, practice });
    const btn = t.player.querySelector('.rhs-part-sheet-stop-practice');
    assert.ok(btn);
    assert.equal(btn.textContent, 'Stop practice');
    btn.click();
    assert.equal(stops, 1);
    assert.equal(t.player.querySelector('.rhs-part-sheet-stop-practice'), null);
    assert.equal(sheet.isOpen(), true, 'the sheet stays open');
    sheet.close();
});

test('no loop running, or no practice hook: no Stop practice; a loop alone still opens the sheet', () => {
    const t = env();
    const s1 = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS, practice: { active: () => false, stop() {} } });
    assert.equal(t.player.querySelector('.rhs-part-sheet-stop-practice'), null);
    s1.close();
    const s2 = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: PLAYERS });
    assert.equal(t.player.querySelector('.rhs-part-sheet-stop-practice'), null);
    s2.close();
    const s3 = openPartSheet({ doc: t.doc, win: t.win, host: t.player, players: [], practice: { active: () => true, stop() {} } });
    assert.ok(s3, 'a guitar-only band practicing still gets the sheet');
    assert.ok(t.player.querySelector('.rhs-part-sheet-stop-practice'));
    s3.close();
});
