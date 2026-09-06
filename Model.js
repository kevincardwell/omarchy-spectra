// Pure logic for Pulsebar: cava wiring, frame parsing, and the maths the
// renderer does every frame. Kept out of the QML so it can be reasoned about
// (and fixed) without a running shell.

// cava reports each band as an integer in 0..asciiRange.
var asciiRange = 1000

// Below this, a frame is silence rather than a very quiet song.
var silenceFloor = 0.012

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
    'cfg="${XDG_RUNTIME_DIR:-/tmp}/jasper-pulsebar.conf"',
    'command -v cava >/dev/null 2>&1 || { echo "pulsebar: cava is not installed" >&2; exit 127; }',
    'cat > "$cfg" <<\'PULSEBAR_CAVA\'',
    config + 'PULSEBAR_CAVA',
    'exec cava -p "$cfg"'
  ].join("\n")
}
