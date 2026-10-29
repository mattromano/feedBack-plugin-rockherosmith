# RockHeroSmith

A Rock Band-style band mode plugin for [feedBack](https://github.com/got-feedback/feedBack).
Play a song as a band from Home or the Song Library: Setup, Confirm, then the live band stage.

## Ways in

- **Play RockHeroSmith** on Home opens band Setup.
- **Play solo** on Home (and on Band setup) opens the Solo screen.
- **Start** on any free controller from Home, the Song Library or Settings opens Setup with
  that controller joined.
- The **RockHeroSmith** button on band-ready Song Library cards (a real guitar part plus a
  charted 5-fret part or a drum chart) opens that song: Confirm when a band is set up, else
  Setup with the song picked.

None of these does anything while a band song is playing.

## Picking a song

- **Picking a song.** Band setup → **Choose a song** opens the Song Library in pick mode
  (band chips, click to select, **Use this song**) → Confirm (parts, difficulty, devices,
  drum sound) → GO. Next song goes back to the library.

## Solo

The Solo screen is for playing alone: a band of one on the RockHeroSmith stage.

- **Instrument:** Drums (kit) on the Drums plugin's MIDI input, a drum controller, a 5-fret
  controller (Lead / Rhythm / Bass), or real guitar (Lead / Rhythm / Bass arrangement). Pick a
  difficulty, and for drums the drum sound.
- **Songs:** the library, filtered to songs with that part (a drum chart, the 5-fret part, or the
  arrangement), with a search box. **Browse library** opens the Song Library in pick mode with
  the same filter.
- **Click a song, or Enter / A:** it plays straight away on that chart. Drums and controllers
  play on the RockHeroSmith stage (`playSolo`); real guitar plays as a normal song on that
  arrangement.
- If the instrument isn't there (no MIDI kit, no controller), the screen says so and offers
  the Drums or 5-Fret controls.
- **Options:** the crowd meter on or off, failing, and **Next song** (back to the list, or play
  the next song in it).
- Every choice is remembered (`prefs.solo`). Results' **Next song** after a solo song comes
  back here.

## Playing on a controller

- **Joining.** With the 5-Fret or Drums plugin installed, press **Start** on an Xbox
  controller, a plastic guitar or a plastic Rock Band kit on the band screen. It gets a
  column on Band setup and a row on Confirm, next to the guitar, drums and vocals. Its
  lights follow what it plays: five frets for 5-Fret, or red, yellow, blue and green pads
  plus the kick for Drums (a cymbal lights its pad's colour).
- **Plays as.** A guitar plays 5-Fret and a kit plays Drums. An Xbox pad (with both plugins)
  can play either, so it joins undecided ("Choose 5-Fret or Drums") and its column shows a
  **Plays as** segment (5-Fret | Drums). On a standard pad **X** picks 5-Fret and **B** picks
  Drums. The choice is remembered for that controller, so it rejoins the same way after
  Leave; the segment changes it any time. Until it is chosen the controller sits out, and
  Start on it does nothing.
- **Set up first.** A controller neither plugin knows yet (no standard mapping, no saved
  binding) can't join. The join slot lists it with a **Set up** link per plugin ("as
  guitar" opens the 5-Fret controls screen, "as drum kit" the Drums one), and Back there
  returns to the band screen. **Controls** on a column opens the screen for what it plays.
- **On Confirm, 5-Fret:** pick the part (Lead, Rhythm or Bass; parts the song lacks are
  greyed, each is tagged *real* or *auto*, and "also:" names the other controllers on it),
  the difficulty, Lefty, and Part audio: **Rock Band** drops your part's stem on a miss,
  **Always play** keeps it. On an unsplit song (no stems, or only the full mix) Rock Band
  muffles the whole song instead. Part audio is greyed when a split song has no stem for
  the part.
- **On Confirm, Drums:** the part is Drums ("also:" names the other drummers), then the
  difficulty and the Sound: **Song drums**, **Rock Band** or **My kit only**, as for the
  real drummer. Rock Band and My kit only are greyed when a split song has no drum stem
  (on an unsplit song only My kit only is). With
  the real drummer on, the drummer's own sound mode sets the drum stem and the controller's
  Sound doesn't apply (the row says so). A song with no drum chart says "No drum chart for
  this song" and the controller sits out.
- **Rock Band audio.** For a controller in Rock Band part audio (5-Fret Rock Band, Drums
  Rock Band), a miss, an overstrum or an overhit plays a short, quiet "clunk" (synthesized,
  no sample files; at most one every 90 ms), and the part's audio drops until the next hit
  or a seek. A song with no stem for the part drops nothing, unless it is unsplit (no
  stems, or only the `full` stem): then the whole song is muffled. In the browser with the
  Stems plugin that is a real low-pass on the song; on core's plain `<audio>` path and the
  desktop's native (JUCE) engine the song's volume dips to 40% instead. A real part or an
  Always play controller playing along keeps the song unmuffled, and it always comes back
  on a hit, a seek or when the song ends. **Miss sound** (On | Off, next to Failing on the
  band screen) turns the clunk off; solo Play as uses the same setting. Real players
  never clunk.
- **Start on a joined controller** is the screen's main button: Choose a song on Band
  setup, GO on Confirm. Frets and pads never press GO. **Leave** on the column, or holding
  Back for 1 s, takes the controller out. Joined controllers stay joined across songs; one that is
  unplugged shows "Not connected" and sits out.
- **In the song.** Start on a controller pauses and resumes the band song. Holding Back for
  1 s pauses and asks "Leave the song?": then Start answers Stay and holding Back again
  answers Leave, from any band controller. Under Settings the controller does nothing.
- **Missing pieces.** Without the 5-Fret or Drums plugin the join slot says to install one;
  on an older feedBack it says to update.

## On the stage: full screen, the hover chrome, the sidebar and Settings

- **Full screen.** With "Full screen stage" on (the band screen), Go and Play again take the
  window full screen and the lanes run to the bottom. Every other way out of the song leaves
  it. Leaving full screen yourself (Esc, the OS) turns full mode off for the rest of the song.
  A Go from a drum pad, or a window that already fills the screen, keeps full mode inside
  the window.
- **The hover chrome.** Moving the mouse shows core's transport, the section map and a band
  row with Menu, the A-B loop (Loop A, Loop B, Clear loop), Full screen and End song.
- **`M` and the sidebar.** `M`, the Menu button or (in full mode) the left edge open the app
  sidebar over the song, which keeps playing. Esc, a click outside it or leaving it (when
  the edge opened it) closes it. With the sidebar shut, Esc leaves the song as usual.
- **Settings mid-song.** The sidebar's Settings pauses the song and shows Settings over it.
  Esc or "Back to the song" closes it, puts the band guitar difficulty back and resumes only
  what was playing. Any other sidebar item pauses and asks "Leave the song?": Stay resumes,
  Leave goes there.
- **Guitar input errors.** In a band song note_detect doesn't block with an alert. The band
  shows "Guitar input couldn't start" instead.

## Results: sections, practice and your bests

- **Sections.** Each card lists the song's sections with that player's accuracy in them; the
  two worst (below 100%, at least 4 notes) are marked in red.
- **Practice a section.** Click a section to play the song again looping it with core's A-B
  loop. The practice bar sets the speed (100/90/80/70%) and the drill: loop until 90% three
  times in a row, speeding up a step after each clear below full speed. Every loop pass starts
  from the score at the loop start, and a practice song never ends in Band failed.
- **Practice isn't scored.** A song that looped or was slowed down is sent as practice, so
  feedBack keeps no stats, XP or bests for it.
- **Bests.** With a feedBack that has run history, each drums, 5-fret and vocals card shows
  your best for the song, part and difficulty, your last runs, and "New best!" when this run
  beats it.

## Development

```
npm test
```

Licensed MIT. Contains no third-party game artwork, logos or sounds.

Licences: MIT, except `src/yarg-rules.js` and its test (LGPL-3.0, YARG star rules); see
[NOTICE.md](NOTICE.md) for those, the Lucide icons (ISC) and the fonts (OFL).
