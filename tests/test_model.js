#!/usr/bin/env node

"use strict";

const assert = require("assert");
const { execFileSync, spawn } = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const Model = require(path.resolve(__dirname, "..", "Model.js"));
const GlovoSession = require(path.resolve(__dirname, "..", "bin", "glovo-session.cjs"));
const enCatalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "i18n", "en.json"), "utf8"));
const itCatalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "i18n", "it.json"), "utf8"));

function makeTranslator(catalog) {
  function t(key, fallback) {
    const entry = catalog[key];
    if (entry && typeof entry === "object") return entry.other || fallback || key;
    return typeof entry === "string" && entry.length > 0 ? entry : (fallback !== undefined ? fallback : key);
  }
  function tn(key, count, fallback) {
    const entry = catalog[key];
    if (entry && typeof entry === "object") {
      const cat = count === 1 ? "one" : "other";
      if (typeof entry[cat] === "string" && entry[cat].length > 0) return entry[cat];
      if (typeof entry.other === "string" && entry.other.length > 0) return entry.other;
    }
    return t(key, fallback);
  }
  return { t, tn };
}

// Replica of /usr/share/omarchy/shell/plugins/notifications/Markup.js render pipeline
// to verify neutralized strings cannot re-open tags or links inside notification toasts.
function omarchyNotificationMarkupRender(body) {
  const ALLOWED = ["b", "i", "u", "s", "em", "strong"];
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

  function decodeOnce(text) {
    return String(text || "")
      .replace(/&#(\d{1,7});/g, (_, n) => {
        const code = parseInt(n, 10);
        return (code > 0 && code < 0x110000) ? String.fromCodePoint(code) : _;
      })
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => {
        const code = parseInt(n, 16);
        return (code > 0 && code < 0x110000) ? String.fromCodePoint(code) : _;
      })
      .replace(/&([a-z]+);/gi, (whole, name) => {
        const hit = ENTITIES[String(name).toLowerCase()];
        return hit === undefined ? whole : hit;
      });
  }

  let text = String(body || "").slice(0, 4096);
  for (let i = 0; i < 3; i++) {
    const once = decodeOnce(text);
    if (once === text) break;
    text = once;
  }

  let out = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  for (const tag of ALLOWED) {
    out = out.replace(new RegExp("&lt;" + tag + "&gt;", "gi"), "<" + tag + ">");
    out = out.replace(new RegExp("&lt;/" + tag + "&gt;", "gi"), "</" + tag + ">");
  }
  out = out.replace(/&lt;br\s*\/?&gt;/gi, "<br/>");
  out = out.replace(
    /&lt;a\s+href=(?:&quot;|")([^"&]+)(?:&quot;|")[^&]*&gt;([\s\S]*?)&lt;\/a&gt;/gi,
    (_, href, label) => (/^https?:\/\//i.test(href) ? `<a href="${href}">${label}</a>` : label)
  );
  out = out.replace(/<(\/?)em>/gi, "<$1i>");
  if (!/<a\b/i.test(out)) {
    out = out.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);
  }
  return out.replace(/\r?\n/g, "<br/>");
}

function assertNoHtmlTags(text, context) {
  const rendered = omarchyNotificationMarkupRender(text);
  assert.strictEqual(/<[^>]+>/.test(rendered), false, `${context}: unexpected HTML tag in rendered output: ${rendered}`);
  assert.strictEqual(/[<>]/.test(text), false, `${context}: raw < or > survived neutralization: ${text}`);
}

const en = makeTranslator(enCatalog);
const it = makeTranslator(itCatalog);
const fmt = (v) => String(v);
const NOW = new Date(2026, 10, 16, 13, 41, 0, 0).getTime();

