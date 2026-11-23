var MAX_RESPONSE_BYTES = 65536
var MAX_STRING_LEN = 120
var MAX_ID_LEN = 64
var MAX_ITEMS = 20
var MAX_ETA_MINUTES = 240
var MIN_TIMESTAMP_MS = 1577836800000
var MAX_TIMESTAMP_MS = 4102444800000

var STAGES = [
  "idle",
  "confirmed",
  "preparing",
  "pickup",
  "delivering",
  "arriving",
  "delivered",
  "cancelled"
]

var ACTIVE_PROGRESS_STAGES = [
  "confirmed",
  "preparing",
  "pickup",
  "delivering",
  "arriving",
  "delivered"
]

var NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " "
}

function clampInt(value, fallback, min, max) {
  var n = parseInt(String(value === undefined || value === null ? "" : value), 10)
  if (!isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function clampFloat(value, fallback, min, max) {
  var n = parseFloat(String(value === undefined || value === null ? "" : value))
  if (!isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function clampTimestampMs(value, fallback) {
  var fb = (typeof fallback === "number" && isFinite(fallback)) ? Math.round(fallback) : 0
  if (value === undefined || value === null || value === "") return fb
  var ms = NaN
  if (typeof value === "number") {
    ms = value < 100000000000 ? value * 1000 : value
  } else {
    var raw = String(value).replace(/^\s+|\s+$/g, "")
    if (/^\d+$/.test(raw)) {
      var num = parseInt(raw, 10)
      ms = num < 100000000000 ? num * 1000 : num
    } else {
      ms = Date.parse(raw)
    }
  }
  if (!isFinite(ms) || ms < MIN_TIMESTAMP_MS || ms > MAX_TIMESTAMP_MS) return fb
  return Math.round(ms)
}

function decodeHtmlEntitiesOnce(text) {
  return String(text || "")
    .replace(/&#(\d{1,7});?/g, function(_, num) {
      var code = parseInt(num, 10)
      if (code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code) } catch (e) { return " " }
      }
      return " "
    })
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, function(_, hex) {
      var code = parseInt(hex, 16)
      if (code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code) } catch (e) { return " " }
      }
      return " "
    })
    .replace(/&([a-zA-Z]+);/g, function(whole, name) {
      var mapped = NAMED_ENTITIES[String(name).toLowerCase()]
      return mapped !== undefined ? mapped : whole
    })
}

