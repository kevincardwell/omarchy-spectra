import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Pipewire
import "Model.js" as Model

// One cava process for the whole shell.
//
// A bar widget is instantiated once per monitor, so the capture cannot live in
// the widget without spawning a second, third, fourth cava alongside it. The
// service owns the process, the widgets read `levels` off it, and every screen
// draws the same numbers.
//
// Widgets do not own the settings either: they hand their wishes to
// `configure()` and the loudest wish wins, so two differently configured
// instances still share one capture instead of fighting over it.
Item {
  id: root

  property var shell: null

  // Capture parameters. Changing any of these rebuilds the cava config and
  // relaunches, debounced so dragging a slider does not fork a process a frame.
  property int bars: 24
  property int framerate: 60
  property int noiseReduction: 45

  // Normalised 0..1, one entry per band, low frequencies first.
  property var levels: Model.zeros(24)

  // Loudest band in the most recent frame, and whether we have seen only
  // silence for long enough that the widgets may fold themselves away.
  property real loudness: 0
  property bool silent: true

  // Set false by any widget that wants the capture pinned on. Otherwise cava
  // only runs while something is actually routed to an output — an idle
  // desktop with no player open should not be paying for an FFT 60 times a
  // second.
  property bool idleSuspend: true

  // True once cava has failed to start enough times that retrying is pointless
  // (it is not installed, or the audio server is refusing us). Widgets read
  // this to show that they are dead rather than merely quiet.
  property bool unavailable: false

  readonly property var nodes: Pipewire.nodes ? Pipewire.nodes.values : []
  readonly property var playbackStreams: {
    var list = []
    for (var i = 0; i < nodes.length; i++) {
      if (Model.isPlaybackStream(nodes[i])) list.push(nodes[i])
    }
    return list
  }
  readonly property bool playing: playbackStreams.length > 0

  // `awake` trails `playing` by a grace period: track changes and seeks tear
  // the stream down and build it back up, and bouncing cava on every gap would
  // cost more than leaving it running.
  property bool awake: true
  readonly property bool shouldCapture: !unavailable && (!idleSuspend || awake)
  readonly property bool running: proc.running

  property int _failures: 0

  // Held low across a relaunch. Writing `proc.running` directly would break
  // the binding that keeps the process following `shouldCapture`, so the
  // restart path toggles this instead.
  property bool _armed: true

  // The highest ask across live widgets. Reset when the last one goes away so
  // a removed widget's oversized request cannot outlive it.
  property var _asks: ({})

  function configure(key, wanted) {
    var next = ({})
    for (var k in _asks) next[k] = _asks[k]
    next[String(key)] = wanted
    _asks = next
    applyAsks()
  }

  function release(key) {
    var next = ({})
    for (var k in _asks) if (k !== String(key)) next[k] = _asks[k]
    _asks = next
    applyAsks()
  }

  function applyAsks() {
    var merged = Model.mergeAsks(_asks, { bars: 24, framerate: 60, noiseReduction: 45 })
    var pin = false
    for (var k in _asks) if (_asks[k] && _asks[k].idleSuspend === false) pin = true
    idleSuspend = !pin

    if (merged.bars === bars && merged.framerate === framerate
        && merged.noiseReduction === noiseReduction) return
    bars = merged.bars
    framerate = merged.framerate
    noiseReduction = merged.noiseReduction
    levels = Model.zeros(bars)
    relaunch.restart()
  }

  // Re-arm the capture from scratch. Switching output device or bouncing
  // pipewire leaves cava attached to a stream that no longer produces audio,
  // and only a fresh process picks the new default up.
  function reload() {
    unavailable = false
    _failures = 0
    relaunch.restart()
  }

  function ingest(line) {
    var parsed = Model.parseFrame(line, bars, Model.asciiRange)
    if (!parsed) return
    // A frame that parses is a frame from a healthy cava, so stop counting
    // earlier crashes against it.
    _failures = 0
    levels = parsed.levels
    loudness = parsed.peak
    if (parsed.peak > Model.silenceFloor) {
      silent = false
      quiet.restart()
    }
  }

  function goSilent() {
    silent = true
    loudness = 0
    levels = Model.zeros(bars)
  }

  onPlayingChanged: {
    if (playing) {
      sleepGrace.stop()
      awake = true
    } else {
      sleepGrace.restart()
    }
  }

  // Keep the stream objects alive long enough to be inspected; without a
  // tracker PipeWire hands back nodes whose properties are never populated.
  PwObjectTracker { objects: root.playbackStreams }

  Timer {
    id: quiet
    interval: 2000
    onTriggered: root.goSilent()
  }

  Timer {
    id: sleepGrace
    interval: 6000
    onTriggered: {
      root.awake = false
      root.goSilent()
    }
  }

  // Kill first, then start on the next tick: cava holds the capture stream, and
  // a same-instant restart can race the old process still owning it.
  Timer {
    id: relaunch
    interval: 250
    onTriggered: {
      root._armed = false
      restart.restart()
    }
  }

  Timer {
    id: restart
    interval: 120
    onTriggered: root._armed = true
  }

  Process {
    id: proc
    running: root.shouldCapture && root._armed
    command: ["bash", "-c", Model.launcher(root.bars, root.framerate, root.noiseReduction)]

    stdout: SplitParser {
      splitMarker: "\n"
      onRead: data => root.ingest(data)
    }

    stderr: SplitParser {
      splitMarker: "\n"
      onRead: data => { if (String(data).trim() !== "") console.warn("spectra:", data) }
    }

    // cava exits if the audio server restarts or the sink disappears. Come back
    // rather than leaving a dead widget on the bar until the next login — but
    // give up after a few tries, because a missing binary fails identically
    // every time and a retry loop would just fork a process forever.
    onExited: function(code) {
      root.goSilent()
      if (code === 0 || !root.shouldCapture) return
      root._failures += 1
      if (root._failures >= 3) {
        console.warn("spectra: cava exited", code, "three times; giving up until reloaded")
        root.unavailable = true
        return
      }
      revive.restart()
    }
  }

  Timer {
    id: revive
    interval: 3000
    onTriggered: root._armed = true
  }

  Component.onDestruction: root._armed = false
}
