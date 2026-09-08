// Pure logic for Spectra: cava wiring, frame parsing, and the maths the
// renderer does every frame. Kept out of the QML so it can be reasoned about
// (and fixed) without a running shell — see test/model.test.mjs, which loads
// this file directly.

// cava reports each band as an integer in 0..asciiRange.
var asciiRange = 1000

// Below this, a frame is silence rather than a very quiet song.
var silenceFloor = 0.012

// How far the spatial smoother looks along the spectrum. Beyond four bands the
// contribution is negligible at any usable strength, and the cost is O(n*w).
var smoothingWindow = 4

// A capture that produces no frame within this many milliseconds of starting is
// not going to. Covers a missing binary, a refused audio server, and a cava
// that starts but never reaches the sink — all of which look identical to an
// empty widget otherwise.
var startupGrace = 4000

function zeros(n) {
  var out = []
  for (var i = 0; i < n; i++) out.push(0)
  return out
}

function clamp(value, low, high) {
  return value < low ? low : (value > high ? high : value)
}

// shell.json is hand-edited, so an unknown or differently-cased spelling should
// land on something sensible rather than rendering nothing at all.
function oneOf(value, options, fallback) {
  var text = String(value)
  for (var i = 0; i < options.length; i++) {
    if (options[i] === text) return text
  }
  var lower = text.toLowerCase()
  for (var j = 0; j < options.length; j++) {
    if (options[j].toLowerCase() === lower) return options[j]
  }
  return fallback
}

