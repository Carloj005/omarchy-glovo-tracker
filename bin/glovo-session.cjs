#!/usr/bin/env node

"use strict";

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Model = require(path.resolve(__dirname, "..", "Model.js"));

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "omarchy",
  "glovo-tracker"
);
const PROFILE_DIR = path.join(STATE_DIR, "browser-profile");
const SESSION_FILE = path.join(STATE_DIR, "session.json");
const AUTH_FILE = path.join(STATE_DIR, "auth.json");
const ORDER_FILE = path.join(STATE_DIR, "order.json");
const LOCK_FILE = path.join(STATE_DIR, "session.lock");

const ALLOWED_LANGS = new Set(["it", "en", "es", "fr", "de", "pt", "pl", "ro", "uk"]);
const SYNC_TIMEOUT_MS = 22000;
const LOGIN_TIMEOUT_MS = 300000;

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch (_) {}
}

function ensureProfileDir() {
  ensureStateDir();
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(PROFILE_DIR, 0o700); } catch (_) {}
}

function atomicWriteJson(filePath, obj) {
  ensureStateDir();
  const suffix = crypto.randomBytes(6).toString("hex");
  const tmp = filePath + ".tmp." + process.pid + "." + suffix;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, filePath);
}

async function readBoundedText(res, maxBytes) {
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : Model.MAX_RESPONSE_BYTES;
  const contentLen = Number(res.headers && res.headers.get("content-length") || 0);
  if (contentLen > limit) throw new Error("Response too large");
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > limit) throw new Error("Response too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error("Response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.length > Model.MAX_RESPONSE_BYTES) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireLock() {
  ensureStateDir();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        try {
          const existingPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
          if (!isPidAlive(existingPid)) {
            fs.unlinkSync(LOCK_FILE);
            continue;
          }
        } catch (_) {}
        return false;
      }
      return false;
    }
  }
  return false;
}

function releaseLock() {
  try {
    const owner = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (owner === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

function cleanLang(raw) {
  const base = String(raw || "it").split("-")[0].toLowerCase().trim();
  return ALLOWED_LANGS.has(base) ? base : "it";
}

function notifyDesktop(headline, body, urgency = "low") {
  try {
    execFile(
      "omarchy-notification-send",
      [
        "--app-name", "Glovo Tracker",
        "-g", Model.stageIcon("idle"),
        "-u", urgency,
        Model.neutralizeMarkup(headline, 80) || "Glovo Tracker",
        Model.neutralizeMarkup(body, 160)
      ],
      { timeout: 4000 },
      () => {}
    );
  } catch (_) {}
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();

    const openTimer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("CDP connection timeout"));
    }, 8000);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params = {}, sessionId = undefined) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout for ${method}`));
            }, 8000);
            pending.set(id, { res, rej, timer });
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
          });
        },
        on(eventName, handler) {
          if (!listeners.has(eventName)) listeners.set(eventName, []);
          listeners.get(eventName).push(handler);
        },
        close() {
          for (const { rej, timer } of pending.values()) {
            clearTimeout(timer);
            rej(new Error("CDP closed"));
          }
          pending.clear();
          try { ws.close(); } catch (_) {}
        }
      });
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data || "")); } catch (_) { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.rej(new Error(msg.error.message || "CDP error"));
        else entry.res(msg.result || {});
        return;
      }
      if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) {
          try { fn(msg.params || {}, msg.sessionId); } catch (_) {}
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(openTimer);
      reject(err instanceof Error ? err : new Error("CDP WebSocket error"));
    });
  });
}

function launchChromium(args, startUrl) {
  return new Promise((resolve, reject) => {
    const finalArgs = startUrl ? [...args, startUrl] : [...args];
    const proc = spawn("chromium", finalArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderrBuf = "";
    let settled = false;

    const bootTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGTERM"); } catch (_) {}
        reject(new Error("Chromium CDP startup timeout"));
      }
    }, 10000);

    proc.stderr.on("data", (chunk) => {
      if (settled) return;
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 32768) stderrBuf = stderrBuf.slice(-16384);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(stderrBuf);
      if (match) {
        settled = true;
        clearTimeout(bootTimer);
        resolve({ proc, wsUrl: match[1] });
      }
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(bootTimer);
        reject(new Error(`Chromium exited early with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(bootTimer);
        reject(err);
      }
    });
  });
}

function stopChromium(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill("SIGTERM"); } catch (_) {}
  setTimeout(() => {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch (_) {}
  }, 1500).unref();
}

