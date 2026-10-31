# Changelog

## [Unreleased]

### Added
- **Drums Freestyle is left alone.** A plain drums play is not adopted while the Drums plugin's Play style is Freestyle (`feedBackDrums.isFreestyle()`): no stars bar, no results screen and no saved run for a song played without a score. The Solo screen and band songs still play scored.
- **Part button on the stage.** The hover chrome has a **Part** button (beside Menu) that opens the Part sheet, so mid-song difficulty and the other quick settings no longer depend on remembering **P**. It shows only when there is a sheet to open.

### Fixed
- **Core's tool rail in full mode.** Full mode (the stage's default) hid core's left rail, so plugin controls, the mixer, stems and practice were out of reach on the stage. The rail now reveals from the left edge as it does windowed; the full-mode left edge no longer opens the sidebar (Menu and **M** still do).

## [0.3.1] - Unreleased

### Changed
- **Solo shows the lane's own HUD.** A solo or adopted drums / 5-Fret song keeps the lane's multiplier ring, note streak, score pops, combo rings, full combo, early / late and star power meter (`setScoreHudHidden(canvas, false)`); the band bar shrinks to the song and stars, with the crowd meter when it is on (no duplicate score, no BAND ×N, no band bonus). Needs a Drums / 5-Fret plugin with `hudModes()`; with an older one nothing changes.
- **Band lanes keep their streak HUD.** In a band, a lane whose plugin supports `hudModes()` → `['score']` hides only its own score, stars and accuracy (`setScoreHudHidden(canvas, 'score')`); the band bar keeps the band score. Teardown shows every lane's HUD again.
- The Scorecard is still hidden during every session (`setHudHidden(true)`): a Scorecard that also scores drums / 5-Fret hides only its guitar HUD, so a guitar band never shows its score beside the band score.

### Added
- **`rockHeroSmith.ownsLane(canvas)`**: true while any RockHeroSmith session (solo, adopted or band, whatever `prefs.adoptSolo` says) scores on that lane canvas (the drums-only `#highway`, a band drum lane, any controller lane), through its results. The Drums plugin uses it to leave the song end (its end card, `drums_best_v1`) to RockHeroSmith's results.
- `play:judgment` carries `offsetMs` (hit minus note, ms; null off a hit), `timing` (`'early'` / `'late'` / `'on'` within ±20 ms or the event's own perfect window), `canvas` (the player's lane) and `local: true`.
- `play:session-start` (session, song, band, players with their lane canvases) when a session plays, `play:rewind { sessionId, t }` when the score rewinds (a backward seek or a loop wrap), and `play:session-end { sessionId, reason: 'results' | 'leave' | 'teardown' }`, for the Scorecard on drums and 5-Fret.

## [0.3.0] - Unreleased

