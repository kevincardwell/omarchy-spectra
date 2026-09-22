import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import Quickshell.Services.Pipewire
import "Model.js" as Model

// One cava process for the whole shell.
//
// A bar widget is instantiated once per monitor, so the capture cannot live in
// the widget without spawning a second, third, fourth cava alongside it. The
// service owns the process, the widgets read `leftLevels` and `rightLevels`
// off it, and every screen draws the same numbers.
//
// Widgets do not own the settings either: they hand their wishes to
// `configure()` and the loudest wish wins, so two differently configured
// instances still share one capture instead of fighting over it.
Item {
  id: root

  property var shell: null

  // Capture parameters. Changing any of these rewrites the cava config and
  // relaunches, debounced so dragging a slider does not fork a process a frame.
  property int bars: 24
  property int framerate: 30
  property int noiseReduction: 45

  // Which PulseAudio/PipeWire device cava listens to. Empty means "auto",
  // which is the default sink's monitor.
  property string source: ""

  // How long silence has to last before the widgets may fold away, and how
  // long the capture stays up after the last playback stream disappears.
  property int quietDelay: 2000
  property int sleepDelay: 6000

  // Normalised 0..1, one entry per band, low frequencies first — one array per
  // channel. `bars` counts bands per channel.
  property var leftLevels: Model.zeros(24)
  property var rightLevels: Model.zeros(24)

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

  // Why it is unavailable, for the widget's tooltip. A user staring at a
  // muted-speaker glyph deserves better than "something went wrong".
  property string failure: ""

  readonly property var nodes: Pipewire.nodes ? Pipewire.nodes.values : []
  readonly property var playbackStreams: {
    var list = []
    for (var i = 0; i < nodes.length; i++) {
      if (Model.isPlaybackStream(nodes[i])) list.push(nodes[i])
    }
    return list
  }
  readonly property bool playing: playbackStreams.length > 0

  // The cover of whatever is playing, for the Cover palette. A player that is
  // actually playing wins over a paused one left open in another window.
  readonly property var players: Mpris.players ? Mpris.players.values : []
  readonly property string coverUrl: {
    var fallback = ""
    for (var i = 0; i < players.length; i++) {
      var art = players[i].trackArtUrl || ""
      if (art === "") continue
      if (players[i].isPlaying) return art
      if (fallback === "") fallback = art
    }
    return fallback
  }

  // `awake` trails `playing` by a grace period: track changes and seeks tear
  // the stream down and build it back up, and bouncing cava on every gap would
  // cost more than leaving it running.
  property bool awake: true
  readonly property bool shouldCapture: !unavailable && (!idleSuspend || awake)
  readonly property bool running: proc.running

  property int _failures: 0

  // Held low across a relaunch. Writing `proc.running` directly would break
  // the binding that keeps the process following `shouldCapture`, so every
  // path that wants a fresh process toggles this instead — including the
  // revive after a crash, which is why `onExited` drops it first. Setting an
  // already-true property emits no change signal, and the binding would never
  // re-evaluate.
  property bool _armed: true

  // The highest ask across live widgets. Reset when the last one goes away so
  // a removed widget's oversized request cannot outlive it.
  property var _asks: ({})

  readonly property var _defaults: ({
    bars: 24,
    framerate: 30,
    noiseReduction: 45,
    quietDelay: 2000,
    sleepDelay: 6000,
    source: ""
  })

  readonly property string configPath:
    (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/radius-spectra.conf"

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
    var merged = Model.mergeAsks(_asks, _defaults)
    var pin = false
    for (var k in _asks) if (_asks[k] && _asks[k].idleSuspend === false) pin = true
    idleSuspend = !pin

    // These two only govern timers, so they can change without disturbing a
    // running capture.
    quietDelay = merged.quietDelay
    sleepDelay = merged.sleepDelay

    if (merged.bars === bars && merged.framerate === framerate
        && merged.noiseReduction === noiseReduction && merged.source === source) return
    bars = merged.bars
    framerate = merged.framerate
    noiseReduction = merged.noiseReduction
    source = merged.source
    leftLevels = Model.zeros(bars)
    rightLevels = Model.zeros(bars)
    relaunch.restart()
  }

  // Re-arm the capture from scratch. Switching output device or bouncing
  // pipewire leaves cava attached to a stream that no longer produces audio,
  // and only a fresh process picks the new default up.
  function reload() {
    unavailable = false
    failure = ""
    _failures = 0
    relaunch.restart()
  }

  // The config has to be on disk before cava is handed its path, so the write
  // blocks. It is a couple of hundred bytes onto a tmpfs.
  function writeConfig() {
    config.setText(Model.cavaConfig(bars, framerate, noiseReduction, source))
  }

  // Write the config, start the watchdog, then let the process binding fire.
  // The watchdog is armed here rather than in `onStarted` because a binary
  // that fails to start never reports a start.
  function arm() {
    writeConfig()
    watchdog.restart()
    _armed = true
  }

  function ingest(line) {
    var parsed = Model.parseFrame(line, bars, Model.asciiRange)
    if (!parsed) return
    // A frame that parses is a frame from a healthy cava, so stop counting
    // earlier crashes against it and call off the startup watchdog.
    _failures = 0
    watchdog.stop()
    leftLevels = parsed.left
    rightLevels = parsed.right
    loudness = parsed.peak
    if (parsed.peak > Model.silenceFloor) {
      silent = false
      quiet.restart()
    }
  }

  function goSilent() {
    silent = true
    loudness = 0
    leftLevels = Model.zeros(bars)
    rightLevels = Model.zeros(bars)
  }

  // A failed capture and a crashed one are the same problem from here: count
  // it, and stop trying once it is clearly not transient.
  function fail(reason) {
    _failures += 1
    if (_failures >= 3) {
      console.warn("spectra:", reason, "— giving up until reloaded")
      failure = reason
      unavailable = true
      return
    }
    _armed = false
    revive.restart()
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

  FileView {
    id: config
    path: root.configPath
    blockWrites: true
    atomicWrites: true
    printErrors: true
  }

  Timer {
    id: quiet
    interval: root.quietDelay
    onTriggered: root.goSilent()
  }

  Timer {
    id: sleepGrace
    interval: root.sleepDelay
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
    onTriggered: root.arm()
  }

  // A cava that never produces a frame looks exactly like a quiet room. Give a
  // fresh process a few seconds to say something before treating it as broken,
  // which covers a missing binary, a refused audio server, and a capture
  // pointed at a device that does not exist.
  Timer {
    id: watchdog
    interval: Model.startupGrace
    onTriggered: root.fail("cava started but produced no audio frames")
  }

  Process {
    id: proc
    running: root.shouldCapture && root._armed
    command: ["cava", "-p", root.configPath]

    onStarted: watchdog.restart()

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
      watchdog.stop()
      root.goSilent()
      // `_armed` is low for every deliberate stop — a relaunch, a suspend, or
      // the shell going away — and none of those are cava's fault.
      if (code === 0 || !root.shouldCapture || !root._armed) return
      root.fail(code === 127 || code < 0
        ? "cava could not be started — is it installed? (omarchy pkg add cava)"
        : "cava exited with code " + code)
    }
  }

  Timer {
    id: revive
    interval: 3000
    onTriggered: root.arm()
  }

  Component.onCompleted: root.arm()
  Component.onDestruction: root._armed = false
}
