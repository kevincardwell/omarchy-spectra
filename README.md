# Pulsebar

Audio spectrum for the [Omarchy](https://omarchy.org/) bar.

One `cava` process feeds every monitor. Bars are frame-smoothed rather than
drawn straight from the capture, so they move at your screen's refresh rate
instead of cava's, with a fast attack and a slow release. Peak-hold caps trail
each band. When nothing has made a sound for a couple of seconds the whole
widget folds away, and unfolds the moment audio comes back.

## Requirements

- Omarchy / `omarchy-shell`
- [`cava`](https://github.com/karlstav/cava) — `omarchy pkg add cava`
- PipeWire (used via `pipewire-pulse`)

## Install

```bash
omarchy plugin add https://github.com/<you>/omarchy-pulsebar --enable
omarchy bar move jasper.pulsebar --section left --after omarchy.menu
```

## Settings

Every option is editable from the bar widget's settings form, or inline in
`~/.config/omarchy/shell.json`:

```json
{ "id": "jasper.pulsebar", "bars": 32, "barWidth": 3, "gap": 2, "mode": "Mirror", "color": "Gradient" }
```

| Key | Default | What it does |
|-----|---------|--------------|
| `bars` | `24` | Frequency bands, 4–64. |
| `barWidth` | `3` | Bar width in logical pixels, 1–12. |
| `gap` | `2` | Space between bars, 0–8. |
| `mode` | `Bottom` | `Bottom`, `Mirror` (grows from the centre line), or `Top`. |
| `color` | `Accent` | `Accent`, `Foreground`, `Muted`, or `Gradient` (quiet bands fade toward muted). |
| `peakHold` | `true` | Falling cap at each band's most recent peak. |
| `autoHide` | `true` | Fold the widget away after ~2s of silence. |
| `sensitivity` | `100` | Percent scaling of incoming levels, 25–400. |
| `framerate` | `60` | Capture rate handed to cava, 20–144. |

Colours come from Omarchy's `Color` singleton, so a theme change recolours the
bars live.

Left click opens the audio panel. Right click re-arms the capture — useful
after switching output device, when cava is still attached to the old stream.

## Vertical bars

A vertical bar is handled: bands stack top to bottom and grow sideways, with
`mode` picking which edge they grow from.

## Notes

The capture lives in a `service`-kind plugin, not in the widget, because the
bar instantiates a widget per monitor and a per-widget process would mean one
cava per screen. Widgets register what they want with the service and the most
generous request wins, so a two-monitor setup still runs exactly one capture.

## Remove

```bash
omarchy plugin disable jasper.pulsebar
omarchy plugin remove jasper.pulsebar --yes
```

## License

MIT