// Neutralize HTML/QML markup, entity-encoded tags, clickable URLs, control chars,
// and leading option-like dashes while keeping literal ampersands such as "Fresh&Fast".
function neutralizeMarkup(raw, maxLen) {
  if (raw === undefined || raw === null) return ""
  var limit = clampInt(maxLen, MAX_STRING_LEN, 1, 512)
  var s = String(raw).slice(0, limit * 4)

  s = s.replace(/<\s*\/?[a-zA-Z!_?][^>]*>/g, " ")
  s = s.replace(/<[^>]*>/g, " ")

  for (var pass = 0; pass < 5; pass++) {
    var decoded = decodeHtmlEntitiesOnce(s)
    if (decoded === s) break
    s = decoded
  }

  s = s.replace(/<\s*\/?[a-zA-Z!_?][^>]*>/g, " ")
  s = s.replace(/<[^>]*>/g, " ")
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ")
  s = s.replace(/\b(?:https?|ftp|file|javascript|data|mailto|tel):(?:\/\/)?[^\s<>"'`]*/gi, " ")
  s = s.replace(/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, " ")
  s = s.replace(/[<>"'`]/g, " ")
  s = s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "")
  s = s.replace(/^-+/, "").replace(/^\s+|\s+$/g, "")

  if (s.length > limit) s = s.slice(0, limit).replace(/\s+$/g, "")
  return s
}

function sanitizeOrderId(raw) {
  if (raw === undefined || raw === null) return ""
  var trimmed = String(raw).replace(/^\s+|\s+$/g, "")
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return ""
  return trimmed.slice(0, MAX_ID_LEN)
}

function sanitizeToken(raw) {
  if (raw === undefined || raw === null) return ""
  var s = String(raw).replace(/[\u0000-\u001f\u007f"'`<>\\]/g, "").replace(/^\s+|\s+$/g, "")
  if (s.toLowerCase().indexOf("bearer ") === 0) s = s.slice(7).replace(/^\s+|\s+$/g, "")
  if (s.length > 1024) s = s.slice(0, 1024)
  return s
}

function buildGlovoApiUrl(orderId) {
  var cleanId = sanitizeOrderId(orderId)
  if (cleanId !== "") return "https://api.glovoapp.com/v3/customer/orders/" + encodeURIComponent(cleanId)
  return "https://api.glovoapp.com/v3/customer/orders-active"
}

function buildGlovoWhatsUpUrl() {
  return "https://api.glovoapp.com/v3/whats_up?fields=statusMessage"
}

function padTwo(n) {
  var v = clampInt(n, 0, 0, 99)
  return v < 10 ? ("0" + v) : String(v)
}

function formatClockHHMM(ms) {
  var d = new Date(ms)
  if (isNaN(d.getTime())) return ""
  return padTwo(d.getHours()) + ":" + padTwo(d.getMinutes())
}

function sanitizeTimeHHMM(raw) {
  var s = String(raw || "").replace(/^\s+|\s+$/g, "")
  var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s)
  if (!m) return ""
  return padTwo(parseInt(m[1], 10)) + ":" + m[2]
}

function computeEtaWindow(refNowMs, etaMinutes, explicitStart, explicitEnd) {
  var startClean = sanitizeTimeHHMM(explicitStart)
  var endClean = sanitizeTimeHHMM(explicitEnd)
  if (startClean !== "" && endClean !== "") {
    return { start: startClean, end: endClean }
  }
  var eta = clampInt(etaMinutes, 0, 0, MAX_ETA_MINUTES)
  if (eta <= 0) return { start: "", end: "" }
  var lowOffset = Math.max(1, eta - 5)
  var highOffset = eta + 5
  return {
    start: formatClockHHMM(refNowMs + lowOffset * 60000),
    end: formatClockHHMM(refNowMs + highOffset * 60000)
  }
}

function defaultProgressForStage(stage) {
  switch (stage) {
    case "confirmed": return 0.15
    case "preparing": return 0.35
    case "pickup": return 0.56
    case "delivering": return 0.78
    case "arriving": return 0.92
    case "delivered": return 1.0
    case "cancelled": return 0.0
    default: return 0.0
  }
}

function normalizeTimeliness(raw) {
  var key = String(raw || "").replace(/^\s+|\s+$/g, "").toLowerCase()
  if (key === "early" || key === "in_anticipo" || key === "in anticipo") return "early"
  if (key === "delayed" || key === "late" || key === "in_ritardo" || key === "in ritardo") return "delayed"
  return "ontime"
}

function emptyOrder() {
  return {
    hasOrder: false,
    orderId: "",
    stage: "idle",
    timeliness: "ontime",
    progressRatio: 0.0,
    storeName: "",
    storeMessage: "",
    courierName: "",
    courierMessage: "",
    bannerMessage: "",
    vehicle: "",
    address: "",
    trackingCode: "",
    etaMinutes: 0,
    etaWindowStart: "",
    etaWindowEnd: "",
    elapsedMinutes: 0,
    startedAtMs: 0,
    updatedAtMs: 0,
    source: "none",
    items: []
  }
}

function normalizeStage(rawStage, etaMinutes) {
  var key = String(rawStage || "").replace(/^\s+|\s+$/g, "").toUpperCase().replace(/[\s-]+/g, "_")
  var stage = "idle"
  if (key === "IDLE" || key === "NONE" || key === "") stage = "idle"
  else if (key === "CREATED" || key === "ACCEPTED" || key === "CONFIRMED" || key === "SCHEDULED" || key === "RECEIVED") stage = "confirmed"
  else if (key === "PREPARING" || key === "IN_KITCHEN" || key === "COOKING") stage = "preparing"
  else if (key === "WAITING_FOR_PICKUP" || key === "PICKUP" || key === "PICKING_UP" || key === "COURIER_AT_STORE" || key === "PICKED_UP") stage = "pickup"
  else if (key === "IN_PROGRESS" || key === "DELIVERING" || key === "OUT_FOR_DELIVERY" || key === "ON_THE_WAY" || key === "EN_ROUTE") stage = "delivering"
  else if (key === "NEAR_DROP_OFF" || key === "ARRIVING" || key === "ALMOST_THERE") stage = "arriving"
  else if (key === "DELIVERED" || key === "COMPLETED" || key === "FINISHED") stage = "delivered"
  else if (key === "CANCELLED" || key === "CANCELED" || key === "FAILED" || key === "REJECTED") stage = "cancelled"
  else stage = "confirmed"

  var eta = clampInt(etaMinutes, 0, 0, MAX_ETA_MINUTES)
  if (stage === "delivering" && eta > 0 && eta <= 3) stage = "arriving"
  return stage
}

function isActiveStage(stage) {
  return stage === "confirmed" || stage === "preparing" || stage === "pickup" || stage === "delivering" || stage === "arriving"
}

function stageStepIndex(stage) {
  if (stage === "confirmed") return 0
  if (stage === "preparing") return 1
  if (stage === "pickup") return 2
  if (stage === "delivering" || stage === "arriving") return 3
  if (stage === "delivered") return 4
  return -1
}

function riderRoutePosition(stage) {
  switch (stage) {
    case "confirmed": return 0.08
    case "preparing": return 0.18
    case "pickup": return 0.25
    case "delivering": return 0.62
    case "arriving": return 0.88
    case "delivered": return 1.0
    default: return 0.0
  }
}

function pickOrderObject(parsed) {
  if (!parsed || typeof parsed !== "object") return null
  if (Array.isArray(parsed)) return parsed.length > 0 && typeof parsed[0] === "object" ? parsed[0] : null
  if (Array.isArray(parsed.orders)) return parsed.orders.length > 0 ? parsed.orders[0] : null
  if (Array.isArray(parsed.data)) return parsed.data.length > 0 ? parsed.data[0] : null
  if (parsed.order && typeof parsed.order === "object" && !Array.isArray(parsed.order)) return parsed.order
  if (parsed.statusMessage && typeof parsed.statusMessage === "object" && !Array.isArray(parsed.statusMessage)) return parsed.statusMessage
  return parsed
}

function extractEtaMinutes(obj, nowMs) {
  if (!obj || typeof obj !== "object") return 0
  var candidates = [
    obj.etaMinutes,
    obj.eta_minutes,
    obj.estimatedDeliveryMinutes,
    obj.remainingMinutes
  ]
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] !== undefined && candidates[i] !== null && candidates[i] !== "") {
      return clampInt(candidates[i], 0, 0, MAX_ETA_MINUTES)
    }
  }
  var etaSeconds = obj.etaSeconds !== undefined ? obj.etaSeconds : obj.estimatedTimeSeconds
  if (etaSeconds !== undefined && etaSeconds !== null && etaSeconds !== "") {
    var sec = clampInt(etaSeconds, 0, 0, MAX_ETA_MINUTES * 60)
    return Math.ceil(sec / 60)
  }
  var etaTimestamp = obj.etaAt || obj.estimatedDeliveryAt || obj.estimatedDeliveryTime
  if (etaTimestamp !== undefined && etaTimestamp !== null && etaTimestamp !== "") {
    var targetMs = clampTimestampMs(etaTimestamp, 0)
    if (targetMs > 0) {
      var refMs = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now()
      var diffMin = Math.ceil((targetMs - refMs) / 60000)
      return clampInt(diffMin, 0, 0, MAX_ETA_MINUTES)
    }
  }
  if (obj.eta && typeof obj.eta === "object") {
    if (obj.eta.minutes !== undefined) return clampInt(obj.eta.minutes, 0, 0, MAX_ETA_MINUTES)
    if (obj.eta.maxMinutes !== undefined) return clampInt(obj.eta.maxMinutes, 0, 0, MAX_ETA_MINUTES)
  }
  return 0
}

function parseOrderItems(rawItems) {
  if (!Array.isArray(rawItems)) return []
  var out = []
  var count = Math.min(rawItems.length, MAX_ITEMS)
  for (var i = 0; i < count; i++) {
    var entry = rawItems[i]
    if (!entry) continue
    if (typeof entry === "string") {
      var plainName = neutralizeMarkup(entry, 80)
      if (plainName !== "") out.push({ name: plainName, quantity: 1 })
    } else if (typeof entry === "object") {
      var itemName = neutralizeMarkup(entry.name || entry.title || entry.productName || "", 80)
      if (itemName === "") continue
      var qty = clampInt(entry.quantity !== undefined ? entry.quantity : entry.qty, 1, 1, 99)
      out.push({ name: itemName, quantity: qty })
    }
  }
  return out
}

function parseGlovoResponse(rawText, nowMs) {
  if (rawText === undefined || rawText === null) return null
  var text = String(rawText)
  if (text.replace(/^\s+|\s+$/g, "") === "") return null
  if (text.length > MAX_RESPONSE_BYTES) return null

  var parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }

  if (Array.isArray(parsed) && parsed.length === 0) return emptyOrder()
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.orders) && parsed.orders.length === 0) return emptyOrder()
    if (Array.isArray(parsed.data) && parsed.data.length === 0) return emptyOrder()
    if (Object.prototype.hasOwnProperty.call(parsed, "statusMessage") && (parsed.statusMessage === null || parsed.statusMessage === "")) {
      return emptyOrder()
    }
  }

  var obj = pickOrderObject(parsed)
  if (!obj || typeof obj !== "object") return null

  var refNow = clampTimestampMs(nowMs, Date.now())
  var rawStatus = obj.stage !== undefined ? obj.stage : (obj.status !== undefined ? obj.status : obj.state)
  if ((rawStatus === undefined || rawStatus === null || String(rawStatus).replace(/^\s+|\s+$/g, "") === "")
      && typeof parsed.statusMessage === "string" && parsed.statusMessage.replace(/^\s+|\s+$/g, "") !== "") {
    rawStatus = inferStageFromPhoneText(parsed.statusMessage.toLowerCase())
  }
  if (rawStatus === undefined || rawStatus === null || String(rawStatus).replace(/^\s+|\s+$/g, "") === "") {
    if (obj.hasOrder === false) return emptyOrder()
    return null
  }

  var etaMinutes = extractEtaMinutes(obj, refNow)
  var stage = normalizeStage(rawStatus, etaMinutes)
  if (stage === "idle") return emptyOrder()
  if (stage === "delivered" || stage === "cancelled") etaMinutes = 0

  var storeObj = (obj.store && typeof obj.store === "object") ? obj.store : null
  var courierObj = (obj.courier && typeof obj.courier === "object") ? obj.courier : null
  var addrObj = (obj.deliveryAddress && typeof obj.deliveryAddress === "object") ? obj.deliveryAddress : null

  var orderId = sanitizeOrderId(obj.orderId || obj.id || obj.urn || obj.code || "")
  var storeName = neutralizeMarkup(
    (storeObj && (storeObj.name || storeObj.title)) || obj.storeName || obj.restaurant || obj.merchant || "Glovo",
    MAX_STRING_LEN
  ) || "Glovo"
  var courierName = neutralizeMarkup(
    (courierObj && (courierObj.name || courierObj.firstName)) || obj.courierName || obj.riderName || "",
    MAX_STRING_LEN
  )
  var vehicle = neutralizeMarkup(
    (courierObj && (courierObj.vehicle || courierObj.transport)) || obj.vehicle || "",
    48
  )
  var address = neutralizeMarkup(
    (addrObj && (addrObj.label || addrObj.street || addrObj.text)) || obj.address || "",
    MAX_STRING_LEN
  )
  var trackingCode = neutralizeMarkup(obj.trackingCode || obj.orderCode || obj.code || "", 48)

  var storeMessage = neutralizeMarkup(obj.storeMessage || obj.storeStatusText || "", MAX_STRING_LEN)
  var courierMessage = neutralizeMarkup(obj.courierMessage || obj.courierStatusText || "", MAX_STRING_LEN)
  var bannerMessage = neutralizeMarkup(obj.bannerMessage || obj.statusMessage || "", MAX_STRING_LEN)

  var winStart = obj.etaWindowStart || ""
  var winEnd = obj.etaWindowEnd || ""
  if ((!winStart || !winEnd) && typeof obj.deliveryWindow === "string") {
    var winMatch = /([01]?\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3]):([0-5]\d)/.exec(obj.deliveryWindow)
    if (winMatch) {
      winStart = winMatch[1] + ":" + winMatch[2]
      winEnd = winMatch[3] + ":" + winMatch[4]
    }
  }
  var etaWin = (stage === "delivered" || stage === "cancelled")
    ? { start: sanitizeTimeHHMM(winStart), end: sanitizeTimeHHMM(winEnd) }
    : computeEtaWindow(refNow, etaMinutes, winStart, winEnd)

  var progressRatio = obj.progressRatio !== undefined && obj.progressRatio !== null
    ? clampFloat(obj.progressRatio, defaultProgressForStage(stage), 0.0, 1.0)
    : defaultProgressForStage(stage)
  var timeliness = normalizeTimeliness(obj.timeliness || obj.punctuality || "ontime")

  var startedAtMs = clampTimestampMs(obj.startedAtMs || obj.createdAt || obj.placedAt, 0)
  var updatedAtMs = clampTimestampMs(obj.updatedAtMs || obj.updatedAt, refNow)
  var elapsedMinutes = 0
  if (obj.elapsedMinutes !== undefined && obj.elapsedMinutes !== null && obj.elapsedMinutes !== "") {
    elapsedMinutes = clampInt(obj.elapsedMinutes, 0, 0, 1440)
  } else if (startedAtMs > 0 && refNow >= startedAtMs) {
    elapsedMinutes = clampInt(Math.floor((refNow - startedAtMs) / 60000), 0, 0, 1440)
  }

  var rawItems = obj.items || obj.products || obj.boughtProducts || []
  var items = parseOrderItems(rawItems)

  return {
    hasOrder: true,
    orderId: orderId,
    stage: stage,
    timeliness: timeliness,
    progressRatio: progressRatio,
    storeName: storeName,
    storeMessage: storeMessage,
    courierName: courierName,
    courierMessage: courierMessage,
    bannerMessage: bannerMessage,
    vehicle: vehicle,
    address: address,
    trackingCode: trackingCode,
    etaMinutes: etaMinutes,
    etaWindowStart: etaWin.start,
    etaWindowEnd: etaWin.end,
    elapsedMinutes: elapsedMinutes,
    startedAtMs: startedAtMs,
    updatedAtMs: updatedAtMs,
    source: "api",
    items: items
  }
}

