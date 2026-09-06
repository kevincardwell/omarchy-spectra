import QtQuick
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
  property string mode: "Bottom"
  property string palette: "Accent"
  property bool peakHold: true
  property bool autoHide: true

  function applySettings() {
    var count = Math.round(Model.clamp(number("bars", 24), 4, 64))
    thickness = Model.clamp(number("barWidth", 3), 1, 12)
    gap = Model.clamp(number("gap", 2), 0, 8)
    framerate = Math.round(Model.clamp(number("framerate", 60), 20, 144))
    sensitivity = Model.clamp(number("sensitivity", 100), 25, 400) / 100
    mode = String(setting("mode", "Bottom"))
    palette = String(setting("color", "Accent"))
    peakHold = setting("peakHold", true) === true
    autoHide = setting("autoHide", true) === true
    if (count !== barCount) barCount = count
    ask()
  }

  onSettingsChanged: applySettings()

  // Identifies this instance's request to the service. One bar surface exists
  // per monitor, so instances must not share a key.
  readonly property string askKey: "pulsebar-" + Math.floor(Math.random() * 1e9)

  readonly property color baseColor: {
    if (palette === "Foreground") return bar ? bar.barForeground : Color.bar.text
    if (palette === "Muted") return Color.muted
    return Color.accent
  }

  readonly property bool quiet: autoHide && (!service || service.silent)
  readonly property real span: Math.max(2, Math.round(barSize * 0.62))
  readonly property real content: barCount * thickness + Math.max(0, barCount - 1) * gap

  // Per-frame render state, kept as plain arrays so a whole frame is one
  // property assignment rather than barCount separate change notifications.
  property var display: Model.zeros(barCount)
  property var peaks: Model.zeros(barCount)
  property var hangs: Model.zeros(barCount)

  function ask() {
    if (!service) return
    service.configure(askKey, { bars: barCount, framerate: framerate, noiseReduction: 45 })
  }

  onServiceChanged: ask()
  onBarCountChanged: {
    display = Model.zeros(barCount)
    peaks = Model.zeros(barCount)
    hangs = Model.zeros(barCount)
    ask()
  }
  Component.onCompleted: applySettings()
  Component.onDestruction: if (service) service.release(askKey)

  function step(dt) {
    var levels = service ? service.levels : []
    var nextDisplay = []
    var nextPeaks = []
    var nextHangs = []
    for (var i = 0; i < barCount; i++) {
      var target = Model.clamp((i < levels.length ? levels[i] : 0) * sensitivity, 0, 1)
      var value = Model.advance(display[i] || 0, target, dt, 26, 9)
      var cap = Model.advancePeak(peaks[i] || 0, value, dt, hangs[i] || 0, 0.9)
      nextDisplay.push(value)
      nextPeaks.push(cap.value)
      nextHangs.push(cap.hang)
    }
    display = nextDisplay
    peaks = nextPeaks
    hangs = nextHangs
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

    Repeater {
      model: root.barCount

      Item {
        id: band
        readonly property real level: root.display[index] || 0
        readonly property real peak: root.peaks[index] || 0
        readonly property real offset: index * (root.thickness + root.gap)
        readonly property color tint: root.palette === "Gradient"
          ? Model.mix(Color.muted, Color.accent, level)
          : root.baseColor

        x: root.vertical ? 0 : offset
        y: root.vertical ? offset : 0
        width: root.vertical ? canvas.width : root.thickness
        height: root.vertical ? root.thickness : canvas.height

        // A band is always at least a hairline: an empty bar should read as a
        // quiet channel, not as a broken widget.
        readonly property real drawn: Math.max(1, level * (root.vertical ? width : height))
        readonly property real capAt: Math.max(1, peak * (root.vertical ? width : height))

        Rectangle {
          radius: Math.min(root.thickness, 4) / 2
          color: band.tint
          opacity: 0.35 + 0.65 * band.level

          width: root.vertical ? band.drawn : band.width
          height: root.vertical ? band.height : band.drawn
          x: root.vertical
            ? (root.mode === "Top" ? band.width - width : (root.mode === "Mirror" ? (band.width - width) / 2 : 0))
            : 0
          y: root.vertical
            ? 0
            : (root.mode === "Top" ? 0 : (root.mode === "Mirror" ? (band.height - height) / 2 : band.height - height))
        }

        // Peak caps: one on the growing edge, two when the band grows both ways.
        Repeater {
          model: root.peakHold ? (root.mode === "Mirror" ? 2 : 1) : 0

          Rectangle {
            readonly property bool trailing: index === 1
            readonly property real thicknessPx: 2

            color: band.tint
            opacity: 0.9
            width: root.vertical ? thicknessPx : band.width
            height: root.vertical ? band.height : thicknessPx

            x: {
              if (!root.vertical) return 0
              if (root.mode === "Top") return band.width - band.capAt
              if (root.mode === "Mirror") {
                var edge = (band.width - band.capAt) / 2
                return trailing ? edge + band.capAt - thicknessPx : edge
              }
              return band.capAt - thicknessPx
            }
            y: {
              if (root.vertical) return 0
              if (root.mode === "Top") return band.capAt - thicknessPx
              if (root.mode === "Mirror") {
                var edge = (band.height - band.capAt) / 2
                return trailing ? edge + band.capAt - thicknessPx : edge
              }
              return band.height - band.capAt
            }
          }
        }
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      if (!root.bar) return
      // Right click re-arms the capture, which is what you want after
      // switching output devices or restarting pipewire.
      if (mouse.button === Qt.RightButton) {
        if (root.service) root.service.reload()
      } else {
        root.bar.run("omarchy-shell shell toggle omarchy.audio")
      }
    }
  }
}
