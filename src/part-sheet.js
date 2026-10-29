// The in-song Part sheet (drums & controllers plan phase 4, play layer contract §4, §5):
// one section per local drums / 5-fret player, each mounting that plugin's quick
// settings on the player's lane canvas (feedBackDrums / feedBackFiveFret
// .mountQuickSettings). Drummers also get the sound-mode switch (contract §6), which
// the runtime applies live and saves. It opens from the stage menu (the sidebar's
// Part item) or with P, solo or band, and never pauses: the song plays on under it.
// As a modal dialog it keeps gamepad-nav's focus inside and drum keys stand down;
// Esc (a pad's B) or Back to the song closes it and puts focus back.
import { DRUM_SOUND_MODES, DRUM_SOUND_MODE_LABELS, DRUM_SOUND_MODE_ORDER } from './drum-sound.js';
import { soundModesOff } from './band-model.js';
import { isControllerId } from './controller-model.js';
import { otherModalOpen, restoreFocus } from './modal-open.js';

const TITLE = 'Part';
const HINT = 'P or Esc closes. The song keeps playing.';
const BACK = 'Back to the song';
const PLUGIN_NAME = { drums: 'Drums', five_fret: '5-Fret' };
const API = { drums: 'feedBackDrums', five_fret: 'feedBackFiveFret' };
const PART_COLOR = { drums: '#e0533d', five_fret: '#2ecc40' };
const CONTROLLER_DRUMS_COLOR = '#f28c28';

// P (no modifiers) opens and closes the sheet.
export function isPartSheetKey(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return false;
    return e.code === 'KeyP' || e.key === 'p' || e.key === 'P';
}

// The sound modes a song's stems can play, in the contract's order.
export function sheetSoundModes(stemIds) {
    const off = soundModesOff(stemIds);
    return DRUM_SOUND_MODE_ORDER.filter((m) => !off.includes(m));
}

// partSheetPlayers({ prefs, scoreParts, stemIds, canvasFor(id) })
//   -> [{ id, kind: 'drums'|'five_fret', input: 'kit'|'controller', name, canvas,
//         controllerKey, soundMode?, soundModes? }]
// The playing players with quick settings, in play order: the real drummer, drums
// controllers and 5-fret controllers. Guitar and vocals have none; a player whose
// lane canvas can't be found is left out (its settings would land on another lane).
// A drummer's soundMode is the one playing (a mode the stems can't play shows as
// Song + pads) and soundModes the ones the stems can.
export function partSheetPlayers({ prefs, scoreParts, stemIds, canvasFor } = {}) {
    const parts = (prefs && prefs.parts) || {};
    const controllers = (prefs && Array.isArray(prefs.controllers)) ? prefs.controllers : [];
    const modes = sheetSoundModes(stemIds);
    const shown = (m) => (modes.includes(m) ? m : 'song');
    const out = [];
    for (const id of Array.isArray(scoreParts) ? scoreParts : []) {
        let p = null;
        if (id === 'drums' && parts.drums) {
            p = { id, kind: 'drums', input: 'kit', name: 'Drums', controllerKey: null,
                soundMode: shown(parts.drums.soundMode || 'song'), soundModes: modes };
        } else if (isControllerId(id)) {
            const c = controllers.find((x) => x && x.id === id);
            if (c && c.playsAs === 'drums') {
                p = { id, kind: 'drums', input: 'controller', name: c.name || c.key, controllerKey: c.key,
                    soundMode: shown(c.soundMode || 'rockband'), soundModes: modes };
            } else if (c && c.playsAs === 'five_fret') {
                p = { id, kind: 'five_fret', input: 'controller', name: c.name || c.key, controllerKey: c.key };
            }
        }
        if (!p) continue;
        const canvas = typeof canvasFor === 'function' ? canvasFor(id) : null;
        if (!canvas) continue;
        out.push({ ...p, canvas });
    }
    return out;
}

// The session prefs with player `id`'s sound mode set (the real drummer, or a drums
// controller), or null when there is no such drummer or mode.
export function withSoundMode(prefs, id, mode) {
    if (!prefs || !DRUM_SOUND_MODES.includes(mode)) return null;
    if (id === 'drums') {
        const drums = prefs.parts && prefs.parts.drums;
        if (!drums) return null;
        return { ...prefs, parts: { ...prefs.parts, drums: { ...drums, soundMode: mode } } };
    }
    const list = Array.isArray(prefs.controllers) ? prefs.controllers : [];
    if (!list.some((c) => c && c.id === id && c.playsAs === 'drums')) return null;
    return { ...prefs, controllers: list.map((c) => (c && c.id === id ? { ...c, soundMode: mode } : c)) };
}

