// Pure logic for Spectra: cava wiring, frame parsing, and the maths the
// widget does every frame before handing it to the shader. Kept out of the QML so it can be reasoned about
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

// What the settings can say. The scroll wheel walks `styles` in this order,
// from the most discrete reading of the spectrum to the most continuous.
var styles = ["Bars", "Dots", "Beads", "Glow", "Spikes", "Steps", "Wave"]
var modes = ["Bottom", "Mirror", "Top", "Butterfly"]
var palettes = ["Accent", "Foreground", "Muted", "Gradient", "Spectrum", "Cover"]
var peakModes = ["Cap", "Trail", "Off"]
var feelNames = ["Smooth", "Balanced", "Punchy"]

// Five signal-shaping knobs nobody could tune without a reference, folded into
// three presets. Any of the five set in shell.json still overrides its preset.
var feels = {
  Smooth: { sensitivity: 100, punch: 130, smoothing: 55, attack: 55, release: 25 },
  Balanced: { sensitivity: 100, punch: 140, smoothing: 35, attack: 80, release: 45 },
  Punchy: { sensitivity: 110, punch: 170, smoothing: 15, attack: 100, release: 70 }
}

// 1.4 had ten styles. Three of them were another style plus an option, and are
// now spelled that way; an entry that still names one keeps its look.
var legacyStyles = {
  area: { style: "Wave", filled: true },
  ridge: { style: "Steps", filled: true },
  trail: { style: "Bars", peak: "Trail" }
}

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

function pick(settings, key, fallback) {
  var value = settings ? settings[key] : undefined
  return value === undefined || value === null ? fallback : value
}

// shell.json is hand-edited often enough that a number written as a string
// should still work rather than collapsing the widget to zero bars.
function number(settings, key, fallback, low, high) {
  var value = Number(pick(settings, key, fallback))
  return clamp(isNaN(value) ? fallback : value, low, high)
}

// Every setting the widget reads, validated in one place: unknown spellings
// fall back, numbers are clamped, and 1.4's names are carried forward.
function resolve(settings) {
  var legacy = legacyStyles[String(pick(settings, "style", "")).toLowerCase()] || {}
  var feel = feels[oneOf(pick(settings, "feel", "Balanced"), feelNames, "Balanced")]
  var peak = legacy.peak
    || oneOf(pick(settings, "peak", pick(settings, "peakHold", true) === false ? "Off" : "Cap"),
             peakModes, "Cap")

  return {
    style: legacy.style || oneOf(pick(settings, "style", "Bars"), styles, "Bars"),
    filled: legacy.filled === true || pick(settings, "filled", false) === true,
    mode: oneOf(pick(settings, "mode", "Bottom"), modes, "Bottom"),
    palette: oneOf(pick(settings, "color", "Accent"), palettes, "Accent"),
    peak: peak,
    bars: Math.round(number(settings, "bars", 28, 4, 64)),
    barWidth: number(settings, "barWidth", 3, 1, 12),
    gap: number(settings, "gap", 2, 0, 8),
    fill: number(settings, "fill", 62, 20, 100) / 100,
    sensitivity: number(settings, "sensitivity", feel.sensitivity, 25, 400) / 100,
    // A punch of 100 is linear; higher bends the curve so quiet passages lift.
    exponent: 100 / number(settings, "punch", feel.punch, 100, 300),
    smoothing: number(settings, "smoothing", feel.smoothing, 0, 100) / 100,
    riseRate: 4 + number(settings, "attack", feel.attack, 0, 100) * 0.34,
    fallRate: 2 + number(settings, "release", feel.release, 0, 100) * 0.28,
    framerate: Math.round(number(settings, "framerate", 30, 20, 144)),
    quietDelay: Math.round(number(settings, "quietDelay", 2000, 200, 30000)),
    sleepDelay: Math.round(number(settings, "sleepDelay", 6000, 1000, 120000)),
    device: String(pick(settings, "device", "")).trim(),
    autoHide: pick(settings, "autoHide", true) === true,
    idleSuspend: pick(settings, "idleSuspend", true) === true,
    reducedMotion: pick(settings, "reducedMotion", false) === true
  }
}

// How many bands a widget draws, and how many per channel it needs captured.
// Butterfly spends half its bands on each channel, so it is always even.
function drawnBands(bars, mode) {
  return mode === "Butterfly" ? 2 * Math.ceil(bars / 2) : bars
}