Drums & controllers: one play layer for drums and 5-fret, solo or band, plus the Solo screen, the in-song Part sheet and richer results (PRs #3, #4, #5 and #6).

### Added
- **Play layer** (`docs/play-layer-contract.md`): `rockHeroSmith.playSolo` takes `kind: 'kit'` (the real drummer on the Drums plugin's MIDI input) besides drum and 5-fret controllers; a song with no chart for the kind returns `'setup'`. New `soloKindFor(song)` (what the drums Play-as should use), `openSolo({ next })` and `adoptsSolo()`.
- **Plain plays adopted:** a plain drums or 5-Fret play on the main highway (no splitscreen, someone able to score) becomes a one-player RockHeroSmith session with the band HUD, results, drop-outs and miss sound, keeping the player's own difficulty (`prefs.adoptSolo`, default on). It leaves like any song: Esc, End song, a held Back and Results **Next song** go back where it was started; Play again stays adopted.
- **`play:judgment`** and **`play:result`** on the core bus for every scored note and once per results screen (players with difficulty, accuracy, stars, full combo, pro cymbals, failed, per-section accuracy; `practice` for looped or slowed songs). `drums:bonus` (a drum solo bonus) adds points.
- **Solo screen** (its own screen, `plugin-rockherosmith-solo`): pick Drums (kit), a drum controller, a 5-Fret controller (Lead / Rhythm / Bass) or real guitar, a difficulty and the drum sound; the library filtered to songs with that part, with search and **Browse library**; click, Enter or A plays it. Options for the crowd meter, failing and auto-next, all saved in `prefs.solo`. **Play solo** on the Home hero and on Band setup. Leaving a Solo-screen or Play-as song mid-song (Esc, End song, held Back) and its Results **Next song** come back here.
- **Crowd meter off** for solo songs (`prefs.solo.crowd`); scoring and failing are unchanged.
- In-song **Part** sheet: **P** or the stage menu's **Part** item opens each local drums / 5-Fret player's quick settings over the song (the drums and 5-Fret plugins' `mountQuickSettings` on that player's lane), solo or band. It never pauses; Esc, P or Back to the song closes it. While a section practice loop runs it also offers **Stop practice**, which clears the loop and puts the speed back to full.
- Drum sound mode changes mid-song (Part sheet): saved per player (`parts.drums.soundMode`, the controller's entry, or `solo.soundMode`) and applied live: the drum stem, Rock Band drop-outs and the pad mute are rebuilt without restarting the song.
- **Pad volume** slider beside the real drummer's and each drums controller's sound mode on the band screen (the drums plugin's `getPadSound` / `setPadSound`; hidden without them).
- Real drummer in **Rock Band**: the Drums plugin's pads are muted while the drum stem (or, on an unsplit song, the whole mix) drops out on a miss; pads come back at the end of the session.
- **Results:** per-section accuracy on each card with the two worst sections marked; click a section to practice it (A-B loop, 100/90/80/70% speed, and a drill to 90% three times in a row); your best, last runs and "New best!" per song, part and difficulty from feedBack's run history.

### Changed
- Drum sound modes read **Rock Band**, **Song + pads** and **Kit only** everywhere (ids unchanged). The real drummer's Rock Band is no longer greyed on an unsplit song: it muffles the whole mix.
- A loop wrap rewinds the score to the loop start, and a looped or slowed song is practice: never scored, and never ends in Band failed.

## [0.2.0] - Unreleased

### Added
- RockHeroSmith is a core play mode: a hero on Home (wordmark art and **Play RockHeroSmith**), a **RockHeroSmith** button on band-ready library cards, Press Start on a free controller, and a tour step. Needs a core with `feedBack.ui.registerPlayMode`; older cores are unaffected.
- **Play as** entry for core's library menus (`libraryCardActions`, placement `play-as`): RockHeroSmith opens the band screen with the song, on band-ready songs (greyed out while a session runs).
- Rock Band miss sound: a controller player in Rock Band part audio hears a short, quiet synthesized "clunk" on a miss, overstrum or overhit (WebAudio, no samples, at most one per 90 ms). **Miss sound** On | Off on the band screen (`prefs.missSound`, default on); solo Play as keeps the saved value.
- Rock Band audio drop on unsplit songs (no stems, or only the `full` stem): a Rock Band controller with no stem of its own muffles the whole song on a miss and brings it back on a hit, a seek or the session's end, by the same rules as a stem drop-out (a real part or Always play controller on the mix keeps it). With the Stems plugin it is a low-pass filter after the stems master; on core's `<audio>` and the desktop JUCE engine the Song volume dips to 40% and is re-applied from the Song fader. The band screen no longer greys 5-Fret Part audio or Drums Rock Band on unsplit songs.

### Changed
- Renamed Build-a-Band to RockHeroSmith (id `rockherosmith`, screen `plugin-rockherosmith`); saved band setups move from `build_a_band.prefs.v1` on first load (the old key is kept).

### Deprecated
- `window.__buildABandRuntime` / `__buildABandScreen` (use `__rockherosmith*`).