// 1. Markup neutralization unit tests (preserving literal "&" in brand names like Fresh&Fast)
{
  const cases = [
    ['<img src="https://example.invalid/tracker">', ""],
    ["<b>bold</b>", "bold"],
    ['<a href="https://evil.example">x</a>', "x"],
    ["&amp;amp;lt;b&amp;amp;gt;hello&amp;amp;lt;/b&amp;amp;gt;", "hello"],
    ["&#60;script&#62;alert(1)&#60;/script&#62;", "alert(1)"],
    ["&#x3c;img src=x&#x3e;Pizza", "Pizza"],
    ["Pizza https://evil.example/track?a=1&b=2", "Pizza"],
    ["javascript:alert(1) Taco", "Taco"],
    ["--exec rm -rf /", "exec rm -rf /"],
    ["-rf /tmp", "rf /tmp"],
    ["Line1\nLine2\r\n\t<b>Tag</b>", "Line1 Line2 Tag"],
    ["Bistro Fresh&Fast", "Bistro Fresh&Fast"]
  ];

  for (const [input, expected] of cases) {
    const out = Model.neutralizeMarkup(input);
    assert.strictEqual(out, expected, `neutralizeMarkup(${JSON.stringify(input)})`);
    assertNoHtmlTags(out, `neutralizeMarkup(${input})`);
  }
}

// 2. Every shared tooltip, bar label, phone-UI message, and notification sink with malicious inputs
{
  const maliciousPayload = JSON.stringify({
    orderId: "GLV-999",
    status: "DELIVERING",
    etaMinutes: 7,
    deliveryWindow: "13:45 - 13:55",
    timeliness: "ontime",
    startedAtMs: NOW - 15 * 60000,
    store: {
      name: '<img src="https://example.invalid/tracker"><b>Bistro - Fresh&Fast</b> &amp;amp;lt;a href="https://evil.example"&amp;amp;gt;click&amp;amp;lt;/a&amp;amp;gt;'
    },
    courier: {
      name: '&#60;i&#62;Marco&#60;/i&#62; https://evil.example/rider',
      vehicle: '--exec <script>x</script>Scooter'
    },
    storeMessage: '<b>Bistro</b> sta preparando',
    courierMessage: '<img src=x>Marco sta arrivando',
    bannerMessage: 'https://evil.example Il tuo ordine sta arrivando...',
    items: [
      { name: '<a href="https://evil.example">Pizza Margherita</a>', quantity: 2 },
      { name: '&#x3c;b&#x3e;Patatine&#x3c;/b&#x3e;', quantity: 1 }
    ]
  });

  const parsed = Model.parseGlovoResponse(maliciousPayload, NOW);
  assert.ok(parsed && parsed.hasOrder);
  assert.strictEqual(parsed.etaWindowStart, "13:45");
  assert.strictEqual(parsed.etaWindowEnd, "13:55");
  assertNoHtmlTags(parsed.storeName, "parsed.storeName");
  assertNoHtmlTags(parsed.courierName, "parsed.courierName");
  assertNoHtmlTags(parsed.vehicle, "parsed.vehicle");
  assertNoHtmlTags(Model.buildStoreMessage(parsed, it.t), "buildStoreMessage");
  assertNoHtmlTags(Model.buildCourierMessage(parsed, it.t), "buildCourierMessage");
  assertNoHtmlTags(Model.buildBannerMessage(parsed, it.t), "buildBannerMessage");
  assertNoHtmlTags(Model.buildEtaWindowText(parsed), "buildEtaWindowText");
  for (const item of parsed.items) {
    assertNoHtmlTags(item.name, "parsed.items[].name");
  }

  const label = Model.buildBarLabel(parsed, true, fmt, en.t, en.tn);
  assertNoHtmlTags(label, "buildBarLabel");
  assert.ok(label.includes("7 min"));

  const tooltipEn = Model.buildBarTooltip(parsed, fmt, en.t, en.tn);
  assertNoHtmlTags(tooltipEn, "buildBarTooltip(en)");
  assert.strictEqual(tooltipEn.includes("example.invalid"), false);
  assert.strictEqual(tooltipEn.includes("evil.example"), false);

  const tooltipIt = Model.buildBarTooltip(parsed, fmt, it.t, it.tn);
  assertNoHtmlTags(tooltipIt, "buildBarTooltip(it)");

  const notif = Model.buildNotificationPayload(
    Model.emptyOrder(),
    parsed,
    { notifyOnStageChange: true, notifyOnEtaChange: true },
    fmt,
    it.t,
    it.tn
  );
  assert.strictEqual(notif.shouldNotify, true);
  assertNoHtmlTags(notif.headline, "notif.headline");
  assertNoHtmlTags(notif.body, "notif.body");
  assert.ok(notif.body.includes("13:45 - 13:55"));
  assert.strictEqual(notif.headline.startsWith("-"), false);
  assert.strictEqual(notif.body.startsWith("-"), false);

  const dashOrder = Model.parseGlovoResponse(JSON.stringify({
    orderId: "DASH1",
    status: "CONFIRMED",
    etaMinutes: 20,
    storeName: "--hint=foo"
  }), NOW);
  assert.strictEqual(dashOrder.storeName.startsWith("-"), false);
  const dashNotif = Model.buildNotificationPayload(Model.emptyOrder(), dashOrder, {}, fmt, en.t, en.tn);
  assert.strictEqual(dashNotif.headline.startsWith("-"), false);
}

