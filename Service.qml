import QtQuick
import Quickshell
import Quickshell.Io
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

  readonly property bool running: proc.running

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
    relaunch.restart()
  }

  function ingest(line) {
    var parsed = Model.parseFrame(line, bars, Model.asciiRange)
    if (!parsed) return
    levels = parsed.levels
    loudness = parsed.peak
    if (parsed.peak > Model.silenceFloor) {
      silent = false
      quiet.restart()
    }
  }

  Timer {
    id: quiet
    interval: 2000
    onTriggered: root.silent = true
  }

  // Kill first, then start on the next tick: cava holds the capture stream, and
  // a same-instant restart can race the old process still owning it.
  Timer {
    id: relaunch
    interval: 250
    onTriggered: {
      proc.running = false
      restart.restart()
    }
  }

  Timer {
    id: restart
    interval: 120
    onTriggered: proc.running = true
  }

  Process {
    id: proc
    running: true
    command: ["bash", "-c", Model.launcher(root.bars, root.framerate, root.noiseReduction)]

    stdout: SplitParser {
      splitMarker: "\n"
      onRead: data => root.ingest(data)
    }

    // cava exits if the audio server restarts or the sink disappears. Come
    // back rather than leaving a dead widget on the bar until the next login.
    onExited: function(code) {
      root.levels = Model.zeros(root.bars)
      root.loudness = 0
      root.silent = true
      if (code !== 0) revive.restart()
    }
  }

  Timer {
    id: revive
    interval: 3000
    onTriggered: if (!proc.running) proc.running = true
  }

  Component.onDestruction: proc.running = false
}
