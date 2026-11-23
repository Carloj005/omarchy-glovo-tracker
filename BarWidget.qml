import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "io.github.carloj005.glovo-tracker"

  Commons.Translations {
    id: strings
    directory: String(Qt.resolvedUrl("i18n")).replace(/^qs:\/\//, "file://")
  }

  // Settings from shell.json
  readonly property bool browserSyncEnabled: setting("browserSyncEnabled", false) === true
  readonly property int browserPollIntervalMinutes: Model.clampInt(setting("browserPollIntervalMinutes", 2), 2, 1, 30)
  readonly property bool autoRefreshEnabled: setting("autoRefreshEnabled", false) === true
  readonly property bool syncFromPhoneEnabled: setting("syncFromPhoneEnabled", true) !== false
  readonly property int pollIntervalMinutes: Model.clampInt(setting("pollIntervalMinutes", 2), 2, 1, 30)
  readonly property bool notifyOnStageChange: setting("notifyOnStageChange", true) !== false
  readonly property bool notifyOnEtaChange: setting("notifyOnEtaChange", true) !== false
  readonly property bool soundEnabled: setting("soundEnabled", true) !== false
  readonly property bool showEtaInBar: setting("showEtaInBar", true) !== false
  readonly property bool hideWhenIdle: setting("hideWhenIdle", false) === true
  readonly property string configuredOrderId: Model.sanitizeOrderId(setting("orderId", ""))

  // Paths under ~/.local/state/omarchy/glovo-tracker/ and fluxd socket
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy/glovo-tracker"
  readonly property string orderFilePath: stateDir + "/order.json"
  readonly property string authFilePath: stateDir + "/auth.json"
  readonly property string sessionFilePath: stateDir + "/session.json"
  readonly property string sessionScriptPath: String(Qt.resolvedUrl("bin/glovo-session.cjs")).replace(/^(?:qs|file):\/\//, "")
  readonly property string fluxSocketPath: {
    var override = Quickshell.env("FLUX_SOCKET") || ""
    if (override !== "") return override
    var runtime = Quickshell.env("XDG_RUNTIME_DIR") || ""
    if (runtime !== "") return runtime + "/flux/fluxd.sock"
    var m = /^Uid:\s+(\d+)/m.exec(procStatus.text())
    return m ? ("/run/user/" + m[1] + "/flux/fluxd.sock") : ""
  }
  readonly property int maxFluxLine: 262144

  // Order and sync state
  property var currentOrder: Model.emptyOrder()
  property var authState: ({ token: "", orderId: "" })
  property var sessionState: Model.parseSessionFile("")
  property bool demoActive: false
  property int demoStep: 1
  property bool fetching: false
  property bool browserSyncing: false
  property bool loginInProgress: false
  property bool logoutInProgress: false
  property bool startupSyncChecked: false
  property string lastError: ""
  property bool fluxConnected: false
  property var fluxSocket: null
  property int fluxRetryDelay: 3000

  readonly property string effectiveToken: authState.token || ""
  readonly property bool hasAuthToken: effectiveToken !== ""
  readonly property string effectiveOrderId: configuredOrderId !== "" ? configuredOrderId : (authState.orderId || "")
  readonly property bool hasActiveOrder: currentOrder && currentOrder.hasOrder && Model.isActiveStage(currentOrder.stage)

  function tFn(key, fallback) { return strings.t(key, fallback) }
  function tnFn(key, count, fallback) { return strings.tn(key, count, fallback) }
  function fmtFn(val, decimals) { return Commons.I18n.formatNumber(val, decimals) }

  // Bar label and tooltip (every dynamic sink neutralized)
  readonly property string barLabel: {
    var _lang = Commons.I18n.language
    var _catalog = strings.strings
    return Model.buildBarLabel(
      root.currentOrder,
      root.showEtaInBar,
      root.fmtFn,
      root.tFn,
      root.tnFn
    )
  }
  readonly property string barTooltip: {
    var _lang = Commons.I18n.language
    var _catalog = strings.strings
    return Model.buildBarTooltip(
      root.currentOrder,
      root.fmtFn,
      root.tFn,
      root.tnFn,
      root.sessionState
    )
  }

  Connections {
    target: strings
    function onStringsChanged() {
      if (root.demoActive) {
        var stamp = root.currentOrder && root.currentOrder.updatedAtMs ? root.currentOrder.updatedAtMs : Date.now()
        root.currentOrder = Model.createDemoOrder(root.demoStep, stamp, root.tFn)
      }
    }
  }

  visible: !hideWhenIdle || (currentOrder && currentOrder.hasOrder) || demoActive || opened
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Contract for shell.summon / hide / toggle and Bar panel routing
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function openFromHotkey() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
    else open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item && panelLoader.item.closeForPopoutSwitch) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("currentOrder" in target) target.currentOrder = root.currentOrder
    if ("demoActive" in target) target.demoActive = root.demoActive
    if ("fetching" in target) target.fetching = root.fetching
    if ("browserSyncing" in target) target.browserSyncing = root.browserSyncing
    if ("loginInProgress" in target) target.loginInProgress = root.loginInProgress
    if ("logoutInProgress" in target) target.logoutInProgress = root.logoutInProgress
    if ("sessionState" in target) target.sessionState = root.sessionState
    if ("lastError" in target) target.lastError = root.lastError
    if ("hasAuthToken" in target) target.hasAuthToken = root.hasAuthToken
    if ("fluxConnected" in target) target.fluxConnected = root.fluxConnected
  }

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  onCurrentOrderChanged: if (panelLoader.item && "currentOrder" in panelLoader.item) panelLoader.item.currentOrder = root.currentOrder
  onDemoActiveChanged: if (panelLoader.item && "demoActive" in panelLoader.item) panelLoader.item.demoActive = root.demoActive
  onFetchingChanged: if (panelLoader.item && "fetching" in panelLoader.item) panelLoader.item.fetching = root.fetching
  onBrowserSyncingChanged: if (panelLoader.item && "browserSyncing" in panelLoader.item) panelLoader.item.browserSyncing = root.browserSyncing
  onLoginInProgressChanged: if (panelLoader.item && "loginInProgress" in panelLoader.item) panelLoader.item.loginInProgress = root.loginInProgress
  onLogoutInProgressChanged: if (panelLoader.item && "logoutInProgress" in panelLoader.item) panelLoader.item.logoutInProgress = root.logoutInProgress
  onSessionStateChanged: if (panelLoader.item && "sessionState" in panelLoader.item) panelLoader.item.sessionState = root.sessionState
  onLastErrorChanged: if (panelLoader.item && "lastError" in panelLoader.item) panelLoader.item.lastError = root.lastError
  onHasAuthTokenChanged: if (panelLoader.item && "hasAuthToken" in panelLoader.item) panelLoader.item.hasAuthToken = root.hasAuthToken
  onFluxConnectedChanged: if (panelLoader.item && "fluxConnected" in panelLoader.item) panelLoader.item.fluxConnected = root.fluxConnected

  onSyncFromPhoneEnabledChanged: {
    if (syncFromPhoneEnabled) connectFlux()
    else disconnectFlux()
  }

  function applyOrderUpdate(nextOrder, forceNotify) {
    if (!nextOrder) return
    var prev = root.currentOrder
    root.currentOrder = nextOrder
    root.lastError = ""

    var payload = Model.buildNotificationPayload(
      prev,
      nextOrder,
      {
        force: !!forceNotify,
        notifyOnStageChange: root.notifyOnStageChange,
        notifyOnEtaChange: root.notifyOnEtaChange
      },
      root.fmtFn,
      root.tFn,
      root.tnFn
    )
    if (payload.shouldNotify) {
      sendDesktopNotification(payload)
    }
  }

  property int soundPreviewIndex: 0
  readonly property var soundPreviewStages: ["confirmed", "preparing", "pickup", "delivering", "arriving", "delivered"]

  Timer {
    id: soundPreviewTimer
    interval: 740
    repeat: true
    onTriggered: {
      if (root.soundPreviewIndex >= root.soundPreviewStages.length) {
        soundPreviewTimer.stop()
        return
      }
      var st = root.soundPreviewStages[root.soundPreviewIndex]
      root.soundPreviewIndex += 1
      root.playNotificationSound(Model.soundAssetForStage(st))
    }
  }

  function playNotificationSound(assetRelPath) {
    var allowedAssets = {
      "assets/stage-confirmed.oga": true,
      "assets/stage-preparing.oga": true,
      "assets/stage-pickup.oga": true,
      "assets/stage-delivering.oga": true,
      "assets/stage-arriving.oga": true,
      "assets/stage-delivered.oga": true,
      "assets/stage-cancelled.oga": true
    }
    var allowed = allowedAssets[assetRelPath] ? assetRelPath : "assets/stage-confirmed.oga"
    var fullPath = String(Qt.resolvedUrl(allowed)).replace(/^(?:qs|file):\/\//, "")
    if (fullPath !== "") {
      Quickshell.execDetached(["paplay", fullPath])
    }
  }

  function testNotificationSound(kind) {
    soundPreviewTimer.stop()
    if (!kind || kind === "sequence") {
      root.soundPreviewIndex = 1
      playNotificationSound(Model.soundAssetForStage(root.soundPreviewStages[0]))
      soundPreviewTimer.start()
      return
    }
    playNotificationSound(Model.soundAssetForStage(String(kind)))
  }

  function sendDesktopNotification(payload) {
    if (!payload || !payload.shouldNotify) return
    Quickshell.execDetached([
      "omarchy-notification-send",
      "--app-name", "Glovo Tracker",
      "-g", String(payload.glyph || Model.stageIcon("idle")),
      "-u", String(payload.urgency || "low"),
      String(payload.headline || "Glovo Tracker"),
      String(payload.body || "")
    ])
    if (root.soundEnabled) {
      playNotificationSound(payload.soundAsset)
    }
  }

  function notifyCurrentStatus() {
    if (!root.currentOrder || !root.currentOrder.hasOrder) {
      Quickshell.execDetached([
        "omarchy-notification-send",
        "--app-name", "Glovo Tracker",
        "-g", Model.stageIcon("idle"),
        "-u", "low",
        Model.neutralizeMarkup(strings.t("plugin.title"), 80),
        Model.neutralizeMarkup(strings.t("stage.idle"), 120)
      ])
      return
    }
    var payload = Model.buildNotificationPayload(
      null,
      root.currentOrder,
      { force: true },
      root.fmtFn,
      root.tFn,
      root.tnFn
    )
    sendDesktopNotification(payload)
  }

  function currentLangCode() {
    var lang = String(Commons.I18n.language || "it").split("-")[0].toLowerCase()
    return /^[a-z]{2,3}$/.test(lang) ? lang : "it"
  }

  function loginBrowser() {
    if (loginProc.running || root.loginInProgress || root.logoutInProgress) return
    root.lastError = ""
    root.loginInProgress = true
    loginProc.command = ["node", root.sessionScriptPath, "login", root.currentLangCode()]
    loginProc.running = true
  }

  function syncBrowserSession() {
    if (browserSyncProc.running || root.browserSyncing || root.loginInProgress || root.logoutInProgress) return
    root.lastError = ""
    root.browserSyncing = true
    browserSyncProc.command = ["node", root.sessionScriptPath, "sync", root.currentLangCode()]
    browserSyncProc.running = true
  }

  function logoutBrowser() {
    if (logoutProc.running || root.logoutInProgress) return
    root.lastError = ""
    root.logoutInProgress = true
    startupSyncTimer.stop()
    if (browserSyncProc.running) {
      browserSyncProc.running = false
      root.browserSyncing = false
    }
    if (loginProc.running) {
      loginProc.running = false
      root.loginInProgress = false
    }
    if (apiProc.running) {
      apiProc.running = false
      root.fetching = false
    }
    logoutProc.command = ["node", root.sessionScriptPath, "logout", root.currentLangCode()]
    logoutProc.running = true
  }

  function refresh() {
    if (root.logoutInProgress) return
    authFile.reload()
    sessionFile.reload()
    if (root.demoActive) {
      var order = Model.createDemoOrder(root.demoStep, Date.now(), root.tFn)
      applyOrderUpdate(order, false)
      return
    }
    if (root.sessionState && root.sessionState.loggedIn && (root.browserSyncEnabled || !root.hasAuthToken)) {
      syncBrowserSession()
      return
    }
    if (root.hasAuthToken) {
      fetchFromGlovoApi(false)
    } else {
      orderFile.reload()
      if (root.syncFromPhoneEnabled && !root.fluxConnected) connectFlux()
    }
  }

  function fetchFromGlovoApi(useWhatsUpFallback) {
    if (!root.hasAuthToken || root.fetching || root.logoutInProgress) return
    var tryingFallback = (useWhatsUpFallback === true)
    var lang = root.currentLangCode()
    apiProc.usingWhatsUpFallback = tryingFallback
    apiProc.canFallbackToWhatsUp = (!tryingFallback && root.effectiveOrderId === "")
    root.fetching = true
    root.lastError = ""
    apiProc.command = [
      "node",
      root.sessionScriptPath,
      "fetch-api",
      lang,
      tryingFallback ? "whatsup" : "active",
      root.effectiveOrderId
    ]
    apiProc.running = true
  }

  function startDemo() {
    root.demoActive = true
    root.demoStep = 1
    root.lastError = ""
    var order = Model.createDemoOrder(1, Date.now(), root.tFn)
    applyOrderUpdate(order, true)
  }

  function nextDemoStep() {
    if (!root.demoActive) {
      startDemo()
      return
    }
    var nextStep = (root.demoStep + 1) % 6
    root.demoStep = nextStep
    var order = Model.createDemoOrder(nextStep, Date.now(), root.tFn)
    applyOrderUpdate(order, false)
  }

  function stopDemo() {
    root.demoActive = false
    root.demoStep = 1
    root.lastError = ""
    root.currentOrder = Model.emptyOrder()
    orderFile.reload()
  }

  function saveCredentials(orderIdInput, tokenInput) {
    var cleanOrderId = Model.sanitizeOrderId(orderIdInput)
    var cleanToken = Model.sanitizeToken(tokenInput)
    var proc = saveAuthComponent.createObject(root, {
      payload: JSON.stringify({ token: cleanToken, orderId: cleanOrderId })
    })
    if (proc) proc.running = true
  }

  function clearCredentials() {
    saveCredentials("", "")
  }

  // ---- Flux local phone notification sync ($XDG_RUNTIME_DIR/flux/fluxd.sock)
  function connectFlux() {
    if (!root.syncFromPhoneEnabled || root.fluxSocketPath === "") return
    if (fluxSocket && fluxSocket.connected) return
    if (fluxSocket) {
      fluxSocket.destroy()
      fluxSocket = null
    }
    fluxSocket = fluxSocketComponent.createObject(root)
    if (fluxSocket) fluxSocket.connected = true
  }

  function disconnectFlux() {
    root.fluxConnected = false
    if (fluxSocket) {
      fluxSocket.destroy()
      fluxSocket = null
    }
  }

  function handleFluxLine(line) {
    if (!line || line.length === 0 || line.length > root.maxFluxLine) return
    var msg
    try { msg = JSON.parse(line) } catch (e) { return }
    if (!msg || msg.event !== "state" || !msg.data) return
    if (root.demoActive) return
    if (root.currentOrder && root.currentOrder.hasOrder && (root.currentOrder.source === "api" || root.currentOrder.source === "file")) {
      return
    }
    var phoneOrder = Model.parseFluxStateForGlovo(msg.data, Date.now())
    if (phoneOrder) {
      root.applyOrderUpdate(phoneOrder, false)
    }
  }

  FileView {
    id: procStatus
    path: "/proc/self/status"
    blockAllReads: true
    printErrors: false
  }

  Component {
    id: fluxSocketComponent
    Socket {
      id: sock
      path: root.fluxSocketPath
      parser: SplitParser {
        onRead: function(data) { root.handleFluxLine(data) }
      }
      onConnectedChanged: {
        if (sock !== root.fluxSocket) return
        root.fluxConnected = connected
        if (connected) {
          root.fluxRetryDelay = 3000
          sock.write(JSON.stringify({ id: 1, method: "subscribe", params: {} }) + "\n")
          sock.flush()
        } else {
          root.fluxRetryDelay = Math.min(root.fluxRetryDelay * 2, 60000)
        }
      }
      onError: {
        if (sock !== root.fluxSocket) return
        root.fluxConnected = false
        root.fluxRetryDelay = Math.min(root.fluxRetryDelay * 2, 60000)
      }
    }
  }

  Timer {
    id: fluxReconnectTimer
    interval: root.fluxRetryDelay
    repeat: true
    running: root.syncFromPhoneEnabled && !root.fluxConnected && root.fluxSocketPath !== ""
    onTriggered: root.connectFlux()
  }

  function maybeScheduleStartupSync() {
    if (root.startupSyncChecked) return
    if (!root.browserSyncEnabled || !root.sessionState || !root.sessionState.loggedIn) return
    root.startupSyncChecked = true
    if (!root.sessionState.tokenExpMs || root.sessionState.tokenExpMs <= Date.now() + 60000) {
      startupSyncTimer.restart()
    }
  }

  Component.onCompleted: {
    if (root.syncFromPhoneEnabled) connectFlux()
    Qt.callLater(root.maybeScheduleStartupSync)
  }
  Component.onDestruction: disconnectFlux()

  // Watch local bridge order file (~/.local/state/omarchy/glovo-tracker/order.json)
  FileView {
    id: orderFile
    path: root.orderFilePath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      if (root.demoActive) return
      var raw = text()
      var parsed = Model.parseGlovoResponse(raw, Date.now())
      if (parsed) {
        if (!parsed.hasOrder && root.currentOrder && root.currentOrder.source === "flux") {
          return
        }
        if (parsed.hasOrder) {
          try {
            var rawObj = JSON.parse(raw)
            parsed.source = (rawObj && typeof rawObj.source === "string") ? rawObj.source : "file"
          } catch (e) {
            parsed.source = "file"
          }
        }
        root.applyOrderUpdate(parsed, false)
      }
    }
  }

  // Watch dedicated browser session file (~/.local/state/omarchy/glovo-tracker/session.json)
  FileView {
    id: sessionFile
    path: root.sessionFilePath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.sessionState = Model.parseSessionFile(text())
      root.maybeScheduleStartupSync()
    }
    onLoadFailed: root.sessionState = Model.parseSessionFile("")
  }

  // Watch local auth file (~/.local/state/omarchy/glovo-tracker/auth.json)
  FileView {
    id: authFile
    path: root.authFilePath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.authState = Model.parseAuthFile(text())
    onLoadFailed: root.authState = ({ token: "", orderId: "" })
  }

  // Dedicated browser session processes
  Process {
    id: loginProc
    onExited: function(exitCode) {
      root.loginInProgress = false
      sessionFile.reload()
      authFile.reload()
      orderFile.reload()
      if (!root.logoutInProgress && exitCode !== 0) {
        root.lastError = "Login exited (" + exitCode + ")"
      }
    }
  }

  Process {
    id: browserSyncProc
    onExited: function(exitCode) {
      root.browserSyncing = false
      sessionFile.reload()
      authFile.reload()
      orderFile.reload()
      if (!root.logoutInProgress && exitCode !== 0) {
        root.lastError = "Browser sync (" + exitCode + ")"
      }
    }
  }

  Process {
    id: logoutProc
    onExited: function(exitCode) {
      root.logoutInProgress = false
      sessionFile.reload()
      authFile.reload()
      orderFile.reload()
      if (exitCode !== 0) {
        root.lastError = "Logout failed (" + exitCode + ")"
        return
      }
      root.authState = ({ token: "", orderId: "" })
      root.sessionState = Model.parseSessionFile("")
      if (root.currentOrder && (root.currentOrder.source === "browser" || root.currentOrder.source === "api")) {
        root.currentOrder = Model.emptyOrder()
      }
      if ((root.browserSyncEnabled || root.autoRefreshEnabled) && panelLoader.item && panelLoader.item.persistSettings) {
        panelLoader.item.persistSettings({
          browserSyncEnabled: false,
          autoRefreshEnabled: false
        })
      }
      root.lastError = ""
    }
  }

  // Save credentials safely via stdin (never passes token in process argv)
  Component {
    id: saveAuthComponent
    Process {
      property string payload: ""
      command: ["node", root.sessionScriptPath, "save-auth"]
      stdinEnabled: true
      onStarted: {
        write(payload)
        stdinEnabled = false
      }
      onExited: function(exitCode) {
        if (exitCode === 0) {
          authFile.reload()
          if (root.hasAuthToken && !root.demoActive) root.fetchFromGlovoApi(false)
        }
        destroy()
      }
    }
  }

  // Query fixed HTTPS Glovo API endpoint with timeout and response-size limits
  Process {
    id: apiProc
    property bool usingWhatsUpFallback: false
    property bool canFallbackToWhatsUp: false
    stdout: StdioCollector {
      id: apiStdout
      onStreamFinished: {
        root.fetching = false
        if (root.logoutInProgress || !root.hasAuthToken) return
        var raw = String(apiStdout.text || "")
        var parsed = Model.parseGlovoResponse(raw, Date.now())
        if (parsed) {
          if (parsed.hasOrder) parsed.source = "api"
          root.applyOrderUpdate(parsed, false)
        } else if (raw.replace(/^\s+|\s+$/g, "") !== "" || !apiProc.canFallbackToWhatsUp) {
          root.lastError = "Invalid API response"
        }
      }
    }
    onExited: function(exitCode) {
      root.fetching = false
      if (root.logoutInProgress) return
      if (exitCode !== 0) {
        if (apiProc.canFallbackToWhatsUp) {
          apiProc.canFallbackToWhatsUp = false
          Qt.callLater(function() { root.fetchFromGlovoApi(true) })
        } else {
          root.lastError = "HTTP " + exitCode
        }
      }
    }
  }

  // Refresh expired JWT shortly after shell startup/reboot
  Timer {
    id: startupSyncTimer
    interval: 3000
    repeat: false
    onTriggered: {
      if (root.browserSyncEnabled && root.sessionState && root.sessionState.loggedIn && !root.demoActive && !root.logoutInProgress) {
        root.syncBrowserSession()
      }
    }
  }

  // Explicit opt-in dedicated browser session polling timer
  Timer {
    id: browserSyncTimer
    interval: root.browserPollIntervalMinutes * 60000
    repeat: true
    running: root.browserSyncEnabled && root.sessionState && root.sessionState.loggedIn && !root.demoActive && !root.loginInProgress && !root.logoutInProgress
    onTriggered: root.syncBrowserSession()
  }

  // Explicit opt-in background polling timer
  Timer {
    id: pollTimer
    interval: root.pollIntervalMinutes * 60000
    repeat: true
    running: root.autoRefreshEnabled && root.hasAuthToken && !root.demoActive && !root.logoutInProgress && !(root.browserSyncEnabled && root.sessionState && root.sessionState.loggedIn)
    onTriggered: root.fetchFromGlovoApi(false)
  }

  // Update elapsed time each minute while an order is active
  Timer {
    id: elapsedTimer
    interval: 60000
    repeat: true
    running: root.hasActiveOrder && !root.demoActive
    onTriggered: {
      if (!root.currentOrder || !root.currentOrder.hasOrder) return
      if (root.currentOrder.startedAtMs > 0) {
        var copy = Object.assign({}, root.currentOrder)
        copy.elapsedMinutes = Model.clampInt(Math.floor((Date.now() - copy.startedAtMs) / 60000), copy.elapsedMinutes, 0, 1440)
        root.currentOrder = copy
      }
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: String(Qt.resolvedUrl("Panel.qml")).replace(/^qs:\/\//, "file://")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  ShellIpc {
    target: "io.github.carloj005.glovo-tracker"
    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function refresh(): string { root.refresh(); return "ok" }
    function login(): string { root.loginBrowser(); return "login_started" }
    function sync(): string { root.syncBrowserSession(); return "sync_started" }
    function logout(): string { root.logoutBrowser(); return "logout_started" }
    function startDemo(): string { root.startDemo(); return "demo_started" }
    function nextDemoStep(): string { root.nextDemoStep(); return root.currentOrder ? root.currentOrder.stage : "idle" }
    function stopDemo(): string { root.stopDemo(); return "demo_stopped" }
    function notifyStatus(): string { root.notifyCurrentStatus(); return "ok" }
    function testSound(kind: string): string { root.testNotificationSound(kind); return "ok" }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barLabel
    hasVisualContent: true
    active: root.hasActiveOrder
    activeColor: Commons.Color.accent
    horizontalMargin: 8.5
    verticalPadding: 6
    tooltipText: root.barTooltip

    onPressed: function(b) {
      if (b === Qt.RightButton) {
        root.notifyCurrentStatus()
      } else if (b === Qt.MiddleButton) {
        if (root.demoActive) root.nextDemoStep()
        else root.refresh()
      } else {
        root.togglePanel()
      }
    }
  }
}