// 3. Flux phone notification parsing tests (normal + markup-shaped phone notification)
{
  const fluxState = {
    devices: [
      {
        id: "dev1",
        name: "Android Phone",
        notifications: [
          {
            id: "notif-101",
            app: "Glovo",
            title: "Puntuale • 13:45 - 13:55",
            text: "Bistro Fresh&Fast sta preparando il tuo ordine. Marco sta aspettando il tuo ordine",
            time: Math.floor(NOW / 1000)
          }
        ]
      }
    ]
  };
  const parsed = Model.parseFluxStateForGlovo(fluxState, NOW);
  assert.ok(parsed && parsed.hasOrder);
  assert.strictEqual(parsed.source, "flux");
  assert.strictEqual(parsed.stage, "preparing");
  assert.strictEqual(parsed.timeliness, "ontime");
  assert.strictEqual(parsed.etaWindowStart, "13:45");
  assert.strictEqual(parsed.etaWindowEnd, "13:55");
  assert.strictEqual(parsed.etaMinutes, 9);
  assert.strictEqual(parsed.storeName, "Bistro Fresh&Fast");
  assert.strictEqual(parsed.courierName, "Marco");

  const maliciousFluxState = {
    devices: [
      {
        id: "dev1",
        notifications: [
          {
            id: "n2",
            app: "Glovo",
            title: '<img src="https://example.invalid/t"><b>Glovo</b> 13:45 - 13:55',
            text: '<b>Store</b> sta preparando &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; https://evil.example',
            time: Math.floor(NOW / 1000)
          }
        ]
      }
    ]
  };
  const safeFlux = Model.parseFluxStateForGlovo(maliciousFluxState, NOW);
  assert.ok(safeFlux);
  assertNoHtmlTags(safeFlux.storeName, "flux.storeName");
  assertNoHtmlTags(safeFlux.storeMessage, "flux.storeMessage");
  assertNoHtmlTags(safeFlux.courierMessage, "flux.courierMessage");
  assertNoHtmlTags(Model.buildBarTooltip(safeFlux, fmt, it.t, it.tn), "flux tooltip");
}

