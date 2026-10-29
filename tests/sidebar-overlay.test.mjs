// The sidebar over the stage (plan 7 R7, R8) on the fake DOM. fire() doesn't
// propagate, so each test fires the listener it means on the node that holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarOverlay } from '../src/sidebar-overlay.js';
import { makeDoc } from './fake-dom.mjs';

function setup({ withSidebar = true } = {}) {
    const doc = makeDoc();
    const calls = { nav: [], settings: 0, songs: 0 };
    let sidebar = null;
    let settingsLink = null;
    let songsLink = null;
    if (withSidebar) {
        sidebar = doc.createElement('aside');
        sidebar.id = 'v3-sidebar';
        doc.body.appendChild(sidebar);
        // Shell's own anchor listeners stand in for go().
        settingsLink = doc.createElement('a');
        settingsLink.setAttribute('data-v3-nav', 'settings');
        settingsLink.addEventListener('click', () => { calls.settings++; });
        songsLink = doc.createElement('a');
        songsLink.setAttribute('data-v3-nav', 'songs');
        songsLink.addEventListener('click', () => { calls.songs++; });
        sidebar.append(settingsLink, songsLink);
        // A real click runs the sidebar's capture listener before the link's own.
        songsLink.click = () => { sidebar.fire('click', { target: songsLink }); songsLink.fire('click'); };
    }
    const outside = doc.createElement('div');
    doc.body.appendChild(outside);
    const before = { doc: doc.listenerCount(), sidebar: sidebar ? sidebar.listenerCount() : 0 };
    const overlay = createSidebarOverlay({ doc, onNavigate: (link, nav) => calls.nav.push([link, nav]) });
    const isOpenClass = () => doc.body.classList.contains('rhs-sidebar-open');
    return { doc, sidebar, settingsLink, songsLink, outside, calls, overlay, before, isOpenClass };
}

test('open and close toggle the body class', () => {
    const { overlay, isOpenClass } = setup();
    assert.equal(overlay.isOpen(), false);
    assert.equal(overlay.open(), true);
    assert.equal(isOpenClass(), true);
    assert.equal(overlay.isOpen(), true);
    overlay.close();
    assert.equal(isOpenClass(), false);
    assert.equal(overlay.isOpen(), false);
    overlay.close();
    assert.equal(isOpenClass(), false);
    overlay.toggle();
    assert.equal(isOpenClass(), true);
    overlay.toggle();
    assert.equal(isOpenClass(), false);
});

test('while open the sidebar is a modal dialog, so drum keys stand down; closed it is not', () => {
    const { sidebar, overlay, doc } = setup();
    sidebar.setAttribute('aria-label', 'Main');
    overlay.open();
    assert.equal(sidebar.getAttribute('aria-label'), 'Main');
    assert.equal(sidebar.getAttribute('role'), 'dialog');
    assert.equal(sidebar.getAttribute('aria-modal'), 'true');
    assert.equal(doc.body.querySelectorAll('[aria-modal="true"]').length, 1);
    overlay.close();
    assert.equal(sidebar.hasAttribute('role'), false);
    assert.equal(sidebar.hasAttribute('aria-modal'), false);
    assert.equal(sidebar.getAttribute('aria-label'), 'Main');
    assert.equal(doc.body.querySelectorAll('[aria-modal="true"]').length, 0);
});

test('an unnamed sidebar is named Menu while open', () => {
    const { sidebar, overlay } = setup();
    overlay.open();
    assert.equal(sidebar.getAttribute('aria-label'), 'Menu');
    overlay.close();
    assert.equal(sidebar.hasAttribute('aria-label'), false);
});

test('focus left inside the sidebar goes back where it was on close', () => {
    const { doc, sidebar, settingsLink, overlay } = setup();
    const stageBtn = doc.createElement('button');
    doc.body.appendChild(stageBtn);
    stageBtn.focus();
    overlay.open();
    settingsLink.focus();
    overlay.close();
    assert.equal(doc.activeElement, stageBtn);
    // Focus that never went into the sidebar is left alone.
    const other = doc.createElement('button');
    doc.body.appendChild(other);
    overlay.open();
    other.focus();
    overlay.close();
    assert.equal(doc.activeElement, other);
    // Gone from the page: the player gets it.
    const player = doc.createElement('div');
    player.id = 'player';
    doc.body.appendChild(player);
    overlay.open();
    settingsLink.focus();
    other.remove();
    overlay.close();
    assert.equal(doc.activeElement, player);
    assert.equal(player.getAttribute('tabindex'), '-1');
    player.fire('blur');
    assert.equal(player.hasAttribute('tabindex'), false);
    assert.ok(sidebar);
});

test('follow leaves focus to the page even when navigation destroys the overlay', () => {
    const { doc, sidebar, songsLink, overlay, isOpenClass } = setup();
    const stageBtn = doc.createElement('button');
    doc.body.appendChild(stageBtn);
    stageBtn.focus();
    overlay.open();
    songsLink.focus();
    // Shell's go() runs inside the click; the band teardown destroys the overlay there.
    songsLink.addEventListener('click', () => overlay.destroy());
    overlay.follow(songsLink);
    assert.equal(isOpenClass(), false);
    assert.equal(doc.activeElement, songsLink);
    assert.equal(sidebar.hasAttribute('aria-modal'), false);
});

test('an existing role on the sidebar is put back on close', () => {
    const { sidebar, overlay } = setup();
    sidebar.setAttribute('role', 'navigation');
    overlay.open();
    assert.equal(sidebar.getAttribute('role'), 'dialog');
    overlay.destroy();
    assert.equal(sidebar.getAttribute('role'), 'navigation');
    assert.equal(sidebar.hasAttribute('aria-modal'), false);
});

