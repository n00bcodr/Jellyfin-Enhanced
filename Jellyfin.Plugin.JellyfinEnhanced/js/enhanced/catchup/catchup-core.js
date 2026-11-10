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

  // client/src/features/catchup/host.ts
  function catchupHost() {
    const host = window, JE2 = host.JellyfinEnhanced;
    const ctx2 = JE2 && featureContext("catchup", JE2, {
      facades: ["catchUpPage"],
      internalSlots: ["catchUp"],
      internalsObject: () => JE2.internals ?? (JE2.internals = {})
    });
    return { host, ctx: ctx2, getApi: () => host.ApiClient, Emby: host.Emby };
  }

  // client/src/features/shared/wire.ts
  function currentLease(session, getApi2) {
    const epoch = session?.getEpoch(), user = getApi2?.()?.getCurrentUserId(), server = getApi2?.()?.getUrl("/");
    return () => (epoch === void 0 || session?.isCurrent(epoch) === true) && user === getApi2?.()?.getCurrentUserId() && server === getApi2?.()?.getUrl("/");
  }
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function object(value) {
    if (!record(value)) throw Error("Invalid response object");
    return value;
  }
  function string(value) {
    if (typeof value !== "string") throw Error("Invalid response string");
    return value;
  }
  function number(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw Error("Invalid response number");
    return value;
  }
  function optionalString(value) {
    return value == null ? void 0 : string(value);
  }
  function optionalNumber(value) {
    return value == null ? void 0 : number(value);
  }
  function array(value, decode) {
    if (!Array.isArray(value)) throw Error("Invalid response array");
    return value.map(decode);
  }

  // client/src/features/catchup/model.ts
  function readItem(value) {
    const v = object(value), tags = v.ImageTags == null ? {} : object(v.ImageTags), user = v.UserData == null ? {} : object(v.UserData);
    return {
      Id: string(v.Id),
      Name: string(v.Name),
      Type: optionalString(v.Type),
      SeriesId: optionalString(v.SeriesId),
      SeriesPrimaryImageTag: optionalString(v.SeriesPrimaryImageTag),
      ImageTags: { Primary: optionalString(tags.Primary) },
      Genres: v.Genres == null ? void 0 : array(v.Genres, string),
      Overview: optionalString(v.Overview),
      ChildCount: optionalNumber(v.ChildCount),
      RunTimeTicks: optionalNumber(v.RunTimeTicks),
      ProductionYear: optionalNumber(v.ProductionYear),
      CommunityRating: optionalNumber(v.CommunityRating),
      IndexNumber: optionalNumber(v.IndexNumber),
      UserData: { UnplayedItemCount: optionalNumber(user.UnplayedItemCount) }
    };
  }
  function readItems(value) {
    return array(object(value).Items, readItem);
  }

  // client/src/features/catchup/catchup-core.ts
  function createCatchUp(JE2, api, navigate) {
    const state = { mode: "Movie", queue: [], seen: /* @__PURE__ */ new Set(), undoStack: [], dismissed: /* @__PURE__ */ new Set(), loading: false, pickerOpen: false };
    let generation = 0;
    const lease = () => {
      const captured = generation, current = currentLease(JE2.session, api);
      return () => captured === generation && current();
    };
    const reset = () => {
      generation++;
      state.loading = false;
      state.queue = [];
      state.seen.clear();
      state.undoStack = [];
      state.pickerOpen = false;
    };
    const userId = () => api().getCurrentUserId();
    const jf = (path, options) => JE2.core.api.jf(path, { skipCache: true, ...options });
    const tt = (key, fallback, params) => {
      const out = JE2.t?.(key, params);
      return out && out !== key ? out : Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), fallback);
    };
    function h(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    const icons = { undo: "undo", x: "close", info: "info_outline", bookmark: "bookmark_border", check: "check", activity: "history", refresh: "refresh" };
    const icon = (name) => {
      const i = h("i", "material-icons", icons[name]);
      i.setAttribute("aria-hidden", "true");
      return i;
    };
    const imageOf = (item) => item.ImageTags?.Primary ? { id: item.Id, tag: item.ImageTags.Primary } : item.SeriesPrimaryImageTag && item.SeriesId ? { id: item.SeriesId, tag: item.SeriesPrimaryImageTag } : null;
    const imageUrl = (im, width) => im ? api().getUrl(`/Items/${im.id}/Images/Primary`, { maxWidth: width, quality: 85, tag: im.tag }) : "";
    const legacyKey = () => `je-catchup-dismissed-${userId()}`;
    const dismissKey = () => `${legacyKey()}:${encodeURIComponent(api().getUrl("/"))}`;
    function storedDismissed() {
      const key = dismissKey(), saved = localStorage.getItem(key);
      if (saved !== null) return saved;
      const legacy = legacyKey(), owner = localStorage.getItem(`${legacy}:server`), server = api().getUrl("/");
      if (owner !== null && owner !== server) return "[]";
      const old = localStorage.getItem(legacy) || "[]";
      array(JSON.parse(old), string);
      try {
        localStorage.setItem(`${legacy}:server`, server);
        localStorage.setItem(key, old);
      } catch {
      }
      return old;
    }
    function loadDismissed() {
      try {
        state.dismissed = new Set(array(JSON.parse(storedDismissed()), string));
      } catch {
        state.dismissed = /* @__PURE__ */ new Set();
      }
    }
    function saveDismissed() {
      try {
        localStorage.setItem(dismissKey(), JSON.stringify([...state.dismissed]));
      } catch {
      }
    }
    const isHidden = (item) => state.dismissed.has(item.Id) || !!(item.SeriesId && state.dismissed.has(item.SeriesId));
    async function refill() {
      if (state.loading) return 0;
      const current = lease();
      state.loading = true;
      try {
        const query = new URLSearchParams({ IncludeItemTypes: state.mode, Recursive: "true", Filters: "IsUnplayed", SortBy: "Random", Limit: "40", Fields: "Overview,Genres,CommunityRating,RunTimeTicks,ProductionYear,ChildCount", ImageTypeLimit: "1", EnableImageTypes: "Primary" });
        const items = readItems(await jf(`/Users/${userId()}/Items?${query}`));
        if (!current()) return 0;
        let added = 0;
        for (const item of items) if (!state.seen.has(item.Id) && !isHidden(item) && imageOf(item)) {
          state.seen.add(item.Id);
          state.queue.push(item);
          added++;
        }
        return added;
      } finally {
        if (current()) state.loading = false;
      }
    }
    const playedUrl = (id) => `/Users/${userId()}/PlayedItems/${id}`;
    const ratingUrl = (id) => `/Users/${userId()}/Items/${id}/Rating`;
    async function mark(ids, method) {
      const results = await Promise.allSettled(ids.map((id) => jf(playedUrl(id), { method })));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    const ACTIONS = {
      right: { name: "watched", run: (i, o) => mark(o?.seasons || [i.Id], "POST"), undo: (i, o) => mark(o?.seasons || [i.Id], "DELETE") },
      left: { name: "dismiss", run: async (i) => {
        state.dismissed.add(i.SeriesId || i.Id);
        saveDismissed();
      }, undo: async (i) => {
        state.dismissed.delete(i.SeriesId || i.Id);
        saveDismissed();
      } },
      up: { name: "watchlist", run: (i) => jf(`${ratingUrl(i.SeriesId || i.Id)}?likes=true`, { method: "POST" }), undo: (i) => jf(ratingUrl(i.SeriesId || i.Id), { method: "DELETE" }) }
    };
    const ACT_NAME = { right: "watched", left: "dismiss", up: "watchlist", down: "open" };
    const logEvent = (event) => {
      JE2.core.api.plugin("/catchup/event", { method: "POST", body: event, skipRetry: true }).catch(() => {
      });
    };
    const logSwipe = (item, dir, opts, ok) => logEvent({ type: "swipe", action: ACT_NAME[dir], itemId: item.Id, ok, seasons: dir === "right" && item.Type === "Series" ? opts?.numbers ?? ["all"] : void 0 });
    return { LOG: "🪼 Jellyfin Enhanced: Catch Up:", state, tt, h, icon, userId, jf, imageOf, imageUrl, navigateToItem: navigate, loadDismissed, saveDismissed, isHidden, refill, ACTIONS, ACT_NAME, logEvent, logSwipe, reset, lease };
  }
  var { ctx, getApi, Emby } = catchupHost();
  var JE = ctx?.core;
  if (ctx && JE?.pluginConfig?.CatchUpEnabled) {
    if (!ctx.own.catchUp) {
      const runtime = createCatchUp(JE, () => {
        const api = getApi();
        if (!api) throw Error("Jellyfin API unavailable");
        return api;
      }, (id) => {
        try {
          if (Emby?.Page?.showItem) {
            Emby.Page.showItem(id);
            return;
          }
        } catch {
        }
        window.location.hash = `#!/details?id=${id}`;
      });
      ctx.own.catchUp = runtime;
      JE.session?.onUserChange("catchup", () => {
        runtime.deck?.dispose();
        runtime.reset();
        runtime.state.dismissed.clear();
      });
    }
  }
})();
})();
//# sourceMappingURL=catchup-core.js.map