// 4. Bounding and validation tests
{
  const oversized = JSON.stringify({ status: "CONFIRMED", storeName: "A".repeat(Model.MAX_RESPONSE_BYTES + 100) });
  assert.strictEqual(Model.parseGlovoResponse(oversized, NOW), null);

  assert.strictEqual(Model.parseGlovoResponse("", NOW), null);
  assert.strictEqual(Model.parseGlovoResponse("{not json", NOW), null);

  const emptyList = Model.parseGlovoResponse(JSON.stringify({ orders: [] }), NOW);
  assert.ok(emptyList && emptyList.hasOrder === false && emptyList.stage === "idle");

  const emptyWhatsUp = Model.parseGlovoResponse(JSON.stringify({ statusMessage: null }), NOW);
  assert.ok(emptyWhatsUp && emptyWhatsUp.hasOrder === false && emptyWhatsUp.stage === "idle");

  const activeWhatsUp = Model.parseGlovoResponse(JSON.stringify({
    statusMessage: {
      orderId: "900000000042",
      status: "PREPARING",
      etaMinutes: 12,
      storeName: "Bistro Fresh&Fast"
    }
  }), NOW);
  assert.ok(activeWhatsUp && activeWhatsUp.hasOrder && activeWhatsUp.stage === "preparing" && activeWhatsUp.storeName === "Bistro Fresh&Fast");
  assert.strictEqual(Model.buildGlovoWhatsUpUrl(), "https://api.glovoapp.com/v3/whats_up?fields=statusMessage");

  const manyItems = Array.from({ length: 50 }, (_, i) => ({ name: "Item " + i + " " + "X".repeat(120), quantity: 500 }));
  const bounded = Model.parseGlovoResponse(JSON.stringify({
    orderId: "ORD_123",
    status: "PREPARING",
    etaMinutes: 9999,
    startedAtMs: 123,
    storeName: "S".repeat(300),
    items: manyItems
  }), NOW);

  assert.strictEqual(bounded.items.length, Model.MAX_ITEMS);
  assert.ok(bounded.items[0].name.length <= 80);
  assert.strictEqual(bounded.items[0].quantity, 99);
  assert.strictEqual(bounded.etaMinutes, Model.MAX_ETA_MINUTES);
  assert.strictEqual(bounded.startedAtMs, 0);
  assert.ok(bounded.storeName.length <= Model.MAX_STRING_LEN);

  assert.strictEqual(Model.sanitizeOrderId("GLV-123_abc"), "GLV-123_abc");
  assert.strictEqual(Model.sanitizeOrderId("https://evil.example/foo"), "");
  assert.strictEqual(Model.sanitizeOrderId("../etc/passwd"), "");
  assert.strictEqual(Model.sanitizeOrderId("id with spaces"), "");
  assert.strictEqual(Model.buildGlovoApiUrl("GLV-123_abc"), "https://api.glovoapp.com/v3/customer/orders/GLV-123_abc");
  assert.strictEqual(Model.buildGlovoApiUrl("../evil"), "https://api.glovoapp.com/v3/customer/orders-active");
  assert.strictEqual(Model.buildGlovoApiUrl("").startsWith("https://api.glovoapp.com/"), true);

  assert.strictEqual(Model.sanitizeToken("Bearer abc\r\nX-Inject: 1"), "abcX-Inject: 1");
}

