# Play layer contract (drums & controllers plan, 2026-10-29)

The fixed interfaces the parallel streams build against. A change to anything here
goes through the orchestrating session first. Plan:
`side-session-notes/local_6117990b-…/drums-controllers-plan.md`.

## Principle

RockHeroSmith's runtime is the one play session for drums (MIDI kit or controller)
and 5-fret, solo ("a band of one") or band. The plugins judge notes and draw lanes;
RockHeroSmith scores, shows the HUD/results, runs stem drop-out, muffle and clunk,
and publishes the results. Real guitar (note detect + Scorecard) is unchanged.
Without RockHeroSmith every plugin behaves exactly as it does today.

## 1. Entry point (RockHeroSmith)

`window.rockHeroSmith` stays `version: 1` and gains fields; nothing is removed.

```js
rockHeroSmith.playSolo(item, { kind, part?, difficulty? })
  // kind: 'kit'        the real drummer on the drums plugin's MIDI input (new)
  //       'drums'      a drums game controller / plastic kit
  //       'five_fret'  a 5-fret controller; part 'guitar' | 'rhythm' | 'bass'
  // -> Promise<'started' | 'setup' | false>   (unchanged meaning)
rockHeroSmith.soloKindFor(song) -> Promise<'kit' | 'drums' | null>
  // what the drums Play-as should use: 'kit' when feedBackDrums.midiInput()
  // is connected (after feedBackDrums.whenMidiReady() when present), else
  // 'drums' when a game controller is connected, else null
rockHeroSmith.openSolo(opts?)   // shows the Solo screen (stream B2); { next: true } from Results
rockHeroSmith.adoptsSolo() -> boolean
  // true only while RockHeroSmith scores the plain play on the main #highway: prefs.adoptSolo
  // on, no splitscreen, and an adopt pending or a solo / adopted session running. Cheap
  // (in-memory prefs): the plugins ask every frame and hide their own HUD only when true
```

- `kind: 'kit'` builds prefs with `parts.drums.on = true` (deviceKey = the connected
  `feedBackDrums.midiInput().key`, else the saved `parts.drums.deviceKey` when midiInput is
  absent or not connected; a kit solo or adopt never switches away from the connected
  input), every other part off, `controllers: []`. Sound mode = saved `parts.drums.soundMode`.
- Controller solos take `soundMode` from the saved controller entry for that key
  when there is one, else `prefs.solo.soundMode`; never hard-coded.
- A song with no chart for the kind returns `'setup'` (never starts with no lane).

## 2. Adopting plain plays

A song that reaches `song:ready` on a drums or 5-fret part, with no RockHeroSmith
session and `prefs.adoptSolo === true`, becomes a one-player session.
- `session.js` gains `idle --adopt{filename}--> playing`, with effects
  `['saveRestorePoint', 'mount', 'applyDifficulties', 'applyDevices']` (no `play`;
  the song is already loading).
