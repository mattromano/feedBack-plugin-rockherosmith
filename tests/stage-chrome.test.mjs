// The stage's hover chrome row (plan 7 R5, R20) on the fake DOM, plus source
// checks on the stage CSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStageChrome } from '../src/stage-chrome.js';
import { makeDoc } from './fake-dom.mjs';

const svg = (b) => b.querySelector('.rhs-chrome-icon').innerHTML;
const CLASSES = ['rhs-chrome-menu', 'rhs-chrome-part', 'rhs-chrome-loop', 'rhs-chrome-full', 'rhs-chrome-end'];

function setup({ full = false } = {}) {
    const doc = makeDoc();
    const player = doc.createElement('div');
    player.id = 'player';
    doc.body.appendChild(player);
    const calls = [];
    const cb = (name) => () => calls.push(name);
    const chrome = createStageChrome({
        doc, player, full,
        onMenu: cb('menu'), onPart: cb('part'), onLoop: cb('loop'), onFullScreen: cb('full'), onEnd: cb('end'),
    });
    const row = player.querySelector('.rhs-chrome');
    const btn = (cls) => row.querySelector('.' + cls);
    return { doc, player, calls, chrome, row, btn };
}

test('the chrome row holds Menu, Part, loop, full screen and End', () => {
    const { player, row, btn } = setup();
    assert.ok(row);
    assert.deepEqual(row.children.map((b) => CLASSES.find((c) => b.classList.contains(c))), CLASSES);
    for (const b of row.children) {
        assert.equal(b.tagName, 'BUTTON');
        assert.equal(b.getAttribute('type'), 'button');
        assert.equal(b.getAttribute('aria-label'), b.getAttribute('title'));
    }
    assert.equal(btn('rhs-chrome-menu').getAttribute('title'), 'Menu (M)');
    assert.equal(btn('rhs-chrome-part').getAttribute('title'), 'Part settings (P)');
    assert.ok(btn('rhs-chrome-part').textContent.includes('Part'));
    assert.equal(btn('rhs-chrome-loop').getAttribute('title'), 'Set loop start');
    assert.equal(btn('rhs-chrome-full').getAttribute('title'), 'Full screen');
    assert.equal(btn('rhs-chrome-end').getAttribute('title'), 'End song');
    assert.ok(svg(btn('rhs-chrome-menu')).includes('<line x1="4" x2="20" y1="12" y2="12"/>'));
    assert.ok(svg(btn('rhs-chrome-part')).includes('<line x1="21" x2="14" y1="4" y2="4"/>'));
    assert.ok(svg(btn('rhs-chrome-loop')).includes('<path d="m17 2 4 4-4 4"/>'));
    assert.ok(svg(btn('rhs-chrome-full')).includes('<path d="M8 3H5a2 2 0 0 0-2 2v3"/>'));
    assert.ok(svg(btn('rhs-chrome-end')).includes('<polyline points="16 17 21 12 16 7"/>'));
    // No edge of its own: core's rail keeps the left edge.
    assert.deepEqual(player.children, [row]);
    assert.equal(player.querySelector('.rhs-edge'), null);
    assert.ok(!player.classList.contains('rhs-full'));
});

test('clicks call back', () => {
    const { player, calls, btn } = setup();
    let stopped = 0;
    for (const cls of CLASSES) btn(cls).fire('click', { stopPropagation() { stopped++; } });
    assert.deepEqual(calls, ['menu', 'part', 'loop', 'full', 'end']);
    assert.equal(stopped, 5);
});

test('setPart shows and hides the Part button', () => {
    const { chrome, btn } = setup();
    const part = btn('rhs-chrome-part');
    assert.equal(part.hidden, true, 'hidden until the caller knows there is a sheet');
    chrome.setPart(true);
    assert.equal(part.hidden, false);
    chrome.setPart(false);
    assert.equal(part.hidden, true);
    chrome.destroy();
    assert.doesNotThrow(() => chrome.setPart(true));
});

