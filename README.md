# Spectra

Audio spectrum for the [Omarchy](https://omarchy.org/) bar: seven styles in
stereo, one shared capture, and one shader that draws only the frames that
change. It gets out of the way when the room is quiet.

![Spectra](preview.png)

## Styles

| Style | What it looks like |
|-------|--------------------|
| **Bars** | Classic rectangles with falling peak caps — or, with `peak` set to `Trail`, chased by a translucent ghost of the last peak. |
| **Dots** | An LED ladder: each band lights cells outward from the baseline, with the peak cell held bright. |
| **Beads** | One disc per band, riding where the top of the bar would be — a contour of dots. |
| **Glow** | No height: each band is a full-depth cell and the level reads as brightness. |
| **Spikes** | Bands tapering to a point, dropping to the baseline between each one. |
| **Steps** | The spectrum held flat across each band's width. |
| **Wave** | The spectrum as one smooth curve. |

Scrolling walks them in that order, from the most discrete reading of the
spectrum to the most continuous. Spikes, Steps and Wave sit over a faint body,
which `filled` makes solid.

Each style grows up from the baseline, down from the ceiling, or out from a
centre line (`mode`). **Mirror** is stereo: the left channel grows up and the
right channel down. **Butterfly** lays the two channels side by side with the
bass meeting in the middle.

Colour (`color`) is a flat theme colour, a gradient that brightens with the
level, a hue sweep anchored on your accent, or **Cover**: colours taken from the
album art of whatever is playing.

## Switching, without opening anything

- **Scroll** over the widget to step through the styles.
- **Middle click** for the next style, **right click** for the next colour.
- **Left click** opens the audio panel.
- **Hover** for a tooltip naming the current style, colour and direction — and,
  if the capture is broken, saying why.
- From a keybinding or a script:

```bash
omarchy-shell radius.spectra cycleStyle
omarchy-shell radius.spectra setStyle Spikes
omarchy-shell radius.spectra cycleColor
omarchy-shell radius.spectra setColor Cover
omarchy-shell radius.spectra reload      # re-arm the capture
```

Every switch is written back to `~/.config/omarchy/shell.json`, so what you land
on is what you get after a restart.

## Requirements

- Omarchy / `omarchy-shell`
- [`cava`](https://github.com/karlstav/cava) — `omarchy pkg add cava`
- PipeWire (used through `pipewire-pulse`)

## Install

```bash
omarchy plugin add https://github.com/kevincardwell/omarchy-spectra --enable
omarchy bar move radius.spectra --section left --after omarchy.menu
```

## Settings

All of these are in the widget's settings form, or inline in `shell.json`:

```json
{ "id": "radius.spectra", "style": "Wave", "mode": "Mirror", "color": "Spectrum" }
```

| Key | Default | What it does |
|-----|---------|--------------|
| `style` | `Bars` | `Bars`, `Dots`, `Beads`, `Glow`, `Spikes`, `Steps`, `Wave`. |
| `filled` | `false` | Fill the body under Spikes, Steps and Wave instead of only hinting at it. |
| `mode` | `Bottom` | `Bottom`, `Mirror`, `Top`, `Butterfly`. |
| `color` | `Accent` | `Accent`, `Foreground`, `Muted`, `Gradient`, `Spectrum`, `Cover`. |
| `peak` | `Cap` | `Cap` leaves a falling cap on each band's recent peak, `Trail` draws Bars chased by a ghost of it, `Off` shows the level alone. |
| `feel` | `Balanced` | How the spectrum moves: `Smooth` glides and spreads each peak wide, `Punchy` snaps to transients and drops fast. |
| `bars` | `28` | Frequency bands, 4–64. Butterfly rounds up to an even count. |
| `barWidth` | `3` | Bar width in logical pixels. |
| `gap` | `2` | Space between bars. |
| `fill` | `62` | Percentage of the bar's height the spectrum may use. |
| `autoHide` | `true` | Fold the widget away after ~2s of silence. |
| `device` | _(empty)_ | PulseAudio source to listen to. Empty follows the default output; `pactl list sources short` lists the names. |
| `reducedMotion` | `false` | Drop the fold and the fade; leave only the spectrum moving. |

Colours come from Omarchy's `Color` singleton, so a theme change recolours
everything live.

### Advanced

These are not in the form, and only matter if the presets do not suit. Set them
in `shell.json`.

| Key | Default | What it does |
|-----|---------|--------------|
| `sensitivity` | from `feel` | Percent scaling of the incoming levels. |
| `punch` | from `feel` | Bends the level curve so quiet passages still lift off the baseline. 100 is linear. |
| `smoothing` | from `feel` | Spreads each peak into its neighbours, 0–100. 0 shows raw FFT bins, which look spiky. |
| `attack` | from `feel` | How fast a band rises to a transient, 0–100. |
| `release` | from `feel` | How fast it sinks back, 0–100. |
| `framerate` | `30` | Frames per second, captured and drawn. 60 is smoother and costs about four times as much — see below. |
| `idleSuspend` | `true` | Stop the cava process entirely while nothing is routed to an output. |
| `quietDelay` | `2000` | Milliseconds of silence before the widget folds away. |
| `sleepDelay` | `6000` | Milliseconds the capture stays up after the last playback stream ends. |

### Upgrading from 1.x

Nothing needs changing. The three retired styles still work — `Area` is Wave
filled, `Ridge` is Steps filled, `Trail` is Bars with `peak: Trail` — and
`peakHold: false` still means `peak: Off`.

The one exception is `source`, which becomes `device`. The bar reserves
`source` for custom QML modules, so an entry that set it was never loaded as
Spectra at all: the widget simply vanished. Rename it and it works.

## How it behaves

**It costs little.** On a 5950X with two monitors and a busy track playing, the
shell spends about 6–7% of one core on Spectra, whatever the style; 1.4 spent
35–52%. Almost all of what a frame costs is the bar redrawing, not the
spectrum, so the savings come from drawing fewer frames:

- Every style is one fragment shader (`spectrum.frag`), which redraws once per
  update. A Shape or a Canvas takes two.
- It draws at 30 frames a second — every other refresh of a 60Hz screen. On
  that machine, drawing on every refresh costs over four times as much, not
  twice.
- A frame that would land on the same pixels as the last one is not drawn.
- With nothing playing, it draws nothing at all.

**One capture, every monitor.** The bar instantiates a widget per screen, so
the cava process lives in a `service`-kind plugin instead. Widgets register
what they want and the most generous request wins; two differently configured
instances still share one capture.

**Stereo, with nothing extra to run.** The capture is stereo. Mirror and
Butterfly draw the two channels apart; the other directions draw whichever of
the two is louder in each band.

**It idles out.** With `idleSuspend` on, cava is stopped whenever nothing is
routed to an output at all, and comes back as soon as something is — a desktop
with no player open pays nothing for the widget. `autoHide` is the visual half
of the same idea: after a couple of seconds of silence the widget folds to zero
width and the bar closes up around it.

**It is smoothed twice, for different reasons.** Along the spectrum, each band
claims the best of its neighbours attenuated by distance, so a peak becomes a
shoulder rather than a spike. Over time, bands rise fast and fall slowly, timed
by the clock rather than the frame count, so the motion is the same at any
framerate.

**Vertical bars work.** Bands stack top to bottom and grow sideways, with
`mode` picking the edge they grow from.

**One capture, any band count.** The shared capture runs at the most generous
band count any monitor asked for, and each widget folds it down to the number it
draws — keeping the loudest band in each bin, so a transient survives the
downmix. Two monitors can show 16 and 64 bands of the same audio.

**It says when it is broken.** A missing `cava`, a refused audio server or a
device that does not exist all look exactly like a quiet room. A watchdog gives
a fresh capture a few seconds to produce a frame; if it does not, the widget
shows a muted-speaker glyph and the tooltip explains it. It gives up after three
attempts rather than forking a process in a loop — `reload` re-arms it.

## Development

`Model.js` holds everything that can be reasoned about without a running shell —
settings validation, frame parsing, band layout and motion, the merge of what
each monitor asked for, and the cava config. `Spectrum.qml` runs that per frame
and hands it to `spectrum.frag`. The tests need nothing beyond node:

```bash
node --test
```

They also check that the manifest, the widget, the shader and this README have
not drifted apart, and that the compiled shader matches its source.

The shell loads `spectrum.frag.qsb`, the compiled form, because Qt 6 does not
compile GLSL at runtime. After editing `spectrum.frag`, rebuild it with Qt's
`qsb` (`qt6-shadertools` on Arch):

```bash
tools/build-shader.sh
```

Running the same script on an unedited checkout should leave `git diff` empty.

## Remove

```bash
omarchy plugin disable radius.spectra
omarchy plugin remove radius.spectra --yes
```

## License

MIT
