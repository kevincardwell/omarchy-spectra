// Pure logic for Spectra: cava wiring, frame parsing, and the maths the
// renderer does every frame. Kept out of the QML so it can be reasoned about
// (and fixed) without a running shell.

// cava reports each band as an integer in 0..asciiRange.
var asciiRange = 1000

// Below this, a frame is silence rather than a very quiet song.
var silenceFloor = 0.012

// How far the spatial smoother looks along the spectrum. Beyond four bands the
// contribution is negligible at any usable strength, and the cost is O(n*w).
var smoothingWindow = 4

function zeros(n) {
  var out = []
  for (var i = 0; i < n; i++) out.push(0)
  return out
}

function clamp(value, low, high) {
  return value < low ? low : (value > high ? high : value)
}

// Widgets ask for what they want; the capture has to satisfy all of them at
// once, so every parameter resolves to the most generous request.
function mergeAsks(asks, fallback) {
  var merged = { bars: 0, framerate: 0, noiseReduction: -1 }
  var seen = false
  for (var key in asks) {
    var ask = asks[key]
    if (!ask) continue
    seen = true
    if (ask.bars > merged.bars) merged.bars = ask.bars
    if (ask.framerate > merged.framerate) merged.framerate = ask.framerate
    if (ask.noiseReduction > merged.noiseReduction) merged.noiseReduction = ask.noiseReduction
  }
  if (!seen) return fallback
  return {
    bars: clamp(Math.round(merged.bars) || fallback.bars, 4, 64),
    framerate: clamp(Math.round(merged.framerate) || fallback.framerate, 20, 144),
    noiseReduction: clamp(Math.round(merged.noiseReduction), 0, 100)
  }
}

// A raw ascii frame is "n;n;n;...;n;" — trailing separator included, which is
// why the last split fragment is dropped rather than parsed as a band.
function parseFrame(line, bars, range) {
  if (!line) return null
  var text = String(line).trim()
  if (text === "") return null

  var parts = text.split(";")
  if (parts.length && parts[parts.length - 1] === "") parts.pop()
  if (parts.length === 0) return null

  var levels = []
  var peak = 0
  for (var i = 0; i < bars; i++) {
    var raw = i < parts.length ? parseInt(parts[i], 10) : 0
    var value = isNaN(raw) ? 0 : clamp(raw / range, 0, 1)
    levels.push(value)
    if (value > peak) peak = value
  }
  return { levels: levels, peak: peak }
}

// Raw FFT bins are spiky: neighbouring bands of one instrument disagree wildly
// frame to frame, which reads as noise rather than as music. Each band claims
// the best of its neighbours attenuated by distance, so a peak spreads into a
// shoulder instead of standing alone. Strength 0 leaves the bins untouched.
function smoothSpatial(values, strength) {
  if (strength <= 0) return values

  var n = values.length
  var out = values.slice()
  // Strong smoothing decays slowly with distance, so a peak reaches further.
  var falloff = 1 + (1 - clamp(strength, 0, 1)) * 8

  for (var i = 0; i < n; i++) {
    var best = out[i]
    var first = Math.max(0, i - smoothingWindow)
    var last = Math.min(n - 1, i + smoothingWindow)
    for (var j = first; j <= last; j++) {
      if (j === i) continue
      var spread = values[j] / Math.pow(falloff, Math.abs(i - j))
      if (spread > best) best = spread
    }
    out[i] = best
  }
  return out
}

// Loudness is logarithmic but cava hands us something close to linear, so a
// track at conversational volume barely lifts off the baseline. An exponent
// below 1 lifts the quiet end without clipping the loud end.
function curve(value, exponent) {
  if (exponent === 1) return value
  return Math.pow(clamp(value, 0, 1), exponent)
}

// Bars should snap up to a transient and sink back slowly — matching the rise
// and fall rates makes drums look like a sine wave. Rates are per second, and
// dt keeps the motion identical on a 60Hz and a 144Hz screen.
function advance(current, target, dt, rise, fall) {
  var rate = target > current ? rise : fall
  var step = 1 - Math.exp(-rate * dt)
  return current + (target - current) * step
}

// The peak cap sits still for a moment before it starts sliding, otherwise it
// never separates visibly from the bar it is capping.
function advancePeak(peak, level, dt, hangLeft, fall) {
  if (level >= peak) return { value: level, hang: 0.35 }
  if (hangLeft > 0) return { value: peak, hang: hangLeft - dt }
  return { value: Math.max(level, peak - fall * dt), hang: 0 }
}

// Cheap linear blend; Qt.tint would composite alpha instead of interpolating.
function mix(a, b, t) {
  var k = clamp(t, 0, 1)
  return Qt.rgba(a.r + (b.r - a.r) * k,
                 a.g + (b.g - a.g) * k,
                 a.b + (b.b - a.b) * k,
                 a.a + (b.a - a.a) * k)
}

// Hue swept across the spectrum, anchored on the theme's accent so it still
// belongs to the desktop rather than looking like a stock rainbow. Only three
// quarters of the wheel is used: a full sweep wraps back to where it started
// and the two ends of the bar become indistinguishable.
function spectrumColor(t, anchor) {
  var base = anchor && anchor.hsvHue >= 0 ? anchor.hsvHue : 0.55
  var hue = (base + clamp(t, 0, 1) * 0.75) % 1
  var saturation = anchor ? clamp(anchor.hsvSaturation + 0.25, 0.35, 0.85) : 0.6
  return Qt.hsva(hue, saturation, 1, 1)
}

// Qt.alpha only landed recently and the shell targets whatever Qt the distro
// ships, so the recolour is done by hand.
function alpha(color, a) {
  return Qt.rgba(color.r, color.g, color.b, clamp(a, 0, 1))
}

// PipeWire marks streams by direction inconsistently across clients, so both
// the flag and the media class are consulted before calling a node playback.
function isPlaybackStream(node) {
  if (!node || !node.isStream) return false
  if (node.isSink === true) return true
  var mediaClass = String(node.type || "")
  return mediaClass.indexOf("Output") !== -1
}

// The whole cava side of the plugin: write a config, hand it to cava, stream
// raw levels back over stdout. The config lands on a fixed runtime path so a
// relaunch overwrites it instead of leaving a trail of temp files behind.
function launcher(bars, framerate, noiseReduction) {
  var reduction = (clamp(noiseReduction, 0, 100) / 100).toFixed(2)
  var config = [
    "[general]",
    "framerate = " + framerate,
    "bars = " + bars,
    "autosens = 1",
    "",
    "[input]",
    "method = pulse",
    "source = auto",
    "",
    "[output]",
    "method = raw",
    "raw_target = /dev/stdout",
    "data_format = ascii",
    "ascii_max_range = " + asciiRange,
    "channels = mono",
    "",
    "[smoothing]",
    "noise_reduction = " + reduction,
    ""
  ].join("\n")

  return [
    'cfg="${XDG_RUNTIME_DIR:-/tmp}/radius-spectra.conf"',
    'command -v cava >/dev/null 2>&1 || { echo "spectra: cava is not installed" >&2; exit 127; }',
    'cat > "$cfg" <<\'PULSEBAR_CAVA\'',
    config + 'PULSEBAR_CAVA',
    'exec cava -p "$cfg"'
  ].join("\n")
}