function inferStageFromPhoneText(combinedLower) {
  if (/consegnat|delivered|buon appetito/.test(combinedLower)) return "delivered"
  if (/annullat|cancellat|cancelled|canceled/.test(combinedLower)) return "cancelled"
  if (/sta arrivando|quasi arrivato|near|arriving|vicino a te/.test(combinedLower)) return "arriving"
  if (/in viaggio|in consegna|on the way|picked up|ha ritirato/.test(combinedLower)) return "delivering"
  if (/ritirando|aspettando il tuo ordine|ready for pickup|pronto per il ritiro|waiting for/.test(combinedLower)) {
    return /sta preparando|preparing/.test(combinedLower) ? "preparing" : "pickup"
  }
  if (/sta preparando|in preparazione|preparing|in cucina/.test(combinedLower)) return "preparing"
  return "confirmed"
}

function parseFluxStateForGlovo(stateObj, nowMs) {
  if (!stateObj || typeof stateObj !== "object") return null
  var devices = Array.isArray(stateObj.devices) ? stateObj.devices : []
  var refNow = clampTimestampMs(nowMs, Date.now())

  var bestNotif = null
  var bestTime = -1
  for (var i = 0; i < devices.length && i < 16; i++) {
    var dev = devices[i]
    if (!dev || !Array.isArray(dev.notifications)) continue
    for (var j = 0; j < dev.notifications.length && j < 64; j++) {
      var n = dev.notifications[j]
      if (!n || typeof n !== "object") continue
      var app = String(n.app || "")
      var title = String(n.title || "")
      var body = String(n.text || n.body || "")
      var combined = (app + " " + title + " " + body).toLowerCase()
      if (!/glovo/.test(app.toLowerCase()) && !/glovo/.test(title.toLowerCase())) continue
      var tMs = clampTimestampMs(n.time, refNow)
      if (tMs >= bestTime) {
        bestTime = tMs
        bestNotif = n
      }
    }
  }

  if (!bestNotif) return null

  var cleanTitle = neutralizeMarkup(bestNotif.title || "", MAX_STRING_LEN)
  var cleanBody = neutralizeMarkup(bestNotif.text || bestNotif.body || "", MAX_STRING_LEN * 2)
  var combinedText = (cleanTitle + " " + cleanBody).replace(/^\s+|\s+$/g, "")
  var lower = combinedText.toLowerCase()

  var stage = inferStageFromPhoneText(lower)

  // Extract arrival time window e.g. "13:45 - 13:55"
  var winStart = ""
  var winEnd = ""
  var etaMinutes = 0
  var winMatch = /\b([01]?\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3]):([0-5]\d)\b/.exec(combinedText)
  if (winMatch) {
    winStart = padTwo(parseInt(winMatch[1], 10)) + ":" + winMatch[2]
    winEnd = padTwo(parseInt(winMatch[3], 10)) + ":" + winMatch[4]
    var nowD = new Date(refNow)
    var midMin = ((parseInt(winMatch[1], 10) * 60 + parseInt(winMatch[2], 10))
      + (parseInt(winMatch[3], 10) * 60 + parseInt(winMatch[4], 10))) / 2
    var curMin = nowD.getHours() * 60 + nowD.getMinutes()
    var diff = Math.round(midMin - curMin)
    if (diff < -180) diff += 1440
    etaMinutes = clampInt(diff, 0, 0, MAX_ETA_MINUTES)
  } else {
    var minMatch = /\b(\d{1,3})\s*(?:min|minuti|minutes)\b/i.exec(combinedText)
    if (minMatch) etaMinutes = clampInt(minMatch[1], 0, 0, MAX_ETA_MINUTES)
  }

  if (stage === "delivering" && etaMinutes > 0 && etaMinutes <= 3) stage = "arriving"
  if (stage === "delivered" || stage === "cancelled") etaMinutes = 0

  // Extract store name from patterns like "<Store> sta preparando il tuo ordine"
  var storeName = "Glovo"
  var storeMatch = /^(.+?)\s+(?:sta preparando|ha ricevuto|ha preparato|is preparing|received)/i.exec(cleanBody)
    || /^(.+?)\s+(?:sta preparando|ha ricevuto|ha preparato|is preparing|received)/i.exec(cleanTitle)
  if (storeMatch && storeMatch[1]) {
    storeName = neutralizeMarkup(storeMatch[1], MAX_STRING_LEN) || "Glovo"
  } else if (cleanTitle !== "" && !/^glovo$/i.test(cleanTitle)) {
    storeName = cleanTitle
  }

  // Extract courier name from patterns like "<Courier> sta aspettando / ritirando / arrivando"
  var courierName = ""
  var courierMatch = /\b([A-Z][a-zA-ZÀ-ÿ' -]{1,32})\s+(?:sta aspettando|sta ritirando|è in viaggio|sta arrivando|ha consegnato|is waiting|is picking up|is on the way|is arriving)/i.exec(combinedText)
  if (courierMatch && courierMatch[1] && courierMatch[1].toLowerCase() !== storeName.toLowerCase()) {
    courierName = neutralizeMarkup(courierMatch[1], 48)
  }

  var timeliness = "ontime"
  if (/in ritardo|ritardo|delayed|late/.test(lower)) timeliness = "delayed"
  else if (/in anticipo|early/.test(lower)) timeliness = "early"

  var etaWin = (stage === "delivered" || stage === "cancelled")
    ? { start: winStart, end: winEnd }
    : computeEtaWindow(refNow, etaMinutes, winStart, winEnd)

  return {
    hasOrder: true,
    orderId: sanitizeOrderId(bestNotif.id || "FLUX-GLOVO") || "FLUX-GLOVO",
    stage: stage,
    timeliness: timeliness,
    progressRatio: defaultProgressForStage(stage),
    storeName: storeName,
    storeMessage: cleanTitle && cleanTitle !== storeName ? cleanTitle : "",
    courierName: courierName,
    courierMessage: cleanBody,
    bannerMessage: "",
    vehicle: "",
    address: "",
    trackingCode: "",
    etaMinutes: etaMinutes,
    etaWindowStart: etaWin.start,
    etaWindowEnd: etaWin.end,
    elapsedMinutes: 0,
    startedAtMs: bestTime > 0 ? bestTime : refNow,
    updatedAtMs: bestTime > 0 ? bestTime : refNow,
    source: "flux",
    items: []
  }
}

function decodeBase64Url(str) {
  var b64 = String(str || "").replace(/-/g, "+").replace(/_/g, "/")
  while (b64.length % 4 !== 0) b64 += "="
  try {
    if (typeof Qt !== "undefined" && typeof Qt.atob === "function") return Qt.atob(b64)
    if (typeof atob === "function") return atob(b64)
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8")
  } catch (e) {}
  return ""
}

function parseJwtExpiryMs(token) {
  var clean = sanitizeToken(token)
  if (!clean) return 0
  var parts = clean.split(".")
  if (parts.length !== 3 || parts[1].length > 2048) return 0
  var raw = decodeBase64Url(parts[1])
  if (!raw) return 0
  try {
    var payload = JSON.parse(raw)
    if (!payload || typeof payload !== "object") return 0
    return clampTimestampMs(payload.exp, 0)
  } catch (e) {
    return 0
  }
}

function findGlovoCookieToken(cookies) {
  if (!Array.isArray(cookies)) return ""
  for (var i = 0; i < cookies.length && i < 128; i++) {
    var c = cookies[i]
    if (!c || typeof c !== "object") continue
    var domain = String(c.domain || "").toLowerCase()
    if (domain.indexOf("glovoapp.com") === -1) continue
    var rawVal = String(c.value || "").slice(0, 8192)
    if (!rawVal) continue
    var decoded = rawVal
    try { decoded = decodeURIComponent(rawVal) } catch (e) { decoded = rawVal }
    if (decoded.charAt(0) === "{") {
      try {
        var obj = JSON.parse(decoded)
        if (obj && typeof obj === "object") {
          var tok = sanitizeToken(obj.accessToken || obj.access_token || obj.token || "")
          if (tok) return tok
        }
      } catch (e) {}
    }
    var name = String(c.name || "").toLowerCase()
    if ((name.indexOf("glov") !== -1 || name.indexOf("auth") !== -1 || name.indexOf("token") !== -1)
        && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded)) {
      return sanitizeToken(decoded)
    }
  }
  return ""
}

