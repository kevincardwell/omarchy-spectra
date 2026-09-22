import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Spectra on the bar: settings, the fold when the room is quiet, and the
// scroll and click shortcuts. The spectrum itself — motion and drawing — is
// Spectrum.qml.
BarWidget {
  id: root
  moduleName: "radius.spectra"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("radius.spectra") : null

  // Settings are snapshotted rather than bound. The bar re-hands `settings`
  // to the slot while it is laying widgets out, so an implicitWidth that reads
  // it directly closes a binding loop with the slot that sizes us.
  property var look: Model.resolve({})
  property int barCount: 28
  property real thickness: 3
  property real gap: 2
  property real fill: 0.62
  property string style: "Bars"
  property bool filled: false
  property string mode: "Bottom"
  property string palette: "Accent"
  property bool autoHide: true
  property bool reducedMotion: false

  function applySettings() {
    var next = Model.resolve(settings)
    thickness = next.barWidth
    gap = next.gap
    fill = next.fill
    style = next.style
    filled = next.filled
    mode = next.mode
    palette = next.palette
    autoHide = next.autoHide
    reducedMotion = next.reducedMotion
    look = next
    var count = Model.drawnBands(next.bars, next.mode)
    if (count !== barCount) barCount = count
    ask()
  }

  onSettingsChanged: applySettings()

  // Identifies this instance's request to the service. One bar surface exists
  // per monitor, so instances must not share a key.
  readonly property string askKey: "spectra-" + Math.floor(Math.random() * 1e9)

  function ask() {
    if (!service) return
    service.configure(askKey, {
      bars: Model.capturedBands(look.bars, look.mode),
      framerate: look.framerate,
      noiseReduction: 45,
      idleSuspend: look.idleSuspend,
      quietDelay: look.quietDelay,
      sleepDelay: look.sleepDelay,
      source: look.device
    })
  }

  onServiceChanged: ask()
  onBarCountChanged: ask()
  // The bar assigns `settings` as an initial property, which emits no change
  // signal, so a straight onCompleted call would snapshot the defaults and
  // never see the user's entry. Deferring picks it up after injection.
  Component.onCompleted: Qt.callLater(applySettings)
  Component.onDestruction: if (service) service.release(askKey)

  readonly property bool dead: service ? service.unavailable === true : false
  readonly property bool quiet: !dead && autoHide && (!service || service.silent)
  readonly property real span: Math.max(2, Math.round(barSize * fill))
  readonly property real content: barCount * thickness + Math.max(0, barCount - 1) * gap

  // ---- Switching styles --------------------------------------------------
  //
  // Style is the setting people actually want to play with, so it is reachable
  // without opening a settings form: scroll or middle click steps through
  // them, and the choice is written back to shell.json so it survives a
  // restart rather than reverting the next time the shell reloads.
  readonly property var styleRing: Model.styles
  readonly property var paletteRing: Model.palettes

  // Switching is applied locally at once and written to disk on a delay: a
  // single flick of the scroll wheel is a dozen wheel events, and each one
  // would otherwise be its own rewrite of shell.json.
  function store(key, value) {
    var next = ({})
    for (var s in settings) next[s] = settings[s]
    next[key] = value
    settings = next
    persist.restart()
  }

  Timer {
    id: persist
    interval: 300
    onTriggered: {
      if (bar && bar.shell && typeof bar.shell.updateEntryInline === "function")
        bar.shell.updateEntryInline(root.moduleName, root.settings)
    }
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
    var match = Model.oneOf(name, styleRing, "")
    if (match !== "") store("style", match)
  }

  function setPalette(name) {
    var match = Model.oneOf(name, paletteRing, "")
    if (match !== "") store("color", match)
  }

  // Bindable from a keyboard shortcut:
  //   omarchy-shell radius.spectra cycleStyle
  IpcHandler {
    target: "radius.spectra"

    function cycleStyle(): void { root.cycleStyle(1) }
    function previousStyle(): void { root.cycleStyle(-1) }
    function setStyle(name: string): void { root.setStyle(name) }
    function cycleColor(): void { root.cyclePalette(1) }
    function setColor(name: string): void { root.setPalette(name) }
    function reload(): void { if (root.service) root.service.reload() }
  }

  // No `visible` binding here: the bar's slot sizes itself from implicitWidth,
  // so reading back width (or visibility) to decide the fold closes a binding
  // loop. Collapsing implicitWidth behind `clip` is enough to disappear.
  implicitWidth: vertical ? span + Style.space(8) : (quiet ? 0 : content + Style.space(8))
  implicitHeight: vertical ? (quiet ? 0 : content + Style.space(8)) : barSize

  // The fold is incidental motion rather than the visualisation itself, so it
  // is the part `reducedMotion` turns off.
  Behavior on implicitWidth {
    NumberAnimation { duration: root.reducedMotion ? 0 : 220; easing.type: Easing.OutCubic }
  }
  Behavior on implicitHeight {
    NumberAnimation { duration: root.reducedMotion ? 0 : 220; easing.type: Easing.OutCubic }
  }

  clip: true

  Spectrum {
    anchors.centerIn: parent
    width: implicitWidth
    height: implicitHeight
    service: root.service
    look: root.look
    vertical: root.vertical
    barCount: root.barCount
    thickness: root.thickness
    gap: root.gap
    span: root.span
    foreground: root.bar ? root.bar.barForeground : Color.bar.text
    opacity: root.quiet ? 0 : 1

    Behavior on opacity { NumberAnimation { duration: root.reducedMotion ? 0 : 200 } }
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

  // The bar owns tooltip rendering, in a PopupWindow that can extend past the
  // bar surface. A Qt Popup declared in here cannot: it is clipped to a strip
  // barely one line tall, it covers the widget it describes, and the pointer
  // then lands on the popup rather than the widget, so scrolling to change
  // style stops working. `bar.showTooltip` avoids all three.
  readonly property bool tooltipHovered: visible && opacity > 0 && mouse.containsMouse

  readonly property bool lineStyle: style === "Spikes" || style === "Steps" || style === "Wave"
  readonly property string tooltipText: dead
    ? (service && service.failure !== "" ? service.failure : "Audio capture unavailable")
    : style + (lineStyle && filled ? " (filled)" : "") + " · " + palette + " · " + mode
      + "\nScroll: style · Right click: colour"

  // Cycling while hovered should update what the tooltip says.
  onTooltipTextChanged: if (tooltipHovered && bar) bar.showTooltip(root, tooltipText)

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true

    onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltipText)
    onExited: if (root.bar) root.bar.hideTooltip(root)
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
    // to see them next to each other.
    onWheel: function(wheel) {
      root.cycleStyle(wheel.angleDelta.y > 0 ? 1 : -1)
      wheel.accepted = true
    }
  }
}