// Widgets ask for what they want; the capture has to satisfy all of them at
// once, so every numeric parameter resolves to the most generous request.
// `source` cannot be merged that way — there is one capture and it reads one
// device — so asks are visited in a stable order and the first named device
// wins, rather than whichever monitor happened to load first.
function mergeAsks(asks, fallback) {
  var merged = {
    bars: 0,
    framerate: 0,
    noiseReduction: -1,
    quietDelay: 0,
    sleepDelay: 0,
    source: ""
  }
  var keys = []
  for (var key in asks) keys.push(key)
  keys.sort()

  var seen = false
  for (var i = 0; i < keys.length; i++) {
    var ask = asks[keys[i]]
    if (!ask) continue
    seen = true
    if (ask.bars > merged.bars) merged.bars = ask.bars
    if (ask.framerate > merged.framerate) merged.framerate = ask.framerate
    if (ask.noiseReduction > merged.noiseReduction) merged.noiseReduction = ask.noiseReduction
    if (ask.quietDelay > merged.quietDelay) merged.quietDelay = ask.quietDelay
    if (ask.sleepDelay > merged.sleepDelay) merged.sleepDelay = ask.sleepDelay
    if (merged.source === "" && ask.source) merged.source = String(ask.source).trim()
  }
  if (!seen) return fallback

  return {
    bars: clamp(Math.round(merged.bars) || fallback.bars, 4, 64),
    framerate: clamp(Math.round(merged.framerate) || fallback.framerate, 20, 144),
    noiseReduction: clamp(Math.round(merged.noiseReduction), 0, 100),
    quietDelay: clamp(Math.round(merged.quietDelay) || fallback.quietDelay, 200, 30000),
    sleepDelay: clamp(Math.round(merged.sleepDelay) || fallback.sleepDelay, 1000, 120000),
    source: merged.source
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

// One capture serves every monitor, and its band count is the most generous
// ask across all of them — so a widget drawing fewer bands than were captured
// must fold the spectrum down rather than read the first n entries, which
// would show it the bass and nothing else.
// `out` is optional: pass a reusable buffer to keep a 144Hz render loop from
// allocating an array per frame. Omit it and a fresh array comes back.
function resample(values, count, out) {
  var reuse = out !== undefined && out !== null && out !== values
  if (count <= 0) return reuse ? truncate(out, 0) : []

  var length = values ? values.length : 0
  var i
  if (length === 0) {
    if (!reuse) return zeros(count)
    truncate(out, count)
    for (i = 0; i < count; i++) out[i] = 0
    return out
  }
  if (length === count) {
    if (!reuse) return values.slice()
    truncate(out, count)
    for (i = 0; i < count; i++) out[i] = values[i]
    return out
  }

  // Sized up front and written by index, so the reused and the freshly
  // allocated buffer take exactly the same path.
  out = reuse ? truncate(out, count) : zeros(count)

  if (count > length) {
    // Asking for more bands than were captured only happens in the moment
    // before the capture relaunches. Interpolate rather than repeat, so the
    // transition does not show as a staircase.
    for (i = 0; i < count; i++) {
      var position = length === 1 ? 0 : i * (length - 1) / (count - 1)
      var low = Math.floor(position)
      var high = Math.min(length - 1, low + 1)
      out[i] = values[low] + (values[high] - values[low]) * (position - low)
    }
    return out
  }

  // Each drawn band takes the loudest of the captured bands it covers: a
  // transient that lands in one bin should survive the downmix rather than
  // being averaged away by its quiet neighbours.
  for (i = 0; i < count; i++) {
    var first = Math.floor(i * length / count)
    var last = Math.max(first, Math.ceil((i + 1) * length / count) - 1)
    var best = 0
    for (var j = first; j <= last && j < length; j++) {
      if (values[j] > best) best = values[j]
    }
    out[i] = best
  }
  return out
}

// Resize a reused buffer in place. Arrays only ever grow to the largest band
// count the widget has drawn, so this is a no-op after the first few frames.
function truncate(buffer, length) {
  while (buffer.length > length) buffer.pop()
  while (buffer.length < length) buffer.push(0)
  return buffer
}

// Raw FFT bins are spiky: neighbouring bands of one instrument disagree wildly
// frame to frame, which reads as noise rather than as music. Each band claims
// the best of its neighbours attenuated by distance, so a peak spreads into a
// shoulder instead of standing alone. Strength 0 leaves the bins untouched.
function smoothSpatial(values, strength, out) {
  var n = values.length
  var reuse = out !== undefined && out !== null && out !== values

  if (strength <= 0) {
    if (!reuse) return values
    truncate(out, n)
    for (var k = 0; k < n; k++) out[k] = values[k]
    return out
  }

  if (reuse) truncate(out, n)
  else out = values.slice()
  // Strong smoothing decays slowly with distance, so a peak reaches further.
  var falloff = 1 + (1 - clamp(strength, 0, 1)) * 8

  for (var i = 0; i < n; i++) {
    // Read the untouched input, never the half-written output: with a reused
    // buffer `out[i]` may still hold the previous frame.
    var best = values[i]
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
//
// `out` is optional, and exists for the same reason the buffers do: this runs
// once per band per frame, and a fresh object each time is a lot of garbage
// for two numbers.
function advancePeak(peak, level, dt, hangLeft, fall, out) {
  var result = out || { value: 0, hang: 0 }
  if (level >= peak) {
    result.value = level
    result.hang = 0.35
  } else if (hangLeft > 0) {
    result.value = peak
    result.hang = hangLeft - dt
  } else {
    result.value = Math.max(level, peak - fall * dt)
    result.hang = 0
  }
  return result
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

// The cava side of the plugin: a config file the service writes itself and
// hands to `cava -p`. No shell in between — the config is written by the
// FileView that owns the path, so there is no heredoc to quote, no `bash`
// process per capture, and one less thing between the widget and the audio.
function cavaConfig(bars, framerate, noiseReduction, source) {
  var reduction = (clamp(noiseReduction, 0, 100) / 100).toFixed(2)
  var device = source && String(source).trim() !== "" ? String(source).trim() : "auto"
  return [
    "[general]",
    "framerate = " + framerate,
    "bars = " + bars,
    "autosens = 1",
    "",
    "[input]",
    "method = pulse",
    "source = " + device,
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
}