// The savePrefs patch for a sound-mode pick (contract §6: prefs are per player): the
// real drummer's parts.drums, the controller's saved entry, else (a solo controller
// with no entry) the Solo choices' soundMode. null when there is nothing to save.
export function soundModePatch(saved, player, mode, { solo = false } = {}) {
    if (!player || !DRUM_SOUND_MODES.includes(mode)) return null;
    if (player.id === 'drums') return { parts: { drums: { soundMode: mode } } };
    const list = (saved && Array.isArray(saved.controllers)) ? saved.controllers : [];
    if (list.some((c) => c && c.key === player.controllerKey)) {
        return { controllers: list.map((c) => (c && c.key === player.controllerKey ? { ...c, soundMode: mode } : c)) };
    }
    return solo ? { solo: { soundMode: mode } } : null;
}

// openPartSheet({ doc, win, host, players, onSoundMode(player, mode), onClose })
//   -> { kind: 'part', el, isOpen(), close({ silent }) } | null (no host or no players)
// A silent close (teardown, the results) skips onClose and leaves focus alone.
export function openPartSheet({ doc, win, host, players, onSoundMode, onClose }) {
    const list = Array.isArray(players) ? players.filter(Boolean) : [];
    if (!host || !list.length) return null;
    const el = (tag, cls, text) => {
        const e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    };

    const prevFocus = doc.activeElement;
    const sheet = el('div', 'rhs-part-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', TITLE);
    const head = el('div', 'rhs-part-sheet-head');
    const back = el('button', 'rhs-part-sheet-close', BACK);
    back.type = 'button';
    back.addEventListener('click', () => close());
    head.append(el('h2', 'rhs-part-sheet-title', TITLE), back);
    sheet.append(head, el('p', 'rhs-part-sheet-hint', HINT));

    const mounted = [];
    for (const p of list) {
        const section = el('section', 'rhs-part-sheet-player');
        section.setAttribute('data-player', p.id);
        const color = p.kind === 'drums' && p.input === 'controller' ? CONTROLLER_DRUMS_COLOR : PART_COLOR[p.kind];
        if (color && section.style && typeof section.style.setProperty === 'function') section.style.setProperty('--rhs-c', color);
        const body = el('div', 'rhs-part-sheet-body');
        section.append(el('h3', 'rhs-part-sheet-name', p.name), body);
        sheet.appendChild(section);
        const api = win && win[API[p.kind]];
        if (!api || typeof api.mountQuickSettings !== 'function') {
            body.appendChild(el('p', 'rhs-part-sheet-note', `Update the ${PLUGIN_NAME[p.kind]} plugin to change these settings in the song`));
            continue;
        }
        const opts = { canvas: p.canvas };
        if (p.kind === 'drums') {
            const modes = Array.isArray(p.soundModes) ? p.soundModes : [];
            if (modes.length > 1) {
                opts.soundModes = modes.map((id) => ({ id, label: DRUM_SOUND_MODE_LABELS[id] || id }));
                opts.soundMode = p.soundMode;
                opts.onSoundMode = (mode) => { if (typeof onSoundMode === 'function') onSoundMode(p, mode); };
            }
        } else {
            opts.controllerKey = p.controllerKey;
        }
        let handle = null;
        try { handle = api.mountQuickSettings(body, opts); } catch (e) { console.warn('[rockherosmith] mountQuickSettings failed', e); }
        if (handle) mounted.push(handle);
        else body.appendChild(el('p', 'rhs-part-sheet-note', `The ${PLUGIN_NAME[p.kind]} settings couldn't open`));
    }

    function onKey(e) {
        if (!e || e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (otherModalOpen(doc, win, sheet)) return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }
    win.addEventListener('keydown', onKey, true);
    host.appendChild(sheet);
    try { back.focus({ preventScroll: true }); } catch (_) { /* focus is a nicety */ }

    let open = true;
    function close({ silent = false } = {}) {
        if (!open) return;
        open = false;
        win.removeEventListener('keydown', onKey, true);
        for (const h of mounted) {
            try { if (typeof h.destroy === 'function') h.destroy(); } catch (e) { console.warn('[rockherosmith] quick settings destroy failed', e); }
        }
        sheet.remove();
        if (silent) return;
        restoreFocus(doc, prevFocus);
        if (typeof onClose === 'function') onClose();
    }

    return { kind: 'part', el: sheet, isOpen: () => open, close };
}