function saveTokenAndSession(token, reason = "", userName = "") {
  const existingAuth = readJsonSafe(AUTH_FILE) || {};
  const existingSession = readJsonSafe(SESSION_FILE) || {};
  const existingOrderId = Model.sanitizeOrderId(existingAuth.orderId || "");
  const cleanTok = Model.sanitizeToken(token);
  const cleanName = Model.neutralizeMarkup(userName || existingSession.userName || "", 48);
  const now = Date.now();
  if (cleanTok) {
    const expMs = Model.parseJwtExpiryMs(cleanTok);
    atomicWriteJson(AUTH_FILE, {
      token: cleanTok,
      orderId: existingOrderId
    });
    atomicWriteJson(SESSION_FILE, {
      loggedIn: true,
      status: "connected",
      userName: cleanName,
      tokenExpMs: expMs,
      lastSyncMs: now,
      updatedAtMs: now,
      reason: ""
    });
    return true;
  }
  atomicWriteJson(SESSION_FILE, {
    loggedIn: false,
    status: "needs_login",
    userName: "",
    tokenExpMs: 0,
    lastSyncMs: now,
    updatedAtMs: now,
    reason: Model.neutralizeMarkup(reason || "needs_login", 80)
  });
  return false;
}

async function fetchGlovoUserName(token, lang) {
  const cleanTok = Model.sanitizeToken(token);
  if (!cleanTok || typeof fetch !== "function") return "";
  try {
    const res = await fetch("https://api.glovoapp.com/v3/me", {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Authorization": cleanTok,
        "Glovo-Api-Version": "14",
        "Glovo-App-Platform": "web",
        "Glovo-App-Type": "customer",
        "Glovo-Language-Code": lang,
        "Origin": "https://glovoapp.com",
        "Referer": "https://glovoapp.com/"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return "";
    const text = await readBoundedText(res, Model.MAX_RESPONSE_BYTES);
    if (!text) return "";
    return Model.extractGlovoUserName(text);
  } catch (_) {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAllowedGlovoUrl(urlStr) {
  return typeof urlStr === "string"
    && (urlStr.startsWith("https://glovoapp.com/") || urlStr.startsWith("https://api.glovoapp.com/"));
}

async function runSync(lang) {
  if (!fs.existsSync(PROFILE_DIR)) {
    saveTokenAndSession("", "profile_missing");
    return;
  }
  if (!acquireLock()) {
    process.stderr.write("glovo-session: sync skipped (lock held)\n");
    return;
  }

  let proc = null;
  let cdp = null;
  const hardTimer = setTimeout(() => {
    if (cdp) cdp.close();
    stopChromium(proc);
    releaseLock();
    process.exit(1);
  }, SYNC_TIMEOUT_MS);

  try {
    const startUrl = `https://glovoapp.com/${lang}/profile/orders`;
    const launched = await launchChromium([
      "--headless=new",
      `--user-data-dir=${PROFILE_DIR}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-background-networking"
    ], "about:blank");
    proc = launched.proc;
    cdp = await createCdpClient(launched.wsUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 131072 }, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    const trackedResponses = new Map();
    const capturedJsonBodies = [];
    const inflightBodies = [];

    cdp.on("Network.responseReceived", (params, sid) => {
      if (sid !== sessionId) return;
      const resp = params.response || {};
      const reqUrl = String(resp.url || "");
      if (!reqUrl.startsWith("https://api.glovoapp.com/")) return;
      if (resp.status >= 200 && resp.status < 300) {
        trackedResponses.set(params.requestId, reqUrl);
      }
    });

    cdp.on("Network.loadingFinished", (params, sid) => {
      if (sid !== sessionId) return;
      if (!trackedResponses.has(params.requestId)) return;
      const reqUrl = trackedResponses.get(params.requestId);
      trackedResponses.delete(params.requestId);
      if (params.encodedDataLength > Model.MAX_RESPONSE_BYTES * 2) return;
      const job = (async () => {
        try {
          const bodyRes = await cdp.send("Network.getResponseBody", { requestId: params.requestId }, sessionId);
          if (bodyRes && !bodyRes.base64Encoded && typeof bodyRes.body === "string" && bodyRes.body.length <= Model.MAX_RESPONSE_BYTES) {
            capturedJsonBodies.push({ url: reqUrl, body: bodyRes.body });
          }
        } catch (_) {}
      })();
      inflightBodies.push(job);
    });

    await cdp.send("Page.navigate", { url: startUrl }, sessionId);
    await delay(4500);
    await Promise.allSettled(inflightBodies.splice(0, inflightBodies.length));

    // Check cookies from browser profile (Chromium auto-refreshes HttpOnly glov... cookie)
    const cookieRes = await cdp.send("Storage.getCookies", {}, sessionId);
    const cookies = Array.isArray(cookieRes.cookies) ? cookieRes.cookies : [];
    const token = Model.findGlovoCookieToken(cookies);

    const pageInfoRes = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const title = String(document.title || "").slice(0, 120);
        const href = String(location.href || "").slice(0, 300);
        const text = String((document.body && document.body.innerText) || "").slice(0, 4096);
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href') || '')
          .filter(h => /\\/(tracking|orders)\\//i.test(h) && !/past-orders/i.test(h))
          .slice(0, 5);
        return { title, href, text, links };
      })()`,
      returnByValue: true
    }, sessionId);

    const pageInfo = (pageInfoRes && pageInfoRes.result && pageInfoRes.result.value) || {};
    const pageTextLower = String(pageInfo.text || "").toLowerCase();
    const pageTitleLower = String(pageInfo.title || "").toLowerCase();
    const blockedOrLoggedOut = !token && (
      /just a moment|attention required|cloudflare|verify you are human/.test(pageTitleLower + " " + pageTextLower)
      || /accedi|registrati|sign in|log in/.test(pageTextLower)
    );

    if (!token || blockedOrLoggedOut) {
      saveTokenAndSession("", blockedOrLoggedOut ? "needs_login" : "no_cookie");
      return;
    }

    let userName = "";
    for (const item of capturedJsonBodies) {
      if (item.url.includes("/v3/me")) {
        userName = Model.extractGlovoUserName(item.body);
        if (userName) break;
      }
    }
    if (!userName) {
      const existingSession = readJsonSafe(SESSION_FILE);
      userName = existingSession && existingSession.userName
        ? Model.neutralizeMarkup(existingSession.userName, 48)
        : await fetchGlovoUserName(token, lang);
    }

    saveTokenAndSession(token, "", userName);

    // 1. Check captured api.glovoapp.com JSON payloads first
    let activeOrder = null;
    for (const item of capturedJsonBodies) {
      const parsed = Model.parseGlovoResponse(item.body, Date.now());
      if (parsed && parsed.hasOrder) {
        parsed.source = "browser";
        activeOrder = parsed;
        break;
      }
    }

    // 2. If there is a dedicated active-order tracking link on /profile/orders, visit it once
    if (!activeOrder && Array.isArray(pageInfo.links) && pageInfo.links.length > 0) {
      const candidate = String(pageInfo.links[0] || "");
      const targetUrl = candidate.startsWith("/")
        ? "https://glovoapp.com" + candidate
        : candidate;
      if (isAllowedGlovoUrl(targetUrl)) {
        await cdp.send("Page.navigate", { url: targetUrl }, sessionId);
        await delay(3500);
        await Promise.allSettled(inflightBodies.splice(0, inflightBodies.length));
        for (const item of capturedJsonBodies) {
          const parsed = Model.parseGlovoResponse(item.body, Date.now());
          if (parsed && parsed.hasOrder) {
            parsed.source = "browser";
            activeOrder = parsed;
            break;
          }
        }
        if (!activeOrder) {
          const trackRes = await cdp.send("Runtime.evaluate", {
            expression: `(() => ({
              bodyText: String((document.body && document.body.innerText) || "").slice(0, 4096)
            }))()`,
            returnByValue: true
          }, sessionId);
          const snap = (trackRes && trackRes.result && trackRes.result.value) || {};
          const domParsed = Model.parseGlovoDomOrder(snap, Date.now());
          if (domParsed && domParsed.hasOrder) activeOrder = domParsed;
        }
      }
    }

    // 3. Fallback: inspect /profile/orders DOM directly for an active order card
    if (!activeOrder) {
      const domParsed = Model.parseGlovoDomOrder({ bodyText: pageInfo.text || "" }, Date.now());
      if (domParsed && domParsed.hasOrder) activeOrder = domParsed;
    }

    if (activeOrder && activeOrder.hasOrder) {
      atomicWriteJson(ORDER_FILE, activeOrder);
    } else {
      const prevOrder = readJsonSafe(ORDER_FILE);
      if (!prevOrder || prevOrder.source === "browser" || prevOrder.source === "api") {
        atomicWriteJson(ORDER_FILE, {
          hasOrder: false,
          status: "idle",
          source: "browser",
          updatedAtMs: Date.now()
        });
      }
    }
  } finally {
    clearTimeout(hardTimer);
    if (cdp) cdp.close();
    stopChromium(proc);
    releaseLock();
  }
}

async function runLogin(lang) {
  ensureProfileDir();
  if (!acquireLock()) {
    process.stderr.write("glovo-session: another session action is running\n");
    process.exit(1);
  }

  let proc = null;

  const loginTimer = setTimeout(() => {
    stopChromium(proc);
  }, LOGIN_TIMEOUT_MS);

  try {
    const startUrl = `https://glovoapp.com/${lang}/${lang}`;
    // Launch clean Chromium without --remote-debugging-port so Google OAuth
    // does not flag the interactive login window as automated/debugging.
    await new Promise((resolve, reject) => {
      proc = spawn("chromium", [
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--disable-default-apps",
        startUrl
      ], {
        stdio: "ignore"
      });
      proc.on("close", () => resolve());
      proc.on("error", (err) => reject(err));
    });
  } finally {
    clearTimeout(loginTimer);
    stopChromium(proc);
    releaseLock();
  }

  await runSync(lang);
  const sess = readJsonSafe(SESSION_FILE);
  if (sess && sess.loggedIn) {
    const greeting = sess.userName
      ? (lang === "it" ? `Ciao, ${sess.userName}` : `Hi, ${sess.userName}`)
      : (lang === "it" ? "Glovo connesso" : "Glovo connected");
    notifyDesktop(
      greeting,
      lang === "it"
        ? "Sessione salvata con successo."
        : "Session saved successfully."
    );
  }
}

function runLogout() {
  if (!acquireLock()) {
    process.stderr.write("glovo-session: lock held\n");
    process.exit(1);
  }
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    atomicWriteJson(AUTH_FILE, { token: "", orderId: "" });
    atomicWriteJson(SESSION_FILE, {
      loggedIn: false,
      status: "logged_out",
      userName: "",
      tokenExpMs: 0,
      lastSyncMs: 0,
      updatedAtMs: Date.now(),
      reason: ""
    });
    const prevOrder = readJsonSafe(ORDER_FILE);
    if (prevOrder && (prevOrder.source === "browser" || prevOrder.source === "api")) {
      atomicWriteJson(ORDER_FILE, {
        hasOrder: false,
        status: "idle",
        source: "browser",
        updatedAtMs: Date.now()
      });
    }
  } finally {
    releaseLock();
  }
}

async function runSaveAuth() {
  const MAX_AUTH_STDIN_BYTES = 8192;
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_AUTH_STDIN_BYTES) {
      process.stderr.write("glovo-session: auth payload too large\n");
      process.exit(1);
    }
    chunks.push(buf);
  }
  let parsed = {};
  try {
    const raw = Buffer.concat(chunks, total).toString("utf8").trim();
    if (raw) parsed = JSON.parse(raw);
  } catch (_) {
    process.stderr.write("glovo-session: invalid auth JSON\n");
    process.exit(1);
  }
  const cleanToken = Model.sanitizeToken(parsed && parsed.token ? parsed.token : "");
  const cleanOrderId = Model.sanitizeOrderId(parsed && parsed.orderId ? parsed.orderId : "");
  atomicWriteJson(AUTH_FILE, {
    token: cleanToken,
    orderId: cleanOrderId
  });
}

async function runFetchApi(lang, mode, orderIdArg) {
  const auth = readJsonSafe(AUTH_FILE);
  const token = Model.sanitizeToken(auth && auth.token ? auth.token : "");
  if (!token || typeof fetch !== "function") {
    process.exit(1);
  }
  const cleanOrderId = Model.sanitizeOrderId(orderIdArg || (auth && auth.orderId) || "");
  const url = mode === "whatsup"
    ? Model.buildGlovoWhatsUpUrl()
    : Model.buildGlovoApiUrl(cleanOrderId);
  if (!isAllowedGlovoUrl(url)) {
    process.exit(1);
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Authorization": token,
      "Glovo-Api-Version": "14",
      "Glovo-App-Platform": "web",
      "Glovo-App-Type": "customer",
      "Glovo-Language-Code": lang,
      "Origin": "https://glovoapp.com",
      "Referer": "https://glovoapp.com/"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    process.stderr.write(`glovo-session: HTTP ${res.status}\n`);
    process.exit(1);
  }
  const text = await readBoundedText(res, Model.MAX_RESPONSE_BYTES);
  process.stdout.write(text);
}

async function main() {
  const cmd = String(process.argv[2] || "sync").toLowerCase();
  const lang = cleanLang(process.argv[3] || "it");

  if (cmd === "login") {
    await runLogin(lang);
  } else if (cmd === "sync") {
    await runSync(lang);
  } else if (cmd === "logout") {
    runLogout();
  } else if (cmd === "save-auth") {
    await runSaveAuth();
  } else if (cmd === "fetch-api") {
    const mode = String(process.argv[4] || "active").toLowerCase();
    const orderIdArg = String(process.argv[5] || "");
    await runFetchApi(lang, mode, orderIdArg);
  } else {
    process.stderr.write("Usage: glovo-session.cjs <login|sync|logout|save-auth|fetch-api> [lang]\n");
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`glovo-session error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  cleanLang,
  isAllowedGlovoUrl
};