test('setFull', () => {
    const { player, chrome, btn } = setup({ full: true });
    const full = btn('rhs-chrome-full');
    assert.ok(player.classList.contains('rhs-full'));
    assert.equal(full.getAttribute('aria-pressed'), 'true');
    assert.equal(full.getAttribute('title'), 'Exit full screen');
    assert.equal(full.getAttribute('aria-label'), 'Exit full screen');
    assert.ok(svg(full).includes('<path d="M8 3v3a2 2 0 0 1-2 2H3"/>'), 'minimize icon');
    chrome.setFull(false);
    assert.ok(!player.classList.contains('rhs-full'));
    assert.equal(full.getAttribute('aria-pressed'), 'false');
    assert.equal(full.getAttribute('title'), 'Full screen');
    assert.equal(full.getAttribute('aria-label'), 'Full screen');
    assert.ok(svg(full).includes('<path d="M8 3H5a2 2 0 0 0-2 2v3"/>'), 'maximize icon');
});

test('setLoop', () => {
    const { chrome, btn } = setup();
    const loop = btn('rhs-chrome-loop');
    assert.ok(loop.textContent.includes('Loop A'));
    chrome.setLoop('a');
    assert.ok(loop.textContent.includes('Loop B'));
    assert.equal(loop.getAttribute('title'), 'Set loop end');
    assert.equal(loop.getAttribute('aria-label'), 'Set loop end');
    chrome.setLoop('ab');
    assert.ok(loop.textContent.includes('Clear loop'));
    assert.equal(loop.getAttribute('title'), 'Clear loop');
    chrome.setLoop('none');
    assert.ok(loop.textContent.includes('Loop A'));
    assert.equal(loop.getAttribute('title'), 'Set loop start');
});

test('destroy', () => {
    const { player, chrome } = setup({ full: true });
    chrome.destroy();
    assert.equal(player.querySelector('.rhs-chrome'), null);
    assert.ok(!player.classList.contains('rhs-full'));
    assert.doesNotThrow(() => chrome.destroy());
});

test('stage CSS: hover chrome and full mode replace the stage hides', () => {
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    assert.ok(!css.includes('#player.rhs-stage #player-hud { display: none; }'));
    assert.ok(!css.includes('#player.rhs-stage #section-map { display: none; }'));
    // Core's tool rail (plugin controls, mixer, stems) stays reachable in full mode.
    assert.ok(!css.includes('#v3-railzone { display: none; }'));
    assert.ok(!css.includes('.rhs-edge'));
    assert.ok(css.includes('#player .rhs-chrome button[hidden] { display: none; }'));
    assert.ok(css.includes('#player.rhs-full .rhs-lanes { bottom: 0 !important; }'));
});

const rule = (css, sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp('(?:^|\\n)' + esc + ' \\{([^}]*)\\}'));
    return m ? m[1] : null;
};

test('stage CSS: the HUD is click-through until the chrome shows, and sits above the lane chrome', () => {
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    // Everything in the HUD (core's Up Next pill is pointer-events: auto) is
    // click-through on the stage; only the reveal gives the pill clicks back.
    assert.match(rule(css, '#player.rhs-stage #player-hud,\n#player.rhs-stage #player-hud *'), /pointer-events: none;/);
    assert.match(rule(css, '#player.rhs-stage.chrome-active #player-hud .v3-upnext,\n#player.rhs-stage.pop-open #player-hud .v3-upnext'), /pointer-events: auto;/);
    // The HUD anchor clears the lane chrome band: transport + section map and
    // row (60px) + the lane chrome's 0.75rem lift + its 2.5rem band.
    assert.match(rule(css, '#player.rhs-stage #player-hud'), /bottom: calc\(var\(--rhs-transport-h, 72px\) \+ 60px \+ 0\.75rem \+ 2\.5rem\);/);
    assert.match(rule(css, '#player.rhs-stage .rhs-lane-chrome'), /bottom: calc\(60px \+ 0\.75rem\);/);
    assert.match(rule(css, '#player.rhs-stage.rhs-full .rhs-lane-chrome'), /bottom: calc\(var\(--rhs-transport-h, 72px\) \+ 60px \+ 0\.75rem\);/);
});

test('stage CSS: only the chrome row buttons take clicks', () => {
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    assert.match(rule(css, '#player .rhs-chrome'), /pointer-events: none;/);
    const shown = rule(css, '#player.chrome-active .rhs-chrome,\n#player.pop-open .rhs-chrome');
    assert.ok(shown && !/pointer-events/.test(shown), 'the shown row stays click-through');
    assert.match(rule(css, '#player.chrome-active .rhs-chrome button,\n#player.pop-open .rhs-chrome button'), /pointer-events: auto;/);
});
