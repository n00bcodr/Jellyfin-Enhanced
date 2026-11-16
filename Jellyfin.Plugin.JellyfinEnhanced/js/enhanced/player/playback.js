(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }
  function publishSharedModules(modules) {
    const JE2 = window.JellyfinEnhanced;
    if (!JE2) return;
    const core = JE2.core ?? (JE2.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }

  // client/src/features/player/wire.ts
  var wire_exports = {};
  __export(wire_exports, {
    decodeItem: () => decodeItem,
    decodeItems: () => decodeItems,
    decodeSegments: () => decodeSegments,
    decodeSessions: () => decodeSessions,
    record: () => record
  });
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  }
  var text = (v) => typeof v === "string" ? v : void 0;
  var number = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  var strings = (v) => Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  var list = (v) => Array.isArray(v) ? v : [];
  function stream(v) {
    const r = record(v);
    const fps = (v2) => typeof v2 === "string" ? v2 : number(v2);
    return { Type: text(r.Type), Index: number(r.Index), ReferenceFrameRate: fps(r.ReferenceFrameRate), RealFrameRate: fps(r.RealFrameRate), AverageFrameRate: fps(r.AverageFrameRate), DisplayTitle: text(r.DisplayTitle), Title: text(r.Title), Language: text(r.Language), Codec: text(r.Codec), IsTextSubtitleStream: typeof r.IsTextSubtitleStream === "boolean" ? r.IsTextSubtitleStream : void 0 };
  }
  function decodeItem(v) {
    const r = record(v);
    return { Id: text(r.Id), Type: text(r.Type), SeriesId: text(r.SeriesId), ParentId: text(r.ParentId), RunTimeTicks: number(r.RunTimeTicks), ProductionYear: number(r.ProductionYear), CommunityRating: number(r.CommunityRating), CriticRating: number(r.CriticRating), OfficialRating: text(r.OfficialRating), Overview: text(r.Overview), Container: text(r.Container), Genres: strings(r.Genres), Tags: strings(r.Tags), ImageTags: { Logo: text(record(r.ImageTags).Logo) }, MediaStreams: list(r.MediaStreams).map(stream), MediaSources: list(r.MediaSources).map((v2) => {
      const s = record(v2);
      return { Id: text(s.Id), MediaStreams: list(s.MediaStreams).map(stream) };
    }) };
  }
  var decodeItems = (v) => list(record(v).Items).map(decodeItem);
  function decodeSessions(v) {
    return list(v).map((v2) => {
      const r = record(v2), p = record(r.PlayState), t = record(r.TranscodingInfo);
      return { Id: text(r.Id), DeviceId: text(r.DeviceId), NowPlayingItem: decodeItem(r.NowPlayingItem), LastPlaybackCheckIn: text(r.LastPlaybackCheckIn), PlayState: { PlayMethod: text(p.PlayMethod), MediaSourceId: text(p.MediaSourceId), AudioStreamIndex: number(p.AudioStreamIndex), SubtitleStreamIndex: number(p.SubtitleStreamIndex), IsPaused: typeof p.IsPaused === "boolean" ? p.IsPaused : void 0, PositionTicks: number(p.PositionTicks) }, TranscodingInfo: r.TranscodingInfo ? { CompletionPercentage: number(t.CompletionPercentage), Container: text(t.Container), VideoCodec: text(t.VideoCodec), AudioCodec: text(t.AudioCodec), Bitrate: number(t.Bitrate), TranscodeReasons: typeof t.TranscodeReasons === "string" ? [t.TranscodeReasons] : strings(t.TranscodeReasons) } : null };
    });
  }
  function decodeSegments(v) {
    return list(record(v).Items).map((v2) => {
      const r = record(v2);
      return { Id: text(r.Id), Type: text(r.Type), StartTicks: number(r.StartTicks), EndTicks: number(r.EndTicks) };
    });
  }

  // client/src/features/player/lifetime.ts
  var lifetime_exports = {};
  __export(lifetime_exports, {
    createPlayerLifetime: () => createPlayerLifetime
  });
  function createPlayerLifetime(JE2, name) {
    let generation = 0;
    let controller = new AbortController();
    const cleanups = /* @__PURE__ */ new Set();
    const timers = /* @__PURE__ */ new Set();
    function reset() {
      generation++;
      controller.abort();
      controller = new AbortController();
      for (const cleanup of cleanups) cleanup();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    }
    JE2.session?.onUserChange(name + "-lifetime", reset);
    if (JE2.core?.navigation) JE2.core.navigation.onNavigate(reset);
    else window.addEventListener("hashchange", reset);
    function lease(video) {
      const captured = generation, hash = location.hash;
      const session = JE2.session?.createLease?.();
      const source = video ? video.currentSrc || video.src : null;
      return { signal: controller.signal, current: () => captured === generation && hash === location.hash && (!session || session.isCurrent()) && (!video || video.isConnected && (video.currentSrc || video.src) === source) };
    }
    return {
      lease,
      reset,
      onReset(cleanup) {
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      },
      timeout(callback, delay) {
        const id = window.setTimeout(() => {
          timers.delete(id);
          callback();
        }, delay);
        timers.add(id);
        return id;
      },
      cancel(id) {
        if (id != null) {
          clearTimeout(id);
          timers.delete(id);
        }
      },
      sleep(delay, signal) {
        return new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const done = () => {
            clearTimeout(id);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const id = window.setTimeout(done, delay);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    };
  }

  // client/src/features/player/host.ts
  var host_exports = {};
  __export(host_exports, {
    playerHost: () => playerHost
  });
  function playerHost() {
    const host = window;
    const JE2 = host.JellyfinEnhanced;
    if (!JE2) throw new Error("Player loaded before Jellyfin Enhanced");
    const ctx2 = featureContext("player", JE2, {
      internalSlots: ["player", "nowPlaying", "autoSkip", "subtitleSync", "osdPlayback"],
      internalsObject: () => JE2.internals = JE2.internals || {}
    });
    const requireApi = () => {
      if (!host.ApiClient) throw new Error("Jellyfin API unavailable");
      return host.ApiClient;
    };
    const ApiClient2 = {
      getCurrentUserId: () => host.ApiClient?.getCurrentUserId() ?? null,
      deviceId: () => host.ApiClient?.deviceId?.() ?? "",
      serverId: () => {
        const id = host.ApiClient?.serverId;
        return typeof id === "function" ? id.call(host.ApiClient) : id ?? "";
      },
      serverAddress: () => requireApi().serverAddress(),
      getUrl: (path, params) => requireApi().getUrl(path, params),
      ajax: (options) => requireApi().ajax(options),
      getItem: (userId, itemId) => requireApi().getItem(userId, itemId)
    };
    return { JE: JE2, ApiClient: ApiClient2, ctx: ctx2 };
  }

  // client/generated-shared/publish/js/enhanced/player/playback.js.ts
  publishSharedModules({ "features/player/wire": wire_exports, "features/player/lifetime": lifetime_exports, "features/player/host": host_exports });

  // client/src/features/player/identity.ts
  function getCurrentVideoItemId() {
    try {
      const hash = window.location.hash || "";
      const q = hash.indexOf("?");
      if (q === -1) return null;
      return new URLSearchParams(hash.substring(q + 1)).get("id");
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: frame-step item id parse failed", err);
      return null;
    }
  }
  function normalizeItemId(value) {
    const v = (value || "").replace(/-/g, "").toLowerCase();
    return v || null;
  }
  function parseItemIdFromVideosSrc(src) {
    const m = (src || "").match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
    return m?.[1] ?? null;
  }

  // client/src/features/player/context.ts
  var playerUnsupportedText = (context2) => context2.tWithFallback("toast_player_unsupported", "{{icon:info}} Not available with this player");

  // client/src/features/player/frame-seek.ts
  function installFrameSeek(context2, history, jumpToLastOsdPosition) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    const FRAME_STEP_FALLBACK_FPS = 24;
    const _fpsCache = /* @__PURE__ */ new Map();
    const _fpsInflight = /* @__PURE__ */ new Map();
    let _frameOverlay = null;
    let _frameOverlayHideTimer = null;
    let _frameOverlayFadeTimer = null;
    const _fallbackFpsWarned = /* @__PURE__ */ new Set();
    function pickFps(stream2) {
      if (!stream2) return null;
      const candidates = [stream2.ReferenceFrameRate, stream2.RealFrameRate, stream2.AverageFrameRate];
      for (const c of candidates) {
        const n = parseFloat(String(c));
        if (Number.isFinite(n) && n >= 1 && n < 1e3) return n;
      }
      return null;
    }
    function getActiveMediaSourceId(video) {
      try {
        const src = video?.currentSrc || video?.src || "";
        const q = src.indexOf("?");
        if (q === -1) return null;
        return new URLSearchParams(src.substring(q + 1)).get("MediaSourceId") || null;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: frame-step MediaSourceId parse failed", err);
        return null;
      }
    }
    async function fetchFpsForItem(itemId, activeMediaSourceId) {
      if (!itemId || !ApiClient2) return null;
      try {
        const userId = ApiClient2.getCurrentUserId();
        const item = decodeItem(await ApiClient2.getItem(userId, itemId));
        const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
        const ordered = activeMediaSourceId ? [...sources.filter((s) => s.Id === activeMediaSourceId), ...sources.filter((s) => s.Id !== activeMediaSourceId)] : sources;
        for (const source of ordered) {
          const vs = source.MediaStreams?.find((s) => s.Type === "Video");
          const fps = pickFps(vs);
          if (fps) return fps;
        }
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: frame-step fps lookup failed", err);
      }
      return null;
    }
    function getFpsCacheKey(itemId, video) {
      if (!itemId) return null;
      const msId = getActiveMediaSourceId(video);
      if (msId) return `${itemId}|ms:${msId}`;
      const src = (video?.currentSrc || video?.src || "").split("?")[0];
      return `${itemId}|src:${src}`;
    }
    async function resolveFps(video) {
      const lease = lifetime2.lease(video);
      const itemId = getCurrentVideoItemId2();
      const cacheKey = getFpsCacheKey(itemId, video);
      const cached = cacheKey ? _fpsCache.get(cacheKey) : void 0;
      if (cached !== void 0) return cached;
      const inflight = itemId ? _fpsInflight.get(itemId) : void 0;
      if (inflight) return inflight;
      const activeMediaSourceId = getActiveMediaSourceId(video);
      const promise = (async () => {
        const fetched = itemId ? await fetchFpsForItem(itemId, activeMediaSourceId) : null;
        const isReal = fetched !== null && Number.isFinite(fetched) && fetched >= 1;
        const fps = isReal ? fetched : FRAME_STEP_FALLBACK_FPS;
        const finalKey = itemId ? activeMediaSourceId ? `${itemId}|ms:${activeMediaSourceId}` : `${itemId}|src:${(video?.currentSrc || video?.src || "").split("?")[0]}` : null;
        if (lease.current() && finalKey && isReal) _fpsCache.set(finalKey, fps);
        if (lease.current() && !isReal && itemId && !_fallbackFpsWarned.has(itemId)) {
          try {
            JE2.toast(tWithFallback2(
              "toast_frame_step_fps_fallback",
              "ℹ Frame step using fallback {fps} fps (actual rate unknown)",
              { fps: FRAME_STEP_FALLBACK_FPS }
            ));
            _fallbackFpsWarned.add(itemId);
          } catch (err) {
            console.warn("🪼 Jellyfin Enhanced: frame-step fallback toast failed", err);
          }
        }
        return fps;
      })();
      if (itemId) _fpsInflight.set(itemId, promise);
      try {
        return await promise;
      } finally {
        if (itemId && _fpsInflight.get(itemId) === promise) _fpsInflight.delete(itemId);
      }
    }
    function showFrameOverlay(text2) {
      if (!_frameOverlay) {
        _frameOverlay = document.createElement("div");
        _frameOverlay.setAttribute("data-je-frame-overlay", "true");
        _frameOverlay.style.cssText = `
                position: fixed; bottom: 18%; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.78); color: #fff; padding: 6px 14px; border-radius: 6px;
                font-size: 0.95em; font-weight: 600; z-index: 999999;
                pointer-events: none; font-family: system-ui;
                opacity: 0; transition: opacity 0.15s ease-out; display: none;
                white-space: nowrap;
            `;
        document.body.appendChild(_frameOverlay);
      }
      _frameOverlay.textContent = text2;
      _frameOverlay.style.display = "block";
      requestAnimationFrame(() => {
        if (_frameOverlay) _frameOverlay.style.opacity = "1";
      });
      if (_frameOverlayHideTimer) {
        lifetime2.cancel(_frameOverlayHideTimer);
        _frameOverlayHideTimer = null;
      }
      if (_frameOverlayFadeTimer) {
        lifetime2.cancel(_frameOverlayFadeTimer);
        _frameOverlayFadeTimer = null;
      }
      _frameOverlayHideTimer = lifetime2.timeout(() => {
        _frameOverlayHideTimer = null;
        if (!_frameOverlay) return;
        _frameOverlay.style.opacity = "0";
        _frameOverlayFadeTimer = lifetime2.timeout(() => {
          _frameOverlayFadeTimer = null;
          if (_frameOverlay && _frameOverlay.style.opacity === "0") {
            _frameOverlay.style.display = "none";
          }
        }, 200);
      }, 900);
    }
    JE2.frameStep = async (direction) => {
      const lease = lifetime2.lease(getVideo2());
      try {
        const video = getVideo2();
        if (!video) {
          JE2.toast(playerUnsupportedText(context2));
          return;
        }
        if (!video.paused) {
          try {
            const r = video.pause();
            if (r instanceof Promise) {
              r.catch((err) => console.warn("🪼 Jellyfin Enhanced: video.pause() rejected", err));
            }
          } catch (err) {
            console.warn("🪼 Jellyfin Enhanced: video.pause() threw", err);
          }
        }
        const fps = await resolveFps(video);
        if (!lease.current() || video !== getVideo2()) return;
        const frameDuration = 1 / fps;
        const delta = direction === "forward" ? frameDuration : -frameDuration;
        const upper = Number.isFinite(video.duration) ? video.duration : Infinity;
        const newTime = Math.max(0, Math.min(upper, video.currentTime + delta));
        video.currentTime = newTime;
        const arrow = direction === "forward" ? "▶" : "◀";
        const frameNum = Math.max(0, Math.round(newTime * fps));
        const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/\.?0+$/, "");
        const text2 = tWithFallback2(
          "toast_frame_step",
          "{arrow} Frame {frame}  ·  {fps} fps",
          { arrow, frame: frameNum, fps: fpsLabel }
        );
        showFrameOverlay(text2);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: frameStep failed", err);
      }
    };
    let _lastStablePosition = null;
    let _jumpingBack = false;
    const seekTracked = /* @__PURE__ */ new Map();
    JE2.attachSeekTracker = (video) => {
      if (!video || seekTracked.has(video)) return;
      for (const release of seekTracked.values()) release();
      seekTracked.clear();
      _lastStablePosition = history.position = null;
      _jumpingBack = false;
      const timeupdate = () => {
        if (_jumpingBack) return;
        if (!video.seeking && Number.isFinite(video.currentTime) && video.currentTime > 0) {
          _lastStablePosition = video.currentTime;
        }
      };
      const seeking = () => {
        if (_jumpingBack) return;
        if (_lastStablePosition !== null) {
          history.position = _lastStablePosition;
        }
      };
      video.addEventListener("timeupdate", timeupdate);
      video.addEventListener("seeking", seeking);
      seekTracked.set(video, () => {
        video.removeEventListener("timeupdate", timeupdate);
        video.removeEventListener("seeking", seeking);
      });
    };
    JE2.jumpToLastPosition = () => {
      const video = getVideo2();
      if (!video) {
        jumpToLastOsdPosition();
        return;
      }
      if (history.position === null) {
        JE2.toast(tWithFallback2("toast_no_last_position", "{{icon:rewind}} No previous position saved"));
        return;
      }
      const targetTime = history.position;
      history.position = null;
      _jumpingBack = true;
      _lastStablePosition = null;
      video.currentTime = targetTime;
      lifetime2.timeout(() => {
        _jumpingBack = false;
      }, 500);
      const mins = Math.floor(targetTime / 60);
      const secs = Math.floor(targetTime % 60).toString().padStart(2, "0");
      JE2.toast(tWithFallback2("toast_jumped_back", "{{icon:rewind}} Jumped back to {time}", { time: `${mins}:${secs}` }));
    };
    lifetime2.onReset(() => {
      _frameOverlay?.remove();
      _frameOverlay = null;
      _frameOverlayHideTimer = _frameOverlayFadeTimer = null;
      for (const release of seekTracked.values()) release();
      seekTracked.clear();
      _lastStablePosition = history.position = null;
      _jumpingBack = false;
      _fpsCache.clear();
      _fpsInflight.clear();
      _fallbackFpsWarned.clear();
    });
  }

  // client/src/features/shared/osd-playback.ts
  function activeOsdPage() {
    return Array.from(document.querySelectorAll("#videoOsdPage")).find((page) => !page.classList.contains("hide")) || null;
  }
  function osdElement(selector) {
    const page = activeOsdPage();
    return page ? page.querySelector(selector) : null;
  }
  function parseRunningTime(text2) {
    const s = String(text2 == null ? "" : text2).replace(/\s+/g, "");
    const match = /^(-)?(\d+(?::\d{1,2}){1,2})$/.exec(s);
    if (!match || !match[2]) return null;
    const seconds = match[2].split(":").reduce((total, part) => total * 60 + Number(part), 0);
    return match[1] ? -seconds : seconds;
  }
  function positionSeconds() {
    const el = osdElement(".osdPositionText");
    if (!el || el.classList.contains("hide")) return null;
    const seconds = parseRunningTime(el.textContent);
    return seconds !== null && seconds >= 0 ? seconds : null;
  }
  function durationSeconds() {
    const el = osdElement(".osdDurationText");
    if (!el || el.classList.contains("hide")) return null;
    const shown = parseRunningTime(el.textContent);
    if (shown === null) return null;
    if (shown >= 0) return shown > 0 ? shown : null;
    const position = positionSeconds();
    return position === null ? null : position - shown;
  }
  function itemKey() {
    if (durationSeconds() === null) return null;
    const btn = osdElement(".btnUserRating[data-id]");
    return btn && btn.getAttribute("data-id") || "";
  }
  function sameItem(a, b) {
    return !!a && !!b && a.key === b.key && Math.abs(a.duration - b.duration) <= 3;
  }
  function isPaused() {
    const icon = osdElement(".btnPause .material-icons");
    if (!icon) return null;
    if (icon.classList.contains("play_arrow")) return true;
    if (icon.classList.contains("pause")) return false;
    return null;
  }
  function seekToPercent(percent) {
    const slider = osdElement(".osdPositionSlider");
    if (!slider || slider.disabled || !Number.isFinite(percent) || durationSeconds() === null) return false;
    slider.value = String(Math.min(100, Math.max(0, percent)));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  function seekTo(seconds) {
    const slider = osdElement(".osdPositionSlider");
    const duration = durationSeconds();
    if (!slider || slider.disabled || !duration || !Number.isFinite(seconds)) return false;
    return seekToPercent(Math.max(0, seconds) / duration * 100);
  }
  var osdPlayback = { activeOsdPage, parseRunningTime, positionSeconds, durationSeconds, itemKey, sameItem, isPaused, seekTo, seekToPercent };

  // client/src/features/player/segment-controls.ts
  function installSegmentControls(context2, sessionItemId) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    const TICKS_PER_SECOND = 1e7;
    const segmentCache = /* @__PURE__ */ new Map();
    const SEGMENT_CACHE_MS = 10 * 60 * 1e3;
    function transcodeOffsetTicks(src) {
      try {
        const q = (src || "").indexOf("?");
        if (q === -1) return 0;
        if (src.substring(0, q).toLowerCase().endsWith(".m3u8")) return 0;
        let startTimeTicks = 0;
        for (const [name, value] of new URLSearchParams(src.substring(q + 1))) {
          const lower = name.toLowerCase();
          if ((lower === "static" || lower === "copytimestamps") && String(value).toLowerCase() === "true") {
            return 0;
          }
          if (lower === "starttimeticks") {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) startTimeTicks = n;
          }
        }
        return startTimeTicks;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: transcode offset parse failed", err);
        return 0;
      }
    }
    async function fetchMediaSegments(itemId) {
      const lease = lifetime2.lease();
      const cached = segmentCache.get(itemId);
      if (cached && performance.now() - cached.at < SEGMENT_CACHE_MS) return cached.segments;
      try {
        const ac = ApiClient2;
        if (!ac) return [];
        const res = await ac.ajax({
          type: "GET",
          url: ac.getUrl(`/MediaSegments/${encodeURIComponent(itemId)}`),
          dataType: "json"
        });
        const segments = decodeSegments(res);
        if (segmentCache.size > 50) segmentCache.clear();
        if (lease.current()) segmentCache.set(itemId, { segments, at: performance.now() });
        return segments;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: media segments fetch failed", err);
        return [];
      }
    }
    function clickSkipButton() {
      const skipButton = document.querySelector("button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)");
      if (!skipButton) return false;
      const buttonText = skipButton.textContent || "";
      skipButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      skipButton.click();
      if (buttonText.includes("Skip Intro")) {
        JE2.toast(JE2.t("toast_skipped_intro"));
      } else if (buttonText.includes("Skip Outro")) {
        JE2.toast(JE2.t("toast_skipped_outro"));
      } else {
        JE2.toast(JE2.t("toast_skipped"));
      }
      return true;
    }
    JE2.skipIntroOutro = () => {
      const lease = lifetime2.lease(getVideo2());
      const video = getVideo2();
      if (!video) {
        skipIntroOutroViaOsd();
        return;
      }
      const itemId = getCurrentVideoItemId2() || parseItemIdFromVideosSrc(video.currentSrc || video.src || "");
      if (!itemId) {
        if (!clickSkipButton()) JE2.toast(JE2.t("toast_no_skip_button"));
        return;
      }
      const pressVideo = video;
      const pressSrc = video.currentSrc || video.src || "";
      fetchMediaSegments(itemId).then((segments) => {
        if (!lease.current()) return;
        const v = getVideo2();
        if (v !== pressVideo || (v && (v.currentSrc || v.src) || "") !== pressSrc) {
          if (!clickSkipButton()) JE2.toast(JE2.t("toast_no_skip_button"));
          return;
        }
        const offset = transcodeOffsetTicks(pressSrc);
        const nowTicks = pressVideo.currentTime * TICKS_PER_SECOND + offset;
        const seg = segments.find((s) => s && typeof s.StartTicks === "number" && typeof s.EndTicks === "number" && s.StartTicks <= nowTicks && s.EndTicks > nowTicks);
        if (seg && seg.EndTicks !== void 0) {
          const endSeconds = (seg.EndTicks - offset) / TICKS_PER_SECOND;
          const duration = Number.isFinite(pressVideo.duration) && pressVideo.duration > 0 ? pressVideo.duration : Infinity;
          const target = Math.min(endSeconds, duration);
          if (target > pressVideo.currentTime) {
            pressVideo.currentTime = target;
            if (seg.Type === "Intro") {
              JE2.toast(JE2.t("toast_skipped_intro"));
            } else if (seg.Type === "Outro") {
              JE2.toast(JE2.t("toast_skipped_outro"));
            } else {
              JE2.toast(JE2.t("toast_skipped"));
            }
            return;
          }
        }
        if (!clickSkipButton()) JE2.toast(JE2.t("toast_no_skip_button"));
      }).catch((err) => {
        if (!lease.current()) return;
        console.warn("🪼 Jellyfin Enhanced: segment skip failed", err);
        if (!clickSkipButton()) JE2.toast(JE2.t("toast_no_skip_button"));
      });
    };
    function skipIntroOutroViaOsd() {
      const lease = lifetime2.lease();
      const reading = () => {
        const key = osdPlayback.itemKey();
        const duration = osdPlayback.durationSeconds();
        return key === null || duration === null ? null : { key, duration };
      };
      const atPress = reading();
      const fallback = () => {
        if (!clickSkipButton()) JE2.toast(JE2.t("toast_no_skip_button"));
      };
      if (atPress === null) {
        fallback();
        return;
      }
      const stillSame = () => lease.current() && (typeof JE2.isVideoPage !== "function" || JE2.isVideoPage()) && !getVideo2() && osdPlayback.sameItem(reading(), atPress);
      const routeId = getCurrentVideoItemId2();
      const lookup = routeId ? Promise.resolve(routeId) : sessionItemId({ duration: atPress.duration });
      lookup.then(async (itemId) => {
        if (!stillSame()) return null;
        const usable = !!itemId && (!atPress.key || normalizeItemId(itemId) === normalizeItemId(atPress.key));
        return { segments: usable && itemId ? await fetchMediaSegments(itemId) : [] };
      }).then((result) => {
        if (!result || !stillSame()) return;
        const now = osdPlayback.positionSeconds();
        const nowTicks = now === null ? null : now * TICKS_PER_SECOND;
        const seg = nowTicks === null ? void 0 : result.segments.find((s) => s && typeof s.StartTicks === "number" && typeof s.EndTicks === "number" && s.StartTicks <= nowTicks && s.EndTicks > nowTicks);
        if (seg && seg.EndTicks !== void 0 && now !== null) {
          const target = Math.min(seg.EndTicks / TICKS_PER_SECOND, osdPlayback.durationSeconds() || Infinity);
          if (target > now && osdPlayback.seekTo(target)) {
            if (seg.Type === "Intro") {
              JE2.toast(JE2.t("toast_skipped_intro"));
            } else if (seg.Type === "Outro") {
              JE2.toast(JE2.t("toast_skipped_outro"));
            } else {
              JE2.toast(JE2.t("toast_skipped"));
            }
            return;
          }
        }
        fallback();
      }).catch((err) => {
        console.warn("🪼 Jellyfin Enhanced: segment skip failed", err);
        if (stillSame()) fallback();
      });
    }
    lifetime2.onReset(() => segmentCache.clear());
  }

  // client/src/features/player/native-track-menu.ts
  function createTrackMenu(context2) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    let pendingMenuOpen = null;
    const sheetClosingAt = /* @__PURE__ */ new WeakMap();
    const SHEET_CLOSING_GRACE_MS = 1e3;
    document.addEventListener("closing", (e) => {
      const t = e.target;
      if (t instanceof Element && t.classList.contains("actionSheet")) {
        sheetClosingAt.set(t, performance.now());
      }
    }, true);
    function isClosing(sheet) {
      const at = sheetClosingAt.get(sheet);
      return at !== void 0 && performance.now() - at < SHEET_CLOSING_GRACE_MS;
    }
    const lastCycled = { subtitle: null, audio: null };
    function recentlyCycledId(kind) {
      const rec = lastCycled[kind];
      return rec && performance.now() - rec.at < 500 && rec.item === getCurrentVideoItemId2() ? rec.id : null;
    }
    function activate(el) {
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      }
      el.click();
    }
    function osdButtonTitle(selector) {
      const btn = document.querySelector(selector);
      return (btn && btn.getAttribute("title") || "").trim();
    }
    function isRendered(el) {
      if (!el) return false;
      const h = (
        /** @type {HTMLElement} */
        el
      );
      return !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length);
    }
    function findOpenSheetByTitle(title) {
      if (!title) return null;
      const sheet = Array.from(document.querySelectorAll(".actionSheet")).find(
        (s) => isRendered(s) && !sheetClosingAt.has(s) && Array.from(s.querySelectorAll(".actionSheetTitle")).some((t) => (t.textContent || "").trim() === title)
      );
      return sheet ? sheet.closest(".dialogContainer") || sheet : null;
    }
    function closeActionSheet(target) {
      let container = target || null;
      if (!container) {
        const sheet = Array.from(document.querySelectorAll(".actionSheet")).find((s) => isRendered(s) && !isClosing(s));
        container = sheet ? sheet.closest(".dialogContainer") : null;
      }
      if (!container) return false;
      if (typeof PointerEvent === "function") {
        container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
      }
      ["mousedown", "click"].forEach((type) => {
        container?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    }
    function openOsdMenu(buttonSelector, expectedTitle, timeout = 3e3) {
      const before = new Set(document.querySelectorAll(".dialogContainer"));
      const btn = (
        /** @type {HTMLElement|null} */
        document.querySelector(buttonSelector)
      );
      if (!btn) return Promise.resolve(null);
      activate(btn);
      return JE2.core.dom.waitForElement(".dialogContainer", {
        timeout,
        quiet: true,
        signal: lifetime2.lease().signal,
        predicate: (el) => {
          if (before.has(el) || !el.querySelector(".actionSheetContent")) return false;
          if (!expectedTitle) return true;
          const t = el.querySelector(".actionSheetTitle");
          return !!t && (t.textContent || "").trim() === expectedTitle;
        }
      });
    }
    function cycleWithinSheet(container, emptyToastKey, toastVar) {
      const options = Array.from(container.querySelectorAll(".actionSheetMenuItem")).filter((item) => /^-?\d+$/.test(item.getAttribute("data-id") || ""));
      if (!options.some((item) => item.getAttribute("data-id") !== "-1")) {
        JE2.toast(JE2.t(emptyToastKey));
        closeActionSheet(container);
        return;
      }
      const recentId = recentlyCycledId(
        /** @type {'subtitle'|'audio'} */
        toastVar
      );
      let currentIndex = recentId !== null ? options.findIndex((option) => option.getAttribute("data-id") === recentId) : -1;
      if (currentIndex === -1) {
        currentIndex = options.findIndex((option) => {
          const check = option.querySelector(".listItemIcon.check");
          return check && getComputedStyle(check).visibility !== "hidden";
        });
      }
      const next = options[(currentIndex + 1) % options.length];
      if (!next) return;
      activate(
        /** @type {HTMLElement} */
        next
      );
      lastCycled[toastVar] = {
        id: next.getAttribute("data-id"),
        at: performance.now(),
        item: getCurrentVideoItemId2()
      };
      const labelEl = next.querySelector(".listItemBodyText");
      JE2.toast(JE2.t("toast_" + toastVar, { [toastVar]: JE2.escapeHtml((labelEl && labelEl.textContent || "").trim()) }));
    }
    function cycleTrackMenu(buttonSelector, emptyToastKey, toastVar) {
      const lease = lifetime2.lease(getVideo2());
      const title = osdButtonTitle(buttonSelector);
      const alreadyOpen = findOpenSheetByTitle(title);
      if (alreadyOpen) {
        cycleWithinSheet(alreadyOpen, emptyToastKey, toastVar);
        return;
      }
      if (pendingMenuOpen) return;
      closeActionSheet();
      const pending = openOsdMenu(buttonSelector, title).then((container) => {
        if (!lease.current()) return;
        if (!container) {
          if (!document.querySelector(buttonSelector)) {
            console.warn(`🪼 Jellyfin Enhanced: ${buttonSelector} is not present; cannot cycle tracks.`);
          } else {
            console.warn(`🪼 Jellyfin Enhanced: ${buttonSelector} menu did not open in time.`);
          }
          if (typeof JE2.isVideoPage !== "function" || JE2.isVideoPage()) {
            JE2.toast(JE2.t(emptyToastKey));
          }
          return;
        }
        cycleWithinSheet(container, emptyToastKey, toastVar);
      }).catch((err) => {
        console.warn("🪼 Jellyfin Enhanced: track cycling failed:", err);
      }).finally(() => {
        if (pendingMenuOpen === pending) pendingMenuOpen = null;
      });
      pendingMenuOpen = pending;
    }
    lifetime2.onReset(() => {
      lastCycled.subtitle = lastCycled.audio = null;
      pendingMenuOpen = null;
    });
    return { cycleTrackMenu, openOsdMenu, activate, closeActionSheet };
  }

  // client/src/features/player/track-controls.ts
  function installTrackControls(context2, cycleTrackMenu) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    const TRACK_COMMAND_MEMORY_MS = 1e4;
    const lastCommanded = { subtitle: null, audio: null };
    function forgetCommanded(kind) {
      lastCommanded[kind] = null;
    }
    function rememberedIndex(kind, sessionId, itemId, mediaSourceId, reported) {
      const rec = lastCommanded[kind];
      if (!rec || rec.sessionId !== sessionId || rec.itemId !== itemId) return null;
      if (rec.mediaSourceId !== (mediaSourceId || null)) {
        forgetCommanded(kind);
        return null;
      }
      if (typeof reported === "number" && reported === rec.index) {
        forgetCommanded(kind);
        return null;
      }
      if (performance.now() - rec.at > TRACK_COMMAND_MEMORY_MS) return null;
      return rec.index;
    }
    function currentItemHint() {
      const video = getVideo2();
      const src = video && (video.currentSrc || video.src) || "";
      return normalizeItemId(parseItemIdFromVideosSrc(src) || getCurrentVideoItemId2());
    }
    async function probeOwnSession() {
      try {
        const ac = ApiClient2;
        if (!ac) return null;
        const userId = ac.getCurrentUserId();
        const deviceId = typeof ac.deviceId === "function" ? ac.deviceId() : "";
        if (!userId || !deviceId) return null;
        const sessions = await ac.ajax({
          type: "GET",
          url: ac.getUrl(`/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`),
          dataType: "json"
        });
        if (!Array.isArray(sessions)) return null;
        const matches = decodeSessions(sessions).filter((s) => s && s.DeviceId === deviceId && s.NowPlayingItem && s.NowPlayingItem.Id);
        return matches.length === 1 ? matches[0] ?? null : null;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: own-session probe failed", err);
        return null;
      }
    }
    const trackCycleChains = { subtitle: Promise.resolve(), audio: Promise.resolve() };
    async function cycleTrackViaApi(kind, press) {
      const ac = ApiClient2;
      if (!ac) return false;
      const onVideoPage = () => press.current() && (typeof JE2.isVideoPage !== "function" || JE2.isVideoPage());
      const surfaceUnchanged = () => {
        const v = getVideo2();
        return v === press.video && (v && (v.currentSrc || v.src) || "") === press.src;
      };
      if (!onVideoPage()) return true;
      const [pressItemId, session] = await Promise.all([press.item, probeOwnSession()]);
      if (!onVideoPage()) return true;
      if (!pressItemId) {
        return press.idless && !surfaceUnchanged();
      }
      const sessionId = session && session.Id;
      const itemId = session && session.NowPlayingItem && session.NowPlayingItem.Id;
      if (!sessionId || !itemId) return false;
      const sessionItem = normalizeItemId(itemId);
      if (sessionItem && pressItemId !== sessionItem) return true;
      if (press.idless && !surfaceUnchanged()) return true;
      const type = kind === "subtitle" ? "Subtitle" : "Audio";
      const streams = (session.NowPlayingItem && session.NowPlayingItem.MediaStreams || []).filter((s) => s.Type === type && typeof s.Index === "number");
      if (streams.length === 0) {
        JE2.toast(JE2.t(kind === "subtitle" ? "toast_no_subtitles_found" : "toast_no_audio_tracks_found"));
        return true;
      }
      const candidates = kind === "subtitle" ? [-1].concat(streams.map((s) => s.Index)) : streams.map((s) => s.Index);
      if (candidates.length < 2) {
        JE2.toast(JE2.t("toast_audio", { audio: JE2.escapeHtml(trackDisplayName(streams[0])) }));
        return true;
      }
      const playState = session.PlayState || {};
      const reported = kind === "subtitle" ? playState.SubtitleStreamIndex : playState.AudioStreamIndex;
      const mediaSourceId = playState.MediaSourceId || null;
      const current = rememberedIndex(kind, sessionId, itemId, mediaSourceId, reported);
      const effective = current !== null ? current : typeof reported === "number" ? reported : -1;
      const position = candidates.indexOf(effective);
      const next = candidates[(position + 1) % candidates.length];
      if (next === void 0) return false;
      const commandName = kind === "subtitle" ? "SetSubtitleStreamIndex" : "SetAudioStreamIndex";
      const itemNow = currentItemHint();
      if (itemNow && itemNow !== pressItemId) return true;
      try {
        await ac.ajax({
          type: "POST",
          url: ac.getUrl(`/Sessions/${encodeURIComponent(sessionId)}/Command`),
          contentType: "application/json",
          data: JSON.stringify({ Name: commandName, Arguments: { Index: String(next) } })
        });
      } catch (err) {
        if (!onVideoPage()) return true;
        let proven = currentItemHint();
        if (!proven) {
          const fresh = await probeOwnSession();
          proven = normalizeItemId(fresh && fresh.NowPlayingItem && fresh.NowPlayingItem.Id);
        }
        if (proven !== pressItemId) return true;
        console.warn(`🪼 Jellyfin Enhanced: ${commandName} failed, falling back to the menu cycle`, err);
        return false;
      }
      if (!onVideoPage()) return true;
      lastCommanded[kind] = { sessionId, itemId, mediaSourceId, index: next, at: performance.now() };
      const nextStream = next === -1 ? null : streams.find((s) => s.Index === next);
      JE2.toast(JE2.t(
        kind === "subtitle" ? "toast_subtitle" : "toast_audio",
        { [kind]: JE2.escapeHtml(trackDisplayName(nextStream)) }
      ));
      return true;
    }
    function trackDisplayName(stream2) {
      if (!stream2) return tWithFallback2("track_off", "Off");
      const name = (stream2.DisplayTitle || stream2.Title || stream2.Language || stream2.Codec || "").trim();
      return name || "#" + stream2.Index;
    }
    function cycleTrack(kind) {
      if (!ApiClient2) {
        forgetCommanded(kind);
        runMenuFallback(kind);
        return;
      }
      const hint = currentItemHint();
      const pressVideo = hint ? null : getVideo2();
      const lease = lifetime2.lease();
      const press = {
        current: lease.current,
        idless: !hint,
        video: pressVideo,
        src: pressVideo && (pressVideo.currentSrc || pressVideo.src) || "",
        item: Promise.resolve(null)
      };
      press.item = hint ? Promise.resolve(hint) : probeOwnSession().then((s) => {
        const id = normalizeItemId(s && s.NowPlayingItem && s.NowPlayingItem.Id);
        const v = getVideo2();
        const same = v === press.video && (v && (v.currentSrc || v.src) || "") === press.src;
        return same ? id : null;
      }).catch(() => null);
      trackCycleChains[kind] = trackCycleChains[kind].then(async () => {
        let handled = false;
        try {
          handled = await cycleTrackViaApi(kind, press);
        } catch (err) {
          console.warn("🪼 Jellyfin Enhanced: API track cycle failed", err);
        }
        if (handled || !press.current()) return;
        if (typeof JE2.isVideoPage === "function" && !JE2.isVideoPage()) return;
        forgetCommanded(kind);
        runMenuFallback(kind);
      });
    }
    function runMenuFallback(kind) {
      if (kind === "subtitle") {
        cycleTrackMenu("button.btnSubtitles", "toast_no_subtitles_found", "subtitle");
      } else {
        cycleTrackMenu("button.btnAudio", "toast_no_audio_tracks_found", "audio");
      }
    }
    JE2.cycleSubtitleTrack = () => cycleTrack("subtitle");
    JE2.cycleAudioTrack = () => cycleTrack("audio");
    let offsetPanel = null;
    let offsetPanelTimer = null;
    const hideOffsetPanel = () => {
      lifetime2.cancel(offsetPanelTimer);
      offsetPanel?.classList.add("hide");
      offsetPanel = offsetPanelTimer = null;
    };
    const syncSlider = () => document.querySelector(".subtitleSyncSlider");
    JE2.setSubtitleOffset = (seconds) => {
      const slider = syncSlider();
      const box = document.querySelector(".subtitleSyncContainer");
      if (!slider || !box || typeof slider.updateOffset !== "function") return false;
      slider.updateOffset(Math.round(seconds * 10) / 10);
      hideOffsetPanel();
      box.classList.remove("hide");
      offsetPanel = box;
      offsetPanelTimer = lifetime2.timeout(hideOffsetPanel, 2e3);
      return true;
    };
    JE2.adjustSubtitleOffset = (deltaSeconds) => {
      const slider = syncSlider();
      if (!slider || !JE2.setSubtitleOffset((parseFloat(slider.value) || 0) + deltaSeconds)) {
        JE2.toast(tWithFallback2("toast_subtitle_offset_unavailable", "Subtitle offset is not available"));
      }
    };
    lifetime2.onReset(() => {
      hideOffsetPanel();
      lastCommanded.subtitle = lastCommanded.audio = null;
      trackCycleChains.subtitle = Promise.resolve();
      trackCycleChains.audio = Promise.resolve();
    });
    return { probeOwnSession, trackDisplayName };
  }

  // client/src/features/player/normal-aspect.ts
  function installAspect(context2, cycleAspectInMenu) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    const ASPECT_MODES = ["auto", "cover", "fill"];
    function aspectModeLabel(mode) {
      if (mode === "cover") return tWithFallback2("aspect_ratio_cover", "Cover");
      if (mode === "fill") return tWithFallback2("aspect_ratio_fill", "Fill");
      return tWithFallback2("aspect_ratio_auto", "Auto");
    }
    JE2.cycleAspect = () => {
      const video = getVideo2();
      if (!video) {
        cycleAspectInMenu();
        return;
      }
      let stored = null;
      try {
        stored = window.localStorage.getItem("aspectRatio");
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: aspect ratio setting read failed", err);
      }
      const current = stored !== null && ASPECT_MODES.indexOf(stored) !== -1 ? stored : "auto";
      const next = ASPECT_MODES[(ASPECT_MODES.indexOf(current) + 1) % ASPECT_MODES.length] ?? "auto";
      try {
        window.localStorage.setItem("aspectRatio", next);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: aspect ratio setting write failed", err);
      }
      if (next === "auto") {
        video.style.removeProperty("object-fit");
      } else {
        video.style.objectFit = next;
      }
      const parent = video.parentElement;
      if (parent) {
        parent.querySelectorAll(":scope > canvas").forEach((canvas) => {
          canvas.style.objectFit = next === "auto" ? "contain" : next;
        });
      }
      JE2.toast(JE2.t("toast_aspect_ratio", { ratio: aspectModeLabel(next) }));
    };
  }

  // client/src/features/player/playback-info.ts
  function installPlaybackInfo(context2, probeOwnSession, trackDisplayName, menu2) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    const SETTINGS_BUTTON2 = "button.btnVideoOsdSettings";
    const NATIVE_MENU_TIMEOUT_MS = 1500;
    const HIDDEN_DIALOGS_MS2 = 400;
    let pendingNative = null;
    async function toggleNativePlaybackInfo() {
      if (!document.querySelector(SETTINGS_BUTTON2)) return false;
      const style = document.createElement("style");
      style.textContent = ".dialogContainer, .dialogBackdrop, .actionSheet { opacity:0 !important; transition:none !important; }";
      document.head.appendChild(style);
      try {
        const container = await menu2.openOsdMenu(SETTINGS_BUTTON2, "", NATIVE_MENU_TIMEOUT_MS);
        const entry = container?.querySelector('button[data-id="stats"]');
        if (!entry) {
          if (container) menu2.closeActionSheet(container);
          return false;
        }
        menu2.activate(entry);
        return true;
      } finally {
        window.setTimeout(() => style.remove(), HIDDEN_DIALOGS_MS2);
      }
    }
    const PLAYBACK_INFO_REFRESH_MS = 1e3;
    let playbackInfoOverlay = null;
    let playbackInfoTimer = null;
    function destroyPlaybackInfo() {
      if (playbackInfoTimer) {
        lifetime2.cancel(playbackInfoTimer);
        playbackInfoTimer = null;
      }
      if (playbackInfoOverlay) {
        playbackInfoOverlay.remove();
        playbackInfoOverlay = null;
      }
    }
    function playbackInfoRows(video, session) {
      const rows = [];
      if (video.videoWidth && video.videoHeight) {
        rows.push([tWithFallback2("pi_resolution", "Resolution"), `${video.videoWidth}×${video.videoHeight}`]);
      }
      if (Math.abs(video.playbackRate - 1) > 1e-3) {
        rows.push([tWithFallback2("pi_speed", "Speed"), `${video.playbackRate}x`]);
      }
      if (typeof video.getVideoPlaybackQuality === "function") {
        const q = video.getVideoPlaybackQuality();
        rows.push([tWithFallback2("pi_dropped_frames", "Dropped frames"), `${q.droppedVideoFrames} / ${q.totalVideoFrames}`]);
      }
      try {
        const buffered = video.buffered;
        if (buffered && buffered.length > 0) {
          const ahead = buffered.end(buffered.length - 1) - video.currentTime;
          if (Number.isFinite(ahead)) rows.push([tWithFallback2("pi_buffer", "Buffered"), `${Math.max(0, ahead).toFixed(1)} s`]);
        }
      } catch (err) {
      }
      if (session) {
        const playState = session.PlayState || {};
        const transcoding = session.TranscodingInfo || null;
        if (playState.PlayMethod) {
          let method = playState.PlayMethod;
          if (transcoding && typeof transcoding.CompletionPercentage === "number") {
            method += ` (${transcoding.CompletionPercentage.toFixed(0)}%)`;
          }
          rows.push([tWithFallback2("pi_play_method", "Play method"), method]);
        }
        if (transcoding) {
          const codecs = [transcoding.Container, transcoding.VideoCodec, transcoding.AudioCodec].filter(Boolean).join(" · ");
          if (codecs) rows.push([tWithFallback2("pi_transcoding", "Transcoding"), codecs]);
          if (typeof transcoding.Bitrate === "number" && transcoding.Bitrate > 0) {
            rows.push([tWithFallback2("pi_bitrate", "Bitrate"), `${(transcoding.Bitrate / 1e6).toFixed(1)} Mbps`]);
          }
          const reasons = Array.isArray(transcoding.TranscodeReasons) ? transcoding.TranscodeReasons.join(", ") : transcoding.TranscodeReasons || "";
          if (reasons) rows.push([tWithFallback2("pi_transcode_reason", "Reason"), reasons]);
        } else if (session.NowPlayingItem && session.NowPlayingItem.Container) {
          rows.push([tWithFallback2("pi_container", "Container"), session.NowPlayingItem.Container]);
        }
        const streams = session.NowPlayingItem && session.NowPlayingItem.MediaStreams || [];
        if (typeof playState.AudioStreamIndex === "number") {
          const audio = streams.find((s) => s && s.Type === "Audio" && s.Index === playState.AudioStreamIndex);
          if (audio) rows.push([tWithFallback2("pi_audio", "Audio"), trackDisplayName(audio)]);
        }
        if (typeof playState.SubtitleStreamIndex === "number" && playState.SubtitleStreamIndex >= 0) {
          const sub = streams.find((s) => s && s.Type === "Subtitle" && s.Index === playState.SubtitleStreamIndex);
          if (sub) rows.push([tWithFallback2("pi_subtitle", "Subtitles"), trackDisplayName(sub)]);
        }
      }
      return rows;
    }
    function renderPlaybackInfo(video, session) {
      if (!playbackInfoOverlay) return;
      const fragment = document.createDocumentFragment();
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;margin-bottom:6px;";
      title.textContent = tWithFallback2("playback_info_title", "Playback Info");
      fragment.appendChild(title);
      for (const [label, value] of playbackInfoRows(video, session)) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:space-between;gap:16px;";
        const labelEl = document.createElement("span");
        labelEl.style.opacity = "0.75";
        labelEl.textContent = label;
        const valueEl = document.createElement("span");
        valueEl.textContent = value;
        row.append(labelEl, valueEl);
        fragment.appendChild(row);
      }
      playbackInfoOverlay.replaceChildren(fragment);
    }
    async function refreshPlaybackInfo(overlay) {
      const lease = lifetime2.lease();
      if (playbackInfoOverlay !== overlay) return;
      try {
        if (typeof JE2.isVideoPage === "function" && !JE2.isVideoPage()) {
          destroyPlaybackInfo();
          return;
        }
        const video = getVideo2();
        if (!video) {
          destroyPlaybackInfo();
          return;
        }
        const sampledSrc = video.currentSrc || video.src || "";
        const sampledPageItem = getCurrentVideoItemId2();
        const session = await probeOwnSession();
        if (playbackInfoOverlay !== overlay) return;
        if (!lease.current()) return;
        const current = getVideo2();
        if (!current) {
          destroyPlaybackInfo();
          return;
        }
        const currentSrc = current.currentSrc || current.src || "";
        const derivable = normalizeItemId(parseItemIdFromVideosSrc(currentSrc) || getCurrentVideoItemId2());
        const sessionItem = normalizeItemId(session && session.NowPlayingItem && session.NowPlayingItem.Id);
        const coherent = current === video && currentSrc === sampledSrc && getCurrentVideoItemId2() === sampledPageItem && !(derivable && sessionItem && derivable !== sessionItem);
        if (coherent) renderPlaybackInfo(current, session);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: playback info refresh failed", err);
      }
      if (playbackInfoOverlay === overlay) {
        playbackInfoTimer = lifetime2.timeout(() => {
          playbackInfoTimer = null;
          refreshPlaybackInfo(overlay);
        }, PLAYBACK_INFO_REFRESH_MS);
      }
    }
    JE2.togglePlaybackInfo = async () => {
      if (playbackInfoOverlay) {
        destroyPlaybackInfo();
        return;
      }
      if (pendingNative) return;
      const lease = lifetime2.lease();
      const pending = toggleNativePlaybackInfo();
      pendingNative = pending;
      let toggled = false;
      try {
        toggled = await pending;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: native playback info failed, using overlay", err);
      } finally {
        if (pendingNative === pending) pendingNative = null;
      }
      if (toggled || !lease.current() || playbackInfoOverlay) return;
      const video = getVideo2();
      if (!video) {
        JE2.toast(playerUnsupportedText(context2));
        return;
      }
      const overlay = document.createElement("div");
      overlay.setAttribute("data-je-playback-info", "true");
      overlay.style.cssText = `
            position: fixed; top: 12px; left: 12px; z-index: 999999;
            background: rgba(0,0,0,0.72); color: #fff; padding: 10px 14px;
            border-radius: 8px; font-size: 0.85em; font-family: system-ui;
            pointer-events: none; min-width: 240px; max-width: 42vw;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        `;
      playbackInfoOverlay = overlay;
      renderPlaybackInfo(video, null);
      document.body.appendChild(overlay);
      refreshPlaybackInfo(overlay);
    };
    lifetime2.onReset(() => {
      destroyPlaybackInfo();
      pendingNative = null;
    });
  }

  // client/src/features/player/long-press.ts
  function installLongPress(context2) {
    const { JE: JE2, ApiClient: ApiClient2, lifetime: lifetime2, getVideo: getVideo2, getCurrentVideoItemId: getCurrentVideoItemId2, tWithFallback: tWithFallback2 } = context2;
    const LONG_PRESS_CONFIG = {
      DURATION: 500,
      SPEED_NORMAL: 1,
      SPEED_FAST: 2,
      MOVEMENT_THRESHOLD: 10
      // pixels - ignore small movements
    };
    let pressTimer = null;
    let isLongPress = false;
    let videoElement = null;
    let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
    let speedOverlay = null;
    let pressStartX = null;
    let pressStartY = null;
    function createSpeedOverlay() {
      if (speedOverlay) return;
      speedOverlay = document.createElement("div");
      speedOverlay.setAttribute("data-speed-overlay", "true");
      speedOverlay.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.9); color: white; padding: 8px 16px; border-radius: 6px;
            font-size: 1.2em; font-weight: bold; z-index: 999999;
            pointer-events: none; font-family: system-ui;
            opacity: 0; transition: opacity 0.2s ease-out; display: none;
        `;
      document.body.appendChild(speedOverlay);
    }
    function showOverlay(speed) {
      createSpeedOverlay();
      if (!speedOverlay) return;
      speedOverlay.innerHTML = `${speed}x${speed > 1 ? " " + JE2.icon(JE2.IconName.FAST_FORWARD) : " " + JE2.icon(JE2.IconName.PLAY)}`;
      speedOverlay.style.display = "block";
      lifetime2.timeout(() => {
        if (speedOverlay) speedOverlay.style.opacity = "1";
      }, 10);
    }
    function hideOverlay() {
      if (speedOverlay) {
        speedOverlay.style.opacity = "0";
        lifetime2.timeout(() => {
          if (speedOverlay) speedOverlay.style.display = "none";
        }, 200);
      }
    }
    JE2.handleLongPressDown = (e) => {
      if (!JE2.currentSettings.longPress2xEnabled || e.button !== void 0 && e.button !== 0 || pressTimer) {
        return;
      }
      videoElement = getVideo2();
      if (!videoElement) return;
      pressStartX = e.clientX ?? e.touches?.[0]?.clientX ?? null;
      pressStartY = e.clientY ?? e.touches?.[0]?.clientY ?? null;
      originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
      isLongPress = false;
      const lease = lifetime2.lease(videoElement);
      pressTimer = lifetime2.timeout(() => {
        if (!lease.current() || videoElement !== getVideo2()) {
          JE2.handleLongPressCancel();
          return;
        }
        if (JE2.state.pauseScreenClickTimer) {
          lifetime2.cancel(JE2.state.pauseScreenClickTimer);
          JE2.state.pauseScreenClickTimer = null;
        }
        isLongPress = true;
        if (!videoElement) return;
        if (videoElement.paused) {
          videoElement.play().catch((err) => console.warn("🪼 Play blocked:", err));
        }
        videoElement.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
        showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
        if (navigator.vibrate) navigator.vibrate(50);
      }, LONG_PRESS_CONFIG.DURATION);
    };
    JE2.handleLongPressUp = (e) => {
      if (!pressTimer) return;
      lifetime2.cancel(pressTimer);
      pressTimer = null;
      if (isLongPress) {
        const video = videoElement;
        if (video) {
          video.playbackRate = originalSpeed;
        }
        hideOverlay();
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      isLongPress = false;
      pressStartX = null;
      pressStartY = null;
    };
    JE2.handleLongPressCancel = () => {
      if (pressTimer) {
        lifetime2.cancel(pressTimer);
        pressTimer = null;
        if (isLongPress) {
          const video = videoElement;
          if (video) {
            video.playbackRate = originalSpeed;
          }
          hideOverlay();
        }
        isLongPress = false;
      }
      pressStartX = null;
      pressStartY = null;
    };
    JE2.handleLongPressMove = (e) => {
      if (!pressTimer || isLongPress || pressStartX === null || pressStartY === null) return;
      const currentX = e.clientX ?? e.touches?.[0]?.clientX ?? null;
      const currentY = e.clientY ?? e.touches?.[0]?.clientY ?? null;
      if (currentX === null || currentY === null) return;
      const distanceMoved = Math.sqrt(
        Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
      );
      if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
        lifetime2.cancel(pressTimer);
        pressTimer = null;
        pressStartX = null;
        pressStartY = null;
      }
    };
    JE2.handleLongPressClick = (e) => {
      if (isLongPress || pressTimer) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
    };
    lifetime2.onReset(() => {
      JE2.handleLongPressCancel();
      videoElement = null;
      speedOverlay?.remove();
      speedOverlay = null;
    });
  }

  // client/src/features/player/osd-seek-history.ts
  var OSD_SEEK_RATE_ALLOWANCE = 4;
  var OSD_ITEM_END_SECONDS = 30;
  var OSD_IDENTITY_SETTLE_MS = 5e3;
  var OSD_INTENT_WINDOW_MS = 3e3;
  var OSD_INTENT_MOVED_SECONDS = 1.5;
  var OSD_INTENT_RATE_TOLERANCE = 0.5;
  var OSD_RATE_WINDOW_MS = 3e3;
  var OSD_SEEK_KEYS = /* @__PURE__ */ new Set(["ArrowLeft", "ArrowRight", "Left", "Right", "Home", "End", "PageUp", "PageDown", "KeyJ", "KeyL"]);
  var OSD_SEEK_BUTTONS = ".btnRewind, .btnFastForward, .btnPreviousChapter, .btnNextChapter";
  var OSD_SEEK_SLACK_SECONDS = 2.5;
  var OSD_SEEK_BACK_SECONDS = 1.5;
  var OSD_SLIDER_SEEK_MIN_SECONDS = 1;
  var OSD_JUMP_SETTLE_MS = 15e3;
  var OSD_JUMP_ARRIVED_SECONDS = 3;
  function installOsdSeekHistory(context2, history) {
    const { JE: JE2, lifetime: lifetime2, getVideo: getVideo2, tWithFallback: tWithFallback2 } = context2;
    let lastReading = null;
    let historyItem = null;
    let jump = null;
    let ownJump = false;
    let intent = null;
    let pendingSeek = null;
    let rate = 1;
    let run = null;
    let watchedText = null;
    let observer = null;
    let listening = null;
    const isOnVideoPage = () => typeof JE2.isVideoPage !== "function" || JE2.isVideoPage();
    function readOsd() {
      const position = osdPlayback.positionSeconds();
      const key = osdPlayback.itemKey();
      const duration = osdPlayback.durationSeconds();
      if (position === null || key === null || duration === null) return null;
      return { key, duration, position, at: Date.now(), playing: osdPlayback.isPaused() !== true };
    }
    function rememberPosition(reading) {
      history.position = reading.position;
      historyItem = { key: reading.key, duration: reading.duration };
      pendingSeek = null;
      run = null;
    }
    function landingFor(reading, target) {
      return { key: reading.key, duration: reading.duration, position: target, from: reading.position, at: reading.at, playing: reading.playing, until: reading.at + OSD_JUMP_SETTLE_MS };
    }
    function noteRate(value) {
      if (Number.isFinite(value) && value > 0) rate = value;
      run = null;
    }
    function confirmIntent(reading) {
      const pending = intent;
      if (!pending) return false;
      if (reading.at - pending.at > OSD_INTENT_WINDOW_MS || !osdPlayback.sameItem(pending, reading)) {
        intent = null;
        return false;
      }
      const playedSinceIntent = pending.playing ? Math.max(0, reading.at - pending.at) / 1e3 : 0;
      const expected = pending.position + playedSinceIntent * rate;
      if (Math.abs(reading.position - expected) < OSD_INTENT_MOVED_SECONDS + playedSinceIntent * OSD_INTENT_RATE_TOLERANCE) return false;
      intent = null;
      rememberPosition(pending);
      return true;
    }
    function notePosition() {
      if (getVideo2()) return;
      const reading = readOsd();
      if (!reading) return;
      if (historyItem && !osdPlayback.sameItem(historyItem, reading)) {
        history.position = null;
        historyItem = null;
      }
      if (jump) {
        const landing = jump;
        if (osdPlayback.sameItem(reading, landing)) {
          const played2 = Math.max(0, reading.at - landing.at) / 1e3 * rate;
          const near = (origin) => reading.position >= origin - OSD_JUMP_ARRIVED_SECONDS && reading.position <= origin + played2 + OSD_JUMP_ARRIVED_SECONDS;
          const landed = near(landing.position);
          if (!landed && near(landing.from) && reading.at < landing.until) return;
          jump = null;
          if (intent && intent.at >= landing.at && confirmIntent(reading)) {
            lastReading = reading;
            return;
          }
          if (landed || reading.at >= landing.until) {
            lastReading = reading;
            run = null;
            return;
          }
        } else {
          jump = null;
        }
      }
      const previous = lastReading;
      lastReading = reading;
      if (pendingSeek) {
        if (!osdPlayback.sameItem(pendingSeek.from, reading)) {
          pendingSeek = null;
        } else if (reading.at >= pendingSeek.until) {
          rememberPosition(pendingSeek.from);
        }
      }
      if (!previous || !osdPlayback.sameItem(previous, reading)) {
        rate = 1;
        run = null;
        return;
      }
      if (confirmIntent(reading)) return;
      const delta = reading.position - previous.position;
      const played = previous.playing ? Math.max(0, reading.at - previous.at) / 1e3 : 0;
      if (delta < -OSD_SEEK_BACK_SECONDS || delta > played * OSD_SEEK_RATE_ALLOWANCE + OSD_SEEK_SLACK_SECONDS) {
        run = null;
        if (previous.duration - previous.position <= OSD_ITEM_END_SECONDS) {
          history.position = null;
          historyItem = null;
          pendingSeek = { from: previous, until: reading.at + OSD_IDENTITY_SETTLE_MS };
          return;
        }
        rememberPosition(previous);
        return;
      }
      if (!previous.playing || !reading.playing) {
        run = null;
      } else if (!run) {
        run = reading;
      } else if (reading.at - run.at >= OSD_RATE_WINDOW_MS) {
        const measured = (reading.position - run.position) / ((reading.at - run.at) / 1e3);
        rate = Math.min(OSD_SEEK_RATE_ALLOWANCE, Math.max(0.25, measured));
        run = reading;
      }
    }
    function intentReading() {
      const reading = readOsd();
      if (!reading || !jump || !osdPlayback.sameItem(reading, jump)) return reading;
      const played = reading.playing ? Math.max(0, reading.at - jump.at) / 1e3 * rate : 0;
      return { ...reading, position: jump.position + played };
    }
    function onSeekKey(e) {
      if (getVideo2() || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !isOnVideoPage()) return;
      const target = e.target;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement && target.type !== "range") return;
      const code = e.code || "";
      if (OSD_SEEK_KEYS.has(code) || OSD_SEEK_KEYS.has(e.key || "") || /^(Digit|Numpad)\d$/.test(code)) intent = intentReading();
    }
    function onSeekButton(e) {
      if (getVideo2()) return;
      const btn = e.target instanceof Element ? e.target.closest(OSD_SEEK_BUTTONS) : null;
      const page = btn && osdPlayback.activeOsdPage();
      if (page && page.contains(btn)) intent = intentReading();
    }
    function onSliderChange(e) {
      const slider = e.target;
      if (ownJump || getVideo2() || !(slider instanceof HTMLInputElement) || !slider.classList.contains("osdPositionSlider")) return;
      const page = osdPlayback.activeOsdPage();
      if (!page || !page.contains(slider)) return;
      const reading = readOsd();
      if (!reading) return;
      const target = parseFloat(slider.value) / 100 * reading.duration;
      if (!Number.isFinite(target) || Math.abs(target - reading.position) < OSD_SLIDER_SEEK_MIN_SECONDS) return;
      rememberPosition(reading);
      lastReading = reading;
      jump = landingFor(reading, target);
    }
    JE2.watchOsdPosition = () => {
      if (!listening) {
        listening = new AbortController();
        const { signal } = listening;
        document.addEventListener("change", onSliderChange, { capture: true, signal });
        document.addEventListener("keydown", onSeekKey, { capture: true, signal });
        document.addEventListener("click", onSeekButton, { capture: true, signal });
      }
      const page = osdPlayback.activeOsdPage();
      const text2 = page && !getVideo2() ? page.querySelector(".osdPositionText") : null;
      if (text2 === watchedText) return;
      observer?.disconnect();
      observer = null;
      watchedText = text2;
      lastReading = null;
      if (!text2 || !page) return;
      observer = new MutationObserver(notePosition);
      observer.observe(text2, { childList: true, characterData: true, subtree: true });
      const playPause = page.querySelector(".btnPause");
      if (playPause) observer.observe(playPause, { attributes: true, attributeFilter: ["class"], subtree: true });
      notePosition();
    };
    JE2.stopWatchingOsdPosition = () => {
      observer?.disconnect();
      observer = null;
      watchedText = null;
      lastReading = null;
      intent = null;
      pendingSeek = null;
      run = null;
      listening?.abort();
      listening = null;
    };
    function jumpToLast() {
      if (osdPlayback.positionSeconds() === null) {
        JE2.toast(playerUnsupportedText(context2));
        return;
      }
      notePosition();
      if (history.position === null) {
        JE2.toast(tWithFallback2("toast_no_last_position", "{{icon:rewind}} No previous position saved"));
        return;
      }
      const targetTime = history.position;
      const before = readOsd();
      ownJump = true;
      let moved;
      try {
        moved = osdPlayback.seekTo(targetTime);
      } finally {
        ownJump = false;
      }
      if (!moved) {
        JE2.toast(playerUnsupportedText(context2));
        return;
      }
      history.position = null;
      historyItem = null;
      pendingSeek = null;
      run = null;
      jump = before ? landingFor(before, targetTime) : null;
      const mins = Math.floor(targetTime / 60);
      const secs = Math.floor(targetTime % 60).toString().padStart(2, "0");
      JE2.toast(tWithFallback2("toast_jumped_back", "{{icon:rewind}} Jumped back to {time}", { time: `${mins}:${secs}` }));
    }
    function jumpToPercent(percentage) {
      if (osdPlayback.seekToPercent(percentage)) JE2.toast(JE2.t("toast_jumped_to", { percent: Number(percentage) }));
      else JE2.toast(playerUnsupportedText(context2));
    }
    lifetime2.onReset(() => {
      JE2.stopWatchingOsdPosition();
      historyItem = null;
      jump = null;
      ownJump = false;
      rate = 1;
    });
    return { jumpToLast, jumpToPercent, noteRate };
  }

  // client/src/features/player/osd-settings-menu.ts
  var SETTINGS_BUTTON = "#videoOsdPage:not(.hide) .btnVideoOsdSettings";
  var SETTINGS_MENU_ITEMS = ["stats", "aspectratio", "playbackrate", "quality", "repeatmode", "suboffset"].map((id) => `button[data-id="${id}"]`).join(", ");
  var HIDDEN_DIALOGS_MS = 400;
  function isSettingsSubmenu(menuId, options, current) {
    if (options.length < 2) return false;
    if (!current || !options.some((option) => option.selected && option.name === current)) return false;
    if (menuId === "playbackrate") {
      return options.every((option) => /^\d+(\.\d+)?$/.test(option.id || "")) && options.some((option) => Number(option.id) === 1);
    }
    return menuId === "aspectratio";
  }
  async function waitUntilRemoved(container, timeoutMs) {
    const t0 = Date.now();
    while (container.isConnected && Date.now() - t0 < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  function createOsdSettingsMenu(context2, menu2, noteRate) {
    const { JE: JE2, lifetime: lifetime2 } = context2;
    let queue = Promise.resolve();
    const isOnVideoPage = () => typeof JE2.isVideoPage !== "function" || JE2.isVideoPage();
    async function runSettingsMenu(menuId, pick) {
      if (!isOnVideoPage()) return false;
      const lease = lifetime2.lease();
      const gone = () => !isOnVideoPage() || !lease.current();
      const style = document.createElement("style");
      style.textContent = ".dialogContainer, .dialogBackdrop, .actionSheet { opacity:0 !important; transition:none !important; }";
      document.head.appendChild(style);
      try {
        const main = await menu2.openOsdMenu(SETTINGS_BUTTON, "");
        if (!main) return false;
        if (!main.querySelector(SETTINGS_MENU_ITEMS)) return null;
        const item = main.querySelector(`button[data-id="${menuId}"]`);
        if (!item || gone()) {
          menu2.closeActionSheet(main);
          return gone() ? null : false;
        }
        const current = (item.querySelector(".actionSheetItemAsideText")?.textContent || "").trim();
        const before = new Set(document.querySelectorAll(".dialogContainer"));
        menu2.activate(item);
        const sub = await JE2.core.dom.waitForElement(".dialogContainer", {
          timeout: 3e3,
          quiet: true,
          signal: lease.signal,
          predicate: (el) => !before.has(el) && !!el.querySelector(".actionSheetContent") && !Array.from(el.querySelectorAll(".actionSheetTitle")).some((title) => (title.textContent || "").trim())
        });
        if (!sub) return gone() ? null : false;
        if (gone()) {
          menu2.closeActionSheet(sub);
          return null;
        }
        const rows = Array.from(sub.querySelectorAll("button[data-id]")).map((btn) => ({
          btn,
          id: btn.getAttribute("data-id") || "",
          name: ((btn.querySelector(".actionSheetItemText") || btn).textContent || "").trim(),
          // Every row has a check icon; only the current option's is visible.
          selected: Array.from(btn.querySelectorAll(".check")).some((icon) => icon.style.visibility !== "hidden")
        }));
        const options = rows.map(({ id, name, selected }) => ({ id, name, selected }));
        if (!isSettingsSubmenu(menuId, options, current)) return null;
        const choice = pick(options);
        const row = choice && rows.find((option) => option.id === choice.id);
        if (!row) {
          menu2.closeActionSheet(sub);
          return null;
        }
        menu2.activate(row.btn);
        await waitUntilRemoved(sub, 1500);
        return { id: row.id, name: row.name };
      } finally {
        window.setTimeout(() => style.remove(), HIDDEN_DIALOGS_MS);
      }
    }
    function chooseInSettingsMenu(menuId, pick) {
      const run = queue.then(() => runSettingsMenu(menuId, pick));
      queue = run.catch(() => void 0);
      return run;
    }
    function stepPlaybackRate(direction) {
      chooseInSettingsMenu("playbackrate", (options) => {
        const normal = options.find((option) => Number(option.id) === 1) || null;
        const current = options.findIndex((option) => option.selected);
        if (direction === "reset" || current === -1) return normal;
        const next = direction === "increase" ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0);
        return options[next];
      }).then((result) => {
        if (!isOnVideoPage() || result === null) return;
        if (result === false) {
          JE2.toast(playerUnsupportedText(context2));
          return;
        }
        const speed = Number(result.id);
        noteRate(speed);
        JE2.toast(speed === 1 ? JE2.t("toast_speed_normal") : JE2.t("toast_speed", { speed }));
      }).catch((err) => {
        console.warn("🪼 Jellyfin Enhanced: playback speed through the settings menu failed", err);
      });
    }
    function cycleAspect() {
      chooseInSettingsMenu("aspectratio", (options) => {
        const current = options.findIndex((option) => option.selected);
        return options[(current + 1) % options.length];
      }).then((result) => {
        if (!isOnVideoPage() || result === null) return;
        if (result === false) {
          JE2.toast(playerUnsupportedText(context2));
          return;
        }
        JE2.toast(JE2.t("toast_aspect_ratio", { ratio: JE2.escapeHtml(result.name) }));
      }).catch((err) => {
        console.warn("🪼 Jellyfin Enhanced: aspect ratio through the settings menu failed", err);
      });
    }
    lifetime2.onReset(() => {
      queue = Promise.resolve();
    });
    return { stepPlaybackRate, cycleAspect };
  }

  // client/src/features/player/playback.ts
  var { JE, ApiClient, ctx } = playerHost();
  var lifetime = createPlayerLifetime(JE, "playback");
  var getVideo = () => document.querySelector("video");
  var _tFallbackWarned = /* @__PURE__ */ new Set();
  function tWithFallback(key, fallback, params) {
    let result;
    try {
      result = JE.t(key, params);
    } catch (err) {
      console.warn(`🪼 Jellyfin Enhanced: JE.t('${key}') threw, using fallback:`, err);
      result = null;
    }
    if (!result || result === key) {
      if (!_tFallbackWarned.has(key)) {
        _tFallbackWarned.add(key);
        console.warn(`🪼 Jellyfin Enhanced: missing translation key '${key}', using inline fallback`);
      }
      let out = fallback;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          out = out.split(`{${k}}`).join(String(v));
        }
      }
      return out;
    }
    return result;
  }
  var settingsBtn = () => document.querySelector(
    '.videoOsdBottom .btnVideoOsdSettings, .videoOsdBottom button[title="Settings"], .videoOsdBottom button[aria-label="Settings"]'
  );
  JE.openSettings = (cb) => {
    settingsBtn()?.click();
    lifetime.timeout(cb, 120);
  };
  JE.adjustPlaybackSpeed = (direction) => {
    const video = getVideo();
    if (!video) {
      osdMenu.stepPlaybackRate(direction === "increase" ? "increase" : "decrease");
      return;
    }
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    let currentIndex = speeds.findIndex((speed) => Math.abs(speed - video.playbackRate) < 0.01);
    if (currentIndex === -1) {
      currentIndex = speeds.findIndex((speed) => speed >= video.playbackRate);
      if (currentIndex === -1) currentIndex = speeds.length - 1;
    }
    if (direction === "increase") {
      currentIndex = Math.min(currentIndex + 1, speeds.length - 1);
    } else {
      currentIndex = Math.max(currentIndex - 1, 0);
    }
    video.playbackRate = speeds[currentIndex] ?? 1;
    JE.toast(JE.t("toast_speed", { speed: video.playbackRate }));
  };
  JE.resetPlaybackSpeed = () => {
    const video = getVideo();
    if (!video) {
      osdMenu.stepPlaybackRate("reset");
      return;
    }
    video.playbackRate = 1;
    JE.toast(JE.t("toast_speed_normal"));
  };
  JE.jumpToPercentage = (percentage) => {
    const video = getVideo();
    if (!video) {
      osdSeek.jumpToPercent(percentage);
      return;
    }
    if (!video.duration) {
      JE.toast(JE.t("toast_no_video_found"));
      return;
    }
    video.currentTime = video.duration * (percentage / 100);
    JE.toast(JE.t("toast_jumped_to", { percent: percentage }));
  };
  var context = { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback };
  ctx.own.osdPlayback = osdPlayback;
  var seekHistory = { position: null };
  var menu = createTrackMenu(context);
  var osdSeek = installOsdSeekHistory(context, seekHistory);
  var osdMenu = createOsdSettingsMenu(context, menu, osdSeek.noteRate);
  installFrameSeek(context, seekHistory, osdSeek.jumpToLast);
  installSegmentControls(context, async (shown) => await ctx.own.nowPlaying?.itemIdFromSession?.(shown) ?? null);
  var tracks = installTrackControls(context, menu.cycleTrackMenu);
  installAspect(context, osdMenu.cycleAspect);
  installPlaybackInfo(context, tracks.probeOwnSession, tracks.trackDisplayName, menu);
  installLongPress(context);
  ctx.own.player = Object.assign(ctx.own.player || {}, { getVideo, getCurrentVideoItemId, probeOwnSession: tracks.probeOwnSession });
})();
})();
//# sourceMappingURL=playback.js.map