// 5. Notification trigger logic (stage change + ETA shift >= 3 min)
{
  const s1 = Model.parseGlovoResponse(JSON.stringify({
    orderId: "O1",
    status: "PREPARING",
    etaMinutes: 20,
    storeName: "Bistro Fresh&Fast"
  }), NOW);
  const s1SmallShift = Model.parseGlovoResponse(JSON.stringify({
    orderId: "O1",
    status: "PREPARING",
    etaMinutes: 19,
    storeName: "Bistro Fresh&Fast"
  }), NOW);
  const s1BigShift = Model.parseGlovoResponse(JSON.stringify({
    orderId: "O1",
    status: "PREPARING",
    etaMinutes: 15,
    storeName: "Bistro Fresh&Fast"
  }), NOW);
  const s2StageChange = Model.parseGlovoResponse(JSON.stringify({
    orderId: "O1",
    status: "DELIVERING",
    etaMinutes: 3,
    storeName: "Bistro Fresh&Fast"
  }), NOW);

  assert.strictEqual(s2StageChange.stage, "arriving");

  const smallNotif = Model.buildNotificationPayload(s1, s1SmallShift, { notifyOnStageChange: true, notifyOnEtaChange: true }, fmt, en.t, en.tn);
  assert.strictEqual(smallNotif.shouldNotify, false);

  const etaNotif = Model.buildNotificationPayload(s1, s1BigShift, { notifyOnStageChange: true, notifyOnEtaChange: true }, fmt, en.t, en.tn);
  assert.strictEqual(etaNotif.shouldNotify, true);
  assert.ok(etaNotif.headline.includes("ETA"));

  const stageNotif = Model.buildNotificationPayload(s1BigShift, s2StageChange, { notifyOnStageChange: true, notifyOnEtaChange: false }, fmt, en.t, en.tn);
  assert.strictEqual(stageNotif.shouldNotify, true);
  assert.strictEqual(stageNotif.urgency, "normal");
  assert.strictEqual(stageNotif.soundAsset, "assets/stage-arriving.oga");
  assert.strictEqual(etaNotif.soundAsset, "assets/stage-preparing.oga");
  assert.strictEqual(Model.soundAssetForStage("confirmed"), "assets/stage-confirmed.oga");
  assert.strictEqual(Model.soundAssetForStage("preparing"), "assets/stage-preparing.oga");
  assert.strictEqual(Model.soundAssetForStage("pickup"), "assets/stage-pickup.oga");
  assert.strictEqual(Model.soundAssetForStage("delivering"), "assets/stage-delivering.oga");
  assert.strictEqual(Model.soundAssetForStage("arriving"), "assets/stage-arriving.oga");
  assert.strictEqual(Model.soundAssetForStage("delivered"), "assets/stage-delivered.oga");
  assert.strictEqual(Model.soundAssetForStage("cancelled"), "assets/stage-cancelled.oga");
}

// 6. Demo order progression (matching screenshot on preparing step)
{
  const preparingDemo = Model.createDemoOrder(1, NOW, it.t);
  assert.strictEqual(preparingDemo.stage, "preparing");
  assert.strictEqual(preparingDemo.storeName, "Bistro Fresh&Fast");
  assert.strictEqual(preparingDemo.courierName, "Marco");
  assert.strictEqual(Model.buildStoreMessage(preparingDemo, it.t), "Bistro Fresh&Fast sta preparando il tuo ordine");
  assert.strictEqual(Model.buildCourierMessage(preparingDemo, it.t), "Marco sta aspettando il tuo ordine");
  assert.strictEqual(preparingDemo.etaWindowStart, "13:45");
  assert.strictEqual(preparingDemo.etaWindowEnd, "13:55");

  for (let step = 0; step < 6; step++) {
    const demo = Model.createDemoOrder(step, NOW, it.t);
    assert.strictEqual(demo.hasOrder, true);
    assert.strictEqual(demo.items.length, 3);
    assertNoHtmlTags(Model.buildBarTooltip(demo, fmt, it.t, it.tn), `demo step ${step} tooltip`);
  }
}

