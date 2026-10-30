// The stage's hover chrome (plan 7 R5, R20): a row of band buttons (Menu, Part,
// A-B loop, Full screen, End) that core's own chrome-active reveal shows above the
// transport. Draws only: the caller decides what each button does. Core's tool rail
// keeps the left edge in both modes, so the sidebar opens from Menu (or M).
import { icon } from './icons.js';

const ICON_PX = 18;
const LOOP = {
    none: { text: 'Loop A', title: 'Set loop start' },
    a: { text: 'Loop B', title: 'Set loop end' },
    ab: { text: 'Clear loop', title: 'Clear loop' },
};

// createStageChrome({ doc, player, full, onMenu, onPart, onLoop, onFullScreen, onEnd })
//   -> { setFull(on), setLoop(state), setPart(on), destroy() }
// Part (the Part sheet, also P) starts hidden; setPart(true) shows it.
export function createStageChrome({ doc, player, full, onMenu, onPart, onLoop, onFullScreen, onEnd }) {
    const row = doc.createElement('div');
    row.className = 'rhs-chrome';

    const setTitle = (btn, title) => {
        btn.setAttribute('title', title);
        btn.setAttribute('aria-label', title);
    };
    const setIcon = (btn, name) => { btn.querySelector('.rhs-chrome-icon').innerHTML = icon(name, { size: ICON_PX }); };
    function button(cls, name, title, cb) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = cls;
        const glyph = doc.createElement('span');
        glyph.className = 'rhs-chrome-icon';
        btn.appendChild(glyph);
        setIcon(btn, name);
        if (title) setTitle(btn, title);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof cb === 'function') cb();
        });
        row.appendChild(btn);
        return btn;
    }

    button('rhs-chrome-menu', 'menu', 'Menu (M)', onMenu);
    const partBtn = button('rhs-chrome-part', 'sliders-horizontal', 'Part settings (P)', onPart);
    const partLabel = doc.createElement('span');
    partLabel.className = 'rhs-chrome-label';
    partLabel.textContent = 'Part';
    partBtn.appendChild(partLabel);
    const loopBtn = button('rhs-chrome-loop', 'repeat', '', onLoop);
    const loopLabel = doc.createElement('span');
    loopLabel.className = 'rhs-chrome-label';
    loopBtn.appendChild(loopLabel);
    const fullBtn = button('rhs-chrome-full', 'maximize', '', onFullScreen);
    button('rhs-chrome-end', 'log-out', 'End song', onEnd);

    player.appendChild(row);

    let destroyed = false;

    // All are no-ops once destroyed, so a late call can't put rhs-full back.
    function setFull(on) {
        if (destroyed) return;
        const isFull = !!on;
        player.classList.toggle('rhs-full', isFull);
        fullBtn.setAttribute('aria-pressed', String(isFull));
        setTitle(fullBtn, isFull ? 'Exit full screen' : 'Full screen');
        setIcon(fullBtn, isFull ? 'minimize' : 'maximize');
    }

    function setLoop(state) {
        if (destroyed) return;
        const s = LOOP[state] || LOOP.none;
        loopLabel.textContent = s.text;
        setTitle(loopBtn, s.title);
    }

    function setPart(on) {
        if (destroyed) return;
        partBtn.hidden = !on;
    }

    setFull(full);
    setLoop('none');
    setPart(false);

    return {
        setFull,
        setLoop,
        setPart,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            row.remove();
            player.classList.remove('rhs-full');
        },
    };
}
