// Band session state machine. Pure: returns the next state plus the named
// effects the caller must run; never mutates its input.
// solo: a one-player session (playSolo, or a plain play adopted, contract §2), whose
// Next song goes to the Solo screen.
export function initialSession() {
    return { phase: 'idle', filename: null, solo: false };
}

const IDLE = Object.freeze({ phase: 'idle', filename: null, solo: false });

// phase -> event type -> (state, event) => { phase/filename change, effects }
const TABLE = {
    idle: {
        go: (s, e) => [{ phase: 'armed', filename: e.filename, solo: e.solo === true }, ['saveRestorePoint', 'armVocals', 'play']],
        // A plain drums / 5-fret play, already loading: no play, no vocals.
        adopt: (s, e) => [{ phase: 'playing', filename: e.filename, solo: true },
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
    // to the band screen (a solo session's to the Solo screen); Play again drops it and replays (always last),
    // keeping the plugins' own score displays hidden into the replayed session.
    ending: {
        loading: () => [IDLE, ['hideResults', 'dropExit', 'teardown']],
        again: () => [IDLE, ['hideResults', 'dropExit', 'keepHides', 'teardown', 'replay']],
        next: (s) => [IDLE, ['hideResults', 'teardown', 'releaseExit', s.solo ? 'showSoloScreen' : 'showBandScreen']],
        left: () => [IDLE, ['hideResults', 'dropExit', 'teardown']],
    },
};

export function reduceSession(state, event) {
    const row = TABLE[state.phase];
    const fn = row && event && row[event.type];
    if (!fn) return { state, effects: [] };
    const [next, effects] = fn(state, event);
    return { state: { phase: next.phase, filename: next.filename, solo: next.solo === true }, effects: [...effects] };
}