- Who: the drum view on a drum part means `kit` (or the controller pinned to it); the
  5-fret view means the 5-fret controller that is playing it.
  The 5-fret part is the one the plugin's #highway instance reports (core's song has no
  5-fret parts). Only the main #highway is adopted (never splitscreen panels), and only
  with a scoring player: nobody able to play means no adopt. The player's own difficulty
  (the plugin's) is kept, Expert+ as Expert.
- Leaving or loading another song tears it down like any session. An adopted play
  leaves like a normal play: Esc, End song, held Back and Results "Next song" take
  core's exit, back where the song came from (Play again keeps it adopted). Only a
  `playSolo` session (Solo screen or Play as) leaves to the Solo screen, and its
  Results "Next song" goes there too, never to the band screen.

## 3. Events out (core bus, `feedBack.emit`)

Emitted only by RockHeroSmith. Core and plugins consume these, never `drums:*` /
`five_fret:*`, for anything above lane drawing.

```js
'play:judgment' {
  filename, sessionId,           // sessionId: unique per started/adopted session
  player,                        // 'drums' | 'guitar' | 'vocals' | 'ctl<N>'
  instrument,                    // 'drums' | 'five_fret' | 'guitar' | 'vocals'
  part,                          // 'drums' | 'guitar' | 'rhythm' | 'bass' | 'vocals' | 'lead'…
  input,                         // 'kit' | 'controller' | 'mic' | 'audio'
  kind,                          // ledger kind: 'hit' | 'miss' | 'overhit' | 'sustain' | 'phrase' | 'deploy' | 'bonus'
  points, multiplier, streak, t, noteTime,  // noteTime null when unknown
  offsetMs,                      // signed ms, hit minus note (+ = late); null off a hit or unreported
  timing,                        // 'early' | 'late' | 'on' | null; 'on' within ±20 ms, or the
                                 //   lane event's own perfectMs / perfectWindowMs when it has one
  canvas,                        // the player's lane canvas (in-page bus only, never serialised); null
                                 //   for guitar / vocals
  local: true,                   // judged on this machine
}
'play:session-start' {           // once per session, when its stage first mounts (solo, adopted, band)
  sessionId, filename, title, artist,   // title / artist null when unknown
  band: boolean,                 // more than one player
  players: [{ player, instrument, part, input, difficulty, canvas }]   // canvas as in play:judgment
}
'play:rewind' { sessionId, t }   // the ledger rewound to t (a backward seek > 50 ms, or a loop wrap)
'play:session-end' {             // once, for a session that sent play:session-start
  sessionId,
  reason,                        // 'results' (the results opened: song end or fail)
                                 // 'leave'   (left mid-song: Esc, End song, held Back, stop)
                                 // 'teardown' (anything else: another song loading, …)
}
'play:result' {
  filename, sessionId, band: boolean,   // band = more than one player
  practice: boolean,                    // looped / slowed: never scored (stream B3 sets it)
  players: [{
    player, instrument, part, input, difficulty,   // 'easy'|'medium'|'hard'|'expert'
    arrangement,                         // arrangement index that was loaded, or null
    score, stars, accuracy,              // accuracy 0..1 = hits / (hits + misses)
    hits, misses, overhits, bestStreak,
    fullCombo: boolean,
    proDrums: boolean,                   // pro cymbals in effect (drums players; false otherwise)
    failed: boolean,                     // dropped out in fail mode (rescued or not)
    sections: [{ name, start, end, hits, misses, accuracy }]   // [] until B3
  }],
  durationSec
}
```

`play:result` fires once, when the results screen opens (song end or fail), not on
leave mid-song.

The offset source is the lane event: the 5-Fret plugin's `five_fret:hit` `offsetMs` (ms), else
the Drums plugin's `drums:hit` `offset` (seconds × 1000), rounded to whole ms.

### Lane HUD modes (amendment, 2026-10-29)

The drums and 5-Fret plugins take `setScoreHudHidden(canvas, mode)`, mode `true` (hide the
whole HUD) | `false` (show it) | `'score'` (hide only the score number, stars and accuracy;
keep streak, multiplier, pops, combo rings, full combo, early / late and the star power meter),
and report `hudModes() -> ['score']`. RockHeroSmith gives a lane:
- one local player (playSolo, adopted, a band of one): `false`, and its own bar shrinks to
  song, stars and (when on) the crowd meter;
- a band: `'score'` when `hudModes()` includes it, else `true`;
- a plugin without `hudModes`: `true` in every case (as before).
Teardown sets `false` on every lane it touched. The plugins' `adoptsSolo` gate no longer hides
their HUD (only their end card and local best).

Scorecard: RockHeroSmith calls `feedBackScorecard.setHudHidden(true)` for a session unless
`feedBackScorecard.instruments()` exists and lists the instrument of every local non-vocal
player (`'guitar'` | `'drums'` | `'five_fret'`), solo or band.

## 4. Drums plugin (`window.feedBackDrums`, additive)

```js
feedBackDrums.midiInput() -> { key, name, connected } | null   // the saved MIDI input
feedBackDrums.setPadSound({ muted?: boolean, volume?: number }) -> { muted, volume }
  // volume 0..1 is synthVolume (saved, same as the Pad volume setting);
  // muted silences pad and auto-note sounds without changing volume; replaces
  // window.__drumsMutePads (kept as an alias for calibration)
feedBackDrums.getPadSound() -> { muted, volume }
feedBackDrums.mountQuickSettings(el, { canvas?, soundModes?, onSoundMode? }) -> { destroy() }
  // difficulty, auto kick, auto cymbals, pro cymbals / 4-lane, timing window,
  // input offset + early/late Apply, pad volume; and, when soundModes is given
  // (RockHeroSmith), a sound-mode switch calling onSoundMode(id). Changes apply live.
```

New lane event on the bus, with the band events: `drums:bonus { canvas, points,
reason: 'solo' }` when a drum solo's bonus is paid (timing and roll bonuses are
already in hit points). RockHeroSmith maps it to a ledger entry `kind: 'bonus'`
(points only; no streak or crowd change).