test('a nav click is taken over', () => {
    const { sidebar, settingsLink, calls, overlay } = setup();
    overlay.open();
    const e = sidebar.fire('click', { target: settingsLink });
    assert.deepEqual(calls.nav, [[settingsLink, 'settings']]);
    assert.equal(e.defaultPrevented, true);
    assert.equal(calls.settings, 0);
    // A click that isn't on a nav link is left alone.
    const other = sidebar.fire('click', { target: sidebar });
    assert.equal(other.defaultPrevented, false);
    assert.equal(calls.nav.length, 1);
});

test("follow runs the link's own handler and closes", () => {
    const { songsLink, calls, overlay, isOpenClass } = setup();
    overlay.open();
    overlay.follow(songsLink);
    assert.equal(calls.songs, 1);
    assert.equal(isOpenClass(), false);
    assert.equal(calls.nav.length, 0);
});

test('opened from the edge it closes when the pointer leaves; from the menu it stays', () => {
    const { sidebar, overlay, isOpenClass } = setup();
    overlay.open('edge');
    sidebar.fire('pointerleave');
    assert.equal(isOpenClass(), false);
    overlay.open('menu');
    sidebar.fire('pointerleave');
    assert.equal(isOpenClass(), true);
    overlay.close();
    overlay.open();
    sidebar.fire('pointerleave');
    assert.equal(isOpenClass(), true);
});

test('a pointerdown outside closes it, inside keeps it', () => {
    const { doc, settingsLink, outside, overlay, isOpenClass } = setup();
    overlay.open();
    doc.fire('pointerdown', { target: settingsLink });
    assert.equal(isOpenClass(), true);
    doc.fire('pointerdown', { target: outside });
    assert.equal(isOpenClass(), false);
});

test('no sidebar in the page', () => {
    const { doc, overlay } = setup({ withSidebar: false });
    assert.equal(overlay.open(), false);
    assert.equal(overlay.isOpen(), false);
    assert.equal(doc.body.classList.contains('rhs-sidebar-open'), false);
    overlay.close();
    overlay.destroy();
});

test('destroy removes its listeners', () => {
    const { doc, sidebar, overlay, before, isOpenClass } = setup();
    overlay.open('edge');
    overlay.destroy();
    assert.equal(isOpenClass(), false);
    assert.equal(sidebar.listenerCount(), before.sidebar);
    assert.equal(doc.listenerCount(), before.doc);
    overlay.destroy();
    assert.equal(overlay.open(), false);
});

test('the CSS shows the sidebar and Settings over the player', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../assets/rockherosmith.css', import.meta.url), 'utf8');
    assert.match(css, /body\.rhs-sidebar-open #v3-sidebar \{[^}]*display: flex !important;[^}]*z-index: 150;[^}]*animation: rhs-sidebar-in \.18s ease-out;/);
    assert.match(css, /@keyframes rhs-sidebar-in \{\s*from \{ transform: translateX\(-100%\); \}\s*to \{ transform: none; \}/);
    assert.match(css, /body\.rhs-settings-over #settings \{[^}]*display: block !important;[^}]*inset: 0;[^}]*z-index: 160;[^}]*background: #0f172a;/);
    assert.match(css, /body\.rhs-settings-over #settings \.fb-settings-back \{ display: none; \}/);
    assert.match(css, /#settings \.rhs-settings-back \{/);
});

// ---- Stage menu items (B1: the Part sheet) ----

function withItems(items) {
    const doc = makeDoc();
    const sidebar = doc.createElement('aside');
    sidebar.id = 'v3-sidebar';
    doc.body.appendChild(sidebar);
    const link = doc.createElement('a');
    link.setAttribute('data-v3-nav', 'songs');
    sidebar.appendChild(link);
    const overlay = createSidebarOverlay({ doc, onNavigate() {}, items });
    return { doc, sidebar, link, overlay };
}

test('stage menu items show at the top of the sidebar only while it is open', () => {
    const picked = [];
    let shown = true;
    const { sidebar, link, overlay } = withItems([
        { id: 'part', label: 'Part', title: 'Part settings (P)', visible: () => shown, onSelect: () => picked.push('part') },
    ]);
    assert.equal(sidebar.querySelector('.rhs-sidebar-item'), null);
    overlay.open();
    const item = sidebar.querySelector('.rhs-sidebar-item');
    assert.ok(item);
    assert.equal(sidebar.children[0], item, 'first, above the nav');
    assert.equal(sidebar.children[1], link);
    assert.equal(item.tagName, 'BUTTON');
    assert.equal(item.getAttribute('data-rhs-item'), 'part');
    assert.equal(item.textContent, 'Part');
    assert.equal(item.getAttribute('title'), 'Part settings (P)');
    item.click();
    assert.deepEqual(picked, ['part']);
    assert.equal(overlay.isOpen(), false, 'picking an item closes the sidebar first');
    assert.equal(sidebar.querySelector('.rhs-sidebar-item'), null, 'and takes the items out');
    shown = false;
    overlay.open();
    assert.equal(sidebar.querySelector('.rhs-sidebar-item'), null, 'a hidden item is left out');
    overlay.close();
    overlay.destroy();
});

test('an item that throws on select still leaves the sidebar closed', () => {
    const { sidebar, overlay } = withItems([{ id: 'x', label: 'X', onSelect: () => { throw new Error('boom'); } }]);
    overlay.open();
    sidebar.querySelector('.rhs-sidebar-item').click();
    assert.equal(overlay.isOpen(), false);
    overlay.destroy();
});
