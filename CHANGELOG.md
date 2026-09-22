# Changelog

Notable changes to Spectra. Versions follow [semver](https://semver.org): the
`version` field in `manifest.json` is what the marketplace orders updates by.

## 2.0.0

The renderer is new, and so is the settings form. Every 1.x setting still
works; see "Upgrading from 1.x" in the README.

### Changed

- **It costs a sixth of what it did.** With music playing on two monitors, the
  shell spent 35–52% of one core on 1.4, depending on the style; it now spends
  about 6–7%, whatever the style. Measured, what a frame costs is almost
  entirely the bar redrawing, not the spectrum, so the work went into drawing
  fewer frames:
  - Every style is now one fragment shader, `spectrum.frag`. The Repeaters,
    Shape and per-band bindings are gone. A Shape — which drew the line styles —
    takes two frames per update, and so would a Canvas; the shader takes one.
  - Frames are captured and drawn at 30 per second by default. On a 60Hz screen
    that is every other refresh, and drawing on every refresh cost over four
    times as much. `framerate: 60` in `shell.json` restores the old rate.
  - A frame that would put nothing on a different pixel is not drawn.
- **Seven styles instead of ten.** Three of the ten were another style plus an
  option, and now are: Area is Wave with `filled`, Ridge is Steps with `filled`,
  and Trail is Bars with `peak: Trail`. An entry still naming one keeps its look.
- **`feel` replaces five sliders.** Attack, release, punch, smoothing and
  sensitivity become Smooth, Balanced and Punchy. Any of the five set in
  `shell.json` still overrides the preset. Framerate and the fold and suspend
  timings leave the form too; they are documented in the README. The form goes
  from 20 fields to 13.
- `peakHold` becomes `peak` (`Cap`, `Trail`, `Off`); `peakHold: false` still
  means `Off`.
- The line styles are anti-aliased, and Wave is a smooth curve through the
  bands rather than straight segments between them.

### Added

- **Stereo.** The capture is stereo. Mirror draws the left channel up and the
  right channel down, where it used to draw the same mono signal twice.
- **Butterfly**, a new direction: the two channels side by side, with the bass
  meeting in the middle and the colours fanning out from it.
- **Cover**, a new colour: taken from the album art of whatever is playing, and
  sweeping like Spectrum until the art has loaded.

### Fixed

- **`source` hid the widget.** The bar reserves an entry's `source` key for
  custom QML modules, so setting it turned Spectra's entry into a request for a
  QML file that did not exist, and the widget disappeared. The setting is now
  `device`.
- **Spectrum and Gradient now colour the line** of Spikes, Steps and Wave. The
  line was always drawn in the accent colour; only the faint body underneath
  swept.
- **Dots in Mirror light outward from the centre line.** They lit from the top
  edge down.
- **Dots no longer rebuilds its ladder every frame.** Its cells were a model
  recreated per frame, so the whole ladder was destroyed and rebuilt sixty times
  a second, and the cells' fade never ran.

## 1.4.0

### Added

- **Six more styles, for ten in total.** The existing four are unchanged; the
  new ones are:
  - **Beads** — a disc per band riding where the top of the bar would be, so the
    spectrum reads as a contour rather than a solid mass.
  - **Trail** — the bar chased by a translucent ghost falling from its last
    peak.
  - **Glow** — no height at all: each band is a full-depth cell and the level
    reads as brightness, which stays legible on a bar too short for length to
    say much. Brightness is its only channel, so it gets a floor and a curve of
    its own: the floor keeps the strip readable as a row of cells when the room
    is quiet instead of an empty slot, and the curve lifts the quiet bands,
    which otherwise vanish and leave only the bass showing.
  - **Spikes** — bands tapering to a point, dropping to the baseline between
    each one.
  - **Steps** — the spectrum held flat across each band's width instead of
    curved through its centre.
  - **Ridge** — those steps with the body filled in.

  All six honour `mode` and every palette, and the scroll wheel walks the ring
  in order from the most discrete reading of the spectrum to the most
  continuous.

### Changed

- The shaped styles (Spikes, Steps, Ridge, Wave, Area) share one polyline
  builder and one `Shape`, so adding them costs no extra items per band.
- Peak caps are drawn for the styles that do not already show their peak —
  Dots lights its own cap cell, Trail is the peak, and Glow has nowhere to put
  one. Beads caps its contour with a smaller bead rather than a bar.

## 1.3.0

### Fixed

- **The capture no longer stays dead after a crash.** `proc.running` is bound to
  `shouldCapture && _armed`, so reviving by setting an already-true `_armed`
  emitted no change signal and the binding never re-evaluated — PipeWire
  restarting left an empty widget until the shell was reloaded. Every revive now
  drops `_armed` first, the way the relaunch path always did.
- **Monitors drawing different band counts no longer show only bass.** One
  capture serves every screen at the most generous band count asked for, and a
  widget configured for fewer bands read the first *n* entries of it — the
  bottom of the spectrum and nothing else. The shared levels are now folded down
  to each widget's band count, keeping the loudest band in each bin.
- **Scrolling no longer rewrites `shell.json` once per wheel event.** The style
  switches immediately and the write is debounced by 300ms, so a flick of the
  wheel is one write instead of a dozen.
- **An unknown `style`, `mode` or `color` falls back instead of rendering
  nothing.** A typo in a hand-edited `shell.json` used to match no draw branch
  at all and leave an unexplained empty slot. Values are now matched
  case-insensitively against the supported set.
- **A capture that never starts is now reported.** A missing `cava` binary, a
  refused audio server, or a source that does not exist all used to look
  identical to a quiet room. A watchdog gives a fresh process a few seconds to
  produce a frame and marks the widget unavailable if it does not.

### Added

- `source` — name the PulseAudio source cava listens to, instead of always
  following the default output.
- `quietDelay` and `sleepDelay` — how long silence lasts before the widget folds
  away, and how long the capture stays up after the last playback stream ends.
  Both were hardcoded.
- `reducedMotion` — drops the fold, the fade and the dot cross-fade, leaving
  only the spectrum itself moving.
- A hover tooltip naming the current style and colour, and listing the click and
  scroll actions — none of which the widget previously advertised. When the
  capture is unavailable it shows why. It is handed to the bar's own tooltip
  window rather than declared as a popup in the widget: a Qt popup cannot leave
  the bar surface, so it would be clipped to a single line, cover the widget it
  describes, and take the pointer away from it — which stopped the scroll wheel
  from changing style at all.
- A test suite (`node --test test/`) over `Model.js` and the manifest, and a CI
  workflow that runs it. The resampling bug above is covered by it.

### Changed

- **No more `bash` between the widget and the audio.** The cava config is
  written by the service's own `FileView` and handed straight to `cava -p`,
  removing a shell process per capture and the heredoc that quoted it.
- Internal geometry (peak caps, the Dots ladder, the Wave stroke) scales with
  the theme's spacing instead of being fixed at 2px, which read as a hairline on
  a HiDPI bar.
- The render loop reuses its buffers rather than allocating six arrays per
  frame, per monitor.
- Attributed to Kevin Cardwell in the manifest and the license.

## 1.2.0

- Renamed to Spectra under the `radius` namespace.
- Preview image of the four styles.

## 1.1.0

- Dots, Wave and Area styles alongside Bars.
- Gradient and Spectrum palettes.
- Mirror and Top growth directions.

## 1.0.0

- Initial release: a shared cava capture rendered as bars on the Omarchy bar.
