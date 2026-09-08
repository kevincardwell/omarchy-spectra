#!/usr/bin/env bash
#
# Record preview.gif from the live widget.
#
# The ten styles are the whole point of the plugin and all of them move, so a
# still image undersells it. This walks every style through the widget's own IPC
# while capturing the bar region, then assembles a GIF.
#
# Play something first — the widget folds itself away when the room is quiet.
#
#   tools/record-preview.sh              # pick the region with the mouse
#   tools/record-preview.sh -g 12,4,240,28
#   SECONDS_PER_STYLE=3 tools/record-preview.sh
#
# Needs: grim, ffmpeg, and slurp unless -g is given.

set -euo pipefail

fps=${FPS:-15}
per_style=${SECONDS_PER_STYLE:-1.5}
out=${OUT:-preview.gif}
geometry=""

while [ $# -gt 0 ]; do
  case "$1" in
    -g|--geometry) geometry=$2; shift 2 ;;
    -o|--output) out=$2; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in grim ffmpeg; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

if [ -z "$geometry" ]; then
  command -v slurp >/dev/null || { echo "missing slurp; pass -g x,y,wxh" >&2; exit 1; }
  echo "Drag a box around the widget..." >&2
  geometry=$(slurp)
fi

# Restore whatever the user was looking at, and never leave the frames behind.
original_style=$(
  grep -o '"id": *"radius.spectra"[^}]*"style": *"[A-Za-z]*"' \
    "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/shell.json" 2>/dev/null \
    | grep -o '"style": *"[A-Za-z]*"' | grep -o '[A-Za-z]*"$' | tr -d '"' || true
)
frames=$(mktemp -d)
cleanup() {
  rm -rf "$frames"
  [ -n "$original_style" ] && omarchy-shell radius.spectra setStyle "$original_style" >/dev/null 2>&1 || true
}
trap cleanup EXIT

frame=0
delay=$(awk -v f="$fps" 'BEGIN { printf "%.3f", 1 / f }')

# Counted in frames rather than against the clock: `date` arithmetic on a
# fractional duration is awkward, and awk's default number format mangles a
# unix timestamp into scientific notation.
per_style_frames=$(awk -v f="$fps" -v n="$per_style" 'BEGIN { printf "%d", (f * n) + 0.5 }')
[ "$per_style_frames" -gt 0 ] || per_style_frames=1

for style in Bars Dots Beads Trail Glow Spikes Steps Ridge Wave Area; do
  echo "Recording $style..." >&2
  omarchy-shell radius.spectra setStyle "$style" >/dev/null 2>&1 || {
    echo "could not reach the widget over IPC — is the shell running?" >&2
    exit 1
  }
  # Let the switch land and the bars settle into the new style before capturing.
  sleep 0.4

  captured=0
  while [ "$captured" -lt "$per_style_frames" ]; do
    grim -g "$geometry" "$(printf '%s/%05d.png' "$frames" "$frame")"
    frame=$((frame + 1))
    captured=$((captured + 1))
    sleep "$delay"
  done
done

echo "Assembling $frame frames into $out..." >&2

# Two passes: one to derive a palette from the frames actually captured, one to
# apply it. A generic 216-colour web palette bands the gradients badly.
palette="$frames/palette.png"
ffmpeg -v error -y -framerate "$fps" -pattern_type glob -i "$frames/*.png" \
  -vf "palettegen=stats_mode=diff" "$palette"
ffmpeg -v error -y -framerate "$fps" -pattern_type glob -i "$frames/*.png" -i "$palette" \
  -lavfi "paletteuse=dither=bayer:bayer_scale=3" -loop 0 "$out"

echo "Wrote $out ($(du -h "$out" | cut -f1), ${frame} frames)" >&2
