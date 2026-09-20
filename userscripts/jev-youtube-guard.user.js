// ==UserScript==
// @name         Jev YouTube Guard
// @namespace    https://github.com/yoshi47/jev-youtube-guard
// @version      0.2.1
// @description  Block high-confidence entertainment videos using TypeSafe Jev.
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/shorts/*
// @match        https://youtube.com/watch*
// @match        https://youtube.com/shorts/*
// @match        https://m.youtube.com/watch*
// @match        https://m.youtube.com/shorts/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  const SCRIPT_VERSION = "0.2.1";
  const CONFIG = {
    endpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/classify",
    clientToken: "YOUR_CLIENT_TOKEN",
    confidenceThreshold: 0.6,
  };

  const OVERRIDE_PREFIX = "jev-youtube-guard:allow:";
  const RESULT_PREFIX = "jev-youtube-guard:result:";
  const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CLASSIFICATION_TIMEOUT_MS = 10_000;
  const OVERLAY_ID = "jev-youtube-guard-overlay";
  const DEBUG_PANEL_ID = "jev-youtube-guard-debug";
  const DEBUG_FLAG_KEY = "jev-youtube-guard:debug";
  const policy = {
    isTargetPage,
    shouldBlock,
    isDebugEnabled,
  };

  globalThis.JevYouTubeGuardPolicy = policy;

  let activeVideoKey = "";
  let runToken = 0;
  let statusTimer = 0;
  let debugMode = false;

  if (typeof document === "undefined" || !isTargetPage(location.href)) return;

  debugMode = isDebugEnabled(location.href);

  void initialize();

  async function initialize() {
    await waitForDocumentElement();
    installOverlay();
    if (debugMode) installDebugPanel();
    dbg(`init url=${location.href}`);
    await evaluateCurrentVideo();

    document.addEventListener("yt-navigate-finish", () => {
      void evaluateCurrentVideo();
    });
    document.addEventListener("yt-page-data-updated", () => {
      void evaluateCurrentVideo();
    });
    window.addEventListener("popstate", () => {
      void evaluateCurrentVideo();
    });
  }

  async function evaluateCurrentVideo() {
    debugMode = isDebugEnabled(location.href);
    if (debugMode) installDebugPanel();
    dbg(`evaluate url=${location.href}`);
    if (!isTargetPage(location.href)) {
      activeVideoKey = "";
      hideOverlay();
      dbg("not a target page, skip");
      return;
    }

    const currentToken = ++runToken;
    const videoKey = getVideoKey(location.href);
    dbg(`videoKey=${videoKey || "(empty)"}`);
    if (!videoKey || videoKey === activeVideoKey) return;
    activeVideoKey = videoKey;

    const overrideKey = `${OVERRIDE_PREFIX}${videoKey}`;
    if (storageGet(overrideKey) === "1") {
      dbg("allow-listed override, skip");
      hideOverlay();
      return;
    }

    showOverlay("Jevで判定中…");
    const cachedResult = readCachedResult(videoKey);
    if (cachedResult) {
      dbg(`cache hit category=${cachedResult.category} confidence=${cachedResult.confidence}`);
      applyResult(cachedResult, overrideKey);
      return;
    }
    dbg("cache miss, reading metadata");

    const metadata = await readVideoMetadata(videoKey);
    if (currentToken !== runToken) return;

    if (!metadata) {
      dbg("metadata not found within timeout, allow");
      showResultStatus("Jev判定: 動画情報を取得できなかったため許可");
      return;
    }
    dbg(`metadata ok titleLen=${metadata.title.length} channel=${metadata.channel}`);

    try {
      dbg(`POST ${CONFIG.endpoint}`);
      const result = await classify(metadata);
      if (currentToken !== runToken) return;

      dbg(`result category=${result.category} confidence=${result.confidence}`);
      writeCachedResult(videoKey, result);
      applyResult(result, overrideKey);
    } catch (error) {
      // A classifier outage must not prevent normal browsing.
      console.warn("[Jev YouTube Guard] classification failed", error);
      dbg(`classify failed: ${error instanceof Error ? error.message : error}`);
      showResultStatus("Jev判定: 通信失敗のため許可");
    }
  }

  function applyResult(result, overrideKey) {
    dbg(`decision=${shouldBlock(result) ? "BLOCK" : "ALLOW"}`);
    if (shouldBlock(result)) {
      showOverlay("エンタメ判定のためブロックしました", () => {
        storageSet(overrideKey, "1");
        hideOverlay();
      });
    } else {
      const category =
        result?.category === "study"
          ? "勉強用"
          : result?.category === "entertainment"
            ? "エンタメ候補（信頼度が閾値未満）"
            : "その他";
      const confidence = Number.isFinite(result?.confidence)
        ? ` ${Math.round(result.confidence * 100)}%`
        : "";
      showResultStatus(`Jev判定: ${category}${confidence}・許可`);
    }
  }

  function showResultStatus(message) {
    showOverlay(message);
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(hideOverlay, 2500);
  }

  function readCachedResult(videoKey) {
    try {
      const raw = storageGet(`${RESULT_PREFIX}${videoKey}`);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - cached.createdAt > RESULT_TTL_MS) {
        storageRemove(`${RESULT_PREFIX}${videoKey}`);
        return null;
      }
      return cached.result;
    } catch {
      return null;
    }
  }

  function writeCachedResult(videoKey, result) {
    storageSet(`${RESULT_PREFIX}${videoKey}`, JSON.stringify({ createdAt: Date.now(), result }));
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      dbg("localStorage is unavailable, continuing without cache");
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A full or restricted localStorage must not block the video.
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // A restricted localStorage must not block the video.
    }
  }

  async function readVideoMetadata(videoKey) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const title =
        findText(["h1.ytd-watch-metadata yt-formatted-string", "h1 yt-formatted-string"]) ||
        metaContent('meta[name="title"]') ||
        document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
      const channel =
        findText(["ytd-watch-metadata ytd-channel-name a", "#owner ytd-channel-name a"]) ||
        metaContent('[itemprop="author"] [itemprop="name"]') ||
        metaContent('[itemprop="author"]');

      if (title && channel) {
        return {
          url: location.href,
          title,
          channel,
          description: findText([
            "ytd-text-inline-expander#description-inline-expander",
            "#description",
          ]),
          videoKey,
          clientVersion: SCRIPT_VERSION,
        };
      }
      await delay(250);
    }
    return null;
  }

  async function classify(metadata) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLASSIFICATION_TIMEOUT_MS);
    try {
      const response = await fetch(CONFIG.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.clientToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Worker request failed: ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function installOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.style.cssText = [
      "position: fixed",
      "inset: 0",
      "z-index: 2147483647",
      "display: grid",
      "place-items: center",
      "background: transparent",
      "color: #111",
      "font: 16px -apple-system, BlinkMacSystemFont, sans-serif",
      "text-align: center",
      "padding: 24px",
      "pointer-events: none",
    ].join(";");
    document.documentElement.appendChild(overlay);
  }

  function showOverlay(message, onAllow) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    window.clearTimeout(statusTimer);
    overlay.hidden = false;
    overlay.innerHTML = "";
    const blocked = Boolean(onAllow);
    overlay.style.inset = blocked ? "0" : "12px 12px auto auto";
    overlay.style.padding = blocked ? "24px" : "8px 12px";
    overlay.style.borderRadius = blocked ? "0" : "8px";
    overlay.style.boxShadow = blocked ? "none" : "0 2px 12px rgba(0, 0, 0, 0.18)";
    overlay.style.width = blocked ? "auto" : "auto";
    overlay.style.background = blocked ? "rgba(255, 255, 255, 0.96)" : "rgba(255, 255, 255, 0.94)";
    overlay.style.pointerEvents = blocked ? "auto" : "none";

    const content = document.createElement("div");
    content.style.cssText = blocked
      ? "max-width: 420px; padding: 24px; border: 1px solid #bbb; border-radius: 12px; background: #fff; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);"
      : "";
    const text = document.createElement("p");
    text.textContent = message;
    content.appendChild(text);

    if (onAllow) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "この動画だけ表示する";
      button.style.cssText =
        "padding: 10px 14px; border: 1px solid #999; border-radius: 8px; background: #fff;";
      button.addEventListener("click", onAllow, { once: true });
      content.appendChild(button);
    }
    overlay.appendChild(content);
  }

  function hideOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    window.clearTimeout(statusTimer);
    if (overlay) overlay.hidden = true;
  }

  function findText(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text) return text;
    }
    return "";
  }

  function metaContent(selector) {
    return document.querySelector(selector)?.getAttribute("content")?.trim() || "";
  }

  function isDebugEnabled(urlString) {
    if (storageGet(DEBUG_FLAG_KEY) === "1") return true;
    try {
      const url = new URL(urlString);
      return url.searchParams.has("jevdebug") || url.hash.includes("jevdebug");
    } catch {
      return false;
    }
  }

  function dbg(message) {
    if (!debugMode) return;
    console.warn("[Jev YouTube Guard][debug]", message);
    const panel = document.getElementById(DEBUG_PANEL_ID);
    if (!panel) return;
    const line = document.createElement("div");
    line.textContent = `${new Date().toISOString().slice(11, 19)} ${message}`;
    panel.appendChild(line);
    while (panel.children.length > 40) panel.firstChild?.remove();
  }

  function installDebugPanel() {
    if (document.getElementById(DEBUG_PANEL_ID)) return;
    const panel = document.createElement("div");
    panel.id = DEBUG_PANEL_ID;
    panel.style.cssText = [
      "position: fixed",
      "left: 8px",
      "bottom: 8px",
      "z-index: 2147483647",
      "max-width: 92vw",
      "max-height: 40vh",
      "overflow-y: auto",
      "background: rgba(0, 0, 0, 0.85)",
      "color: #0f0",
      "font: 11px monospace",
      "white-space: pre-wrap",
      "word-break: break-all",
      "padding: 8px",
      "border-radius: 8px",
      "pointer-events: none",
    ].join(";");
    document.documentElement.appendChild(panel);
  }

  function waitForDocumentElement() {
    if (document.documentElement) return Promise.resolve();
    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function isTargetPage(urlString) {
    try {
      const url = new URL(urlString);
      if (
        url.hostname !== "www.youtube.com" &&
        url.hostname !== "youtube.com" &&
        url.hostname !== "m.youtube.com"
      ) {
        return false;
      }
      return (
        (url.pathname === "/watch" && url.searchParams.has("v")) ||
        url.pathname.startsWith("/shorts/")
      );
    } catch {
      return false;
    }
  }

  function getVideoKey(urlString) {
    try {
      const url = new URL(urlString);
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
      return "";
    } catch {
      return "";
    }
  }

  function shouldBlock(result) {
    return result?.category === "entertainment" && result.confidence >= CONFIG.confidenceThreshold;
  }
})();
