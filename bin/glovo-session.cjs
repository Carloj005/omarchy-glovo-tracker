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
const LOGOUT_MARKER = path.join(STATE_DIR, "logout.pending");

const ALLOWED_LANGS = new Set(["it", "en", "es", "fr", "de", "pt", "pl", "ro", "uk"]);
const SYNC_TIMEOUT_MS = 22000;
const LOGIN_TIMEOUT_MS = 300000;
const LOGOUT_WAIT_MS = 6000;
const MAX_CDP_BUFFER_BYTES = 4 * 1024 * 1024;

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

function isGlovoSessionPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (!isPidAlive(pid)) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return cmdline.includes("glovo-session.cjs");
  } catch (_) {
    return false;
  }
}

function readPidFile(filePath) {
  try {
    const pid = parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (_) {
    return 0;
  }
}

function writeLogoutMarker() {
  ensureStateDir();
  const suffix = crypto.randomBytes(6).toString("hex");
  const tmp = LOGOUT_MARKER + ".tmp." + process.pid + "." + suffix;
  fs.writeFileSync(tmp, String(process.pid) + "\n", { mode: 0o600, flag: "wx" });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, LOGOUT_MARKER);
}

function clearLogoutMarker() {
  try {
    const owner = readPidFile(LOGOUT_MARKER);
    if (owner === process.pid || (owner > 0 && !isPidAlive(owner))) {
      fs.unlinkSync(LOGOUT_MARKER);
    }
  } catch (_) {}
}

function isLogoutRequested() {
  if (!fs.existsSync(LOGOUT_MARKER)) return false;
  const owner = readPidFile(LOGOUT_MARKER);
  if (owner === process.pid || isGlovoSessionPid(owner)) return true;
  // Clean up stale marker left by a crashed logout process
  if (owner > 0 && !isPidAlive(owner)) {
    try { fs.unlinkSync(LOGOUT_MARKER); } catch (_) {}
    return false;
  }
  return true;
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
          const existingPid = readPidFile(LOCK_FILE);
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
    const owner = readPidFile(LOCK_FILE);
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

function createPipeCdpClient(proc) {
  const pipeOut = proc && proc.stdio ? proc.stdio[3] : null;
  const pipeIn = proc && proc.stdio ? proc.stdio[4] : null;
  if (!pipeOut || !pipeIn) {
    throw new Error("Chromium CDP pipe streams unavailable");
  }

  let nextId = 1;
  let closed = false;
  let rxBuf = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Map();

  function failAll(err) {
    if (closed) return;
    closed = true;
    for (const { rej, timer } of pending.values()) {
      clearTimeout(timer);
      rej(err);
    }
    pending.clear();
  }

  pipeOut.on("error", (err) => failAll(err instanceof Error ? err : new Error("CDP pipe write error")));
  pipeIn.on("error", (err) => failAll(err instanceof Error ? err : new Error("CDP pipe read error")));
  pipeIn.on("end", () => failAll(new Error("CDP pipe closed")));
  proc.on("exit", (code) => failAll(new Error(`Chromium exited (${code})`)));
  proc.on("error", (err) => failAll(err instanceof Error ? err : new Error("Chromium process error")));

  pipeIn.on("data", (chunk) => {
    if (closed) return;
    rxBuf = rxBuf.length > 0 ? Buffer.concat([rxBuf, chunk]) : Buffer.from(chunk);
    if (rxBuf.length > MAX_CDP_BUFFER_BYTES) {
      failAll(new Error("CDP pipe message exceeded buffer limit"));
      return;
    }
    let nulIdx = rxBuf.indexOf(0);
    while (nulIdx !== -1) {
      const raw = rxBuf.subarray(0, nulIdx).toString("utf8");
      rxBuf = rxBuf.subarray(nulIdx + 1);
      if (raw.length > 0) {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { msg = null; }
        if (msg) {
          if (msg.id !== undefined && pending.has(msg.id)) {
            const entry = pending.get(msg.id);
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.rej(new Error(msg.error.message || "CDP error"));
            else entry.res(msg.result || {});
          } else if (msg.method && listeners.has(msg.method)) {
            for (const fn of listeners.get(msg.method)) {
              try { fn(msg.params || {}, msg.sessionId); } catch (_) {}
            }
          }
        }
      }
      nulIdx = rxBuf.indexOf(0);
    }
  });

  return {
    send(method, params = {}, sessionId = undefined) {
      return new Promise((res, rej) => {
        if (closed) {
          rej(new Error("CDP pipe closed"));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`CDP timeout for ${method}`));
        }, 8000);
        pending.set(id, { res, rej, timer });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        try {
          pipeOut.write(JSON.stringify(payload) + "\0");
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          rej(err instanceof Error ? err : new Error("CDP write failed"));
        }
      });
    },
    on(eventName, handler) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(handler);
    },
    close() {
      failAll(new Error("CDP closed"));
      try { pipeOut.destroy(); } catch (_) {}
      try { pipeIn.destroy(); } catch (_) {}
    }
  };
}

