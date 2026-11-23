import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "io.github.carloj005.glovo-tracker"
  ipcTarget: "io.github.carloj005.glovo-tracker"
  manageIpc: false

  Commons.Translations {
    id: strings
    directory: String(Qt.resolvedUrl("i18n")).replace(/^qs:\/\//, "file://")
  }

  property var anchorItem: null
  property var hostWidget: null
  property bool openedFromHotkey: false
  property bool showSettings: false

  readonly property var orderHost: hostWidget || root
  readonly property var barIdentity: hostWidget || root
  readonly property color contentForeground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dimForeground: Qt.darker(contentForeground, 1.45)
  readonly property color accentColor: Commons.Color.accent
  readonly property color urgentColor: bar ? bar.urgent : Commons.Color.urgent
  readonly property color glovoTeal: "#00A082"
  readonly property color glovoYellow: "#FFC244"
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  property var currentOrder: Model.emptyOrder()
  property var sessionState: Model.parseSessionFile("")
  property bool demoActive: false
  property bool fetching: false
  property bool browserSyncing: false
  property bool loginInProgress: false
  property bool logoutInProgress: false
  property string lastError: ""
  property bool hasAuthToken: false
  property bool fluxConnected: false

  readonly property bool browserSyncEnabled: setting("browserSyncEnabled", false) === true
  readonly property int browserPollIntervalMinutes: Model.clampInt(setting("browserPollIntervalMinutes", 2), 2, 1, 30)
  readonly property bool autoRefreshEnabled: setting("autoRefreshEnabled", false) === true
  readonly property bool syncFromPhoneEnabled: setting("syncFromPhoneEnabled", true) !== false
  readonly property int pollIntervalMinutes: Model.clampInt(setting("pollIntervalMinutes", 2), 2, 1, 30)
  readonly property bool notifyOnStageChange: setting("notifyOnStageChange", true) !== false
  readonly property bool notifyOnEtaChange: setting("notifyOnEtaChange", true) !== false
  readonly property bool soundEnabled: setting("soundEnabled", true) !== false
  readonly property bool showEtaInBar: setting("showEtaInBar", true) !== false

  readonly property var progressSteps: [
    { key: "confirmed", labelKey: "step.confirmed" },
    { key: "preparing", labelKey: "step.preparing" },
    { key: "pickup", labelKey: "step.pickup" },
    { key: "delivering", labelKey: "step.delivering" },
    { key: "delivered", labelKey: "step.delivered" }
  ]

  function tFn(key, fallback) { return strings.t(key, fallback) }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    showSettings = false
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function persistSettings(values) {
    var entry = { id: root.moduleName }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    for (var key in values) {
      if (values[key] === undefined) delete entry[key]
      else entry[key] = values[key]
    }
    root.settings = entry
    if (root.hostWidget && "settings" in root.hostWidget) root.hostWidget.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function") {
      root.bar.shell.updateEntryInline(root.moduleName, entry)
    }
  }

  function formatUpdatedTime(ms) {
    if (!ms || ms <= 0) return ""
    var locale = Qt.locale(Commons.I18n.formatLocale)
    return new Date(ms).toLocaleTimeString(locale, Locale.ShortFormat)
  }

  function heroMetaText() {
    var _lang = Commons.I18n.language
    var _cat = strings.strings
    var o = root.currentOrder
    var stageText = strings.t(Model.stageTitleKey(o.stage))
    if (o.hasOrder && o.elapsedMinutes > 0) {
      var elapsedText = strings.tn("order.elapsedMinutes", o.elapsedMinutes).arg(Commons.I18n.formatNumber(o.elapsedMinutes))
      return stageText + " • " + elapsedText
    }
    return stageText
  }

  function heroDetailText() {
    var _lang = Commons.I18n.language
    var _cat = strings.strings
    var o = root.currentOrder
    if (!o.hasOrder) {
      if (root.demoActive) return strings.t("demo.badge")
      if (root.sessionState && root.sessionState.loggedIn) return strings.t("browser.statusConnected")
      return ""
    }
    if (Model.isActiveStage(o.stage)) {
      if (o.etaMinutes > 0) {
        return strings.tn("eta.minutes", o.etaMinutes).arg(Commons.I18n.formatNumber(o.etaMinutes))
      }
      return strings.t("eta.arrivingNow")
    }
    return root.demoActive ? strings.t("demo.badge") : ""
  }

  onShowSettingsChanged: {
    if (showSettings && orderIdField) {
      orderIdField.text = (orderHost && "effectiveOrderId" in orderHost) ? (orderHost.effectiveOrderId || "") : ""
      tokenField.text = ""
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(mainColumn.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: orderIdField.activeFocus || tokenField.activeFocus

      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dy !== 0 && panelScroll.interactive) {
          panelScroll.contentY = Math.max(
            0,
            Math.min(panelScroll.contentHeight - panelScroll.height, panelScroll.contentY + dy * Style.space(50))
          )
        }
      }
      onTextKey: function(t) {
        if (t === "r" || t === "R") {
          if (orderHost && orderHost.refresh) orderHost.refresh()
        } else if (t === "n" || t === "N") {
          if (orderHost && orderHost.notifyCurrentStatus) orderHost.notifyCurrentStatus()
        }
      }

      Flickable {
        id: panelScroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: mainColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: mainColumn
          width: panelScroll.width
          spacing: Style.space(12)

          // -------------------------------------------------- Hero Header
          PanelHero {
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            title: root.currentOrder.hasOrder
              ? Model.neutralizeMarkup(root.currentOrder.storeName, Model.MAX_STRING_LEN)
              : ((root.sessionState && root.sessionState.loggedIn)
                  ? (root.sessionState.userName
                      ? strings.t("browser.greeting").arg(Model.neutralizeMarkup(root.sessionState.userName, 48))
                      : strings.t("browser.greetingShort"))
                  : strings.t("plugin.title"))
            meta: root.heroMetaText()
            detail: root.heroDetailText()

            iconComponent: Component {
              BorderSurface {
                implicitWidth: Style.space(38)
                implicitHeight: Style.space(38)
                radius: Style.cornerRadius
                color: Model.isActiveStage(root.currentOrder.stage)
                  ? Qt.rgba(root.glovoTeal.r, root.glovoTeal.g, root.glovoTeal.b, 0.18)
                  : Style.normalFillFor(root.contentForeground, root.accentColor)
                borderSpec: Border.controlSpec(
                  Model.isActiveStage(root.currentOrder.stage) ? "selected" : "normal",
                  root.contentForeground,
                  root.glovoTeal
                )

                PlainText {
                  anchors.centerIn: parent
                  text: Model.stageIcon(root.currentOrder.stage)
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.display
                  color: Model.isActiveStage(root.currentOrder.stage)
                    ? root.glovoTeal
                    : root.contentForeground
                }
              }
            }

            trailingControl: Component {
              PanelActionButton {
                iconText: "\uf013"
                tooltipText: strings.t("panel.settingsTooltip")
                foreground: root.contentForeground
                hoverColor: root.accentColor
                fontFamily: root.contentFontFamily
                bordered: root.showSettings
                onClicked: root.showSettings = !root.showSettings
              }
            }
          }

          // -------------------------------------------------- Error Banner
          BorderSurface {
            visible: root.lastError !== ""
            width: parent.width
            implicitHeight: errorLabel.implicitHeight + Style.space(12)
            radius: Style.cornerRadius
            color: Style.hoverFillFor(root.urgentColor, root.urgentColor)
            borderSpec: Border.controlSpec("normal", root.urgentColor, root.urgentColor)

            PlainText {
              id: errorLabel
              anchors.fill: parent
              anchors.margins: Style.space(6)
              text: strings.t("panel.errorPrefix").arg(Model.neutralizeMarkup(root.lastError, 80))
              color: root.urgentColor
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
            }
          }

          // -------------------------------------------------- Active Order (Phone Layout)
          Column {
            visible: root.currentOrder.hasOrder
            width: parent.width
            spacing: Style.space(10)

            PanelSeparator { foreground: root.contentForeground }

            // 1. Phone-style Header: Timeliness Pill + Arrival Window + Continuous Teal Bar + Store & Rider Rows
            BorderSurface {
              width: parent.width
              implicitHeight: phoneCardColumn.implicitHeight + Style.space(22)
              radius: Style.cornerRadius
              color: Style.normalFillFor(root.contentForeground, root.accentColor)
              borderSpec: Border.controlSpec("normal", root.contentForeground, root.accentColor)

              Column {
                id: phoneCardColumn
                anchors.fill: parent
                anchors.margins: Style.space(11)
                spacing: Style.space(10)

                // Top Row: Timeliness Pill ("Puntuale") + Demo/Updated meta
                Item {
                  width: parent.width
                  height: Math.max(timelinessPill.implicitHeight, rightMetaRow.implicitHeight)

                  BorderSurface {
                    id: timelinessPill
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    implicitWidth: timelinessText.implicitWidth + Style.space(14)
                    implicitHeight: timelinessText.implicitHeight + Style.space(6)
                    radius: Math.max(Style.cornerRadius, Style.space(6))
                    readonly property bool isDelayed: root.currentOrder.timeliness === "delayed" || root.currentOrder.stage === "cancelled"
                    readonly property color badgeColor: isDelayed ? root.urgentColor : root.glovoTeal
                    color: Qt.rgba(badgeColor.r, badgeColor.g, badgeColor.b, 0.16)
                    borderSpec: Border.controlSpec("normal", badgeColor, badgeColor)

                    PlainText {
                      id: timelinessText
                      anchors.centerIn: parent
                      text: root.currentOrder.stage === "cancelled"
                        ? strings.t("stage.cancelled")
                        : strings.t(Model.timelinessKey(root.currentOrder.timeliness))
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      color: timelinessPill.badgeColor
                    }
                  }

                  Row {
                    id: rightMetaRow
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(6)

                    BorderSurface {
                      visible: root.demoActive
                      implicitWidth: demoTagText.implicitWidth + Style.space(10)
                      implicitHeight: demoTagText.implicitHeight + Style.space(4)
                      radius: Style.cornerRadius
                      color: Style.selectedFillFor(root.contentForeground, root.accentColor)
                      borderSpec: Border.controlSpec("selected", root.contentForeground, root.accentColor)

                      PlainText {
                        id: demoTagText
                        anchors.centerIn: parent
                        text: strings.t("demo.badge")
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                        color: root.accentColor
                      }
                    }

                    PlainText {
                      visible: root.currentOrder.updatedAtMs > 0
                      anchors.verticalCenter: parent.verticalCenter
                      text: root.currentOrder.updatedAtMs > 0
                        ? strings.t("panel.updatedAt").arg(root.formatUpdatedTime(root.currentOrder.updatedAtMs))
                        : ""
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      color: root.dimForeground
                    }
                  }
                }

                // Bold Arrival Window ("13:45 - 13:55") or Final Stage Headline
                Column {
                  width: parent.width
                  spacing: Style.space(2)

                  PlainText {
                    id: windowText
                    width: parent.width
                    readonly property string etaWin: Model.buildEtaWindowText(root.currentOrder)
                    text: (Model.isActiveStage(root.currentOrder.stage) && etaWin !== "")
                      ? etaWin
                      : strings.t(Model.stageTitleKey(root.currentOrder.stage))
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.displayLarge
                    font.bold: true
                    color: root.currentOrder.stage === "cancelled" ? root.urgentColor : root.contentForeground
                    elide: Text.ElideRight
                  }

                  PlainText {
                    visible: Model.isActiveStage(root.currentOrder.stage)
                    width: parent.width
                    text: root.currentOrder.etaMinutes > 0
                      ? strings.tn("eta.arrivingIn", root.currentOrder.etaMinutes).arg(Commons.I18n.formatNumber(root.currentOrder.etaMinutes))
                      : strings.t("eta.arrivingNow")
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    color: root.dimForeground
                    elide: Text.ElideRight
                  }
                }

                // Continuous Glovo Teal Progress Bar
                Column {
                  width: parent.width
                  spacing: Style.space(6)

                  Rectangle {
                    id: progressTrack
                    width: parent.width
                    height: Style.space(6)
                    radius: height / 2
                    color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.14)

                    Rectangle {
                      height: parent.height
                      radius: parent.radius
                      width: Math.max(
                        root.currentOrder.progressRatio > 0 ? height : 0,
                        parent.width * Model.clampFloat(root.currentOrder.progressRatio, 0, 0, 1)
                      )
                      color: root.currentOrder.stage === "cancelled" ? root.urgentColor : root.glovoTeal

                      Behavior on width {
                        NumberAnimation {
                          duration: Style.duration(220)
                          easing.type: Easing.OutCubic
                        }
                      }
                    }
                  }

                  // Compact stage ticks underneath
                  Row {
                    id: stepRow
                    width: parent.width
                    spacing: Style.space(4)
                    readonly property int activeIndex: Model.stageStepIndex(root.currentOrder.stage)
                    readonly property bool isCancelled: root.currentOrder.stage === "cancelled"

                    Repeater {
                      model: root.progressSteps
                      delegate: PlainText {
                        required property var modelData
                        required property int index
                        readonly property bool reached: !stepRow.isCancelled && stepRow.activeIndex >= index
                        readonly property bool current: !stepRow.isCancelled && stepRow.activeIndex === index
                        width: (stepRow.width - stepRow.spacing * (root.progressSteps.length - 1)) / root.progressSteps.length
                        horizontalAlignment: Text.AlignHCenter
                        text: strings.t(modelData.labelKey)
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: current
                        color: current ? root.contentForeground : (reached ? root.glovoTeal : Qt.darker(root.contentForeground, 1.9))
                        elide: Text.ElideRight
                      }
                    }
                  }
                }

                PanelSeparator { foreground: root.contentForeground; strength: 0.08 }

                // Store Status Row ("Bistro Fresh&Fast is preparing your order")
                Row {
                  width: parent.width
                  spacing: Style.space(10)

                  BorderSurface {
                    width: Style.space(30)
                    height: Style.space(30)
                    radius: Math.max(Style.cornerRadius, Style.space(6))
                    anchors.verticalCenter: parent.verticalCenter
                    color: Qt.rgba(root.glovoTeal.r, root.glovoTeal.g, root.glovoTeal.b, 0.14)
                    borderSpec: Border.controlSpec("normal", root.glovoTeal, root.glovoTeal)

                    PlainText {
                      anchors.centerIn: parent
                      text: "\uf290"
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.icon
                      color: root.glovoTeal
                    }
                  }

                  PlainText {
                    width: parent.width - Style.space(40)
                    anchors.verticalCenter: parent.verticalCenter
                    text: {
                      var _lang = Commons.I18n.language
                      var _cat = strings.strings
                      return Model.buildStoreMessage(root.currentOrder, root.tFn)
                    }
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                    color: root.contentForeground
                    wrapMode: Text.Wrap
                  }
                }

                // Courier Status Row ("Marco is waiting for your order")
                Row {
                  visible: Model.isActiveStage(root.currentOrder.stage) || root.currentOrder.courierName !== "" || root.currentOrder.courierMessage !== ""
                  width: parent.width
                  spacing: Style.space(10)

                  Rectangle {
                    width: Style.space(30)
                    height: Style.space(30)
                    radius: width / 2
                    anchors.verticalCenter: parent.verticalCenter
                    color: root.currentOrder.courierName !== "" ? root.glovoYellow : Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)

                    PlainText {
                      anchors.centerIn: parent
                      text: root.currentOrder.courierName !== "" ? "\uf041" : "\uf206"
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.icon
                      color: root.currentOrder.courierName !== "" ? "#1D1D1F" : root.dimForeground
                    }
                  }

                  Column {
                    width: parent.width - Style.space(40)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    PlainText {
                      width: parent.width
                      text: {
                        var _lang = Commons.I18n.language
                        var _cat = strings.strings
                        return Model.buildCourierMessage(root.currentOrder, root.tFn)
                      }
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                      color: root.contentForeground
                      wrapMode: Text.Wrap
                    }

                    PlainText {
                      visible: root.currentOrder.vehicle !== ""
                      width: parent.width
                      text: Model.neutralizeMarkup(root.currentOrder.vehicle, 48)
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      color: root.dimForeground
                      elide: Text.ElideRight
                    }
                  }
                }
              }
            }

            // 2. Glovo-style Live Route Map Card
            BorderSurface {
              id: mapCard
              width: parent.width
              implicitHeight: Style.space(138)
              radius: Style.cornerRadius
              clip: true
              color: Style.normalFillFor(root.contentForeground, root.accentColor)
              borderSpec: Border.controlSpec("normal", root.contentForeground, root.accentColor)

              readonly property bool mirrored: LayoutMirroring.enabled
              property real riderT: Model.riderRoutePosition(root.currentOrder.stage)
              readonly property real storeX: mirrored ? width * 0.25 : width * 0.75
              readonly property real storeY: height * 0.56
              readonly property real destX: mirrored ? width * 0.74 : width * 0.26
              readonly property real destY: height * 0.24
              readonly property real ctrlX: width * 0.50
              readonly property real ctrlY: height * 0.52

              // Quadratic Bezier position along route
              readonly property real riderPosX: (1 - riderT) * (1 - riderT) * storeX + 2 * (1 - riderT) * riderT * ctrlX + riderT * riderT * destX
              readonly property real riderPosY: (1 - riderT) * (1 - riderT) * storeY + 2 * (1 - riderT) * riderT * ctrlY + riderT * riderT * destY

              Behavior on riderT {
                NumberAnimation {
                  duration: Style.duration(260)
                  easing.type: Easing.OutCubic
                }
              }

              onWidthChanged: routeCanvas.requestPaint()
              onHeightChanged: routeCanvas.requestPaint()
              onMirroredChanged: routeCanvas.requestPaint()
              onRiderTChanged: routeCanvas.requestPaint()

              Connections {
                target: Commons.Color
                function onForegroundChanged() { routeCanvas.requestPaint() }
                function onAccentChanged() { routeCanvas.requestPaint() }
              }

              Canvas {
                id: routeCanvas
                anchors.fill: parent
                onPaint: {
                  var ctx = getContext("2d")
                  ctx.clearRect(0, 0, width, height)

                  var fg = root.contentForeground
                  // Subtle vector street grid lines
                  ctx.strokeStyle = Qt.rgba(fg.r, fg.g, fg.b, 0.08)
                  ctx.lineWidth = 1.5
                  for (var gx = 1; gx < 5; gx++) {
                    ctx.beginPath()
                    ctx.moveTo(width * (gx * 0.22), 0)
                    ctx.lineTo(width * (gx * 0.18 + 0.08), height)
                    ctx.stroke()
                  }
                  for (var gy = 1; gy < 4; gy++) {
                    ctx.beginPath()
                    ctx.moveTo(0, height * (gy * 0.28))
                    ctx.lineTo(width, height * (gy * 0.24 + 0.05))
                    ctx.stroke()
                  }

                  // Dashed full route curve between store and destination
                  ctx.save()
                  ctx.strokeStyle = Qt.rgba(root.glovoTeal.r, root.glovoTeal.g, root.glovoTeal.b, 0.35)
                  ctx.lineWidth = 3
                  ctx.setLineDash([6, 5])
                  ctx.beginPath()
                  ctx.moveTo(mapCard.storeX, mapCard.storeY)
                  ctx.quadraticCurveTo(mapCard.ctrlX, mapCard.ctrlY, mapCard.destX, mapCard.destY)
                  ctx.stroke()
                  ctx.restore()

                  // Solid traveled segment up to current rider position
                  var steps = 20
                  var limit = Math.max(0.02, mapCard.riderT)
                  ctx.strokeStyle = root.currentOrder.stage === "cancelled"
                    ? root.urgentColor
                    : root.glovoTeal
                  ctx.lineWidth = 3.5
                  ctx.beginPath()
                  ctx.moveTo(mapCard.storeX, mapCard.storeY)
                  for (var s = 1; s <= steps; s++) {
                    var u = limit * (s / steps)
                    var px = (1 - u) * (1 - u) * mapCard.storeX + 2 * (1 - u) * u * mapCard.ctrlX + u * u * mapCard.destX
                    var py = (1 - u) * (1 - u) * mapCard.storeY + 2 * (1 - u) * u * mapCard.ctrlY + u * u * mapCard.destY
                    ctx.lineTo(px, py)
                  }
                  ctx.stroke()
                }
              }

              // Destination Pin ("Tu" / Globe marker)
              Rectangle {
                x: mapCard.destX - width / 2
                y: mapCard.destY - height / 2
                width: Style.space(28)
                height: Style.space(28)
                radius: width / 2
                color: root.glovoTeal
                border.width: 2
                border.color: "#FFFFFF"

                PlainText {
                  anchors.centerIn: parent
                  text: "\uf015"
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: "#FFFFFF"
                }
              }

              // Store Pin
              Rectangle {
                x: mapCard.storeX - width / 2
                y: mapCard.storeY - height / 2
                width: Style.space(28)
                height: Style.space(28)
                radius: width / 2
                color: "#1B5E4E"
                border.width: 2
                border.color: "#FFFFFF"

                PlainText {
                  anchors.centerIn: parent
                  text: "\uf290"
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: "#FFFFFF"
                }
              }

              // Animated Courier Scooter Badge
              Rectangle {
                visible: root.currentOrder.stage !== "cancelled"
                x: mapCard.riderPosX - width / 2
                y: mapCard.riderPosY - height / 2
                width: Style.space(26)
                height: Style.space(26)
                radius: width / 2
                color: root.glovoYellow
                border.width: 2
                border.color: "#1D1D1F"

                PlainText {
                  anchors.centerIn: parent
                  text: "\uf206"
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.caption
                  color: "#1D1D1F"
                }
              }

              // Floating Bottom Banner Card ("Il tuo ordine sta arrivando...")
              BorderSurface {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.margins: Style.space(8)
                implicitHeight: bannerRow.implicitHeight + Style.space(10)
                radius: Style.cornerRadius
                color: Commons.Color.popups.background
                borderSpec: Border.controlSpec("normal", root.contentForeground, root.accentColor)

                Row {
                  id: bannerRow
                  anchors.fill: parent
                  anchors.margins: Style.space(6)
                  spacing: Style.space(8)

                  PlainText {
                    anchors.verticalCenter: parent.verticalCenter
                    text: Model.stageIcon(root.currentOrder.stage)
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    color: root.currentOrder.stage === "cancelled" ? root.urgentColor : root.glovoTeal
                  }

                  PlainText {
                    width: parent.width - Style.space(24)
                    anchors.verticalCenter: parent.verticalCenter
                    text: {
                      var _lang = Commons.I18n.language
                      var _cat = strings.strings
                      return Model.buildBannerMessage(root.currentOrder, root.tFn)
                    }
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                    color: root.contentForeground
                    elide: Text.ElideRight
                  }
                }
              }
            }

            // 3. Order Items Card
            Column {
              visible: root.currentOrder.items && root.currentOrder.items.length > 0
              width: parent.width
              spacing: Style.space(6)

              PanelSectionHeader {
                text: strings.t("panel.items") + " • " + strings.tn("order.itemsCount", root.currentOrder.items.length).arg(Commons.I18n.formatNumber(root.currentOrder.items.length))
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
              }

              BorderSurface {
                width: parent.width
                implicitHeight: itemsColumn.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                color: Style.normalFillFor(root.contentForeground, root.accentColor)
                borderSpec: Border.controlSpec("normal", root.contentForeground, root.accentColor)

                Column {
                  id: itemsColumn
                  anchors.fill: parent
                  anchors.margins: Style.space(8)
                  spacing: Style.space(4)

                  Repeater {
                    model: root.currentOrder.items || []
                    delegate: Row {
                      required property var modelData
                      width: itemsColumn.width
                      spacing: Style.space(8)

                      PlainText {
                        text: Commons.I18n.formatNumber(modelData.quantity || 1) + "×"
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.bodySmall
                        font.bold: true
                        color: root.glovoTeal
                        width: Style.space(26)
                      }

                      PlainText {
                        width: parent.width - Style.space(34)
                        text: Model.neutralizeMarkup(modelData.name || "", 80)
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.bodySmall
                        color: root.contentForeground
                        elide: Text.ElideRight
                      }
                    }
                  }
                }
              }
            }
          }

          // -------------------------------------------------- Idle Empty State
          BorderSurface {
            visible: !root.currentOrder.hasOrder
            width: parent.width
            implicitHeight: idleColumn.implicitHeight + Style.space(20)
            radius: Style.cornerRadius
            color: Style.normalFillFor(root.contentForeground, root.accentColor)
            borderSpec: Border.controlSpec("normal", root.contentForeground, root.accentColor)

            Column {
              id: idleColumn
              anchors.fill: parent
              anchors.margins: Style.space(10)
              spacing: Style.space(6)

              PlainText {
                width: parent.width
                text: strings.t("panel.noActiveOrder")
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.body
                font.bold: true
                color: root.contentForeground
                wrapMode: Text.Wrap
              }

              PlainText {
                width: parent.width
                text: strings.t("panel.noActiveOrderHint")
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
                color: root.dimForeground
                wrapMode: Text.Wrap
              }

              Flow {
                width: parent.width
                spacing: Style.space(8)

                Button {
                  visible: !(root.sessionState && root.sessionState.loggedIn)
                  text: root.loginInProgress ? strings.t("browser.loggingIn") : strings.t("browser.loginButton")
                  iconText: "\uf090"
                  foreground: root.contentForeground
                  accent: root.glovoTeal
                  fontFamily: root.contentFontFamily
                  bordered: true
                  selected: true
                  onClicked: if (orderHost && orderHost.loginBrowser) orderHost.loginBrowser()
                }

                Button {
                  visible: !!(root.sessionState && root.sessionState.loggedIn)
                  text: root.browserSyncing ? strings.t("browser.statusSyncing") : strings.t("browser.syncNowButton")
                  iconText: "\uf021"
                  iconSpinning: root.browserSyncing
                  foreground: root.contentForeground
                  accent: root.glovoTeal
                  fontFamily: root.contentFontFamily
                  bordered: true
                  selected: true
                  onClicked: if (orderHost && orderHost.syncBrowserSession) orderHost.syncBrowserSession()
                }
              }
            }
          }

          // -------------------------------------------------- Action Buttons
          Flow {
            width: parent.width
            spacing: Style.space(8)

            Button {
              visible: root.demoActive
              text: strings.t("demo.nextStage")
              iconText: "\uf051"
              foreground: root.contentForeground
              accent: root.accentColor
              fontFamily: root.contentFontFamily
              bordered: true
              selected: true
              onClicked: if (orderHost && orderHost.nextDemoStep) orderHost.nextDemoStep()
            }

            Button {
              visible: root.demoActive
              text: strings.t("demo.stop")
              iconText: "\uf04d"
              foreground: root.contentForeground
              accent: root.accentColor
              fontFamily: root.contentFontFamily
              bordered: true
              onClicked: if (orderHost && orderHost.stopDemo) orderHost.stopDemo()
            }

            Button {
              visible: !root.demoActive
              text: strings.t("panel.refresh")
              iconText: "\uf021"
              iconSpinning: root.fetching || root.browserSyncing
              foreground: root.contentForeground
              accent: root.accentColor
              fontFamily: root.contentFontFamily
              bordered: true
              onClicked: if (orderHost && orderHost.refresh) orderHost.refresh()
            }
          }

          // -------------------------------------------------- Settings Drawer
          Item {
            id: settingsDrawer
            width: parent.width
            clip: true
            height: root.showSettings ? settingsContent.implicitHeight : 0
            opacity: root.showSettings ? 1 : 0
            scale: root.showSettings ? 1 : 0.97
            visible: height > 1 || opacity > 0.01

            Behavior on height {
              NumberAnimation {
                duration: Style.duration(root.showSettings ? 180 : 120)
                easing.type: Easing.OutCubic
              }
            }
            Behavior on opacity {
              NumberAnimation {
                duration: Style.duration(root.showSettings ? 180 : 120)
                easing.type: Easing.OutCubic
              }
            }
            Behavior on scale {
              NumberAnimation {
                duration: Style.duration(root.showSettings ? 180 : 120)
                easing.type: Easing.Bezier
                easing.bezierCurve: Style.easeOut
              }
            }

            Column {
              id: settingsContent
              width: parent.width
              spacing: Style.space(10)

              PanelSeparator { foreground: root.contentForeground }

              PanelSectionHeader {
                text: strings.t("settings.title")
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
              }

              // Dedicated PC Browser Session (Option B — standalone, no phone)
              BorderSurface {
                width: parent.width
                implicitHeight: browserSessionCol.implicitHeight + Style.space(18)
                radius: Style.cornerRadius
                color: Style.normalFillFor(root.contentForeground, root.accentColor)
                borderSpec: Border.controlSpec("normal", root.contentForeground, root.accentColor)

                Column {
                  id: browserSessionCol
                  anchors.fill: parent
                  anchors.margins: Style.space(9)
                  spacing: Style.space(8)

                  Row {
                    width: parent.width
                    spacing: Style.space(8)

                    PlainText {
                      width: parent.width - sessionBadgeText.implicitWidth - Style.space(8)
                      text: strings.t("browser.sectionTitle")
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      color: root.contentForeground
                      elide: Text.ElideRight
                    }

                    PlainText {
                      id: sessionBadgeText
                      text: root.browserSyncing
                        ? strings.t("browser.statusSyncing")
                        : ((root.sessionState && root.sessionState.loggedIn)
                            ? (root.sessionState.userName
                                ? strings.t("browser.greeting").arg(Model.neutralizeMarkup(root.sessionState.userName, 48))
                                : strings.t("browser.statusConnected"))
                            : strings.t("browser.statusNeedsLogin"))
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      color: (root.sessionState && root.sessionState.loggedIn) ? root.glovoTeal : root.glovoYellow
                    }
                  }

                  PlainText {
                    visible: !!(root.sessionState && root.sessionState.lastSyncMs > 0)
                    width: parent.width
                    text: (root.sessionState && root.sessionState.lastSyncMs > 0)
                      ? strings.t("browser.lastSyncAt").arg(root.formatUpdatedTime(root.sessionState.lastSyncMs))
                      : ""
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    color: root.dimForeground
                  }

                  Flow {
                    width: parent.width
                    spacing: Style.space(6)

                    Button {
                      enabled: !root.logoutInProgress
                      text: root.loginInProgress ? strings.t("browser.loggingIn") : strings.t("browser.loginButton")
                      iconText: "\uf090"
                      foreground: root.contentForeground
                      accent: root.glovoTeal
                      fontFamily: root.contentFontFamily
                      fontSize: Style.font.caption
                      bordered: true
                      selected: !(root.sessionState && root.sessionState.loggedIn)
                      onClicked: if (orderHost && orderHost.loginBrowser) orderHost.loginBrowser()
                    }

                    Button {
                      visible: !!(root.sessionState && root.sessionState.loggedIn)
                      enabled: !root.logoutInProgress
                      text: strings.t("browser.syncNowButton")
                      iconText: "\uf021"
                      iconSpinning: root.browserSyncing
                      foreground: root.contentForeground
                      accent: root.accentColor
                      fontFamily: root.contentFontFamily
                      fontSize: Style.font.caption
                      bordered: true
                      onClicked: if (orderHost && orderHost.syncBrowserSession) orderHost.syncBrowserSession()
                    }

                    Button {
                      visible: !!(root.sessionState && root.sessionState.loggedIn) || root.hasAuthToken || root.logoutInProgress
                      enabled: !root.logoutInProgress
                      text: root.logoutInProgress ? strings.t("browser.loggingOut") : strings.t("browser.logoutButton")
                      iconText: "\uf08b"
                      foreground: root.contentForeground
                      accent: root.urgentColor
                      fontFamily: root.contentFontFamily
                      fontSize: Style.font.caption
                      bordered: true
                      onClicked: if (orderHost && orderHost.logoutBrowser) orderHost.logoutBrowser()
                    }
                  }

                  Row {
                    width: parent.width
                    spacing: Style.space(8)

                    PlainText {
                      width: parent.width - browserAutoSyncSwitch.implicitWidth - Style.space(8)
                      anchors.verticalCenter: parent.verticalCenter
                      text: strings.t("browser.autoSyncLabel")
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                      color: root.contentForeground
                      wrapMode: Text.Wrap
                    }

                    ToggleSwitch {
                      id: browserAutoSyncSwitch
                      checked: root.browserSyncEnabled
                      foreground: root.contentForeground
                      accent: root.accentColor
                      onToggled: root.persistSettings({ browserSyncEnabled: !root.browserSyncEnabled })
                    }
                  }

                  PlainText {
                    width: parent.width
                    text: strings.t("browser.autoSyncDisclosure")
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    color: root.dimForeground
                    wrapMode: Text.Wrap
                  }

                  Row {
                    width: parent.width
                    spacing: Style.space(6)

                    PlainText {
                      width: parent.width - browserPollRow.implicitWidth - Style.space(6)
                      anchors.verticalCenter: parent.verticalCenter
                      text: strings.t("settings.pollIntervalLabel")
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                      color: root.contentForeground
                      elide: Text.ElideRight
                    }

                    Row {
                      id: browserPollRow
                      spacing: Style.space(4)

                      Repeater {
                        model: [1, 2, 5]
                        delegate: Button {
                          required property int modelData
                          text: strings.tn("settings.pollEveryMinutes", modelData).arg(Commons.I18n.formatNumber(modelData))
                          selected: root.browserPollIntervalMinutes === modelData
                          foreground: root.contentForeground
                          accent: root.accentColor
                          fontFamily: root.contentFontFamily
                          fontSize: Style.font.caption
                          bordered: true
                          onClicked: root.persistSettings({ browserPollIntervalMinutes: modelData })
                        }
                      }
                    }
                  }
                }
              }

              PanelSeparator { foreground: root.contentForeground; strength: 0.08 }

              // Flux phone notification sync toggle + status
              Column {
                width: parent.width
                spacing: Style.space(4)

                Row {
                  width: parent.width
                  spacing: Style.space(8)

                  Column {
                    width: parent.width - phoneSyncSwitch.implicitWidth - Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(1)

                    PlainText {
                      width: parent.width
                      text: strings.t("settings.phoneSyncLabel")
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                      color: root.contentForeground
                      wrapMode: Text.Wrap
                    }

                    PlainText {
                      width: parent.width
                      text: root.fluxConnected ? strings.t("settings.phoneConnected") : strings.t("settings.phoneDisconnected")
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                      color: root.fluxConnected ? root.glovoTeal : root.dimForeground
                    }
                  }

                  ToggleSwitch {
                    id: phoneSyncSwitch
                    checked: root.syncFromPhoneEnabled
                    foreground: root.contentForeground
                    accent: root.accentColor
                    onToggled: root.persistSettings({ syncFromPhoneEnabled: !root.syncFromPhoneEnabled })
                  }
                }

                PlainText {
                  width: parent.width
                  text: strings.t("settings.phoneSyncDisclosure")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.caption
                  color: root.dimForeground
                  wrapMode: Text.Wrap
                }
              }

              PanelSeparator { foreground: root.contentForeground; strength: 0.08 }

              PlainText {
                text: strings.t("settings.orderIdLabel")
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                color: root.dimForeground
              }

              TextField {
                id: orderIdField
                width: parent.width
                foreground: root.contentForeground
                accent: root.accentColor
                font.family: root.contentFontFamily
                placeholderText: strings.t("settings.orderIdPlaceholder")
              }

              PlainText {
                text: strings.t("settings.tokenLabel")
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                color: root.dimForeground
              }

              TextField {
                id: tokenField
                width: parent.width
                password: true
                foreground: root.contentForeground
                accent: root.accentColor
                font.family: root.contentFontFamily
                placeholderText: root.hasAuthToken ? strings.t("settings.tokenSaved") : strings.t("settings.tokenPlaceholder")
              }

              Row {
                width: parent.width
                spacing: Style.space(8)

                Button {
                  text: strings.t("settings.saveCredentials")
                  foreground: root.contentForeground
                  accent: root.accentColor
                  fontFamily: root.contentFontFamily
                  bordered: true
                  selected: true
                  onClicked: {
                    var cleanId = Model.sanitizeOrderId(orderIdField.text)
                    var existingToken = (orderHost && "effectiveToken" in orderHost) ? orderHost.effectiveToken : ""
                    var nextToken = tokenField.text !== "" ? tokenField.text : existingToken
                    root.persistSettings({ orderId: cleanId })
                    if (orderHost && orderHost.saveCredentials) {
                      orderHost.saveCredentials(cleanId, nextToken)
                    }
                    tokenField.text = ""
                  }
                }

                Button {
                  text: strings.t("settings.clearCredentials")
                  foreground: root.contentForeground
                  accent: root.urgentColor
                  fontFamily: root.contentFontFamily
                  bordered: true
                  onClicked: {
                    orderIdField.text = ""
                    tokenField.text = ""
                    root.persistSettings({ orderId: "", autoRefreshEnabled: false })
                    if (orderHost && orderHost.clearCredentials) {
                      orderHost.clearCredentials()
                    }
                  }
                }
              }

              // Auto-refresh toggle + disclosure
              Column {
                width: parent.width
                spacing: Style.space(4)

                Row {
                  width: parent.width
                  spacing: Style.space(8)

                  PlainText {
                    width: parent.width - autoRefreshSwitch.implicitWidth - Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    text: strings.t("settings.autoRefreshLabel")
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.bodySmall
                    color: root.contentForeground
                    wrapMode: Text.Wrap
                  }

                  ToggleSwitch {
                    id: autoRefreshSwitch
                    checked: root.autoRefreshEnabled
                    foreground: root.contentForeground
                    accent: root.accentColor
                    onToggled: root.persistSettings({ autoRefreshEnabled: !root.autoRefreshEnabled })
                  }
                }

                PlainText {
                  width: parent.width
                  text: strings.t("settings.autoRefreshDisclosure")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.caption
                  color: root.dimForeground
                  wrapMode: Text.Wrap
                }
              }

              // Poll interval selector
              Row {
                width: parent.width
                spacing: Style.space(6)

                PlainText {
                  width: parent.width - pollButtonsRow.implicitWidth - Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter
                  text: strings.t("settings.pollIntervalLabel")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: root.contentForeground
                  elide: Text.ElideRight
                }

                Row {
                  id: pollButtonsRow
                  spacing: Style.space(4)

                  Repeater {
                    model: [1, 2, 5]
                    delegate: Button {
                      required property int modelData
                      text: strings.tn("settings.pollEveryMinutes", modelData).arg(Commons.I18n.formatNumber(modelData))
                      selected: root.pollIntervalMinutes === modelData
                      foreground: root.contentForeground
                      accent: root.accentColor
                      fontFamily: root.contentFontFamily
                      fontSize: Style.font.caption
                      bordered: true
                      onClicked: root.persistSettings({ pollIntervalMinutes: modelData })
                    }
                  }
                }
              }

              // Notify on status changes
              Row {
                width: parent.width
                spacing: Style.space(8)

                PlainText {
                  width: parent.width - notifyStageSwitch.implicitWidth - Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  text: strings.t("settings.notifyStageLabel")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: root.contentForeground
                }

                ToggleSwitch {
                  id: notifyStageSwitch
                  checked: root.notifyOnStageChange
                  foreground: root.contentForeground
                  accent: root.accentColor
                  onToggled: root.persistSettings({ notifyOnStageChange: !root.notifyOnStageChange })
                }
              }

              // Notify on ETA shifts
              Row {
                width: parent.width
                spacing: Style.space(8)

                PlainText {
                  width: parent.width - notifyEtaSwitch.implicitWidth - Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  text: strings.t("settings.notifyEtaLabel")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: root.contentForeground
                }

                ToggleSwitch {
                  id: notifyEtaSwitch
                  checked: root.notifyOnEtaChange
                  foreground: root.contentForeground
                  accent: root.accentColor
                  onToggled: root.persistSettings({ notifyOnEtaChange: !root.notifyOnEtaChange })
                }
              }

              // Order bell notification sound
              Row {
                width: parent.width
                spacing: Style.space(8)

                PlainText {
                  width: parent.width - soundSwitch.implicitWidth - soundTestBtn.implicitWidth - soundDeliveredTestBtn.implicitWidth - Style.space(24)
                  anchors.verticalCenter: parent.verticalCenter
                  text: strings.t("settings.soundLabel")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: root.contentForeground
                  elide: Text.ElideRight
                }

                PanelActionButton {
                  id: soundTestBtn
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: "\uf028"
                  tooltipText: strings.t("settings.soundTest")
                  foreground: root.contentForeground
                  hoverColor: root.glovoTeal
                  fontFamily: root.contentFontFamily
                  bordered: true
                  onClicked: if (orderHost && orderHost.testNotificationSound) orderHost.testNotificationSound("sequence")
                }

                PanelActionButton {
                  id: soundDeliveredTestBtn
                  anchors.verticalCenter: parent.verticalCenter
                  iconText: "\uf058"
                  tooltipText: strings.t("settings.soundDeliveredTest")
                  foreground: root.contentForeground
                  hoverColor: root.glovoTeal
                  fontFamily: root.contentFontFamily
                  bordered: true
                  onClicked: if (orderHost && orderHost.testNotificationSound) orderHost.testNotificationSound("delivered")
                }

                ToggleSwitch {
                  id: soundSwitch
                  checked: root.soundEnabled
                  foreground: root.contentForeground
                  accent: root.accentColor
                  onToggled: root.persistSettings({ soundEnabled: !root.soundEnabled })
                }
              }

              // Show ETA in bar
              Row {
                width: parent.width
                spacing: Style.space(8)

                PlainText {
                  width: parent.width - showEtaSwitch.implicitWidth - Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  text: strings.t("settings.showEtaInBarLabel")
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  color: root.contentForeground
                }

                ToggleSwitch {
                  id: showEtaSwitch
                  checked: root.showEtaInBar
                  foreground: root.contentForeground
                  accent: root.accentColor
                  onToggled: root.persistSettings({ showEtaInBar: !root.showEtaInBar })
                }
              }

              PanelSeparator { foreground: root.contentForeground; strength: 0.08 }

              Flow {
                width: parent.width
                spacing: Style.space(8)

                Button {
                  visible: !root.demoActive
                  text: strings.t("demo.start")
                  iconText: "\uf04b"
                  foreground: root.contentForeground
                  accent: root.accentColor
                  fontFamily: root.contentFontFamily
                  fontSize: Style.font.caption
                  bordered: true
                  onClicked: {
                    root.showSettings = false
                    if (orderHost && orderHost.startDemo) orderHost.startDemo()
                  }
                }

                Button {
                  visible: root.demoActive
                  text: strings.t("demo.nextStage")
                  iconText: "\uf051"
                  foreground: root.contentForeground
                  accent: root.accentColor
                  fontFamily: root.contentFontFamily
                  fontSize: Style.font.caption
                  bordered: true
                  selected: true
                  onClicked: if (orderHost && orderHost.nextDemoStep) orderHost.nextDemoStep()
                }

                Button {
                  visible: root.demoActive
                  text: strings.t("demo.stop")
                  iconText: "\uf04d"
                  foreground: root.contentForeground
                  accent: root.accentColor
                  fontFamily: root.contentFontFamily
                  fontSize: Style.font.caption
                  bordered: true
                  onClicked: if (orderHost && orderHost.stopDemo) orderHost.stopDemo()
                }
              }

              PlainText {
                width: parent.width
                text: strings.t("settings.localBridgeHint")
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                color: root.dimForeground
                wrapMode: Text.Wrap
              }
            }
          }
        }
      }
    }
  }
}
