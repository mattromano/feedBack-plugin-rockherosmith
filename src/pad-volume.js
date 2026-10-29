// The drums plugin's pad volume (feedBackDrums.getPadSound / setPadSound, play layer
// contract §4) as a slider beside a drum sound mode: the band screen's drums column
// and each drums controller's Confirm row. The value is the plugin's own saved
// synthVolume (one for every drummer), so RockHeroSmith keeps no copy of it.
// Without the API (an older drums plugin, or none) the field hides.

const STEP_PCT = 5;

// { get(): 0..1 | null, set(volume 0..1) } over window.feedBackDrums, or null.
export function padSoundApi(win) {
    const api = win && win.feedBackDrums;
    if (!api || typeof api.getPadSound !== 'function' || typeof api.setPadSound !== 'function') return null;
    return {
        get() {
            let cur = null;
            try { cur = api.getPadSound(); } catch (_) { return null; }
            const v = cur && Number(cur.volume);
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
        },
        set(volume) {
            try { api.setPadSound({ volume }); } catch (e) { console.warn('[rockherosmith] setPadSound failed', e); }
        },
    };
}

export const volumePct = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100);

// createPadVolume({ doc, win }) -> { field, input, render() }
// render() shows the plugin's current volume (not while the slider has focus, so a
// drag isn't fought) and hides the field when there is no API.
export function createPadVolume({ doc, win }) {
    const field = doc.createElement('div');
    field.className = 'rhs-field rhs-padvol';
    const label = doc.createElement('span');
    label.className = 'rhs-label';
    label.textContent = 'Pad volume';
    const input = doc.createElement('input');
    input.type = 'range';
    input.className = 'rhs-padvol-input';
    input.setAttribute('min', '0');
    input.setAttribute('max', '100');
    input.setAttribute('step', String(STEP_PCT));
    input.setAttribute('aria-label', 'Pad volume');
    const out = doc.createElement('span');
    out.className = 'rhs-padvol-val';
    field.append(label, input, out);

    const show = (pct) => { out.textContent = pct + '%'; };
    input.addEventListener('input', () => {
        const api = padSoundApi(win);
        const pct = Number(input.value);
        if (!api || !Number.isFinite(pct)) return;
        api.set(Math.min(100, Math.max(0, pct)) / 100);
        show(volumePct(pct / 100));
    });

    function render() {
        const api = padSoundApi(win);
        const v = api ? api.get() : null;
        field.hidden = v === null;
        if (v === null || doc.activeElement === input) return;
        input.value = String(volumePct(v));
        show(volumePct(v));
    }

    render();
    return { field, input, render };
}