function launchChromiumPipe(args, startUrl) {
  const finalArgs = startUrl ? [...args, startUrl] : [...args];
  // Use inherited anonymous pipes (FD 3/4) via --remote-debugging-pipe so Chromium
  // never opens any TCP listening port on loopback or any other interface.
  const proc = spawn("chromium", finalArgs, {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]
  });
  const cdp = createPipeCdpClient(proc);
  return { proc, cdp };
}

function stopChromium(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try { proc.kill("SIGTERM"); } catch (_) {}
  setTimeout(() => {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch (_) {}
  }, 1500).unref();
}

function stopChromiumAndWait(proc, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };
    proc.once("exit", finish);
    proc.once("close", finish);
    try { proc.kill("SIGTERM"); } catch (_) { finish(); return; }
    const killTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      } catch (_) {}
    }, Math.min(1200, Math.floor(timeoutMs * 0.6)));
    killTimer.unref();
    const giveUpTimer = setTimeout(finish, timeoutMs);
    giveUpTimer.unref();
  });
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

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAllowedGlovoUrl(urlStr) {
  return typeof urlStr === "string"
    && (urlStr.startsWith("https://glovoapp.com/") || urlStr.startsWith("https://api.glovoapp.com/"));
}

async function runSync(lang) {
  if (isLogoutRequested()) return;
  if (!acquireLock()) {
    process.stderr.write("glovo-session: sync skipped (lock held)\n");
    return;
  }

  let proc = null;
  let cdp = null;
  const abortController = new AbortController();
  const isAborted = () => abortController.signal.aborted || isLogoutRequested();

  const onSignal = () => {
    abortController.abort();
    if (cdp) cdp.close();
    stopChromium(proc);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const hardTimer = setTimeout(() => {
    abortController.abort();
    if (cdp) cdp.close();
    stopChromium(proc);
  }, SYNC_TIMEOUT_MS);

  try {
    if (isAborted()) return;
    if (!fs.existsSync(PROFILE_DIR)) {
      const existingSess = readJsonSafe(SESSION_FILE);
      if (existingSess && existingSess.loggedIn) {
        saveTokenAndSession("", "profile_missing");
      }
      return;
    }

    const startUrl = `https://glovoapp.com/${lang}/profile/orders`;
    const launched = launchChromiumPipe([
      "--headless=new",
      `--user-data-dir=${PROFILE_DIR}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-background-networking"
    ], "about:blank");
    proc = launched.proc;
    cdp = launched.cdp;

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
    await delay(4500, abortController.signal);
    if (isAborted()) return;
    await Promise.allSettled(inflightBodies.splice(0, inflightBodies.length));
    if (isAborted()) return;

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
    if (isAborted()) return;

    const pageInfo = (pageInfoRes && pageInfoRes.result && pageInfoRes.result.value) || {};
    const pageTextLower = String(pageInfo.text || "").toLowerCase();
    const pageTitleLower = String(pageInfo.title || "").toLowerCase();
    const blockedOrLoggedOut = !token && (
      /just a moment|attention required|cloudflare|verify you are human/.test(pageTitleLower + " " + pageTextLower)
      || /accedi|registrati|sign in|log in/.test(pageTextLower)
    );

    if (!token || blockedOrLoggedOut) {
      if (!isAborted()) {
        saveTokenAndSession("", blockedOrLoggedOut ? "needs_login" : "no_cookie");
      }
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

    if (isAborted()) return;
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
    if (!activeOrder && !isAborted() && Array.isArray(pageInfo.links) && pageInfo.links.length > 0) {
      const candidate = String(pageInfo.links[0] || "");
      const targetUrl = candidate.startsWith("/")
        ? "https://glovoapp.com" + candidate
        : candidate;
      if (isAllowedGlovoUrl(targetUrl)) {
        await cdp.send("Page.navigate", { url: targetUrl }, sessionId);
        await delay(3500, abortController.signal);
        if (isAborted()) return;
        await Promise.allSettled(inflightBodies.splice(0, inflightBodies.length));
        if (isAborted()) return;
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

    if (isAborted()) return;
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
  } catch (err) {
    if (!isAborted()) throw err;
  } finally {
    clearTimeout(hardTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (cdp) cdp.close();
    await stopChromiumAndWait(proc, 2000);
    releaseLock();
  }
}

async function runLogin(lang) {
  if (isLogoutRequested()) {
    process.stderr.write("glovo-session: logout in progress\n");
    process.exit(1);
  }
  ensureProfileDir();
  if (!acquireLock()) {
    process.stderr.write("glovo-session: another session action is running\n");
    process.exit(1);
  }

  let proc = null;
  let aborted = false;

  const onSignal = () => {
    aborted = true;
    stopChromium(proc);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const loginTimer = setTimeout(() => {
    stopChromium(proc);
  }, LOGIN_TIMEOUT_MS);

  try {
    const startUrl = `https://glovoapp.com/${lang}/${lang}`;
    // Launch clean Chromium without remote debugging flags so Google OAuth
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
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await stopChromiumAndWait(proc, 2000);
    releaseLock();
  }

  if (aborted || isLogoutRequested()) return;

  await runSync(lang);
  if (aborted || isLogoutRequested()) return;
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

async function runLogout() {
  writeLogoutMarker();
  let lockAcquired = false;
  try {
    const startMs = Date.now();
    const signaled = new Set();
    const killed = new Set();

    while (Date.now() - startMs < LOGOUT_WAIT_MS) {
      if (acquireLock()) {
        lockAcquired = true;
        break;
      }
      const holderPid = readPidFile(LOCK_FILE);
      if (holderPid > 0 && isGlovoSessionPid(holderPid)) {
        const elapsed = Date.now() - startMs;
        if (!signaled.has(holderPid)) {
          signaled.add(holderPid);
          try { process.kill(holderPid, "SIGTERM"); } catch (_) {}
        } else if (elapsed >= 3000 && !killed.has(holderPid)) {
          killed.add(holderPid);
          try { process.kill(holderPid, "SIGKILL"); } catch (_) {}
        }
      }
      await delay(100);
    }

    if (!lockAcquired) {
      throw new Error("could not acquire session lock for logout");
    }

    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    if (fs.existsSync(PROFILE_DIR)) {
      throw new Error("Failed to remove browser profile directory");
    }
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
    if (lockAcquired) releaseLock();
    clearLogoutMarker();
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
  if (isLogoutRequested()) {
    process.exit(1);
  }
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
  if (isLogoutRequested()) {
    process.exit(1);
  }
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
    await runLogout();
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
  isAllowedGlovoUrl,
  createPipeCdpClient
};
