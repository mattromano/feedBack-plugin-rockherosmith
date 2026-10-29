// Controller players on the band screen: one Setup column and one Confirm row per joined
// controller, built once per key and kept in a Map. Thin DOM layer; the rows come from
// bandScreenModel().controllers and every control writes back through onChange.
// What a controller plays as (row.playsAs) picks its look, its lights and its Confirm
// fields; a row that can play two kinds also gets the Plays as segment.
import { icon } from './icons.js';
import { FIVE_FRET_PART, DRUMS_CONTROLLER_PART } from './parts.js';
import { FIVE_FRET_PART_LABELS } from './controller-model.js';
import { DIFFICULTIES } from './mappings.js';
import { DRUM_SOUND_MODE_LABELS, DRUM_SOUND_MODE_ORDER } from './drum-sound.js';
import { createPadVolume } from './pad-volume.js';

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
const PART_ORDER = ['guitar', 'rhythm', 'bass'];
const KIND_TAG = { chart: 'real', auto: 'auto' };
const LEFTY = [['off', 'Off'], ['on', 'On']];
const PART_AUDIO = [['rockband', 'Rock Band'], ['always', 'Always play']];
// The drum sound modes as every UI shows them (contract §6), as the real drums column does.
const SOUND_MODES = DRUM_SOUND_MODE_ORDER.map((m) => [m, DRUM_SOUND_MODE_LABELS[m]]);
const PLAYS_AS = [['five_fret', '5-Fret'], ['drums', 'Drums']];
const PLAYS_AS_HINT = 'X: 5-Fret \u00b7 B: Drums';
// Per kind: the Setup column's lights (the join manager's lit flags, CONTROLLER_KINDS
// lights) and the look. An undecided controller shows a plain gamepad and no lights.
const LIGHTS = { five_fret: ['green', 'red', 'yellow', 'blue', 'orange'], drums: ['red', 'yellow', 'blue', 'green', 'kick'] };
const LIGHT_CLASS = { five_fret: 'rhs-fret', drums: 'rhs-drumpad' };
const LOOK = {
    five_fret: FIVE_FRET_PART,
    drums: DRUMS_CONTROLLER_PART,
    none: { icon: 'gamepad-2', color: FIVE_FRET_PART.color },
};
const NO_LIGHTS = [];

