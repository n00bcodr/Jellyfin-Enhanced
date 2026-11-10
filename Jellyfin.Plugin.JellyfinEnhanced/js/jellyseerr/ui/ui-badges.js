(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared4 = core.core?.featureContext;
    if (typeof shared4 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared4(feature, core, slots);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE) {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE.internals || (JE.internals = {})
      });
      coreContexts.set(JE, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export20 = /* @__PURE__ */ sharedExport(shared, "isSafeTmdbImagePath");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/display.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/display");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "analyzeSeasonStatuses");
  var export5 = /* @__PURE__ */ sharedExport(shared2, "hasDownloads");

  // client/generated-shared/stub/client/src/features/seerr/core/status.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/seerr/core/status");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "DISPLAY");
  var export52 = /* @__PURE__ */ sharedExport(shared3, "getBadgeConfig");
  var export11 = /* @__PURE__ */ sharedExport(shared3, "resolveDisplayStatus");

  // client/src/features/seerr/core/runtime.ts
  var LOG_UI = "🪼 Jellyfin Enhanced: Seerr UI:";
  function groupInternals(JE) {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE, name) {
    const internals = groupInternals(JE);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }
  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  function escapeWith(JE) {
    return (value) => {
      const escape = JE.escapeHtml;
      if (typeof escape === "function") return escape(value);
      return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
    };
  }
  function thrownProperty(error, key) {
    if (typeof error !== "object" || error === null) return void 0;
    const value = Reflect.get(error, key);
    return value;
  }
  function isAbortError(error) {
    return thrownProperty(error, "name") === "AbortError";
  }

  // client/src/features/seerr/core/ui/badges.ts
  function sanitizeProviders(list) {
    if (!Array.isArray(list)) return null;
    const providers = [];
    for (const entry of list) {
      if (export19(entry) && export22(entry.provider_name) && export20(entry.logo_path)) {
        providers.push({ ...entry, provider_name: entry.provider_name, logo_path: entry.logo_path });
      }
    }
    return providers;
  }
  var configList = (value) => value ? String(value).replace(/'/g, "").replace(/\n/g, ",").split(",").map((s) => s.trim()).filter(Boolean) : [];
  var PROVIDER_BATCH_DELAY_MS = 50;
  var PROVIDER_BATCH_MAX = 100;
  function installBadges(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "ui-badges")) return;
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    const badgeIconTemplates = /* @__PURE__ */ new Map();
    function appendBadgeIcon(badge, iconHtml) {
      let template = badgeIconTemplates.get(iconHtml);
      if (!template) {
        template = document2.createElement("template");
        template.innerHTML = iconHtml;
        badgeIconTemplates.set(iconHtml, template);
      }
      badge.appendChild(document2.importNode(template.content, true));
    }
    function setStatusBadge(card, item, seasonAnalysis) {
      const badge = card.querySelector(".jellyseerr-status-badge");
      const info = item.mediaInfo;
      if (!badge || !info) {
        if (badge) badge.style.display = "none";
        return;
      }
      let status;
      if (item.mediaType === "tv" && info.seasons) {
        const analysis = seasonAnalysis || export0(info.seasons, JE.t);
        status = analysis ? analysis.overallStatus : info.status;
      } else {
        status = info.status || 1;
      }
      const downloads = export5(item);
      const displayStatus = export11(status, downloads);
      const config = export52(displayStatus);
      if (!config) {
        badge.style.display = "none";
        return;
      }
      if (!badge.firstChild) appendBadgeIcon(badge, config.icon);
      else badge.innerHTML = config.icon;
      badge.className = `jellyseerr-status-badge ${config.cssClass}`;
      badge.style.display = "flex";
      if (displayStatus === export02.PARTIAL && item.mediaType === "tv" && downloads) {
        badge.style.cursor = "pointer";
        internals.addDownloadProgressHover?.(badge, item);
      }
    }
    const providerLookups = /* @__PURE__ */ new Map();
    let queuedLookups = [];
    let providerFlushTimer = null;
    const providerRegion = () => {
      const region = String(JE.pluginConfig?.DEFAULT_REGION || "US").trim().toUpperCase();
      return /^[A-Z]{2}$/.test(region) ? region : "US";
    };
    const abortError = () => {
      const error = new Error("Request aborted");
      error.name = "AbortError";
      return error;
    };
    function settleLookup(lookup, settle) {
      if (providerLookups.get(lookup.lookupKey) === lookup) providerLookups.delete(lookup.lookupKey);
      for (const waiter of [...lookup.waiters]) {
        lookup.waiters.delete(waiter);
        waiter.detach();
        settle(waiter);
      }
    }
    function releaseLookup(lookup) {
      if (lookup.waiters.size > 0) return;
      const batch = lookup.batch;
      if (!batch) {
        providerLookups.delete(lookup.lookupKey);
        queuedLookups = queuedLookups.filter((l) => l !== lookup);
        return;
      }
      if (batch.lookups.some((l) => l.waiters.size > 0)) return;
      for (const l of batch.lookups) if (providerLookups.get(l.lookupKey) === l) providerLookups.delete(l.lookupKey);
      batch.controller.abort();
    }
    function flushProviderBatch() {
      if (providerFlushTimer !== null) window2.clearTimeout(providerFlushTimer);
      providerFlushTimer = null;
      const first = queuedLookups[0];
      if (!first) return;
      const region = first.region;
      const lookups = [];
      const rest = [];
      for (const lookup of queuedLookups) (lookup.region === region && lookups.length < PROVIDER_BATCH_MAX ? lookups : rest).push(lookup);
      queuedLookups = rest;
      if (rest.length > 0) providerFlushTimer = window2.setTimeout(flushProviderBatch, PROVIDER_BATCH_DELAY_MS);
      const batch = { controller: new AbortController(), lookups };
      for (const lookup of lookups) lookup.batch = batch;
      const epoch = JE.session?.getEpoch();
      const items = lookups.map((l) => l.key).join(",");
      const api = JE.core?.api;
      const pending = api ? api.plugin(`/watch-providers?items=${items}&region=${region}`, { signal: batch.controller.signal, priority: "low" }) : Promise.reject(new Error("core API unavailable"));
      pending.then((data) => {
        const results = export19(data) && export19(data.results) ? data.results : {};
        const cacheable = !JE.session || epoch === void 0 || JE.session.isCurrent(epoch);
        for (const lookup of lookups) {
          const providers = sanitizeProviders(results[lookup.key]);
          if (providers && cacheable) {
            try {
              JE.core?.api?.manager?.setCache?.(lookup.cacheKey, providers);
            } catch (error) {
              console.debug(`${LOG_UI} Provider cache write skipped:`, error);
            }
          }
          settleLookup(lookup, (waiter) => waiter.resolve(providers));
        }
      }, (error) => {
        if (batch.controller.signal.aborted) return;
        if (!isAbortError(error)) console.warn(`${LOG_UI} Could not fetch provider icons for ${lookups.length} title(s):`, error);
        for (const lookup of lookups) settleLookup(lookup, (waiter) => waiter.resolve(null));
      });
    }
    function getFlatrateProviders(mediaType, tmdbId, signal) {
      const region = providerRegion();
      const key = `${mediaType}:${tmdbId}`;
      const cacheKey = `providers:${region}:${key}`;
      const cached = sanitizeProviders(JE.core?.api?.manager?.getCached?.(cacheKey));
      if (cached) return Promise.resolve(cached);
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const lookupKey = `${region}:${key}`;
        let lookup = providerLookups.get(lookupKey);
        if (!lookup) {
          lookup = { lookupKey, region, key, cacheKey, waiters: /* @__PURE__ */ new Set(), batch: null };
          providerLookups.set(lookupKey, lookup);
          queuedLookups.push(lookup);
          if (queuedLookups.length >= PROVIDER_BATCH_MAX) flushProviderBatch();
          else if (providerFlushTimer === null) providerFlushTimer = window2.setTimeout(flushProviderBatch, PROVIDER_BATCH_DELAY_MS);
        }
        const owner = lookup;
        const onAbort = () => {
          owner.waiters.delete(waiter);
          reject(abortError());
          releaseLookup(owner);
        };
        const waiter = { resolve, reject, detach: () => signal?.removeEventListener("abort", onAbort) };
        owner.waiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    function setHasIcons(container, hasIcons) {
      container.classList.toggle("has-icons", hasIcons);
      container.closest(".cardImageContainer")?.classList.toggle("jellyseerr-has-provider-icons", hasIcons);
    }
    async function fetchProviderIcons(container, tmdbId, mediaType, signal) {
      if (!container || !tmdbId || !mediaType) return;
      const config = JE.pluginConfig;
      if (!config?.TmdbEnabled) return;
      const defaults = configList(config.DEFAULT_PROVIDERS);
      const ignored = configList(config.IGNORE_PROVIDERS);
      try {
        let providers = await getFlatrateProviders(mediaType, tmdbId, signal);
        if (signal && !container.isConnected) return;
        if (!providers || providers.length === 0) return;
        if (defaults.length > 0) providers = providers.filter((p) => defaults.includes(p.provider_name));
        if (ignored.length > 0) {
          try {
            const patterns = ignored.map((pattern) => new RegExp(pattern, "i"));
            providers = providers.filter((p) => !patterns.some((regex) => regex.test(p.provider_name)));
          } catch (error) {
            console.error(`${LOG_UI} Invalid regex in IGNORE_PROVIDERS setting.`, error);
          }
        }
        providers = providers.filter((p) => export20(p.logo_path));
        for (const provider of providers.slice(0, 4)) {
          const img = document2.createElement("img");
          img.loading = "lazy";
          img.decoding = "async";
          if ("fetchPriority" in img) img.fetchPriority = "low";
          img.width = 92;
          img.height = 92;
          img.alt = provider.provider_name || "";
          img.src = `https://image.tmdb.org/t/p/w92${provider.logo_path}`;
          img.title = provider.provider_name;
          img.onerror = () => {
            img.remove();
            if (container.childElementCount === 0) setHasIcons(container, false);
          };
          container.appendChild(img);
        }
        if (container.childElementCount > 0) setHasIcons(container, true);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        console.warn(`${LOG_UI} Could not fetch provider icons for TMDB ID ${tmdbId}:`, error);
      }
    }
    function addMediaTypeBadge(card, item, imageContainer, label) {
      if (item.mediaType !== "movie" && item.mediaType !== "tv" && item.mediaType !== "collection") return;
      const container = imageContainer || card.querySelector(".cardImageContainer");
      if (!container) return;
      const badge = document2.createElement("div");
      if (item.mediaType === "movie") {
        badge.className = "jellyseerr-media-badge jellyseerr-media-badge-movie";
        badge.textContent = label ?? JE.t("jellyseerr_card_badge_movie");
      } else if (item.mediaType === "tv") {
        badge.className = "jellyseerr-media-badge jellyseerr-media-badge-series";
        badge.textContent = label ?? JE.t("jellyseerr_card_badge_series");
      } else {
        badge.className = "jellyseerr-media-badge jellyseerr-media-badge-collection";
        badge.textContent = label ?? JE.t("jellyseerr_card_badge_collection");
      }
      container.appendChild(badge);
    }
    function addCollectionMembershipBadge(card, item, imageContainer) {
      if (!item.collection || item.mediaType !== "movie") return;
      const container = imageContainer || card.querySelector(".cardImageContainer");
      if (!container) return;
      const badge = document2.createElement("div");
      badge.className = "jellyseerr-collection-badge";
      badge.innerHTML = `<span class="material-icons">collections</span><span>${escapeHtml(item.collection.name ?? "") || JE.t("jellyseerr_card_badge_collection")}</span>`;
      badge.title = `Part of ${item.collection.name || "collection"}`;
      container.appendChild(badge);
    }
    internals.setStatusBadge = setStatusBadge;
    internals.fetchProviderIcons = fetchProviderIcons;
    internals.isSafeTmdbImagePath = export20;
    internals.addMediaTypeBadge = addMediaTypeBadge;
    internals.addCollectionMembershipBadge = addCollectionMembershipBadge;
  }

  // client/src/features/seerr/core/ui/badges-entry.ts
  installBadges(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-badges.js.map