// 7. Browser session, cookie extraction, JWT expiry, and DOM parsing (Option B)
{
  const fakeHeader = Buffer.from(JSON.stringify({ alg: "RS512" })).toString("base64url");
  const fakePayload = Buffer.from(JSON.stringify({ exp: 1794840201 })).toString("base64url");
  const fakeJwt = `${fakeHeader}.${fakePayload}.sig123`;
  assert.strictEqual(Model.parseJwtExpiryMs(fakeJwt), 1794840201000);
  assert.strictEqual(Model.parseJwtExpiryMs("not.a.jwt"), 0);

  const encodedCookieVal = encodeURIComponent(JSON.stringify({ accessToken: fakeJwt, refreshToken: "ref" }));
  const foundTok = Model.findGlovoCookieToken([
    { name: "_ga", domain: ".other.example", value: encodedCookieVal },
    { name: "glovo_user_auth", domain: ".glovoapp.com", value: encodedCookieVal }
  ]);
  assert.strictEqual(foundTok, fakeJwt);

  const ignoredTok = Model.findGlovoCookieToken([
    { name: "glovo_user_auth", domain: "evil.example", value: encodedCookieVal }
  ]);
  assert.strictEqual(ignoredTok, "");

  const sess = Model.parseSessionFile(JSON.stringify({
    loggedIn: true,
    status: "<b>connected</b>",
    userName: '<img src="https://example.invalid/t">Alex',
    lastSyncMs: NOW,
    tokenExpMs: 1794840201000
  }));
  assert.strictEqual(sess.loggedIn, true);
  assert.strictEqual(sess.status, "connected");
  assert.strictEqual(sess.userName, "Alex");
  assertNoHtmlTags(sess.status, "session.status");
  assertNoHtmlTags(sess.userName, "session.userName");

  assert.strictEqual(Model.extractGlovoUserName(JSON.stringify({ firstName: "<b>Alex</b>", lastName: "Rossi" })), "Alex");
  assert.strictEqual(Model.extractGlovoUserName({ user: { name: "Alex" } }), "Alex");
  const loggedInTooltip = Model.buildBarTooltip(Model.emptyOrder(), fmt, it.t, it.tn, sess);
  assert.strictEqual(loggedInTooltip, "Glovo Tracker — Ciao, Alex (Nessun ordine attivo)");
  assertNoHtmlTags(loggedInTooltip, "loggedInTooltip");

  // Past-order DOM text ("Consegnato") must NOT trigger an active order
  const pastDom = Model.parseGlovoDomOrder({
    bodyText: "Bistro Fresh&Fast Consegnato 16 Nov, 2026 | 13:56 ID GLOVO: 900000000042"
  }, NOW);
  assert.strictEqual(pastDom.hasOrder, false);
  assert.strictEqual(pastDom.stage, "idle");

  // Active-order DOM text with malicious markup must be parsed and neutralized
  const activeDom = Model.parseGlovoDomOrder({
    bodyText: 'Puntuale 13:45 - 13:55 <img src="https://example.invalid/x">Bistro Fresh&Fast sta preparando il tuo ordine. Marco sta aspettando il tuo ordine https://evil.example',
    items: [{ name: "<b>Pizza Margherita</b>", quantity: 1 }]
  }, NOW);
  assert.strictEqual(activeDom.hasOrder, true);
  assert.strictEqual(activeDom.stage, "preparing");
  assert.strictEqual(activeDom.etaWindowStart, "13:45");
  assert.strictEqual(activeDom.etaWindowEnd, "13:55");
  assert.strictEqual(activeDom.courierName, "Marco");
  assertNoHtmlTags(activeDom.storeName, "dom.storeName");
  assertNoHtmlTags(activeDom.courierName, "dom.courierName");
  assertNoHtmlTags(activeDom.items[0].name, "dom.items[0].name");
  assertNoHtmlTags(Model.buildBarTooltip(activeDom, fmt, it.t, it.tn), "dom tooltip");

  // glovo-session.cjs URL & lang allowlists
  assert.strictEqual(GlovoSession.cleanLang("it-IT"), "it");
  assert.strictEqual(GlovoSession.cleanLang("en;rm -rf"), "it");
  assert.strictEqual(GlovoSession.isAllowedGlovoUrl("https://glovoapp.com/it/profile/orders"), true);
  assert.strictEqual(GlovoSession.isAllowedGlovoUrl("https://api.glovoapp.com/v3/whats_up"), true);
  assert.strictEqual(GlovoSession.isAllowedGlovoUrl("https://evil.example/glovoapp.com"), false);
  assert.strictEqual(GlovoSession.isAllowedGlovoUrl("http://glovoapp.com/it"), false);

  // glovo-session.cjs save-auth via stdin creates 0700 dir + 0600 auth.json and rejects oversized stdin
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "glovo-tracker-test-"));
  try {
    const scriptPath = path.resolve(__dirname, "..", "bin", "glovo-session.cjs");
    execFileSync(process.execPath, [scriptPath, "save-auth"], {
      env: { ...process.env, XDG_STATE_HOME: tmpState },
      input: JSON.stringify({ token: "Bearer tok_123\r\n", orderId: "ORD-42" })
    });
    const stateDir = path.join(tmpState, "omarchy", "glovo-tracker");
    const authPath = path.join(stateDir, "auth.json");
    assert.strictEqual(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(authPath).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.strictEqual(saved.token, "tok_123");
    assert.strictEqual(saved.orderId, "ORD-42");

    let oversizedFailed = false;
    try {
      execFileSync(process.execPath, [scriptPath, "save-auth"], {
        env: { ...process.env, XDG_STATE_HOME: tmpState },
        input: "A".repeat(10000),
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (_) {
      oversizedFailed = true;
    }
    assert.strictEqual(oversizedFailed, true);

    // Verify glovo-session.cjs uses --remote-debugging-pipe and never opens a TCP debugging port
    const sessionSrc = fs.readFileSync(scriptPath, "utf8");
    assert.strictEqual(sessionSrc.includes("--remote-debugging-pipe"), true);
    assert.strictEqual(sessionSrc.includes("--remote-debugging-port"), false);
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
}

// 8. Async tests: pipe CDP framing & preemptive logout while sync holds the lock
(async () => {
  // 8a. createPipeCdpClient NUL-delimited framing, chunk splitting, and event dispatch
  const fakeProc = new EventEmitter();
  const pipeToBrowser = new PassThrough();
  const pipeFromBrowser = new PassThrough();
  fakeProc.stdio = [null, null, null, pipeToBrowser, pipeFromBrowser];

  const cdp = GlovoSession.createPipeCdpClient(fakeProc);
  const receivedEvents = [];
  cdp.on("Network.responseReceived", (params, sid) => receivedEvents.push({ params, sid }));

  let written = "";
  pipeToBrowser.on("data", (c) => { written += c.toString("utf8"); });
  const versionPromise = cdp.send("Browser.getVersion", {}, "sess-1");

  // Feed split chunks containing an event + command response separated by NUL bytes
  const evtFrame = JSON.stringify({ method: "Network.responseReceived", sessionId: "sess-1", params: { requestId: "r1" } }) + "\0";
  const resFrame = JSON.stringify({ id: 1, result: { product: "HeadlessChrome/test" } }) + "\0";
  const combined = Buffer.from(evtFrame + resFrame, "utf8");
  pipeFromBrowser.write(combined.subarray(0, 17));
  pipeFromBrowser.write(combined.subarray(17));

  const versionRes = await versionPromise;
  assert.strictEqual(versionRes.product, "HeadlessChrome/test");
  assert.strictEqual(receivedEvents.length, 1);
  assert.strictEqual(receivedEvents[0].params.requestId, "r1");
  assert.strictEqual(receivedEvents[0].sid, "sess-1");
  assert.ok(written.endsWith("\0"));
  assert.strictEqual(JSON.parse(written.slice(0, -1)).method, "Browser.getVersion");
  cdp.close();

  // 8b. Preemptive sign out succeeds while a concurrent sync holds session.lock
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glovo-logout-race-"));
  const tmpState = path.join(tmpRoot, "state");
  const fakeBin = path.join(tmpRoot, "bin");
  const stateDir = path.join(tmpState, "omarchy", "glovo-tracker");
  const profileDir = path.join(stateDir, "browser-profile");
  const scriptPath = path.resolve(__dirname, "..", "bin", "glovo-session.cjs");
  let syncProc = null;
  let blockerProc = null;

  try {
    fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profileDir, "Cookies"), "secret-cookie-data", { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "auth.json"), JSON.stringify({ token: "secret_tok", orderId: "ORD1" }), { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "session.json"), JSON.stringify({ loggedIn: true, status: "connected", userName: "Alex" }), { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, "order.json"), JSON.stringify({ hasOrder: true, stage: "preparing", source: "browser", storeName: "Bistro" }), { mode: 0o600 });

    // Mock chromium that records its argv (confirming --remote-debugging-pipe) and stays open until terminated
    const argsLog = path.join(tmpRoot, "chromium-args.txt");
    const fakeChromium = path.join(fakeBin, "chromium");
    fs.writeFileSync(fakeChromium, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
setInterval(() => {}, 1000);
`, { mode: 0o755 });

    const env = {
      ...process.env,
      XDG_STATE_HOME: tmpState,
      PATH: `${fakeBin}:${process.env.PATH || ""}`
    };

    syncProc = spawn(process.execPath, [scriptPath, "sync", "it"], { env, stdio: "ignore" });

    // Wait until sync acquires session.lock and spawns mock chromium
    const lockFile = path.join(stateDir, "session.lock");
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(lockFile) && fs.existsSync(argsLog)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(fs.existsSync(lockFile), true, "sync should hold session.lock");
    const launchedArgs = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    assert.strictEqual(launchedArgs.includes("--remote-debugging-pipe"), true, "chromium must use --remote-debugging-pipe");
    assert.strictEqual(launchedArgs.some((a) => a.startsWith("--remote-debugging-port")), false, "chromium must never pass --remote-debugging-port");

    // Trigger logout WHILE sync holds the lock
    execFileSync(process.execPath, [scriptPath, "logout", "it"], { env, timeout: 8000 });

    // Wait briefly for sync process exit and ensure it cannot rewrite credentials
    await new Promise((resolve) => {
      if (syncProc.exitCode !== null || syncProc.signalCode !== null) return resolve();
      syncProc.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
    assert.notStrictEqual(syncProc.exitCode === null && syncProc.signalCode === null, true, "sync should be terminated by logout");
    assert.strictEqual(fs.existsSync(profileDir), false, "browser-profile must be deleted after logout");
    const authAfter = JSON.parse(fs.readFileSync(path.join(stateDir, "auth.json"), "utf8"));
    const sessAfter = JSON.parse(fs.readFileSync(path.join(stateDir, "session.json"), "utf8"));
    const orderAfter = JSON.parse(fs.readFileSync(path.join(stateDir, "order.json"), "utf8"));
    assert.strictEqual(authAfter.token, "");
    assert.strictEqual(sessAfter.loggedIn, false);
    assert.strictEqual(sessAfter.status, "logged_out");
    assert.strictEqual(orderAfter.hasOrder, false);
    assert.strictEqual(fs.existsSync(lockFile), false, "session.lock should be released");
    assert.strictEqual(fs.existsSync(path.join(stateDir, "logout.pending")), false, "logout.pending should be cleaned up");

    // 8c. Verify logout refuses to signal an unrelated PID holding session.lock and fails non-zero
    blockerProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(lockFile, String(blockerProc.pid), { mode: 0o600 });
    let logoutFailed = false;
    try {
      execFileSync(process.execPath, [scriptPath, "logout", "it"], { env, timeout: 9000, stdio: "pipe" });
    } catch (_) {
      logoutFailed = true;
    }
    assert.strictEqual(logoutFailed, true, "logout must fail non-zero if an unrelated PID holds the lock");
    assert.strictEqual(blockerProc.exitCode, null, "logout must never kill an unrelated PID");
    assert.strictEqual(fs.existsSync(path.join(stateDir, "logout.pending")), false, "logout.pending cleaned up on failure");
  } finally {
    if (syncProc && syncProc.exitCode === null) try { syncProc.kill("SIGKILL"); } catch (_) {}
    if (blockerProc && blockerProc.exitCode === null) try { blockerProc.kill("SIGKILL"); } catch (_) {}
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log("All glovo-tracker model & security tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
