# Changelog

## [0.2.0] - Unreleased

### Added
- RockHeroSmith is a core play mode: a hero on Home (wordmark art and **Play RockHeroSmith**), a **RockHeroSmith** button on band-ready library cards, Press Start on a free controller, and a tour step. Needs a core with `feedBack.ui.registerPlayMode`; older cores are unaffected.
- **Play as** entry for core's library menus (`libraryCardActions`, placement `play-as`): RockHeroSmith opens the band screen with the song, on band-ready songs (greyed out while a session runs).
- Rock Band miss sound: a controller player in Rock Band part audio hears a short, quiet synthesized "clunk" on a miss, overstrum or overhit (WebAudio, no samples, at most one per 90 ms). **Miss sound** On | Off on the band screen (`prefs.missSound`, default on); solo Play as keeps the saved value.
- Rock Band audio drop on unsplit songs (no stems, or only the `full` stem): a Rock Band controller with no stem of its own muffles the whole song on a miss and brings it back on a hit, a seek or the session's end, by the same rules as a stem drop-out (a real part or Always play controller on the mix keeps it). With the Stems plugin it is a low-pass filter after the stems master; on core's `<audio>` and the desktop JUCE engine the Song volume dips to 40% and is re-applied from the Song fader. The band screen no longer greys 5-Fret Part audio or Drums Rock Band on unsplit songs.
- In-song **Part** sheet: **P** or the stage menu's **Part** item opens each local drums / 5-Fret player's quick settings over the song (the drums and 5-Fret plugins' `mountQuickSettings` on that player's lane), solo or band. It never pauses; Esc, P or Back to the song closes it. While a section practice loop runs it also offers **Stop practice** (the runtime's `stopPractice`, when wired).
- Drum sound mode changes mid-song (Part sheet): saved per player (`parts.drums.soundMode`, the controller's entry, or `solo.soundMode`) and applied live: the drum stem, Rock Band drop-outs and the pad mute are rebuilt without restarting the song.
- Leaving a solo or adopted session mid-song (held Back, Esc, End song) goes to the Solo screen (`openSolo`) instead of band setup; band sessions are unchanged. A sidebar link is still followed.
- **Pad volume** slider beside the real drummer's and each drums controller's sound mode on the band screen (the drums plugin's `getPadSound` / `setPadSound`; hidden without them).

### Changed
- Drum sound modes read **Rock Band**, **Song + pads** and **Kit only** everywhere (ids unchanged). The real drummer's Rock Band is no longer greyed on an unsplit song: it muffles the whole mix.
- Renamed Build-a-Band to RockHeroSmith (id `rockherosmith`, screen `plugin-rockherosmith`); saved band setups move from `build_a_band.prefs.v1` on first load (the old key is kept).

### Deprecated
- `window.__buildABandRuntime` / `__buildABandScreen` (use `__rockherosmith*`).
