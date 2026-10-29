// The app sidebar over the stage (plan 7 R7, R8). While body.rhs-sidebar-open is set,
// the plugin CSS shows #v3-sidebar fixed above #player. Opening it never pauses.
// While open it is a modal dialog (role="dialog", aria-modal="true"), so drum keys
// stand down under it (plan 7 R14), named "Menu" unless it has a name; closing puts
// the earlier attributes back, and focus left inside it goes back where it was.
// Nav links are taken over in the capture phase and handed to onNavigate; follow()
// re-clicks one with the takeover bypassed so shell's own handler runs.
// items: the stage menu's own entries (the Part sheet), buttons put at the top of the
// sidebar while it is open; picking one closes the sidebar, then runs it.
import { contains, restoreFocus } from './modal-open.js';

const OPEN_CLASS = 'rhs-sidebar-open';
const MODAL_ATTRS = [['role', 'dialog'], ['aria-modal', 'true']];

// createSidebarOverlay({ doc, onNavigate, items })
//   items: [{ id, label, title?, visible?(): boolean, onSelect() }]
//   -> { open(via), close(), toggle(via), isOpen(), follow(link), destroy() }
export function createSidebarOverlay({ doc, onNavigate, items = [] }) {
    const sidebar = doc.getElementById('v3-sidebar');
    let open = false;
    let byEdge = false;
    let following = false;
    let destroyed = false;
    let saved = null;
    let prevFocus = null;
    let shownItems = [];

    function addItems() {
        const list = (Array.isArray(items) ? items : []).filter((it) => {
            if (!it || typeof it.onSelect !== 'function') return false;
            try { return typeof it.visible !== 'function' || it.visible() === true; } catch (_) { return false; }
        });
        shownItems = list.map((it) => {
            const b = doc.createElement('button');
            b.type = 'button';
            b.className = 'rhs-sidebar-item';
            b.setAttribute('data-rhs-item', String(it.id || ''));
            b.textContent = it.label || '';
            if (it.title) b.setAttribute('title', it.title);
            b.addEventListener('click', (e) => {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                close();
                try { it.onSelect(); } catch (err) { console.warn('[rockherosmith] menu item failed', err); }
            });
            return b;
        });
        for (let i = shownItems.length - 1; i >= 0; i--) sidebar.prepend(shownItems[i]);
    }

    function removeItems() {
        for (const b of shownItems) b.remove();
        shownItems = [];
    }

    function onClick(e) {
        if (following) return;
        const t = e && e.target;
        const link = t && typeof t.closest === 'function' ? t.closest('a[data-v3-nav]') : null;
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof onNavigate === 'function') onNavigate(link, link.getAttribute('data-v3-nav'));
    }
    function onPointerDown(e) {
        if (open && !contains(sidebar, e && e.target)) close();
    }
    function onLeave() { close(); }

    function setEdge(on) {
        if (on === byEdge) return;
        byEdge = on;
        if (on) sidebar.addEventListener('pointerleave', onLeave);
        else sidebar.removeEventListener('pointerleave', onLeave);
    }

    if (sidebar) {
        sidebar.addEventListener('click', onClick, true);
        doc.addEventListener('pointerdown', onPointerDown, true);
    }

    function openIt(via = 'menu') {
        if (!sidebar || destroyed) return false;
        if (open) {
            // A menu open makes an edge-opened sidebar stay.
            if (via !== 'edge') setEdge(false);
            return true;
        }
        open = true;
        prevFocus = doc.activeElement;
        saved = [...MODAL_ATTRS, ['aria-label']].map(([k]) => [k, sidebar.getAttribute(k)]);
        for (const [k, v] of MODAL_ATTRS) sidebar.setAttribute(k, v);
        if (!sidebar.getAttribute('aria-label')) sidebar.setAttribute('aria-label', 'Menu');
        doc.body.classList.add(OPEN_CLASS);
        setEdge(via === 'edge');
        addItems();
        return true;
    }

    // While follow() runs, the link's navigation owns focus (it may destroy us mid-click),
    // so no close restores it then.
    function close() {
        if (!open) return;
        open = false;
        const focusInside = contains(sidebar, doc.activeElement);
        setEdge(false);
        for (const [k, v] of saved) {
            if (v === null) sidebar.removeAttribute(k);
            else sidebar.setAttribute(k, v);
        }
        saved = null;
        removeItems();
        doc.body.classList.remove(OPEN_CLASS);
        if (focusInside && !following) restoreFocus(doc, prevFocus);
        prevFocus = null;
    }

    return {
        open: openIt,
        close,
        toggle(via) {
            if (open) close();
            else openIt(via);
            return open;
        },
        isOpen: () => open,
        follow(link) {
            following = true;
            try {
                link.click();
            } finally {
                close();
                following = false;
            }
        },
        destroy() {
            if (destroyed) return;
            close();
            destroyed = true;
            if (sidebar) {
                sidebar.removeEventListener('click', onClick, true);
                doc.removeEventListener('pointerdown', onPointerDown, true);
            }
        },
    };
}