function extractGlovoUserName(rawOrObj) {
  if (!rawOrObj) return ""
  var obj = null
  if (typeof rawOrObj === "string") {
    if (rawOrObj.length > MAX_RESPONSE_BYTES) return ""
    try { obj = JSON.parse(rawOrObj) } catch (e) { return "" }
  } else if (typeof rawOrObj === "object") {
    obj = rawOrObj
  }
  if (!obj || typeof obj !== "object") return ""
  var target = (obj.user && typeof obj.user === "object") ? obj.user : obj
  var rawName = target.firstName || target.givenName || target.name || target.fullName || obj.name || ""
  return neutralizeMarkup(rawName, 48)
}

function parseSessionFile(rawText) {
  var fallback = { loggedIn: false, status: "needs_login", userName: "", lastSyncMs: 0, tokenExpMs: 0, reason: "" }
  if (!rawText) return fallback
  var str = String(rawText)
  if (str.length > MAX_RESPONSE_BYTES) return fallback
  try {
    var obj = JSON.parse(str)
    if (!obj || typeof obj !== "object") return fallback
    return {
      loggedIn: obj.loggedIn === true,
      status: neutralizeMarkup(obj.status || (obj.loggedIn ? "connected" : "needs_login"), 48) || "needs_login",
      userName: neutralizeMarkup(obj.userName || "", 48),
      lastSyncMs: clampTimestampMs(obj.lastSyncMs || obj.updatedAtMs, 0),
      tokenExpMs: clampTimestampMs(obj.tokenExpMs, 0),
      reason: neutralizeMarkup(obj.reason || "", 80)
    }
  } catch (e) {
    return fallback
  }
}

