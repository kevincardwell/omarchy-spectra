import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The visible spectrum. Levels arrive from the shared service at cava's
// framerate; everything here runs per rendered frame instead, so the bars keep
// moving smoothly between captures and look the same on a 60Hz and a 144Hz
// screen.
BarWidget {
  id: root
  moduleName: "jasper.pulsebar"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("jasper.pulsebar") : null

  // shell.json is hand-edited often enough that a number written as a string
  // should still work rather than collapsing the widget to zero bars.
  function number(name, fallback) {
    var value = Number(setting(name, fallback))
    return isNaN(value) ? fallback : value
  }

  // Settings are snapshotted rather than bound. The bar re-hands `settings`
  // to the slot while it is laying widgets out, so an implicitWidth that reads
  // it directly closes a binding loop with the slot that sizes us.
  property int barCount: 24
  property real thickness: 3
  property real gap: 2
  property int framerate: 60
  property real sensitivity: 1
  property real exponent: 0.7
  property real smoothing: 0.35
  property real riseRate: 26
  property real fallRate: 9
  property real fill: 0.62
  property string style: "Bars"
  property string mode: "Bottom"
  property string palette: "Accent"
  property bool peakHold: true
  property bool autoHide: true
  property bool idleSuspend: true

  function applySettings() {
    var count = Math.round(Model.clamp(number("bars", 24), 4, 64))
    thickness = Model.clamp(number("barWidth", 3), 1, 12)
    gap = Model.clamp(number("gap", 2), 0, 8)
    framerate = Math.round(Model.clamp(number("framerate", 60), 20, 144))
    sensitivity = Model.clamp(number("sensitivity", 100), 25, 400) / 100
    // A "punch" of 100 is linear; higher values bend the curve so quiet
    // passages still lift off the originDepth.
    exponent = 1 / Model.clamp(number("punch", 140), 100, 300) * 100
    smoothing = Model.clamp(number("smoothing", 35), 0, 100) / 100
    riseRate = 4 + Model.clamp(number("attack", 80), 0, 100) * 0.34
    fallRate = 2 + Model.clamp(number("release", 45), 0, 100) * 0.28
    fill = Model.clamp(number("fill", 62), 20, 100) / 100
    style = String(setting("style", "Bars"))
    mode = String(setting("mode", "Bottom"))
    palette = String(setting("color", "Accent"))
    peakHold = setting("peakHold", true) === true
    autoHide = setting("autoHide", true) === true
    idleSuspend = setting("idleSuspend", true) === true
    if (count !== barCount) barCount = count
    ask()
  }

  onSettingsChanged: applySettings()

  // Identifies this instance's request to the service. One bar surface exists
  // per monitor, so instances must not share a key.
  readonly property string askKey: "pulsebar-" + Math.floor(Math.random() * 1e9)

  readonly property color accentColor: Color.accent
  readonly property color mutedColor: Color.muted
  readonly property color baseColor: {
    if (palette === "Foreground") return bar ? bar.barForeground : Color.bar.text
    if (palette === "Muted") return mutedColor
    return accentColor
  }

  // Colour at normalised position `t` along the spectrum. Flat palettes ignore
  // the position; only Spectrum actually sweeps.
  function stopColor(t) {
    if (palette === "Spectrum") return Model.spectrumColor(t, accentColor)
    if (palette === "Gradient") return Model.mix(mutedColor, accentColor, t)
    return baseColor
  }

  // Fill colour at position `t` for the curved styles, already faded back so
  // the body sits under the outline rather than competing with it.
  function fillStop(t) {
    return Model.alpha(stopColor(t), style === "Area" ? 0.38 : 0.13)
  }

  // Per-band colour, which unlike stopColor may respond to how loud the band
  // currently is — that is the whole point of the Gradient palette.
  function bandColor(index, level) {
    if (palette === "Spectrum")
      return Model.spectrumColor(barCount > 1 ? index / (barCount - 1) : 0, accentColor)
    if (palette === "Gradient") return Model.mix(mutedColor, accentColor, level)
    return baseColor
  }

  readonly property bool dead: service ? service.unavailable === true : false
  readonly property bool quiet: !dead && autoHide && (!service || service.silent)
  readonly property real span: Math.max(2, Math.round(barSize * fill))
  readonly property real pitch: thickness + gap
  readonly property real content: barCount * thickness + Math.max(0, barCount - 1) * gap
  readonly property bool curved: style === "Wave" || style === "Area"

  // Which end of the depth axis the bars grow from. A vertical bar flips the
  // axis, so "Bottom" means "the far edge" on one and "the near edge" on the
  // other.
  readonly property bool fromFarEnd: (mode === "Bottom") !== vertical

  // Per-frame render state, kept as plain arrays so a whole frame is one
  // property assignment rather than barCount separate change notifications.
  property var display: Model.zeros(barCount)
  property var peaks: Model.zeros(barCount)
  property var hangs: Model.zeros(barCount)

  // Polyline geometry for the curved styles, rebuilt each frame.
  property var outline: []
  property var mirrorOutline: []
  property var area: []

  function ask() {
    if (!service) return
    service.configure(askKey, {
      bars: barCount,
      framerate: framerate,
      noiseReduction: 45,
      idleSuspend: idleSuspend
    })
  }

  onServiceChanged: ask()
  onBarCountChanged: {
    display = Model.zeros(barCount)
    peaks = Model.zeros(barCount)
    hangs = Model.zeros(barCount)
    ask()
  }
  // The bar assigns `settings` as an initial property, which emits no change
  // signal, so a straight onCompleted call would snapshot the defaults and
  // never see the user's entry. Deferring picks it up after injection.
  Component.onCompleted: Qt.callLater(applySettings)
  Component.onDestruction: if (service) service.release(askKey)

  // ---- Switching styles --------------------------------------------------
  //
  // Style is the setting people actually want to play with, so it is reachable
  // without opening a settings form: middle click steps through the four, and
  // the choice is written back to shell.json so it survives a restart rather
  // than reverting the next time the shell reloads.
  readonly property var styleRing: ["Bars", "Dots", "Wave", "Area"]
  readonly property var paletteRing: ["Accent", "Foreground", "Muted", "Gradient", "Spectrum"]

  function store(key, value) {
    if (!bar || !bar.shell || typeof bar.shell.updateEntryInline !== "function") {
      // No persistence available: still switch, just for this session.
      var local = ({})
      for (var k in settings) local[k] = settings[k]
      local[key] = value
      settings = local
      return
    }
    var next = ({})
    for (var s in settings) next[s] = settings[s]
    next[key] = value
    bar.shell.updateEntryInline(moduleName, next)
  }

  function stepRing(ring, current, delta) {
    var at = ring.indexOf(current)
    if (at < 0) at = 0
    return ring[(at + delta + ring.length) % ring.length]
  }

  function cycleStyle(delta) {
    store("style", stepRing(styleRing, style, delta === undefined ? 1 : delta))
  }

  function cyclePalette(delta) {
    store("color", stepRing(paletteRing, palette, delta === undefined ? 1 : delta))
  }

  function setStyle(name) {
    if (styleRing.indexOf(name) >= 0) store("style", name)
  }

  function setPalette(name) {
    if (paletteRing.indexOf(name) >= 0) store("color", name)
  }

  // Bindable from a keyboard shortcut:
  //   omarchy-shell jasper.pulsebar cycleStyle
  IpcHandler {
    target: "jasper.pulsebar"

    function cycleStyle(): void { root.cycleStyle(1) }
    function previousStyle(): void { root.cycleStyle(-1) }
    function setStyle(name: string): void { root.setStyle(name) }
    function cycleColor(): void { root.cyclePalette(1) }
    function setColor(name: string): void { root.setPalette(name) }
    function reload(): void { if (root.service) root.service.reload() }
  }

  // Centre of band `i` measured across the widget.
  function alongAt(index) {
    return index * pitch + thickness / 2
  }

  // Depth coordinate for a normalised level, in pixels along the growth axis.
  // `side` only matters in Mirror mode, where the band grows both ways.
  function depthAt(level, side) {
    if (mode === "Mirror") return span / 2 + side * level * span / 2
    return fromFarEnd ? span - level * span : level * span
  }

  readonly property real originDepth: mode === "Mirror" ? span / 2 : (fromFarEnd ? span : 0)

  function point(along, depth) {
    return vertical ? Qt.point(depth, along) : Qt.point(along, depth)
  }

  function rebuildCurve() {
    var top = []
    var bottom = []
    for (var i = 0; i < barCount; i++) {
      var along = alongAt(i)
      top.push(point(along, depthAt(display[i], -1)))
      if (mode === "Mirror") bottom.push(point(along, depthAt(display[i], 1)))
    }

    // The curve has to reach the edges of the widget, otherwise it visibly
    // stops half a band short of both ends.
    if (top.length > 1) {
      top.unshift(point(0, top[0].y !== undefined && !vertical ? top[0].y : (vertical ? top[0].x : top[0].y)))
      top[0] = vertical ? Qt.point(top[1].x, 0) : Qt.point(0, top[1].y)
      top.push(vertical ? Qt.point(top[top.length - 1].x, content)
                        : Qt.point(content, top[top.length - 1].y))
    }
    if (bottom.length > 1) {
      bottom.unshift(vertical ? Qt.point(bottom[0].x, 0) : Qt.point(0, bottom[0].y))
      bottom.push(vertical ? Qt.point(bottom[bottom.length - 1].x, content)
                           : Qt.point(content, bottom[bottom.length - 1].y))
    }

    outline = top
    mirrorOutline = bottom

    // Close the filled region: back along the mirrored curve when there is
    // one, otherwise straight along the originDepth.
    var closed = top.slice()
    if (bottom.length > 0) {
      for (var j = bottom.length - 1; j >= 0; j--) closed.push(bottom[j])
    } else {
      closed.push(vertical ? Qt.point(originDepth, content) : Qt.point(content, originDepth))
      closed.push(vertical ? Qt.point(originDepth, 0) : Qt.point(0, originDepth))
    }
    area = closed
  }

  function step(dt) {
    var raw = service ? service.levels : []

    // Shape the signal before it is smoothed in time: sensitivity, then the
    // perceptual curve, then the spatial smoother that turns spiky FFT bins
    // into something that reads as music.
    var targets = []
    for (var i = 0; i < barCount; i++) {
      var value = Model.clamp((i < raw.length ? raw[i] : 0) * sensitivity, 0, 1)
      targets.push(Model.curve(value, exponent))
    }
    targets = Model.smoothSpatial(targets, smoothing)

    var nextDisplay = []
    var nextPeaks = []
    var nextHangs = []
    for (var j = 0; j < barCount; j++) {
      var level = Model.advance(display[j] || 0, targets[j], dt, riseRate, fallRate)
      var cap = Model.advancePeak(peaks[j] || 0, level, dt, hangs[j] || 0, 0.9)
      nextDisplay.push(level)
      nextPeaks.push(cap.value)
      nextHangs.push(cap.hang)
    }
    display = nextDisplay
    peaks = nextPeaks
    hangs = nextHangs

    if (curved) rebuildCurve()
  }

  // Nothing to animate while the widget is folded away and the bars have
  // already settled at zero.
  FrameAnimation {
    running: !root.quiet || root.display.some(v => v > 0.001)
    onTriggered: root.step(Math.min(frameTime, 0.1))
  }

  // No `visible` binding here: the bar's slot sizes itself from implicitWidth,
  // so reading back width (or visibility) to decide the fold closes a binding
  // loop. Collapsing implicitWidth behind `clip` is enough to disappear.
  implicitWidth: vertical ? span + Style.space(8) : (quiet ? 0 : content + Style.space(8))
  implicitHeight: vertical ? (quiet ? 0 : content + Style.space(8)) : barSize

  Behavior on implicitWidth { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
  Behavior on implicitHeight { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }

  clip: true

  Item {
    id: canvas
    anchors.centerIn: parent
    width: root.vertical ? root.span : root.content
    height: root.vertical ? root.content : root.span
    opacity: root.quiet ? 0 : 1

    Behavior on opacity { NumberAnimation { duration: 200 } }

    // ---- Bars and Dots -----------------------------------------------------

    Repeater {
      model: root.curved ? 0 : root.barCount

      Item {
        id: band
        readonly property real level: root.display[index] || 0
        readonly property real peak: root.peaks[index] || 0
        readonly property color tint: root.bandColor(index, level)

        // The band's extent along the growth axis, as two depth coordinates.
        readonly property real near: Math.min(root.depthAt(level, -1),
                                              root.mode === "Mirror" ? root.depthAt(level, 1) : root.originDepth)
        readonly property real far: Math.max(root.depthAt(level, -1),
                                             root.mode === "Mirror" ? root.depthAt(level, 1) : root.originDepth)

        x: root.vertical ? 0 : index * root.pitch
        y: root.vertical ? index * root.pitch : 0
        width: root.vertical ? canvas.width : root.thickness
        height: root.vertical ? root.thickness : canvas.height

        // A band is always at least a hairline: an empty bar should read as a
        // quiet channel, not as a broken widget.
        Rectangle {
          visible: root.style === "Bars"
          radius: Math.min(root.thickness, 5) / 2
          color: band.tint
          opacity: 0.35 + 0.65 * band.level
          x: root.vertical ? band.near : 0
          y: root.vertical ? 0 : band.near
          width: root.vertical ? Math.max(1, band.far - band.near) : band.width
          height: root.vertical ? band.height : Math.max(1, band.far - band.near)
        }

        // Dots: a fixed ladder of cells lit from the origin outwards, so the
        // level reads as a quantity rather than as a length.
        //
        // The cells carry their own state in the model rather than reading the
        // band's level out of the enclosing scope: a nested delegate resolves
        // that inconsistently, and a cell that silently reads `undefined` just
        // renders a dead grid.
        readonly property var cells: {
          if (root.style !== "Dots") return []
          var out = []
          for (var i = 0; i < matrix.rows; i++) {
            var at = (i + 0.5) / matrix.rows
            out.push({
              lit: at <= level,
              // The cell the falling peak currently sits in, so Dots gets the
              // same peak-hold read-out the other styles have.
              cap: root.peakHold && at <= peak && (i + 1.5) / matrix.rows > peak,
              offset: root.mode === "Mirror"
                ? root.span / 2 + (i - (matrix.rows - 1) / 2) * matrix.pitch - matrix.cell / 2
                : (root.fromFarEnd ? root.span - (i + 1) * matrix.pitch : i * matrix.pitch)
            })
          }
          return out
        }

        Repeater {
          model: band.cells

          Rectangle {
            required property var modelData

            radius: Math.min(root.thickness, matrix.cell) / 3
            color: band.tint
            opacity: modelData.cap ? 1 : (modelData.lit ? (0.5 + 0.4 * band.level) : 0.07)
            x: root.vertical ? modelData.offset : 0
            y: root.vertical ? 0 : modelData.offset
            width: root.vertical ? matrix.cell : band.width
            height: root.vertical ? band.height : matrix.cell

            Behavior on opacity { NumberAnimation { duration: 90 } }
          }
        }

        // Peak caps: one on the growing edge, two when the band grows both ways.
        Repeater {
          model: root.peakHold && root.style !== "Dots" ? (root.mode === "Mirror" ? 2 : 1) : 0

          Rectangle {
            readonly property real depth: root.depthAt(band.peak, index === 1 ? 1 : -1)
            readonly property real thick: 2

            color: band.tint
            opacity: 0.9
            radius: 1
            x: root.vertical ? depth - (root.fromFarEnd && root.mode !== "Mirror" ? 0 : thick) : 0
            y: root.vertical ? 0 : depth - (root.fromFarEnd && root.mode !== "Mirror" ? 0 : thick)
            width: root.vertical ? thick : band.width
            height: root.vertical ? band.height : thick
          }
        }
      }
    }

    // Cell geometry for the Dots style, derived once rather than per band.
    QtObject {
      id: matrix
      // Cells are deliberately shorter than the bars are wide: a bar height
      // only ever offers a dozen or so pixels, and a ladder needs enough rungs
      // that a level reads as a quantity rather than as on/off.
      readonly property real cell: 2
      readonly property real gap: 1
      readonly property real pitch: cell + gap
      readonly property int rows: Math.max(3, Math.floor((root.span + gap) / pitch))
    }

    // ---- Wave and Area -----------------------------------------------------

    Shape {
      anchors.fill: parent
      visible: root.curved
      asynchronous: false

      // The filled body. Drawn under the stroke so the outline stays crisp.
      ShapePath {
        strokeWidth: 0
        strokeColor: "transparent"

        fillGradient: LinearGradient {
          x1: 0
          y1: 0
          x2: root.vertical ? 0 : canvas.width
          y2: root.vertical ? canvas.height : 0
          GradientStop { position: 0.0; color: root.fillStop(0.0) }
          GradientStop { position: 0.34; color: root.fillStop(0.34) }
          GradientStop { position: 0.67; color: root.fillStop(0.67) }
          GradientStop { position: 1.0; color: root.fillStop(1.0) }
        }

        PathPolyline { path: root.area }
      }

      ShapePath {
        strokeWidth: 2
        strokeColor: root.palette === "Spectrum" ? root.accentColor : root.stopColor(1.0)
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin

        PathPolyline { path: root.outline }
      }

      ShapePath {
        strokeWidth: root.mode === "Mirror" ? 2 : 0
        strokeColor: root.palette === "Spectrum" ? root.accentColor : root.stopColor(1.0)
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin

        PathPolyline { path: root.mirrorOutline }
      }
    }
  }

  // Something is wrong with the capture rather than merely quiet — say so
  // instead of showing an empty slot the user cannot explain.
  Text {
    anchors.centerIn: parent
    visible: root.dead
    text: "󰝟"
    color: Color.urgent
    font.family: root.bar ? root.bar.fontFamily : "monospace"
    font.pixelSize: Style.font.body
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor

    onClicked: function(mouse) {
      if (!root.bar) return
      // Middle click steps the style, right click steps the colour: the two
      // things worth trying on a whim, without a trip through the settings.
      if (mouse.button === Qt.MiddleButton) root.cycleStyle(1)
      else if (mouse.button === Qt.RightButton) root.cyclePalette(1)
      else root.bar.run("omarchy-shell shell toggle omarchy.audio")
    }

    // Scrolling over the widget walks the styles too, which is the fastest way
    // to see all four next to each other.
    onWheel: function(wheel) {
      root.cycleStyle(wheel.angleDelta.y > 0 ? 1 : -1)
      wheel.accepted = true
    }
  }
}