Fallback: the drums HUD, end card and `drums_best_v1` run only when
`window.rockHeroSmith` is absent or `prefs.adoptSolo` is off.
The gear panel moves into `feedBack.ui.playerControlSlot()` when present.

## 5. 5-Fret plugin (`window.feedBackFiveFret`, additive)

```js
feedBackFiveFret.mountQuickSettings(el, { canvas?, controllerKey? }) -> { destroy() }
  // difficulty, part (guitar/rhythm/bass), lefty, input offset; live
```
Same fallback rule for its HUD.

## 6. Drum sound modes (ids unchanged, so no migration)

| id | Label | Song's drum stem | Pads |
|---|---|---|---|
| `rockband` | Rock Band | drops out on miss / overhit, back on hit or seek; no drum stem → full-mix muffle | muted (`setPadSound({muted:true})`) |
| `song` | Song + pads | always plays | play |
| `kit` | Kit only | muted all song | play |

Applies to the real drummer (`parts.drums.soundMode`, default `song`) and drums
controllers (`controllers[].soundMode`, default `rockband`). RockHeroSmith restores
`muted:false` at teardown.

## 7. RockHeroSmith prefs additions (`rockherosmith.prefs.v1`, stream A2 only)

```js
adoptSolo: true,                     // use the band HUD for plain drums / 5-fret plays
solo: {
  instrument: 'kit',                 // 'kit' | 'drums' | 'five_fret' | 'guitar'
  part: 'guitar',                    // 5-fret part
  arrangement: 'Lead',               // real guitar
  difficulty: 'expert',
  soundMode: 'rockband',             // controller solos without a saved entry
  crowd: true,                       // crowd meter in solo
  failMode: 'nofail',
  autoNext: false,                   // play the next song in the Solo list
},
```

`normalizePrefs` validates each with the existing `oneOf` / `bool` helpers; `savePrefs`
merges `solo` shallowly like `pickFilters`.

## 8. Stream ownership (no two writers on one file)

| Stream | Owns |
|---|---|
| A1 core library filter | core `static/v3/songs.js`, songs tests |
| A2 RHS play layer | RHS `solo.js`, `session.js`, `band-runtime.js`, `part-events.js`, `prefs.js`, `drum-sound.js`, `stem-sound.js`, `screen.js` |
| A3 drums APIs | drums `screen.js`, `assets/session.js`, `screen.html` |
| A4 5-fret APIs | five-fret `screen.js`, `assets/controls.js` |
| A5 core progression | core `lib/routers/stats.py`, `lib/metadata_db.py` (stats tables only), `static/v3/stats-recorder.js`, `plugins/achievements`, `plugins/career` |
| B1 Part sheet + sound UI | RHS `sidebar-overlay.js`, new `part-sheet.js`, `controller-columns.js`, band-screen drums column |
| B2 Solo screen | RHS new `solo-screen.js`, `main-mode.js`, `band-screen.js` hero/nav hooks |
| B3 Results | RHS `results.js`, `results-screen.js`, new `sections.js`, new `practice.js` |
