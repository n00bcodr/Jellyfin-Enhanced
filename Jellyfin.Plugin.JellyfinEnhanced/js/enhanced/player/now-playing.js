(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/player/host.ts
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

  // client/src/features/player/wire.ts
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
  function decodeSessions(v) {
    return list(v).map((v2) => {
      const r = record(v2), p = record(r.PlayState), t = record(r.TranscodingInfo);
      return { Id: text(r.Id), DeviceId: text(r.DeviceId), NowPlayingItem: decodeItem(r.NowPlayingItem), LastPlaybackCheckIn: text(r.LastPlaybackCheckIn), PlayState: { PlayMethod: text(p.PlayMethod), MediaSourceId: text(p.MediaSourceId), AudioStreamIndex: number(p.AudioStreamIndex), SubtitleStreamIndex: number(p.SubtitleStreamIndex), IsPaused: typeof p.IsPaused === "boolean" ? p.IsPaused : void 0, PositionTicks: number(p.PositionTicks) }, TranscodingInfo: r.TranscodingInfo ? { CompletionPercentage: number(t.CompletionPercentage), Container: text(t.Container), VideoCodec: text(t.VideoCodec), AudioCodec: text(t.AudioCodec), Bitrate: number(t.Bitrate), TranscodeReasons: typeof t.TranscodeReasons === "string" ? [t.TranscodeReasons] : strings(t.TranscodeReasons) } : null };
    });
  }

  // client/src/features/player/lifetime.ts
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

  // client/src/features/player/now-playing.ts
  var { JE, ApiClient, ctx } = playerHost();
  var lifetime = createPlayerLifetime(JE, "now-playing");
  var logPrefix = "🪼 Jellyfin Enhanced: Now Playing:";
  var DURATION_TOLERANCE_SECONDS = 2;
  var TICKS_PER_SECOND = 1e7;
  function normalizeId(id) {
    return id ? String(id).replace(/-/g, "").toLowerCase() : null;
  }
  function itemIdFromSource(video) {
    const src = video && (video.currentSrc || video.src) || "";
    const match = src.match(/\/Videos\/([0-9a-f]{32}|[0-9a-f-]{36})\//i);
    return normalizeId(match && match[1]);
  }
  function itemIdFromRoute() {
    return normalizeId(ctx.own.player?.getCurrentVideoItemId?.());
  }
  async function itemIdFromSession(video) {
    const lease = lifetime.lease(video instanceof HTMLVideoElement ? video : null);
    try {
      const userId = ApiClient.getCurrentUserId?.();
      const deviceId = ApiClient.deviceId?.();
      if (!userId || !deviceId) return null;
      const sessions = await ApiClient.ajax({
        type: "GET",
        url: ApiClient.getUrl("/Sessions", { ControllableByUserId: userId }),
        dataType: "json"
      });
      if (!lease.current() || !Array.isArray(sessions)) return null;
      const matches = decodeSessions(sessions).filter((s) => s?.DeviceId === deviceId && s?.NowPlayingItem?.Id);
      if (matches.length !== 1) return null;
      const item = matches[0]?.NowPlayingItem;
      if (!item) return null;
      if (video && item.RunTimeTicks && Number.isFinite(video.duration) && Math.abs(item.RunTimeTicks / TICKS_PER_SECOND - video.duration) > DURATION_TOLERANCE_SECONDS) {
        return null;
      }
      return normalizeId(item.Id);
    } catch (e) {
      console.debug(`${logPrefix} Session probe failed`, e);
      return null;
    }
  }
  async function resolveItemId(video) {
    return itemIdFromSource(video) || itemIdFromRoute() || await itemIdFromSession(video);
  }
  ctx.own.nowPlaying = { normalizeId, itemIdFromSource, itemIdFromRoute, itemIdFromSession, resolveItemId };
})();
})();
//# sourceMappingURL=now-playing.js.map