function parseGlovoDomOrder(snapshot, nowMs) {
  if (!snapshot || typeof snapshot !== "object") return emptyOrder()
  var refNow = clampTimestampMs(nowMs, Date.now())
  var bodyText = String(snapshot.bodyText || "").slice(0, 4096)
  var cleanBody = neutralizeMarkup(bodyText, 2048)
  if (!cleanBody) return emptyOrder()

  var lower = cleanBody.toLowerCase()
  var hasActivePhrase = /\b(sta preparando|ordine confermato|in preparazione|in consegna|sta arrivando|sta aspettando|sta ritirando|in viaggio|puntuale|in anticipo|in ritardo|is preparing|order confirmed|waiting for|picking up|on the way|arriving soon|on time|delayed)\b/i.test(lower)
  if (!hasActivePhrase) return emptyOrder()

  var stage = inferStageFromPhoneText(lower)
  if (!isActiveStage(stage)) return emptyOrder()

  var winStart = ""
  var winEnd = ""
  var etaMinutes = 0
  var winMatch = /\b([01]?\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3]):([0-5]\d)\b/.exec(cleanBody)
  if (winMatch) {
    winStart = padTwo(parseInt(winMatch[1], 10)) + ":" + winMatch[2]
    winEnd = padTwo(parseInt(winMatch[3], 10)) + ":" + winMatch[4]
    var nowD = new Date(refNow)
    var midMin = ((parseInt(winMatch[1], 10) * 60 + parseInt(winMatch[2], 10))
      + (parseInt(winMatch[3], 10) * 60 + parseInt(winMatch[4], 10))) / 2
    var curMin = nowD.getHours() * 60 + nowD.getMinutes()
    var diff = Math.round(midMin - curMin)
    if (diff < -180) diff += 1440
    etaMinutes = clampInt(diff, 0, 0, MAX_ETA_MINUTES)
  } else {
    var minMatch = /\b(\d{1,3})\s*(?:min|minuti|minutes)\b/i.exec(cleanBody)
    if (minMatch) etaMinutes = clampInt(minMatch[1], 0, 0, MAX_ETA_MINUTES)
  }

  if (stage === "delivering" && etaMinutes > 0 && etaMinutes <= 3) stage = "arriving"

  var storeName = neutralizeMarkup(snapshot.storeName || "", MAX_STRING_LEN)
  if (!storeName) {
    var storeMatch = /([^\n.•|]{2,64}?)\s+(?:sta preparando|ha ricevuto|ha preparato|is preparing|received)/i.exec(cleanBody)
    if (storeMatch && storeMatch[1]) storeName = neutralizeMarkup(storeMatch[1], MAX_STRING_LEN)
  }
  if (!storeName) storeName = "Glovo"

  var courierName = neutralizeMarkup(snapshot.courierName || "", 48)
  if (!courierName) {
    var courierMatch = /\b([A-Z][a-zA-ZÀ-ÿ' -]{1,32})\s+(?:sta aspettando|sta ritirando|è in viaggio|sta arrivando|is waiting|is picking up|is on the way|is arriving)/i.exec(cleanBody)
    if (courierMatch && courierMatch[1] && courierMatch[1].toLowerCase() !== storeName.toLowerCase()) {
      courierName = neutralizeMarkup(courierMatch[1], 48)
    }
  }

  var timeliness = "ontime"
  if (/in ritardo|delayed|late/.test(lower)) timeliness = "delayed"
  else if (/in anticipo|early/.test(lower)) timeliness = "early"

  var etaWin = computeEtaWindow(refNow, etaMinutes, winStart, winEnd)
  var orderId = sanitizeOrderId(snapshot.orderId || "GLV-WEB") || "GLV-WEB"
  var items = parseOrderItems(snapshot.items || [])

  return {
    hasOrder: true,
    orderId: orderId,
    stage: stage,
    timeliness: timeliness,
    progressRatio: defaultProgressForStage(stage),
    storeName: storeName,
    storeMessage: neutralizeMarkup(snapshot.storeMessage || "", MAX_STRING_LEN),
    courierName: courierName,
    courierMessage: neutralizeMarkup(snapshot.courierMessage || "", MAX_STRING_LEN),
    bannerMessage: neutralizeMarkup(snapshot.bannerMessage || "", MAX_STRING_LEN),
    vehicle: "",
    address: "",
    trackingCode: "",
    etaMinutes: etaMinutes,
    etaWindowStart: etaWin.start,
    etaWindowEnd: etaWin.end,
    elapsedMinutes: 0,
    startedAtMs: refNow,
    updatedAtMs: refNow,
    source: "browser",
    items: items
  }
}

function parseAuthFile(rawText) {
  if (!rawText) return { token: "", orderId: "" }
  var str = String(rawText)
  if (str.length > MAX_RESPONSE_BYTES) return { token: "", orderId: "" }
  try {
    var obj = JSON.parse(str)
    if (!obj || typeof obj !== "object") return { token: "", orderId: "" }
    return {
      token: sanitizeToken(obj.token || obj.accessToken || obj.bearerToken || ""),
      orderId: sanitizeOrderId(obj.orderId || "")
    }
  } catch (e) {
    return { token: "", orderId: "" }
  }
}

function stageIcon(stage) {
  switch (stage) {
    case "confirmed": return "\uf046"
    case "preparing": return "\uf0f5"
    case "pickup": return "\uf1b2"
    case "delivering": return "\uf206"
    case "arriving": return "\uf041"
    case "delivered": return "\uf058"
    case "cancelled": return "\uf057"
    default: return "\uf290"
  }
}

function stageTitleKey(stage) {
  switch (stage) {
    case "confirmed": return "stage.confirmed"
    case "preparing": return "stage.preparing"
    case "pickup": return "stage.pickup"
    case "delivering": return "stage.delivering"
    case "arriving": return "stage.arriving"
    case "delivered": return "stage.delivered"
    case "cancelled": return "stage.cancelled"
    default: return "stage.idle"
  }
}

function storeActionKey(stage) {
  switch (stage) {
    case "confirmed": return "storeAction.confirmed"
    case "preparing": return "storeAction.preparing"
    case "pickup": return "storeAction.pickup"
    case "delivering": return "storeAction.delivering"
    case "arriving": return "storeAction.arriving"
    case "delivered": return "storeAction.delivered"
    case "cancelled": return "storeAction.cancelled"
    default: return "stage.idle"
  }
}

function courierActionKey(stage) {
  switch (stage) {
    case "confirmed":
    case "preparing": return "courierAction.waiting"
    case "pickup": return "courierAction.pickup"
    case "delivering": return "courierAction.delivering"
    case "arriving": return "courierAction.arriving"
    case "delivered": return "courierAction.delivered"
    default: return "panel.courierUnassigned"
  }
}

function bannerKey(stage) {
  switch (stage) {
    case "confirmed": return "banner.confirmed"
    case "preparing": return "banner.preparing"
    case "pickup": return "banner.pickup"
    case "delivering": return "banner.delivering"
    case "arriving": return "banner.arriving"
    case "delivered": return "banner.delivered"
    case "cancelled": return "banner.cancelled"
    default: return "stage.idle"
  }
}

function timelinessKey(timeliness) {
  if (timeliness === "early") return "timeliness.early"
  if (timeliness === "delayed") return "timeliness.delayed"
  return "timeliness.ontime"
}

function defaultT(key) { return key }
function defaultTn(key) { return key }
function defaultFmt(v) { return String(v) }

function formatArgs(template) {
  var args = Array.prototype.slice.call(arguments, 1)
  return String(template || "").replace(/%([1-9])/g, function(m, n) {
    var idx = parseInt(n, 10) - 1
    return idx >= 0 && idx < args.length ? String(args[idx]) : m
  })
}

function buildStoreMessage(order, t) {
  var tr = typeof t === "function" ? t : defaultT
  var o = order || emptyOrder()
  if (!o.hasOrder) return neutralizeMarkup(tr("stage.idle"), MAX_STRING_LEN)
  if (o.storeMessage && o.storeMessage !== "") return neutralizeMarkup(o.storeMessage, MAX_STRING_LEN)
  var store = neutralizeMarkup(o.storeName || "Glovo", MAX_STRING_LEN) || "Glovo"
  return neutralizeMarkup(formatArgs(tr(storeActionKey(o.stage)), store), MAX_STRING_LEN)
}

function buildCourierMessage(order, t) {
  var tr = typeof t === "function" ? t : defaultT
  var o = order || emptyOrder()
  if (!o.hasOrder) return ""
  if (o.courierMessage && o.courierMessage !== "") return neutralizeMarkup(o.courierMessage, MAX_STRING_LEN)
  var courier = neutralizeMarkup(o.courierName || "", MAX_STRING_LEN)
  if (courier === "") return neutralizeMarkup(tr("panel.courierUnassigned"), MAX_STRING_LEN)
  return neutralizeMarkup(formatArgs(tr(courierActionKey(o.stage)), courier), MAX_STRING_LEN)
}

function buildBannerMessage(order, t) {
  var tr = typeof t === "function" ? t : defaultT
  var o = order || emptyOrder()
  if (!o.hasOrder) return ""
  if (o.bannerMessage && o.bannerMessage !== "") return neutralizeMarkup(o.bannerMessage, MAX_STRING_LEN)
  return neutralizeMarkup(tr(bannerKey(o.stage)), MAX_STRING_LEN)
}

function buildEtaWindowText(order) {
  var o = order || emptyOrder()
  if (!o.etaWindowStart || !o.etaWindowEnd) return ""
  return neutralizeMarkup(o.etaWindowStart + " - " + o.etaWindowEnd, 32)
}

function buildBarLabel(order, showEtaInBar, fmtNumber, t, tn) {
  var fmt = typeof fmtNumber === "function" ? fmtNumber : defaultFmt
  var tr = typeof t === "function" ? t : defaultT
  var trn = typeof tn === "function" ? tn : defaultTn

  var o = order || emptyOrder()
  var icon = stageIcon(o.stage)
  if (!o.hasOrder || o.stage === "idle") {
    return icon
  }
  if (showEtaInBar && isActiveStage(o.stage) && o.etaMinutes > 0) {
    var etaText = neutralizeMarkup(formatArgs(trn("eta.minutes", o.etaMinutes), fmt(o.etaMinutes)), 40)
    return icon + " " + etaText
  }
  if (o.stage === "arriving") {
    return icon + " " + neutralizeMarkup(tr("eta.arrivingNow"), 40)
  }
  return icon
}

function buildBarTooltip(order, fmtNumber, t, tn, sessionState) {
  var fmt = typeof fmtNumber === "function" ? fmtNumber : defaultFmt
  var tr = typeof t === "function" ? t : defaultT
  var trn = typeof tn === "function" ? tn : defaultTn

  var o = order || emptyOrder()
  if (!o.hasOrder || o.stage === "idle") {
    if (sessionState && sessionState.loggedIn && sessionState.userName) {
      var user = neutralizeMarkup(sessionState.userName, 48)
      if (user !== "") {
        return neutralizeMarkup(formatArgs(tr("bar.tooltipLoggedInIdle"), user), MAX_STRING_LEN * 2)
      }
    }
    return neutralizeMarkup(tr("bar.tooltipIdle"), MAX_STRING_LEN)
  }
  var store = neutralizeMarkup(o.storeName || "Glovo", MAX_STRING_LEN) || "Glovo"
  var stageText = neutralizeMarkup(tr(stageTitleKey(o.stage)), 64)
  if (isActiveStage(o.stage) && o.etaMinutes > 0) {
    var etaText = neutralizeMarkup(formatArgs(trn("eta.minutes", o.etaMinutes), fmt(o.etaMinutes)), 40)
    return neutralizeMarkup(formatArgs(tr("bar.tooltipWithEta"), store, stageText, etaText), MAX_STRING_LEN * 2)
  }
  return neutralizeMarkup(formatArgs(tr("bar.tooltipActive"), store, stageText), MAX_STRING_LEN * 2)
}

function soundAssetForStage(stage) {
  switch (stage) {
    case "confirmed": return "assets/stage-confirmed.oga"
    case "preparing": return "assets/stage-preparing.oga"
    case "pickup": return "assets/stage-pickup.oga"
    case "delivering": return "assets/stage-delivering.oga"
    case "arriving": return "assets/stage-arriving.oga"
    case "delivered": return "assets/stage-delivered.oga"
    case "cancelled": return "assets/stage-cancelled.oga"
    default: return "assets/stage-confirmed.oga"
  }
}

function buildNotificationPayload(prevOrder, nextOrder, options, fmtNumber, t, tn) {
  var noNotify = { shouldNotify: false, glyph: "", urgency: "low", headline: "", body: "", soundAsset: "" }
  if (!nextOrder || !nextOrder.hasOrder || nextOrder.stage === "idle") return noNotify

  var opts = options || {}
  var force = !!opts.force
  var notifyStage = opts.notifyOnStageChange !== false
  var notifyEta = opts.notifyOnEtaChange !== false

  var prev = prevOrder || emptyOrder()
  var sameOrder = prev.hasOrder && (prev.orderId === nextOrder.orderId || (!prev.orderId && !nextOrder.orderId))
  var stageChanged = !sameOrder || prev.stage !== nextOrder.stage
  var etaDiff = sameOrder ? Math.abs((nextOrder.etaMinutes || 0) - (prev.etaMinutes || 0)) : 0
  var etaChanged = sameOrder && !stageChanged && isActiveStage(nextOrder.stage) && etaDiff >= 3

  if (!force) {
    if (stageChanged && !notifyStage) stageChanged = false
    if (etaChanged && !notifyEta) etaChanged = false
    if (!stageChanged && !etaChanged) return noNotify
  }

  var fmt = typeof fmtNumber === "function" ? fmtNumber : defaultFmt
  var tr = typeof t === "function" ? t : defaultT
  var trn = typeof tn === "function" ? tn : defaultTn

  var store = neutralizeMarkup(nextOrder.storeName || "Glovo", MAX_STRING_LEN) || "Glovo"
  var stageLabel = neutralizeMarkup(tr(stageTitleKey(nextOrder.stage)), 64)
  var glyph = stageIcon(nextOrder.stage)
  var urgency = (nextOrder.stage === "arriving" || nextOrder.stage === "delivered" || nextOrder.stage === "cancelled")
    ? "normal"
    : "low"

  var headlineRaw = (!force && etaChanged && !stageChanged)
    ? formatArgs(tr("notify.etaUpdatedHeadline"), store)
    : formatArgs(tr("notify.stageHeadline"), store)

  var bodyRaw = ""
  if (isActiveStage(nextOrder.stage) && nextOrder.etaMinutes > 0) {
    var etaLine = formatArgs(trn("eta.arrivingIn", nextOrder.etaMinutes), fmt(nextOrder.etaMinutes))
    var win = buildEtaWindowText(nextOrder)
    if (win !== "") etaLine = formatArgs(tr("eta.windowWithMinutes"), win, etaLine)
    bodyRaw = (!force && etaChanged && !stageChanged)
      ? formatArgs(tr("notify.etaUpdatedBody"), stageLabel, etaLine)
      : formatArgs(tr("notify.stageBodyWithEta"), stageLabel, etaLine)
  } else {
    bodyRaw = formatArgs(tr("notify.stageBodyNoEta"), stageLabel)
  }

  var headline = neutralizeMarkup(headlineRaw, MAX_STRING_LEN)
  var body = neutralizeMarkup(bodyRaw, MAX_STRING_LEN * 2)
  if (!headline) headline = "Glovo Tracker"

  return {
    shouldNotify: true,
    glyph: glyph,
    urgency: urgency,
    headline: headline,
    body: body,
    soundAsset: soundAssetForStage(nextOrder.stage)
  }
}

function createDemoOrder(stepIndex, nowMs, t) {
  var tr = typeof t === "function" ? t : defaultT
  var refNow = clampTimestampMs(nowMs, Date.now())
  var courier = neutralizeMarkup(tr("demo.courierName"), MAX_STRING_LEN) || "Marco"
  var store = neutralizeMarkup(tr("demo.storeName"), MAX_STRING_LEN) || "Bistro Fresh&Fast"
  var steps = [
    { stage: "confirmed", eta: 24, elapsed: 1, courier: "", ratio: 0.15 },
    { stage: "preparing", eta: 9, elapsed: 6, courier: courier, ratio: 0.35 },
    { stage: "pickup", eta: 7, elapsed: 10, courier: courier, ratio: 0.56 },
    { stage: "delivering", eta: 5, elapsed: 14, courier: courier, ratio: 0.78 },
    { stage: "arriving", eta: 2, elapsed: 18, courier: courier, ratio: 0.92 },
    { stage: "delivered", eta: 0, elapsed: 20, courier: courier, ratio: 1.0 }
  ]
  var idx = clampInt(stepIndex, 0, 0, steps.length - 1)
  var spec = steps[idx]
  var etaWin = (spec.stage === "delivered")
    ? { start: "", end: "" }
    : computeEtaWindow(refNow, spec.eta, "", "")

  return {
    hasOrder: true,
    orderId: "GLV-DEMO-8421",
    stage: spec.stage,
    timeliness: "ontime",
    progressRatio: spec.ratio,
    storeName: store,
    storeMessage: "",
    courierName: spec.courier,
    courierMessage: "",
    bannerMessage: "",
    vehicle: spec.courier ? (neutralizeMarkup(tr("demo.vehicle"), 48) || "Scooter") : "",
    address: "Demo District",
    trackingCode: "8421",
    etaMinutes: spec.eta,
    etaWindowStart: etaWin.start,
    etaWindowEnd: etaWin.end,
    elapsedMinutes: spec.elapsed,
    startedAtMs: refNow - spec.elapsed * 60000,
    updatedAtMs: refNow,
    source: "demo",
    items: [
      { name: neutralizeMarkup(tr("demo.item1"), 80) || "Pizza Margherita", quantity: 1 },
      { name: neutralizeMarkup(tr("demo.item2"), 80) || "Patatine Croccanti", quantity: 1 },
      { name: neutralizeMarkup(tr("demo.item3"), 80) || "Acqua Frizzante 330ml", quantity: 1 }
    ]
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    MAX_STRING_LEN: MAX_STRING_LEN,
    MAX_ID_LEN: MAX_ID_LEN,
    MAX_ITEMS: MAX_ITEMS,
    MAX_ETA_MINUTES: MAX_ETA_MINUTES,
    MIN_TIMESTAMP_MS: MIN_TIMESTAMP_MS,
    MAX_TIMESTAMP_MS: MAX_TIMESTAMP_MS,
    STAGES: STAGES,
    ACTIVE_PROGRESS_STAGES: ACTIVE_PROGRESS_STAGES,
    clampInt: clampInt,
    clampFloat: clampFloat,
    clampTimestampMs: clampTimestampMs,
    decodeHtmlEntitiesOnce: decodeHtmlEntitiesOnce,
    neutralizeMarkup: neutralizeMarkup,
    sanitizeOrderId: sanitizeOrderId,
    sanitizeToken: sanitizeToken,
    buildGlovoApiUrl: buildGlovoApiUrl,
    buildGlovoWhatsUpUrl: buildGlovoWhatsUpUrl,
    emptyOrder: emptyOrder,
    normalizeStage: normalizeStage,
    isActiveStage: isActiveStage,
    stageStepIndex: stageStepIndex,
    riderRoutePosition: riderRoutePosition,
    parseGlovoResponse: parseGlovoResponse,
    parseFluxStateForGlovo: parseFluxStateForGlovo,
    parseGlovoDomOrder: parseGlovoDomOrder,
    parseJwtExpiryMs: parseJwtExpiryMs,
    findGlovoCookieToken: findGlovoCookieToken,
    extractGlovoUserName: extractGlovoUserName,
    parseSessionFile: parseSessionFile,
    parseAuthFile: parseAuthFile,
    stageIcon: stageIcon,
    stageTitleKey: stageTitleKey,
    storeActionKey: storeActionKey,
    courierActionKey: courierActionKey,
    bannerKey: bannerKey,
    timelinessKey: timelinessKey,
    buildStoreMessage: buildStoreMessage,
    buildCourierMessage: buildCourierMessage,
    buildBannerMessage: buildBannerMessage,
    buildEtaWindowText: buildEtaWindowText,
    buildBarLabel: buildBarLabel,
    buildBarTooltip: buildBarTooltip,
    soundAssetForStage: soundAssetForStage,
    buildNotificationPayload: buildNotificationPayload,
    createDemoOrder: createDemoOrder,
    formatArgs: formatArgs
  }
}
