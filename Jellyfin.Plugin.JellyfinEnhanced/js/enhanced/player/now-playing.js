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
  var export3 = /* @__PURE__ */ sharedExport(shared2, "decodeSessions");

  // client/generated-shared/stub/client/src/features/player/lifetime.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/player/lifetime");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "createPlayerLifetime");

  // client/src/features/player/now-playing.ts
  var { JE, ApiClient, ctx } = export0();
  var lifetime = export02(JE, "now-playing");
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
    const lease = lifetime.lease(video);
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
      const matches = export3(sessions).filter((s) => s?.DeviceId === deviceId && s?.NowPlayingItem?.Id);
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