function capturedBands(bars, mode) {
  return mode === "Butterfly" ? Math.ceil(bars / 2) : bars
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
//
// The capture is stereo, and cava lays a stereo frame out the way its own
// terminal draws one: the left channel from the top of the spectrum down to
// the bass, then the right channel from the bass back up. `bars` is the count
// per channel, so a frame carries twice that. Both channels come back ordered
// bass first.
function parseFrame(line, bars, range) {
  if (!line) return null
  var text = String(line).trim()
  if (text === "") return null

  var parts = text.split(";")
  if (parts.length && parts[parts.length - 1] === "") parts.pop()
  if (parts.length === 0) return null

  var left = []
  var right = []
  var peak = 0
  for (var i = 0; i < bars; i++) {
    var l = band(parts, bars - 1 - i, range)
    var r = band(parts, bars + i, range)
    left.push(l)
    right.push(r)
    if (l > peak) peak = l
    if (r > peak) peak = r
  }
  return { left: left, right: right, peak: peak }
}

function band(parts, index, range) {
  var raw = index < parts.length ? parseInt(parts[index], 10) : 0
  return isNaN(raw) ? 0 : clamp(raw / range, 0, 1)
}

// Lay the two channels out as the bands a widget draws. Mirror keeps them
// apart, one per side of the centre line; Butterfly puts them side by side
// with the bass meeting in the middle; everything else draws whichever of the
// two is louder in each band.
// `a` and `b` are reused buffers; `b` is only filled for Mirror.
function arrange(left, right, count, mode, a, b, scratch) {
  if (mode === "Mirror") {
    resample(left, count, a)
    resample(right, count, b)
    return
  }
  if (mode === "Butterfly") {
    var half = count / 2
    resample(left, half, scratch)
    truncate(a, count)
    for (var i = 0; i < half; i++) a[half - 1 - i] = scratch[i]
    resample(right, half, scratch)
    for (var j = 0; j < half; j++) a[half + j] = scratch[j]
    return
  }
  resample(left, count, a)
  resample(right, count, scratch)
  for (var k = 0; k < count; k++) if (scratch[k] > a[k]) a[k] = scratch[k]
}

// One frame of motion for one side, in place: shape the targets (sensitivity,
// then the perceptual curve), spread them along the spectrum, then chase them
// in time with a peak cap that holds and then falls.
function animate(state, raw, dt, look, scratch) {
  var n = raw.length
  truncate(state.level, n)
  truncate(state.peak, n)
  truncate(state.hang, n)

  var shaped = truncate(scratch.shaped, n)
  for (var i = 0; i < n; i++) shaped[i] = curve(clamp(raw[i] * look.sensitivity, 0, 1), look.exponent)
  var smoothed = smoothSpatial(shaped, look.smoothing, scratch.smoothed)

  for (var j = 0; j < n; j++) {
    var level = advance(state.level[j], smoothed[j], dt, look.riseRate, look.fallRate)
    advancePeak(state.peak[j], level, dt, state.hang[j], 0.9, scratch.cap)
    state.level[j] = level
    state.peak[j] = scratch.cap.value
    state.hang[j] = scratch.cap.hang
  }
}

// A band's level and peak packed into one float for the shader, twelve bits
// each — finer than any bar has pixels — so 64 bands per side fit in sixteen
// vec4 uniforms. spectrum.frag unpacks it with mod and floor; a float holds
// integers exactly up to 2^24, which is where the two halves stop.
function packBand(level, peak) {
  return Math.round(clamp(level || 0, 0, 1) * 4095) + 4096 * Math.round(clamp(peak || 0, 0, 1) * 4095)
}

// Whether a frame would look any different from the last one drawn. Every
// redraw of the bar costs the same whatever changed, and a spectrum a couple of
// dozen pixels tall spends most frames moving by less than one of them, so
// frames that would land on the same pixels are skipped. `keys` holds the last
// drawn frame in pixels and is brought up to date whenever this says yes.
function moved(keys, arrays, resolution) {
  var k = 0
  var changed = false
  for (var a = 0; a < arrays.length; a++) {
    var values = arrays[a]
    for (var i = 0; i < values.length; i++, k++) {
      var key = Math.round(values[i] * resolution)
      if (keys[k] !== key) {
        keys[k] = key
        changed = true
      }
    }
  }
  if (keys.length !== k) {
    truncate(keys, k)
    changed = true
  }
  return changed
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
//
// `bars` is per channel: a stereo capture reports twice as many bands, left
// and right, which is what lets Mirror and Butterfly draw the two apart.
function cavaConfig(bars, framerate, noiseReduction, source) {
  var reduction = (clamp(noiseReduction, 0, 100) / 100).toFixed(2)
  var device = source && String(source).trim() !== "" ? String(source).trim() : "auto"
  return [
    "[general]",
    "framerate = " + framerate,
    "bars = " + bars * 2,
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
    "channels = stereo",
    "",
    "[smoothing]",
    "noise_reduction = " + reduction,
    ""
  ].join("\n")
}
