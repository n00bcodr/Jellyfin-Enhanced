(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/player/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/player/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "playerHost");

  // client/generated-shared/stub/client/src/features/player/wire.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/player/wire");
  var export2 = /* @__PURE__ */ sharedExport(shared2, "decodeSegments");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "decodeSessions");

  // client/generated-shared/stub/client/src/features/player/lifetime.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/player/lifetime");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "createPlayerLifetime");

  // client/src/features/player/auto-skip-engine.ts
  var TICKS_PER_SECOND = 1e7;
  var MIN_SEGMENT_TICKS = TICKS_PER_SECOND;
  var MAX_PROBE_ATTEMPTS = 5;
  function segmentKey(seg) {
    return seg.Id || `${seg.Type || "Unknown"}:${seg.StartTicks != null ? seg.StartTicks : ""}:${seg.EndTicks != null ? seg.EndTicks : ""}`;
  }
  function parseTranscodeOffsetTicksFromSrc(src) {
    try {
      const q = src.indexOf("?");
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
      console.warn("🪼 Jellyfin Enhanced: auto-skip offset parse failed", err);
      return 0;
    }
  }
  function createSessionItemResolver(opts) {
    let probedSrc = null;
    let probedId = null;
    let probeAttempts = 0;
    let inFlight = false;
    return (video) => {
      const src = video.currentSrc || "";
      const direct = src ? opts.parseFromSrc(src) : null;
      if (direct) return direct;
      const fromPage = opts.fallbackId();
      if (fromPage) return fromPage;
      if (src !== probedSrc) {
        probedSrc = src;
        probedId = null;
        probeAttempts = 0;
      }
      if (src && !probedId && !inFlight && probeAttempts < MAX_PROBE_ATTEMPTS) {
        probeAttempts++;
        inFlight = true;
        opts.probeNowPlayingId().then((id) => {
          if (probedSrc === src) probedId = id;
        }).catch(() => void 0).finally(() => {
          inFlight = false;
        });
      }
      return src && src === probedSrc ? probedId : null;
    };
  }
  function createAutoSkipEngine(deps) {
    let video = null;
    let listener = null;
    let itemId = null;
    let segments = [];
    let fetchToken = 0;
    let lastTimeTicks = -1;
    let lastKey = null;
    let lastIgnored = false;
    async function loadSegments(id) {
      const token = ++fetchToken;
      let result = [];
      try {
        result = await deps.fetchSegments(id);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: media-segments fetch failed", err);
        result = [];
      }
      if (token !== fetchToken) return;
      segments = (Array.isArray(result) ? result : []).filter((s) => s && s.StartTicks != null).slice().sort((a, b) => (a.StartTicks || 0) - (b.StartTicks || 0));
    }
    function reinitIfItemChanged() {
      if (!video) return;
      const id = deps.resolveItemId(video);
      if (id === itemId) return;
      if (!id) {
        itemId = null;
        segments = [];
        lastTimeTicks = -1;
        lastKey = null;
        lastIgnored = false;
        fetchToken++;
        return;
      }
      itemId = id;
      segments = [];
      lastTimeTicks = -1;
      lastKey = null;
      lastIgnored = false;
      loadSegments(id);
    }
    function evaluate() {
      if (!video) return;
      const t = video.currentTime;
      if (!Number.isFinite(t)) return;
      const offsetTicks = deps.getPositionOffsetTicks(video);
      const timeTicks = t * TICKS_PER_SECOND + offsetTicks;
      if (!segments.length) return;
      for (const seg of segments) {
        if (seg.StartTicks == null || seg.EndTicks == null) continue;
        const inSegment = seg.StartTicks <= timeTicks && seg.EndTicks > timeTicks;
        if (!inSegment) continue;
        if (!deps.shouldSkipType(seg.Type)) continue;
        const key = segmentKey(seg);
        if (lastIgnored && lastKey === key) break;
        lastKey = key;
        if (lastTimeTicks > seg.StartTicks) {
          lastIgnored = true;
          break;
        }
        if (seg.EndTicks - seg.StartTicks < MIN_SEGMENT_TICKS) {
          lastIgnored = true;
          break;
        }
        lastIgnored = false;
        const endSeconds = (seg.EndTicks - offsetTicks) / TICKS_PER_SECOND;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
        const target = Math.min(endSeconds, duration);
        if (target > t) {
          video.currentTime = target;
          deps.onSkipped(seg);
        }
        break;
      }
      lastTimeTicks = timeTicks;
    }
    function onTick() {
      reinitIfItemChanged();
      evaluate();
    }
    return {
      /**
       * Begin driving auto-skip off `v`'s timeupdate. Idempotent.
       * @param {HTMLVideoElement} v
       */
      attach(v) {
        if (v === video) {
          reinitIfItemChanged();
          return;
        }
        this.detach();
        video = v;
        listener = onTick;
        v.addEventListener("timeupdate", listener);
        reinitIfItemChanged();
      },
      /** Stop and reset all state. Idempotent. */
      detach() {
        if (video && listener) video.removeEventListener("timeupdate", listener);
        video = null;
        listener = null;
        itemId = null;
        segments = [];
        lastTimeTicks = -1;
        lastKey = null;
        lastIgnored = false;
        fetchToken++;
      },
      /** Inspection hooks for tests/debugging — not part of the public surface. */
      _internal: {
        evaluate,
        reinitIfItemChanged,
        get segments() {
          return segments;
        },
        get itemId() {
          return itemId;
        },
        get lastKey() {
          return lastKey;
        },
        get lastIgnored() {
          return lastIgnored;
        }
      }
    };
  }

  // client/src/features/player/auto-skip.ts
  var { JE, ApiClient, ctx } = export0();
  var lifetime = export02(JE, "auto-skip");
  function segmentTypeEnabled(type) {
    if (type === "Intro") return !!JE.currentSettings?.autoSkipIntro;
    if (type === "Outro") return !!JE.currentSettings?.autoSkipOutro;
    return false;
  }
  function segmentTypeEnabledFor(epoch, type) {
    if (JE.session && !JE.session.isCurrent(epoch)) return false;
    return segmentTypeEnabled(type);
  }
  function autoSkipToast(seg) {
    if (seg.Type === "Intro") JE.toast(JE.t("toast_auto_skipped_intro"));
    else if (seg.Type === "Outro") JE.toast(JE.t("toast_auto_skipped_outro"));
  }
  function parseItemIdFromVideosSrc(src) {
    const m = src.match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
    return m?.[1]?.replace(/-/g, "").toLowerCase() ?? null;
  }
  async function probeNowPlayingItemId(userId) {
    try {
      const api = JE.core?.api;
      const ac = ApiClient;
      if (!api || typeof api.jf !== "function" || !ac) return null;
      const deviceId = typeof ac.deviceId === "function" ? ac.deviceId() : "";
      if (!userId || !deviceId) return null;
      const sessions = await api.jf(
        `/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`,
        { skipCache: true }
      );
      if (!Array.isArray(sessions)) return null;
      const matches = export3(sessions).filter((x) => x?.DeviceId === deviceId && x?.NowPlayingItem?.Id);
      return matches.length === 1 ? matches[0]?.NowPlayingItem?.Id || null : null;
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: auto-skip now-playing probe failed", err);
      return null;
    }
  }
  async function fetchMediaSegments(itemId) {
    const api = JE.core?.api;
    if (!api || typeof api.jf !== "function") return [];
    const res = await api.jf(`/MediaSegments/${encodeURIComponent(itemId)}`, { skipCache: true });
    return export2(res);
  }
  function currentUserId() {
    try {
      return JE.session?.getUserId?.() || ApiClient?.getCurrentUserId?.() || null;
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: auto-skip user lookup failed", err);
      return null;
    }
  }
  var _engine = null;
  var _engineEpoch = null;
  function autoSkipEngine() {
    const epoch = JE.session ? JE.session.getEpoch() : 0;
    if (!_engine || _engineEpoch !== epoch) {
      _engine?.detach();
      _engineEpoch = epoch;
      const userId = currentUserId();
      _engine = createAutoSkipEngine({
        shouldSkipType: (type) => segmentTypeEnabledFor(epoch, type),
        fetchSegments: fetchMediaSegments,
        resolveItemId: createSessionItemResolver({
          parseFromSrc: parseItemIdFromVideosSrc,
          fallbackId: () => ctx.own.player?.getCurrentVideoItemId?.() || null,
          probeNowPlayingId: () => probeNowPlayingItemId(userId)
        }),
        onSkipped: autoSkipToast,
        getPositionOffsetTicks: (video) => parseTranscodeOffsetTicksFromSrc(video.currentSrc || "")
      });
    }
    return _engine;
  }
  JE.session?.onUserChange("auto-skip", () => {
    _engine?.detach();
    _engine = null;
    _engineEpoch = null;
  });
  JE.initializeAutoSkipObserver = () => {
    if (!currentUserId()) return;
    const video = ctx.own.player?.getVideo?.();
    if (!video) return;
    autoSkipEngine().attach(video);
  };
  JE.stopAutoSkip = () => {
    _engine?.detach();
  };
  ctx.own.autoSkip = {
    TICKS_PER_SECOND,
    MIN_SEGMENT_TICKS,
    createAutoSkipEngine,
    createSessionItemResolver,
    parseTranscodeOffsetTicksFromSrc,
    parseItemIdFromVideosSrc,
    segmentTypeEnabled
  };
  lifetime.onReset(() => {
    _engine?.detach();
    _engine = null;
    _engineEpoch = null;
  });
})();
})();
//# sourceMappingURL=auto-skip.js.map
