// ==UserScript==
// @name         Jev YouTube Guard
// @namespace    https://github.com/yoshi47/jev-youtube-guard
// @version      0.8.2
// @description  Block high-confidence entertainment videos using TypeSafe Jev.
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  const SCRIPT_VERSION = "0.8.2";
  const CONFIG = {
    endpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/classify",
    allowEndpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/allow",
    feedbackEndpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/feedback",
    clientToken: "YOUR_CLIENT_TOKEN",
    confidenceThreshold: 0.6,
  };

  const OVERRIDE_PREFIX = "jev-youtube-guard:allow:";
  const RESULT_PREFIX = "jev-youtube-guard:result:";
  const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CLASSIFICATION_TIMEOUT_MS = 10_000;
  const OVERLAY_ID = "jev-youtube-guard-overlay";
  // Must match the Worker's POLICY_VERSION. Bump together when criteria change.
  const POLICY_VERSION = "1";
  const DEBUG_PANEL_ID = "jev-youtube-guard-debug";
  const FEEDBACK_BUTTON_ID = "jev-youtube-guard-feedback";
  const FEEDBACK_FLOAT_ID = "jev-youtube-guard-feedback-float";
  const DEBUG_FLAG_KEY = "jev-youtube-guard:debug";
  // Temporary: force the debug panel on for every video until the issue is resolved.
  // Set back to false to restore opt-in (&jevdebug=1) behavior.
  const DEBUG_FORCE_ON = false;
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
  // Last classification for the false-negative feedback button (log-only).
  let lastMetadata = null;
  let lastResult = null;
  // Debounce SPA event storms (yt-page-data-updated fires dozens of times).
  let evalTimer = 0;
  // Full log history for the copy button; panel shows only the tail.
  const logHistory = [];
  const LOG_HISTORY_MAX = 200;
  const LOG_PANEL_MAX = 25;
  // Keeps the video paused while undecided so audio never leaks behind
  // the "判定中" overlay. YouTube re-plays on SPA updates, hence interval.
  let pauseTimer = 0;
  let wasPlaying = false;

  // Stay resident on list pages (/, /results, /feed, ...) so SPA navigation
  // from a list to /watch can still be detected. Target filtering happens
  // inside evaluateCurrentVideoInner().
  if (typeof document === "undefined") return;

  debugMode = DEBUG_FORCE_ON || isDebugEnabled(location.href);

  void initialize();

  async function initialize() {
    await waitForDocumentElement();
    installOverlay();
    installFeedbackFloat();
    installGlobalErrorTrap();
    if (debugMode) installDebugPanel();
    dbg(`init url=${location.href}`);
    await evaluateCurrentVideo();

    document.addEventListener("yt-navigate-finish", () => {
      scheduleEvaluate();
    });
    document.addEventListener("yt-page-data-updated", () => {
      scheduleEvaluate();
    });
    window.addEventListener("popstate", () => {
      scheduleEvaluate();
    });
    // Fallback for SPA transitions where YouTube's custom events don't fire.
    // Wrapping pushState/replaceState catches list -> watch taps.
    // Debounced: a burst of pushStates becomes one evaluation.
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    try {
      history.pushState = function (...args) {
        const result = originalPushState.apply(this, args);
        scheduleEvaluate();
        return result;
      };
      history.replaceState = function (...args) {
        const result = originalReplaceState.apply(this, args);
        scheduleEvaluate();
        return result;
      };
    } catch {
      // Another extension may have frozen history: fall back to YouTube events.
      dbg("history wrap failed, relying on YouTube events");
    }
    window.addEventListener("hashchange", () => {
      scheduleEvaluate();
    });
    // Another tab changed an allow-override: drop the pinned video so this tab
    // re-reads localStorage instead of trusting activeVideoKey.
    window.addEventListener("storage", (event) => {
      if (!event.key || !event.key.startsWith(OVERRIDE_PREFIX)) return;
      if (event.key.slice(OVERRIDE_PREFIX.length) !== activeVideoKey) return;
      activeVideoKey = "";
      scheduleEvaluate();
    });
  }

  function scheduleEvaluate() {
    window.clearTimeout(evalTimer);
    evalTimer = window.setTimeout(() => {
      void evaluateCurrentVideo();
    }, 400);
  }

  async function evaluateCurrentVideo() {
    try {
      await evaluateCurrentVideoInner();
    } catch (error) {
      debugMode = true;
      installDebugPanel();
      dbg(`FATAL: ${error instanceof Error ? error.message : error}`);
      if (error instanceof Error && error.stack) dbg(`STACK: ${error.stack}`);
      console.error("[Jev YouTube Guard] fatal", error);
    }
  }

  async function evaluateCurrentVideoInner() {
    debugMode = DEBUG_FORCE_ON || isDebugEnabled(location.href);
    if (debugMode) installDebugPanel();
    if (!isTargetPage(location.href)) {
      if (activeVideoKey !== "") dbg(`leave video ${activeVideoKey}`);
      activeVideoKey = "";
      // Cancel any in-flight classification for the previous video.
      runToken++;
      stopPlaybackGuard(false);
      hideOverlay();
      setFeedbackFloatVisible(false);
      return;
    }

    const videoKey = getVideoKey(location.href);
    // Same-video events (progress, comments, pushState bursts) are silent.
    if (!videoKey || videoKey === activeVideoKey) return;
    // A previous video's guard must not leak into the new video.
    stopPlaybackGuard(false);
    dbg(`evaluate videoKey=${videoKey}`);
    setFeedbackFloatVisible(true);
    const currentToken = ++runToken;
    activeVideoKey = videoKey;
    lastMetadata = null;
    lastResult = null;

    const overrideKey = `${OVERRIDE_PREFIX}${videoKey}`;
    const overrideValue = storageGet(overrideKey);
    if (overrideValue === "1") {
      dbg("allow-listed override, skip");
      hideOverlay();
      return;
    }

    // Pause first, ask later: undecided video never plays behind the overlay.
    startPlaybackGuard();
    showOverlay("Jevで判定中…");
    const cacheStartedAt = Date.now();
    const cached = readCachedResult(videoKey);
    if (cached) {
      dbg(`cache hit category=${cached.result.category} confidence=${cached.result.confidence}`);
      lastMetadata = cached.metadata;
      lastResult = cached.result;
      applyResult(cached.result, overrideKey, cached.metadata);
      return;
    }
    dbg("cache miss, reading metadata");

    const metaStartedAt = Date.now();
    const metadata = await readVideoMetadata(videoKey, () => currentToken === runToken);
    if (currentToken !== runToken) return;

    if (!metadata) {
      dbg("metadata not found within timeout, allow");
      stopPlaybackGuard(true);
      showResultStatus("Jev判定: 動画情報を取得できなかったため許可");
      return;
    }
    dbg(
      `metadata ok titleLen=${metadata.title.length} channel=${metadata.channel} (${Date.now() - metaStartedAt}ms)`,
    );

    try {
      dbg(`POST ${CONFIG.endpoint}`);
      const classifyStartedAt = Date.now();
      const result = await classify(metadata);
      if (currentToken !== runToken) return;

      dbg(
        `result category=${result.category} confidence=${result.confidence} (${Date.now() - classifyStartedAt}ms, total ${Date.now() - cacheStartedAt}ms)`,
      );
      const resultMetadata = {
        videoKey,
        url: metadata.url,
        title: metadata.title,
        channel: metadata.channel,
      };
      writeCachedResult(videoKey, result, resultMetadata);
      lastMetadata = resultMetadata;
      lastResult = result;
      applyResult(result, overrideKey, resultMetadata);
    } catch (error) {
      // A classifier outage must not prevent normal browsing.
      console.warn("[Jev YouTube Guard] classification failed", error);
      dbg(`classify failed: ${error instanceof Error ? error.message : error}`);
      stopPlaybackGuard(true);
      showResultStatus("Jev判定: 通信失敗のため許可");
    }
  }

  function mainVideo() {
    return (
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video.video-stream") ||
      document.querySelector("video")
    );
  }

  function pauseAllVideos() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      try {
        if (!video.paused) video.pause();
      } catch {
        // A video that refuses to pause must not break the guard.
      }
    }
  }

  function startPlaybackGuard() {
    const first = mainVideo();
    wasPlaying = Boolean(first && !first.paused);
    pauseAllVideos();
    window.clearInterval(pauseTimer);
    pauseTimer = window.setInterval(pauseAllVideos, 400);
  }

  function stopPlaybackGuard(resume) {
    window.clearInterval(pauseTimer);
    pauseTimer = 0;
    if (!resume || !wasPlaying) return;
    wasPlaying = false;
    try {
      const result = mainVideo()?.play();
      // play() returns a promise in modern browsers; autoplay policy
      // rejections must not surface as unhandled errors.
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Resume is best-effort only.
    }
  }

  function applyResult(result, overrideKey, metadata) {
    dbg(`decision=${shouldBlock(result) ? "BLOCK" : "ALLOW"}`);
    lastMetadata = metadata ?? lastMetadata;
    lastResult = result ?? lastResult;
    if (shouldBlock(result)) {
      // Guard stays on: the video remains paused behind the block screen.
      pauseAllVideos();
      showOverlay("エンタメ判定のためブロックしました", () => {
        storageSet(overrideKey, "1");
        void reportOverride({
          videoKey: metadata?.videoKey || getVideoKey(location.href),
          url: metadata?.url || location.href,
          title: metadata?.title || "",
          channel: metadata?.channel || "",
        });
        stopPlaybackGuard(true);
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
      stopPlaybackGuard(true);
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
      if (cached.policyVersion !== POLICY_VERSION) {
        dbg(`cache policy mismatch (cached=${cached.policyVersion}), re-classify`);
        storageRemove(`${RESULT_PREFIX}${videoKey}`);
        return null;
      }
      return { result: cached.result, metadata: cached.metadata ?? null };
    } catch {
      return null;
    }
  }

  function writeCachedResult(videoKey, result, metadata) {
    storageSet(
      `${RESULT_PREFIX}${videoKey}`,
      JSON.stringify({
        createdAt: Date.now(),
        policyVersion: POLICY_VERSION,
        result,
        metadata: metadata ?? null,
      }),
    );
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

  async function readVideoMetadata(videoKey, isActive) {
    const active = typeof isActive === "function" ? isActive : () => true;
    const deadline = Date.now() + 10_000;
    let attempts = 0;
    let htmlFallback = null;
    // Race DOM against same-origin HTML from the start: on m.youtube.com the
    // DOM path usually loses, so waiting 3s before fetching just adds latency.
    // The fetch is aborted on timeout or when a newer video takes over.
    const htmlController = new AbortController();
    const htmlTimeoutId = setTimeout(() => htmlController.abort(), 8000);
    void fetchHtmlMetadata(videoKey, htmlController.signal).then((result) => {
      clearTimeout(htmlTimeoutId);
      if (!active()) return;
      htmlFallback = result;
      if (result)
        dbg(`html fetch ready: title=${result.title.length}ch channel=${result.channel.length}ch`);
      else dbg("html fetch empty");
    });
    while (Date.now() < deadline) {
      // A newer navigation already owns the guard: stop burning cycles.
      if (!active()) {
        clearTimeout(htmlTimeoutId);
        htmlController.abort();
        return null;
      }
      attempts++;
      const player = getPlayerDetails();
      const title =
        findText([
          "h1.ytd-watch-metadata yt-formatted-string",
          "h1 yt-formatted-string",
          "ytd-watch-flexy h1",
          "ytd-video-primary-info-renderer #title",
          "#info #title",
          "#title h1",
          "h2.reel-player-header-title",
          ".yt-core-attributed-string",
          // m.youtube.com (mobile) layouts
          ".slim-video-information-title",
          "#slim-video-information-title",
          "ytm-video-title",
          ".video-title",
        ]) ||
        player.title ||
        htmlFallback?.title ||
        metaContent('meta[property="og:title"]') ||
        metaContent('meta[name="title"]') ||
        document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
      const channel =
        findText([
          "ytd-watch-metadata ytd-channel-name a",
          "#owner ytd-channel-name a",
          "ytd-video-owner-renderer #channel-name a",
          "ytd-video-owner-renderer #owner-text a",
          "#owner-text a",
          "ytd-channel-name a",
          "#channel-name a",
          "#owner a",
          // m.youtube.com (mobile) layouts
          ".slim-video-information-channel",
          "#slim-video-information-channel",
          "ytm-channel-name",
          ".channel-name",
          ".owner-channel-name",
        ]) ||
        findHandleText() ||
        player.author ||
        htmlFallback?.channel ||
        metaContent('[itemprop="author"] [itemprop="name"]') ||
        metaContent('[itemprop="author"]');

      if (title && channel) {
        if (htmlFallback && !player.fromPlayer) dbg(`metadata via html fetch (${attempts})`);
        else if (player.fromPlayer && !findText(["h1 yt-formatted-string"])) {
          dbg(`metadata via player response (attempt ${attempts})`);
        }
        return {
          url: location.href,
          title,
          channel,
          description:
            player.description ||
            findText(["ytd-text-inline-expander#description-inline-expander", "#description"]),
          videoKey,
          clientVersion: SCRIPT_VERSION,
        };
      }
      // One line per ~2s so the panel stays readable.
      if (attempts === 1 || attempts % 8 === 0) {
        dbg(
          `waiting metadata (${attempts}): title=${title.length}ch channel=${channel.length}ch player=${player.found ? "y" : "n"} html=${htmlFallback ? "y" : "n"}`,
        );
      }
      // Polling loop: each wait must finish before the next DOM read.
      // oxlint-disable-next-line no-await-in-loop
      await delay(250);
    }
    clearTimeout(htmlTimeoutId);
    dbg("metadata timeout");
    return null;
  }

  // Same-origin fetch of the watch HTML. Server-rendered HTML carries the
  // correct og:title / ownerChannelName even during SPA navigations where
  // the live DOM and <head> meta are stale or mobile-structured.
  async function fetchHtmlMetadata(videoKey, signal) {
    try {
      const url = `${location.origin}/watch?v=${encodeURIComponent(videoKey)}`;
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        signal,
      });
      if (!response.ok) return null;
      const html = await response.text();
      const titleRaw = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1] ?? "";
      const channelRaw =
        html.match(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/)?.[1] ??
        html.match(/"author":"((?:[^"\\]|\\.)*)"/)?.[1] ??
        html.match(/<meta[^>]+name="author"[^>]+content="([^"]+)"/)?.[1] ??
        "";
      const title = decodeHtml(unescapeJsonString(titleRaw)).trim();
      const channel = unescapeJsonString(channelRaw).trim();
      if (!title || !channel) return null;
      return { title, channel };
    } catch {
      return null;
    }
  }

  function unescapeJsonString(raw) {
    if (!raw || !raw.includes("\\")) return raw;
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  }

  function decodeHtml(raw) {
    if (!raw || !raw.includes("&")) return raw;
    try {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = raw;
      return textarea.value;
    } catch {
      return raw;
    }
  }

  // window.ytInitialPlayerResponse is refreshed on SPA navigations while
  // <head> meta tags stay stale, so it is the most reliable SPA fallback.
  function getPlayerDetails() {
    try {
      const response = window.ytInitialPlayerResponse;
      const details = response?.videoDetails;
      if (details && typeof details === "object") {
        const title = typeof details.title === "string" ? details.title.trim() : "";
        const author = typeof details.author === "string" ? details.author.trim() : "";
        return {
          title,
          author,
          description:
            typeof details.shortDescription === "string"
              ? details.shortDescription.slice(0, 8000)
              : "",
          found: true,
          fromPlayer: Boolean(title || author),
        };
      }
      return { title: "", author: "", description: "", found: false, fromPlayer: false };
    } catch {
      return { title: "", author: "", description: "", found: false, fromPlayer: false };
    }
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

  async function reportOverride(payload) {
    try {
      dbg(`POST ${CONFIG.allowEndpoint}`);
      const response = await fetch(CONFIG.allowEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.clientToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, clientVersion: SCRIPT_VERSION }),
      });
      if (!response.ok) throw new Error(`Worker request failed: ${response.status}`);
      dbg("override reported");
    } catch (error) {
      // A failed override report must not prevent watching the video.
      console.warn("[Jev YouTube Guard] override report failed", error);
      dbg(`override report failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function reportFeedback(payload) {
    try {
      dbg(`POST ${CONFIG.feedbackEndpoint}`);
      const response = await fetch(CONFIG.feedbackEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.clientToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, clientVersion: SCRIPT_VERSION }),
      });
      if (!response.ok) throw new Error(`Worker request failed: ${response.status}`);
      dbg("feedback reported");
      return true;
    } catch (error) {
      // A failed feedback report must not prevent watching the video.
      console.warn("[Jev YouTube Guard] feedback report failed", error);
      dbg(`feedback report failed: ${error instanceof Error ? error.message : error}`);
      return false;
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
    // YouTube enforces Trusted Types: innerHTML assignment throws, so clear via DOM APIs.
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    const blocked = Boolean(onAllow);
    overlay.style.inset = blocked ? "0" : "12px 12px auto auto";
    overlay.style.padding = blocked ? "24px" : "8px 12px";
    overlay.style.borderRadius = blocked ? "0" : "8px";
    overlay.style.boxShadow = blocked ? "none" : "0 2px 12px rgba(0, 0, 0, 0.18)";
    overlay.style.background = blocked ? "rgba(255, 255, 255, 0.96)" : "rgba(255, 255, 255, 0.94)";
    overlay.style.pointerEvents = blocked ? "auto" : "none";

    const content = document.createElement("div");
    content.style.cssText = blocked
      ? "width: 100%; max-width: 420px; box-sizing: border-box; padding: 24px; border: 1px solid #bbb; border-radius: 12px; background: #fff; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);"
      : "";
    const text = document.createElement("p");
    text.textContent = message;
    text.style.cssText = blocked
      ? "margin: 0; font-size: 16px; font-weight: 700; line-height: 1.6; color: #111;"
      : "margin: 0;";
    content.appendChild(text);

    if (onAllow) {
      const actions = document.createElement("div");
      actions.style.cssText = "display: flex; flex-direction: column; gap: 8px; margin-top: 16px;";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "この動画だけ表示する";
      button.style.cssText = [
        "width: 100%",
        "box-sizing: border-box",
        "padding: 12px 16px",
        "border: none",
        "border-radius: 10px",
        "background: #111",
        "color: #fff",
        "font-size: 15px",
        "font-weight: 700",
        "line-height: 1.4",
        "cursor: pointer",
      ].join(";");
      button.addEventListener("click", onAllow, { once: true });
      actions.appendChild(button);

      // Blocked but actually study: report without unblocking.
      const reportButton = document.createElement("button");
      reportButton.type = "button";
      reportButton.textContent = "勉強用だったと報告";
      reportButton.style.cssText = [
        "width: 100%",
        "box-sizing: border-box",
        "padding: 12px 16px",
        "border: 1px solid #ddd",
        "border-radius: 10px",
        "background: #fff",
        "color: #333",
        "font-size: 14px",
        "font-weight: 600",
        "line-height: 1.4",
        "cursor: pointer",
      ].join(";");
      reportButton.addEventListener("click", () => {
        void sendFeedback(reportButton);
      });
      actions.appendChild(reportButton);
      content.appendChild(actions);
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

  // Channel handle links like <a href="/@xxx">@xxx</a> exist on mobile/SPA
  // layouts where the owner-renderer selectors above miss.
  function findHandleText() {
    const candidates = ['a[href^="/@"]', 'a[href*="/channel/"]', 'a[href*="/user/"]'];
    for (const selector of candidates) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const text = element?.textContent?.trim();
        // Skip nav/drawer links: handles start with @ or live inside owner area.
        if (!text) continue;
        if (selector === 'a[href^="/@"]' && text.startsWith("@")) return text;
        if (element.closest("#owner, ytd-video-owner-renderer, ytd-channel-name")) return text;
      }
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
    const stamped = `${new Date().toISOString().slice(11, 19)} ${message}`;
    console.warn("[Jev YouTube Guard][debug]", message);
    logHistory.push(stamped);
    if (logHistory.length > LOG_HISTORY_MAX)
      logHistory.splice(0, logHistory.length - LOG_HISTORY_MAX);
    const panel = document.getElementById(DEBUG_PANEL_ID);
    if (!panel) return;
    const logBox = panel.querySelector('[data-logbox="1"]');
    if (!logBox) return;
    const line = document.createElement("div");
    line.textContent = stamped;
    logBox.appendChild(line);
    while (logBox.children.length > LOG_PANEL_MAX) logBox.removeChild(logBox.firstChild);
    logBox.scrollTop = logBox.scrollHeight;
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
      "max-height: 30vh",
      "overflow-y: auto",
      "background: rgba(0, 0, 0, 0.85)",
      "color: #0f0",
      "font: 11px monospace",
      "white-space: pre-wrap",
      "word-break: break-all",
      "padding: 8px",
      "border-radius: 8px",
      "pointer-events: auto",
      "-webkit-overflow-scrolling: touch",
      "touch-action: pan-y",
    ].join(";");
    const header = document.createElement("div");
    header.textContent = `Jev Guard v${SCRIPT_VERSION} (tap to collapse)`;
    header.style.cssText = "margin-bottom: 6px; opacity: 0.8; cursor: pointer;";
    const logBox = document.createElement("div");
    logBox.setAttribute("data-logbox", "1");
    // Replay history if the panel was installed late.
    for (const line of logHistory.slice(-LOG_PANEL_MAX)) {
      const div = document.createElement("div");
      div.textContent = line;
      logBox.appendChild(div);
    }
    let collapsed = false;
    header.addEventListener("click", () => {
      collapsed = !collapsed;
      logBox.style.display = collapsed ? "none" : "";
    });
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "ログをコピー";
    copyButton.style.cssText = [
      "display: block",
      "margin-bottom: 6px",
      "padding: 6px 10px",
      "border: 1px solid #0f0",
      "border-radius: 6px",
      "background: #002200",
      "color: #0f0",
      "font: 11px monospace",
      "pointer-events: auto",
    ].join(";");
    copyButton.addEventListener("click", () => {
      const text = logHistory.join("\n") || "(empty)";
      const done = () => dbg("logs copied");
      try {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
        } else {
          fallbackCopy(text, done);
        }
      } catch {
        fallbackCopy(text, done);
      }
    });
    const feedbackButton = document.createElement("button");
    feedbackButton.id = FEEDBACK_BUTTON_ID;
    feedbackButton.type = "button";
    feedbackButton.textContent = "この動画を誤判定として報告";
    feedbackButton.style.cssText = [
      "display: block",
      "margin-bottom: 6px",
      "padding: 6px 10px",
      "border: 1px solid #0f0",
      "border-radius: 6px",
      "background: #002200",
      "color: #0f0",
      "font: 11px monospace",
      "pointer-events: auto",
    ].join(";");
    feedbackButton.addEventListener("click", () => {
      void sendFeedback(feedbackButton);
    });
    panel.appendChild(header);
    panel.appendChild(copyButton);
    panel.appendChild(feedbackButton);
    panel.appendChild(logBox);
    document.documentElement.appendChild(panel);
  }

  // Always-visible feedback entry point: works with the debug panel off.
  // Placed above the player controls so it never blocks playback ops.
  function installFeedbackFloat() {
    if (document.getElementById(FEEDBACK_FLOAT_ID)) return;
    const button = document.createElement("button");
    button.id = FEEDBACK_FLOAT_ID;
    button.type = "button";
    button.textContent = "誤判定を報告";
    button.hidden = true;
    button.style.cssText = [
      "position: fixed",
      "right: 8px",
      "bottom: 64px",
      "z-index: 2147483647",
      "padding: 8px 12px",
      "border: 1px solid rgba(255,255,255,0.4)",
      "border-radius: 20px",
      "background: rgba(0, 0, 0, 0.6)",
      "color: #fff",
      "font: 12px -apple-system, BlinkMacSystemFont, sans-serif",
      "pointer-events: auto",
    ].join(";");
    button.addEventListener("click", () => {
      void sendFeedback(button);
    });
    document.documentElement.appendChild(button);
    setFeedbackFloatVisible(isTargetPage(location.href));
  }

  function setFeedbackFloatVisible(visible) {
    const button = document.getElementById(FEEDBACK_FLOAT_ID);
    if (button) button.hidden = !visible;
  }

  // Shared reporter: kind is inferred from the last decision so one button
  // covers both directions (blocked study -> false-positive,
  // allowed entertainment -> false-negative). Log-only on the Worker.
  async function sendFeedback(invokedButton) {
    if (!lastMetadata) {
      dbg("nothing to report yet");
      flashButton(invokedButton, "判定待ち");
      return;
    }
    const blocked = lastResult ? shouldBlock(lastResult) : false;
    const ok = await reportFeedback({
      videoKey: lastMetadata.videoKey || getVideoKey(location.href),
      url: lastMetadata.url || location.href,
      title: lastMetadata.title || "",
      channel: lastMetadata.channel || "",
      category: lastResult?.category || "",
      confidence: lastResult?.confidence,
      kind: blocked ? "false-positive" : "false-negative",
    });
    flashButton(invokedButton, ok ? "報告済み ✓" : "報告失敗");
  }

  function flashButton(button, text) {
    if (!button || !button.isConnected) return;
    const original = button.textContent;
    button.textContent = text;
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 2000);
  }

  function fallbackCopy(text, done) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position: fixed; opacity: 0;";
      document.documentElement.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    } catch {
      // Clipboard unavailable: history stays in console.warn anyway.
    }
    done();
  }

  function installGlobalErrorTrap() {
    window.addEventListener("error", (event) => {
      try {
        // YouTube itself throws cross-origin "Script error." noise constantly.
        // Without a filename it is sanitized and almost certainly not ours.
        const message = event.message || "";
        const filename = event.filename || "";
        const stack = event.error?.stack || "";
        if (message === "Script error." && !filename) return;
        const isOurs =
          filename.includes("jev-youtube-guard") ||
          stack.includes("JevYouTubeGuard") ||
          stack.includes("jev-youtube-guard") ||
          message.includes("[Jev YouTube Guard]");
        if (!isOurs) {
          // Page's own error: note it but don't force the debug panel on.
          console.warn("[Jev YouTube Guard] page error (ignored)", message);
          return;
        }
        debugMode = true;
        installDebugPanel();
        dbg(`window.onerror: ${message}`);
      } catch {
        // Never let the error trap break the page.
      }
    });
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
