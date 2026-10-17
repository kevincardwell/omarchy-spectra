import QtQuick
import QtQuick.Window
import qs.Commons
import qs.Commons as Commons
import "Model.js" as Model

// The spectrum itself: the motion between cava's frames, and the one shader
// that draws every style (spectrum.frag). The bar widget hands it a service, a
// resolved look, and the geometry to draw at.
//
// What a frame costs is almost entirely the bar redrawing, so the three
// things that matter are drawing each update exactly once, drawing no more
// often than cava can say something new, and not drawing at all when nothing
// would move by a pixel. A ShaderEffect does the first — a Shape or a Canvas
// takes two frames per update — and the motion below does the other two.
Item {
  id: root

  property var service: null
  property var look: Model.resolve({})
  property bool vertical: false
  property int barCount: 28
  property real thickness: 3
  property real gap: 2
  property real span: 16
  // Internal geometry scales with the theme's spacing, like every other
  // measurement in the shell — a 2px cap is a hairline on a HiDPI bar.
  readonly property real lineWidth: Math.max(1, Style.space(2))
  readonly property real cell: Math.max(1, Style.space(2))
  readonly property real cellGap: Math.max(1, Style.space(1))
  // The Foreground palette's colour. The bar hands in its own text colour.
  property color foreground: Commons.Color.bar.text

  readonly property string mode: look.mode
  readonly property string peak: look.peak
  readonly property bool mirrored: mode === "Mirror"
  readonly property bool butterfly: mode === "Butterfly"
  readonly property real pitch: thickness + gap
  readonly property real content: barCount * thickness + Math.max(0, barCount - 1) * gap

  implicitWidth: vertical ? span : content
  implicitHeight: vertical ? content : span

  readonly property color accentColor: Commons.Color.accent
  readonly property color mutedColor: Commons.Color.muted
  readonly property color baseColor: {
    if (look.palette === "Foreground") return foreground
    if (look.palette === "Muted") return mutedColor
    return accentColor
  }

  // Which end of the depth axis the bands grow from. A vertical bar flips the
  // axis, so "Bottom" means "the far edge" on one and "the near edge" on the
  // other. Butterfly grows from the baseline like Bottom.
  readonly property bool fromFarEnd: (mode === "Bottom" || butterfly) !== vertical

  // The finest step a frame can show, in device pixels across the full range
  // of one side's level. Glow has no length at all, only brightness, so it
  // gets a fixed number of steps instead.
  readonly property real resolution: look.style === "Glow"
    ? 64 : Math.max(8, (mirrored ? span / 2 : span) * Screen.devicePixelRatio)

  // The motion itself, one per side, mutated in place every frame. Nothing is
  // bound to these, so they can move without anything being redrawn; a frame
  // reaches the screen only when `publish` hands it to the shader.
  readonly property var _sideA: ({ level: [], peak: [], hang: [] })
  readonly property var _sideB: ({ level: [], peak: [], hang: [] })
  readonly property var _rawA: []
  readonly property var _rawB: []
  readonly property var _scratch: ({ shaped: [], smoothed: [], half: [], cap: { value: 0, hang: 0 } })
  readonly property var _keys: []

  // Whether every band and cap has come to rest at zero, so the animation can
  // stop until the music comes back.
  property bool settled: true
  property real _pending: 0

  function step(dt) {
    // The capture is shared and runs at the most generous band count anyone
    // asked for, so it is folded to what this one draws, and laid out for the
    // mode: channels apart, side by side, or merged.
    Model.arrange(service ? service.leftLevels : [], service ? service.rightLevels : [],
                  barCount, mode, _rawA, _rawB, _scratch.half)
    Model.animate(_sideA, _rawA, dt, look, _scratch)
    if (mirrored) Model.animate(_sideB, _rawB, dt, look, _scratch)

    var still = atRest(_sideA) && (!mirrored || atRest(_sideB))
    if (still !== settled) settled = still

    var drawn = peak === "Off" ? [_sideA.level] : [_sideA.level, _sideA.peak]
    if (mirrored) {
      drawn.push(_sideB.level)
      if (peak !== "Off") drawn.push(_sideB.peak)
    }
    if (Model.moved(_keys, drawn, resolution)) publish()
  }

  function atRest(side) {
    for (var i = 0; i < side.level.length; i++) {
      if (side.level[i] > 0.001 || side.peak[i] > 0.001) return false
    }
    return true
  }

  // Hand the frame to the shader, four bands to a uniform.
  function publish() {
    upload("a", _sideA)
    if (mirrored) upload("b", _sideB)
  }

  function upload(prefix, side) {
    var level = side.level
    var peaks = side.peak
    for (var k = 0; k * 4 < barCount; k++) {
      var i = k * 4
      fx[prefix + k] = Qt.vector4d(Model.packBand(level[i], peaks[i]),
                                   Model.packBand(level[i + 1], peaks[i + 1]),
                                   Model.packBand(level[i + 2], peaks[i + 2]),
                                   Model.packBand(level[i + 3], peaks[i + 3]))
    }
  }

  // Draw now, whether or not the spectrum moved: what it is drawn from did.
  function invalidate() {
    Model.truncate(_keys, 0)
    publish()
  }

  onBarCountChanged: invalidate()
  onModeChanged: invalidate()
  onLookChanged: invalidate()

  // Steps at the capture rate rather than the screen's: cava cannot report
  // anything new any faster, and each frame drawn costs the same. The slack
  // keeps a 60fps cap on a 59.9Hz screen from dropping every other frame.
  FrameAnimation {
    running: root.visible && ((root.service !== null && !root.service.silent) || !root.settled)
    onTriggered: {
      root._pending += frameTime
      if (root._pending < 0.75 / root.look.framerate) return
      root.step(Math.min(root._pending, 0.1))
      root._pending = 0
    }
  }

  ShaderEffect {
    id: fx
    anchors.fill: parent
    fragmentShader: Qt.resolvedUrl("spectrum.frag.qsb")

    // Everything the shader reads, by the name it reads it under. See the
    // uniform block at the top of spectrum.frag for what each one means.
    property size size: Qt.size(width, height)
    property real bands: root.barCount
    property real pitch: root.pitch
    property real thickness: root.thickness
    property real span: root.span
    property real vertical: root.vertical ? 1 : 0
    property real mirrored: root.mirrored ? 1 : 0
    property real fromFar: root.fromFarEnd ? 1 : 0
    property real style: Model.styles.indexOf(root.look.style)
    property real peakMode: Model.peakModes.indexOf(root.peak)
    property real fillAlpha: root.look.filled ? 0.38 : 0.13
    property real capWidth: root.lineWidth
    // Dots cells are deliberately shorter than the bars are wide: a bar only
    // offers a dozen or so pixels of height, and a ladder needs enough rungs
    // that a level reads as a quantity rather than as on/off.
    property real cell: root.cell
    property real cellPitch: root.cell + root.cellGap
    property real rows: Math.max(3, Math.floor((root.span + root.cellGap) / cellPitch))
    property real paletteMode: ({ Gradient: 1, Spectrum: 2, Cover: 3 })[root.look.palette] || 0
    property real butterfly: root.butterfly ? 1 : 0
    property color flatColor: root.baseColor
    property color mutedColor: root.mutedColor
    // Spectrum sweeps hue from the accent, so it still belongs to the theme.
    property point anchor: Qt.point(root.accentColor.hsvHue >= 0 ? root.accentColor.hsvHue : 0.55,
                                    root.accentColor.hsvSaturation)
    // Cover samples the album art; until it has loaded, it sweeps like Spectrum.
    property var cover: coverArt
    property real coverReady: coverArt.status === Image.Ready ? 1 : 0

    property vector4d a0; property vector4d a1; property vector4d a2; property vector4d a3
    property vector4d a4; property vector4d a5; property vector4d a6; property vector4d a7
    property vector4d a8; property vector4d a9; property vector4d a10; property vector4d a11
    property vector4d a12; property vector4d a13; property vector4d a14; property vector4d a15
    property vector4d b0; property vector4d b1; property vector4d b2; property vector4d b3
    property vector4d b4; property vector4d b5; property vector4d b6; property vector4d b7
    property vector4d b8; property vector4d b9; property vector4d b10; property vector4d b11
    property vector4d b12; property vector4d b13; property vector4d b14; property vector4d b15
  }

  // The cover of what is playing, for the Cover palette. Tiny on purpose: the
  // shader only wants its colours, and a 16px texture is all it samples.
  Image {
    id: coverArt
    visible: false
    asynchronous: true
    sourceSize: Qt.size(16, 16)
    source: root.look.palette === "Cover" && root.service ? root.service.coverUrl : ""
  }
}
