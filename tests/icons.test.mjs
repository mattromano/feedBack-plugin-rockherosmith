import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icon, ICON_NAMES } from '../src/icons.js';

test('icon returns a Lucide SVG string', () => {
    const s = icon('star');
    assert.ok(s.startsWith('<svg class="rhs-icon'), s);
    assert.ok(s.includes('viewBox="0 0 24 24"'));
    assert.ok(s.includes('stroke="currentColor"'));
    assert.ok(s.includes('fill="none"'));
    assert.ok(s.includes('aria-hidden="true"'));
    assert.ok(s.includes('width="18" height="18"'));
    assert.ok(s.endsWith('</svg>'));
});

test('icon size and class options', () => {
    const s = icon('zoom-in', { size: 14, cls: 'rhs-x' });
    assert.ok(s.includes('class="rhs-icon rhs-x"'), s);
    assert.ok(s.includes('width="14" height="14"'));
    assert.ok(s.includes('<line x1="11" x2="11" y1="8" y2="14"/>'));
});

test('unknown icon is empty', () => {
    assert.equal(icon('nope'), '');
});

test('seventeen icons', () => {
    assert.equal(ICON_NAMES.length, 18);
    for (const n of ICON_NAMES) assert.ok(icon(n).includes('</svg>'), n);
});

test('the stage chrome icons (plan 7 R23)', () => {
    for (const n of ['menu', 'sliders-horizontal', 'maximize', 'minimize', 'repeat', 'log-out']) assert.ok(ICON_NAMES.includes(n), n);
    assert.ok(icon('log-out').includes('<line x1="21" x2="9" y1="12" y2="12"/>'));
});

test('gamepad-2 is vendored verbatim from lucide-static 0.468.0', () => {
    assert.ok(ICON_NAMES.includes('gamepad-2'));
    const s = icon('gamepad-2');
    assert.ok(s.includes('<line x1="6" x2="10" y1="11" y2="11"/>'));
    assert.ok(s.includes('<path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>'));
});