// createControllerColumns({ doc, win, setupHost, confirmHost, onChange(key, patch), onLeave(key),
//   onControls(key), onPlaysAs(key, kind) }) -> { render(rows), light(key, lit), destroy() }
// win (optional): a drums row's pad volume reads and sets the drums plugin's (pad-volume.js).
// light(key, lit) takes the join manager's reused lit flags for the kind the controller
// plays as (null: all off) and writes only the classes that changed.
export function createControllerColumns({ doc, win, setupHost, confirmHost, onChange, onLeave, onControls, onPlaysAs }) {
    const cards = new Map(); // key -> card (build)
    let order = [];

    function el(tag, cls, text) {
        const e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function top(nameEls, icoEls) {
        const t = el('div', 'rhs-top');
        const ico = el('span', 'rhs-ico');
        icoEls.push(ico);
        const name = el('h2', 'rhs-part-name');
        nameEls.push(name);
        t.append(ico, name);
        return t;
    }

    // A labelled segment; each button calls send(value).
    function seg(label, field, options, send) {
        const wrap = el('div', 'rhs-field');
        const box = el('div', 'rhs-seg');
        box.setAttribute('data-field', field);
        const buttons = {};
        for (const [value, text] of options) {
            const b = el('button');
            b.type = 'button';
            b.setAttribute('data-value', value);
            if (typeof text === 'string') b.textContent = text;
            else b.append(...text);
            b.addEventListener('click', () => send(value));
            buttons[value] = b;
            box.appendChild(b);
        }
        wrap.append(el('span', 'rhs-label', label), box);
        return { field: wrap, buttons };
    }
    const prefSeg = (key, label, field, options, toPref = (v) => v) =>
        seg(label, field, options, (v) => onChange(key, { [field]: toPref(v) }));

    function build(key) {
        const names = [];
        const icos = [];
        const notes = [];

        const col = el('div', 'rhs-col rhs-ctl');
        col.setAttribute('data-ctl', key);
        const colTop = top(names, icos);
        const playsAs = seg('Plays as', 'playsAs', PLAYS_AS, (k) => { if (onPlaysAs) onPlaysAs(key, k); });
        playsAs.field.classList.add('rhs-playsas');
        const hint = el('span', 'rhs-playsas-hint', PLAYS_AS_HINT);
        playsAs.field.appendChild(hint);
        const lightBox = el('div', 'rhs-lights');
        const colNote = el('div', 'rhs-note');
        notes.push(colNote);
        const actions = el('div', 'rhs-ctl-actions');
        const controls = el('button', 'rhs-ctl-controls', 'Controls');
        controls.type = 'button';
        controls.addEventListener('click', () => onControls(key));
        const leave = el('button', 'rhs-ctl-leave');
        leave.type = 'button';
        const leaveIco = el('span', 'rhs-btn-ico');
        leaveIco.innerHTML = icon('log-out', { size: 14 });
        leave.append(leaveIco, 'Leave');
        leave.addEventListener('click', () => onLeave(key));
        actions.append(controls, leave);

        const row = el('div', 'rhs-part rhs-ctl');
        row.setAttribute('data-ctl', key);
        const rowTop = top(names, icos);
        const partTags = {};
        const partAlso = {};
        const part = prefSeg(key, 'Part', 'part', PART_ORDER.map((p) => {
            partTags[p] = el('span', 'rhs-tag', '');
            partAlso[p] = el('span', 'rhs-also', '');
            return [p, [el('span', 'rhs-seg-text', FIVE_FRET_PART_LABELS[p]), partTags[p], partAlso[p]]];
        }));
        // Drums has one part: a fixed segment that names who else is on drums.
        const drumAlso = el('span', 'rhs-also', '');
        const drumPart = seg('Part', 'drumPart', [['drums', [el('span', 'rhs-seg-text', DRUMS_CONTROLLER_PART.label), drumAlso]]], () => {});
        const difficulty = prefSeg(key, 'Difficulty', 'difficulty', DIFFICULTIES.map((d) => [d, DIFFICULTY_LABELS[d] || d]));
        const lefty = prefSeg(key, 'Lefty', 'lefty', LEFTY, (v) => v === 'on');
        const partAudio = prefSeg(key, 'Part audio', 'partAudio', PART_AUDIO);
        const soundMode = prefSeg(key, 'Sound', 'soundMode', SOUND_MODES);
        const padVolume = createPadVolume({ doc, win });
        const rowNote = el('div', 'rhs-note');
        notes.push(rowNote);

        return {
            col, row, names, icos, notes, colTop, rowTop, colNote, rowNote, actions, lightBox, hint,
            playsAsField: playsAs.field, partTags, partAlso, drumAlso, padVolume,
            fields: {
                five_fret: [part.field, difficulty.field, lefty.field, partAudio.field],
                drums: [drumPart.field, difficulty.field, soundMode.field, padVolume.field],
                none: [difficulty.field],
            },
            segs: {
                playsAs: playsAs.buttons, part: part.buttons, drumPart: drumPart.buttons, difficulty: difficulty.buttons,
                lefty: lefty.buttons, partAudio: partAudio.buttons, soundMode: soundMode.buttons,
            },
            layout: null, // the kind + ask signature the DOM was laid out for
            kind: null, lightNames: NO_LIGHTS, lights: {}, lit: {},
        };
    }

    // Lays the column and row out for what the controller plays as. Runs only when that
    // (or whether it is asked to choose) changes; the lights start dark.
    function layOut(c, kind, ask) {
        const sig = (kind || 'none') + (ask ? '?' : '');
        if (c.layout === sig) return;
        c.layout = sig;
        const look = LOOK[kind || 'none'];
        for (const ico of c.icos) ico.innerHTML = icon(look.icon, { size: 30 });
        for (const e of [c.col, c.row]) e.style.setProperty('--rhs-c', look.color);
        if (c.kind !== kind) {
            c.kind = kind;
            c.lightNames = LIGHTS[kind] || NO_LIGHTS;
            c.lights = {};
            c.lit = {};
            const spans = c.lightNames.map((n) => {
                const s = el('span', LIGHT_CLASS[kind]);
                s.setAttribute('data-light', n);
                if (kind === 'five_fret') s.setAttribute('data-fret', n);
                c.lights[n] = s;
                c.lit[n] = false;
                return s;
            });
            c.lightBox.className = kind === 'five_fret' ? 'rhs-lights rhs-frets' : 'rhs-lights rhs-drumpads';
            c.lightBox.replaceChildren(...spans);
        }
        c.col.replaceChildren(c.colTop, ...(ask ? [c.playsAsField] : []), ...(kind ? [c.lightBox] : []), c.colNote, c.actions);
        c.row.replaceChildren(c.rowTop, ...c.fields[kind || 'none'], c.rowNote);
    }

    function press(buttons, value, disabled = () => false) {
        for (const v of Object.keys(buttons)) {
            buttons[v].setAttribute('aria-pressed', v === value ? 'true' : 'false');
            buttons[v].disabled = disabled(v);
        }
    }

    const alsoText = (info) => {
        const others = info && Array.isArray(info.takenBy) ? info.takenBy.filter(Boolean) : [];
        return others.length ? 'also: ' + others.join(', ') : '';
    };

    function update(c, r) {
        const kinds = Array.isArray(r.kinds) ? r.kinds : NO_LIGHTS;
        const kind = LIGHTS[r.playsAs] ? r.playsAs : null;
        layOut(c, kind, kinds.length > 1);
        for (const n of c.names) n.textContent = r.name || r.key;
        for (const n of c.notes) n.textContent = r.note || '';
        for (const e of [c.col, c.row]) {
            e.classList.toggle('rhs-off', !r.on);
            e.classList.toggle('rhs-unavailable', !!r.unavailable);
        }
        // An undecided column sits out, but the Plays as question it asks stays
        // at full strength (CSS), with Leave and Controls.
        c.col.classList.toggle('rhs-asking', !kind && kinds.length > 1);
        press(c.segs.playsAs, kind, (k) => !kinds.includes(k));
        c.hint.textContent = r.standard ? PLAYS_AS_HINT : '';
        const parts = r.parts || {};
        press(c.segs.difficulty, r.difficulty);
        if (kind === 'five_fret') {
            press(c.segs.part, r.part, (p) => !(parts[p] && parts[p].has));
            for (const p of PART_ORDER) {
                const info = parts[p] || {};
                c.partTags[p].textContent = KIND_TAG[info.kind] || '';
                c.partAlso[p].textContent = alsoText(info);
            }
            press(c.segs.lefty, r.lefty ? 'on' : 'off');
            press(c.segs.partAudio, r.partAudio, () => !!r.partAudioDisabled);
        } else if (kind === 'drums') {
            press(c.segs.drumPart, 'drums', () => !!(parts.drums && !parts.drums.has));
            c.drumAlso.textContent = alsoText(parts.drums);
            const off = Array.isArray(r.soundModeDisabled) ? r.soundModeDisabled : NO_LIGHTS;
            press(c.segs.soundMode, r.soundMode, (m) => off.includes(m));
            c.padVolume.render();
        }
    }

    return {
        render(rows) {
            const list = Array.isArray(rows) ? rows.filter((r) => r && r.key) : [];
            const keys = list.map((r) => r.key);
            for (const [key, c] of cards) {
                if (keys.includes(key)) continue;
                c.col.remove();
                c.row.remove();
                cards.delete(key);
            }
            for (const r of list) if (!cards.has(r.key)) cards.set(r.key, build(r.key));
            // Re-append only when the join order changed (or a card was added).
            if (keys.length !== order.length || keys.some((k, i) => k !== order[i])) {
                for (const k of keys) {
                    setupHost.appendChild(cards.get(k).col);
                    confirmHost.appendChild(cards.get(k).row);
                }
                order = keys;
            }
            for (const r of list) update(cards.get(r.key), r);
        },
        light(key, lit) {
            const c = cards.get(key);
            if (!c) return;
            const names = c.lightNames;
            for (let i = 0; i < names.length; i++) {
                const n = names[i];
                const on = !!(lit && lit[n]);
                if (c.lit[n] === on) continue;
                c.lit[n] = on;
                c.lights[n].classList.toggle('rhs-lit', on);
            }
        },
        destroy() {
            for (const c of cards.values()) { c.col.remove(); c.row.remove(); }
            cards.clear();
            order = [];
        },
    };
}
