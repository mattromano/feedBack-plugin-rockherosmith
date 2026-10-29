// Band session state machine. Pure: returns the next state plus the named
// effects the caller must run; never mutates its input.
// solo: a one-player session (playSolo, or a plain play adopted, contract §2).
// adopted: a plain play adopted (or its Play again), which leaves like a normal play:
// its Next song is core's exit, back where the song came from. A playSolo session's
// Next song goes to the Solo screen.
export function initialSession() {
    return { phase: 'idle', filename: null, solo: false, adopted: false };
}

const IDLE = Object.freeze({ phase: 'idle', filename: null, solo: false, adopted: false });

// phase -> event type -> (state, event) => { phase/filename change, effects }
const TABLE = {
    idle: {
        go: (s, e) => [{ phase: 'armed', filename: e.filename, solo: e.solo === true, adopted: e.adopted === true },
            ['saveRestorePoint', 'armVocals', 'play']],
        // A plain drums / 5-fret play, already loading: no play, no vocals.
        adopt: (s, e) => [{ phase: 'playing', filename: e.filename, solo: true, adopted: true },
            ['saveRestorePoint', 'mount', 'applyDifficulties', 'applyDevices']],
    },
    armed: {
        ready: (s, e) => (e.filename === s.filename
            ? [{ ...s, phase: 'playing' }, ['mount', 'applyDifficulties', 'applyDevices', 'startVocals']]
            : [IDLE, ['teardown']]),
        loading: (s) => [s, []],
        left: () => [IDLE, ['teardown']],
    },
    playing: {
        loading: () => [IDLE, ['teardown']],
        ended: (s) => [{ ...s, phase: 'ending' }, ['holdExit', 'showResults']],
        // Fail mode (plan 5 R12): every part dropped out, so the song stops into the results.
        failed: (s) => [{ ...s, phase: 'ending' }, ['pauseSong', 'showResults']],
        left: () => [IDLE, ['teardown']],
    },
    // The results show (R16): Next song releases core's held exit and returns
    // to the band screen (a playSolo session's to the Solo screen; an adopted play's
    // to where it came from, core's exit); Play again drops it and replays (always last),
    // keeping the plugins' own score displays hidden into the replayed session.
    ending: {
        loading: () => [IDLE, ['hideResults', 'dropExit', 'teardown']],
        again: () => [IDLE, ['hideResults', 'dropExit', 'keepHides', 'teardown', 'replay']],
        next: (s) => [IDLE, ['hideResults', 'teardown', 'releaseExit', nextScreen(s)]],
        left: () => [IDLE, ['hideResults', 'dropExit', 'teardown']],
    },
};

function nextScreen(s) {
    if (s.adopted) return 'exitToOrigin';
    return s.solo ? 'showSoloScreen' : 'showBandScreen';
}

export function reduceSession(state, event) {
    const row = TABLE[state.phase];
    const fn = row && event && row[event.type];
    if (!fn) return { state, effects: [] };
    const [next, effects] = fn(state, event);
    return {
        state: { phase: next.phase, filename: next.filename, solo: next.solo === true, adopted: next.adopted === true },
        effects: [...effects],
    };
}
