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
    const shared4 = core.core?.featureContext;
    if (typeof shared4 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared4(feature, core, slots);
  }
  function publishSharedModules(modules) {
    const JE = window.JellyfinEnhanced;
    if (!JE) return;
    const core = JE.core ?? (JE.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/core/display.ts
  var display_exports = {};
  __export(display_exports, {
    analyzeSeasonStatuses: () => analyzeSeasonStatuses,
    capitalize: () => capitalize,
    formatEtaText: () => formatEtaText,
    formatNextReset: () => formatNextReset,
    formatQuotaLine: () => formatQuotaLine,
    hasDownloads: () => hasDownloads,
    progressPercent: () => progressPercent
  });

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/status.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/status");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "DISPLAY");
  var export1 = /* @__PURE__ */ sharedExport(shared2, "MEDIA");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "resolveDisplayStatus");

  // client/src/features/seerr/core/display.ts
  function formatEtaText(downloadStatus, now) {
    if (!export19(downloadStatus)) return null;
    const rawEta = downloadStatus.estimatedCompletionTime;
    if (!rawEta || !(export22(rawEta) || export18(rawEta))) return null;
    const timeUntilMs = new Date(rawEta).getTime() - now;
    if (Number.isNaN(timeUntilMs)) return null;
    if (timeUntilMs <= 0) return "Estimated soon";
    const minutes = Math.round(timeUntilMs / 6e4);
    if (minutes >= 1440) {
      const days = Math.round(minutes / 1440);
      return `Estimated in ${days} day${days !== 1 ? "s" : ""}`;
    }
    if (minutes >= 60) {
      const hours = Math.round(minutes / 60);
      return `Estimated in ${hours} hour${hours !== 1 ? "s" : ""}`;
    }
    return `Estimated in ${minutes} min`;
  }
  function progressPercent(size, sizeLeft) {
    if (!export18(size) || !export18(sizeLeft) || size <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - sizeLeft / size))));
  }
  var capitalize = (value) => value.replace(/^./, (c) => c.toUpperCase());
  function analyzeSeasonStatuses(seasons, t) {
    if (!Array.isArray(seasons) || seasons.length === 0) return { overallStatus: export1.UNKNOWN, statusSummary: null, total: 0 };
    const entries = seasons.filter(export19);
    const regular = entries.filter((s) => export18(s.seasonNumber) && s.seasonNumber > 0);
    const total = regular.length;
    if (total === 0) return { overallStatus: export1.UNKNOWN, statusSummary: null, total: 0 };
    const count = (status) => regular.filter((s) => s.status === status).length;
    const available = count(export1.AVAILABLE);
    const pending = count(export1.PENDING);
    const processing = count(export1.PROCESSING);
    const partiallyAvailable = count(export1.PARTIALLY_AVAILABLE);
    const notRequested = count(export1.UNKNOWN);
    const requestedCount = pending + processing;
    const availableCount = available + partiallyAvailable;
    const accountedForCount = requestedCount + availableCount;
    let overallStatus;
    let statusSummary = null;
    if (notRequested === 0) {
      overallStatus = availableCount === total ? export1.AVAILABLE : export1.DELETED;
      if (overallStatus === export1.DELETED) statusSummary = t("jellyseerr_seasons_accounted_for", { count: accountedForCount, total });
    } else if (accountedForCount > 0) {
      overallStatus = availableCount > 0 ? export1.PARTIALLY_AVAILABLE : export1.PROCESSING;
      statusSummary = availableCount > 0 ? t("jellyseerr_seasons_available_count", { count: availableCount, total }) : t("jellyseerr_seasons_requested_count", { count: requestedCount, total });
    } else {
      overallStatus = export1.UNKNOWN;
    }
    if (overallStatus === export1.AVAILABLE) {
      const specials = entries.find((s) => s.seasonNumber === 0);
      if (specials && specials.status === export1.UNKNOWN) {
        overallStatus = export1.DELETED;
        statusSummary = t("jellyseerr_seasons_accounted_for", { count: accountedForCount, total });
      }
    }
    return { overallStatus, statusSummary, total, availableCount };
  }
  function hasDownloads(item) {
    return (item.mediaInfo?.downloadStatus?.length ?? 0) > 0 || (item.mediaInfo?.downloadStatus4k?.length ?? 0) > 0;
  }
  function formatNextReset(resetAt, now, t) {
    if (!resetAt || !(export22(resetAt) || export18(resetAt))) return "";
    const ts = new Date(resetAt).getTime();
    if (!Number.isFinite(ts)) return "";
    const deltaMs = ts - now;
    if (deltaMs <= 0) return t("jellyseerr_quota_reset_now");
    const minutes = Math.round(deltaMs / 6e4);
    const hours = Math.round(deltaMs / 36e5);
    const days = Math.round(deltaMs / 864e5);
    if (minutes < 60) return t("jellyseerr_quota_reset_in_minutes", { minutes: Math.max(1, minutes) });
    if (hours < 36) return t("jellyseerr_quota_reset_in_hours", { hours });
    return t("jellyseerr_quota_reset_in_days", { days });
  }
  var numberOf = (value) => Number(value) || 0;
  function formatQuotaLine(quota, type, now, t) {
    if (!quota) return { text: "", restricted: false, unlimited: true, resetText: "" };
    const limit = numberOf(quota.limit);
    const used = numberOf(quota.used);
    const days = numberOf(quota.days);
    const label = t(type === "tv" ? "jellyseerr_quota_label_tv" : "jellyseerr_quota_label_movie");
    if (limit <= 0) return { text: t("jellyseerr_quota_unlimited", { label }), restricted: false, unlimited: true, resetText: "" };
    return {
      text: days > 0 ? t("jellyseerr_quota_usage_window", { label, used, limit, days }) : t("jellyseerr_quota_usage", { label, used, limit }),
      restricted: !!quota.restricted,
      unlimited: false,
      resetText: formatNextReset(quota.nextResetAt, now, t)
    };
  }

  // client/generated-shared/publish/js/jellyseerr/ui/ui-popover.js.ts
  publishSharedModules({ "features/seerr/core/display": display_exports });

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
  function text(read) {
    try {
      const value = read();
      return export22(value) && value ? value : null;
    } catch {
      return null;
    }
  }
  function captureOrigin(host) {
    const session = host.JE.session;
    const epoch = session ? session.getEpoch() : null;
    const user = () => text(() => host.apiClient()?.getCurrentUserId?.());
    const server = () => text(() => {
      const client = host.apiClient();
      const id = client?.serverId;
      return typeof id === "function" ? Reflect.apply(id, client, []) : id;
    });
    const startClient = host.apiClient();
    const root = () => text(() => host.apiClient()?.getUrl("/"));
    const token = () => text(() => host.apiClient()?.accessToken?.());
    const startRoot = root();
    const startToken = token();
    const startUser = user();
    const startServer = server();
    return {
      epoch,
      current: () => host.apiClient() === startClient && root() === startRoot && token() === startToken && (!session || epoch === null || session.isCurrent(epoch)) && user() === startUser && server() === startServer
    };
  }
  function bindViewOrigin(host, element) {
    const internals = groupInternals(host.JE);
    const owners = internals.viewOrigins || (internals.viewOrigins = /* @__PURE__ */ new WeakMap());
    owners.set(element, captureOrigin(host));
  }
  function isViewCurrent(host, element) {
    const owners = groupInternals(host.JE).viewOrigins;
    for (let node = element; node; node = node.parentElement) {
      if (owners?.get(node)?.current() === false) return false;
    }
    return true;
  }

  // client/generated-shared/stub/client/src/features/seerr/core/ui/icon-markup.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/seerr/core/ui/icon-markup");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "ICONS");

  // client/src/features/seerr/core/ui/popover.ts
  function installPopover(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "ui-popover")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const state = internals.state;
    const escapeHtml = escapeWith(JE);
    const icons = () => internals.icons ?? export02;
    function ensureHoverPopover() {
      if (!state.jellyseerrHoverPopover) {
        const popover = document2.createElement("div");
        popover.className = "jellyseerr-hover-popover";
        document2.body.appendChild(popover);
        state.jellyseerrHoverPopover = popover;
      }
      return state.jellyseerrHoverPopover;
    }
    const etaText = (downloadStatus) => {
      try {
        return formatEtaText(downloadStatus, Date.now());
      } catch {
        return null;
      }
    };
    function fillHoverPopover(item) {
      const downloads = [...item.mediaInfo?.downloadStatus || [], ...item.mediaInfo?.downloadStatus4k || []];
      if (downloads.length === 0) {
        console.debug(`${LOG_UI} No download status found`);
        return null;
      }
      const popover = ensureHoverPopover();
      let html = "";
      for (const download of downloads) {
        const percent = progressPercent(download.size, download.sizeLeft);
        const status = (download.status || "").toLowerCase();
        const isQueued = status === "queued";
        const isWarning = status === "warning";
        if (percent === null && !isQueued && !isWarning) continue;
        const title = escapeHtml(download.title ?? "") || JE.t("jellyseerr_popover_downloading");
        if (isQueued || download.size === null || typeof download.size === "number" && download.size <= 0) {
          html += `
                    <div class="jellyseerr-popover-item">
                        <div class="title">${title}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:0%;"></div></div>
                        <div class="row">
                            <div>0%</div>
                            <div class="status">Queued</div>
                        </div>
                    </div>`;
        } else {
          const shown = percent ?? 0;
          const statusDisplay = isWarning ? "Warning" : capitalize(download.status || "Downloading");
          const eta = etaText(download);
          html += `
                    <div class="jellyseerr-popover-item">
                        <div class="title">${title}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:${shown}%;"></div></div>
                        <div class="row">
                            <div>${shown}%</div>
                            <div class="status">${escapeHtml(statusDisplay)}</div>
                            ${eta ? `<div class="eta">${escapeHtml(eta)}</div>` : ""}
                        </div>
                    </div>`;
        }
      }
      popover.innerHTML = html;
      console.debug(`${LOG_UI} Popover filled for ${downloads.length} download item(s)`);
      return popover;
    }
    function positionHoverPopover(element, x, y) {
      const padding = 12;
      const rect = element.getBoundingClientRect();
      const newX = Math.min(Math.max(x + 14, padding), window2.innerWidth - rect.width - padding);
      const newY = Math.min(Math.max(y - rect.height - 14, padding), window2.innerHeight - rect.height - padding);
      element.style.transform = `translate(${newX}px, ${newY}px)`;
    }
    function showAt(popover, item, x, y) {
      positionHoverPopover(popover, x, y);
      popover.classList.add("show");
      popover.dataset.tmdbId = String(item.id);
      popover.dataset.clientX = String(x);
      popover.dataset.clientY = String(y);
    }
    function hideHoverPopover() {
      const popover = state.jellyseerrHoverPopover;
      if (popover && !state.jellyseerrHoverLock) {
        popover.classList.remove("show");
        delete popover.dataset.tmdbId;
        delete popover.dataset.clientX;
        delete popover.dataset.clientY;
      }
    }
    function toggleHoverPopoverLock(lockState) {
      state.jellyseerrHoverLock = typeof lockState === "boolean" ? lockState : !state.jellyseerrHoverLock;
    }
    function createInlineProgress(downloadStatus) {
      const percent = progressPercent(downloadStatus?.size, downloadStatus?.sizeLeft);
      if (!downloadStatus || percent === null) return null;
      const container = document2.createElement("div");
      container.className = "jellyseerr-inline-progress";
      container.innerHTML = `
            <div class="jellyseerr-inline-progress-bar"><div class="jellyseerr-inline-progress-fill" style="width: ${percent}%"></div></div>
            <div class="jellyseerr-inline-progress-text">${percent}% • ${escapeHtml(capitalize(downloadStatus.status || "downloading"))}</div>`;
      return container;
    }
    function hide4KPopup() {
      if (state.active4KPopup) {
        state.active4KPopup.remove();
        state.active4KPopup = null;
      }
    }
    function show4KPopup(buttonGroup, item) {
      if (!isViewCurrent(host, buttonGroup)) return;
      hide4KPopup();
      const popup = document2.createElement("div");
      bindViewOrigin(host, popup);
      popup.className = "jellyseerr-4k-popup";
      const button = document2.createElement("button");
      button.className = "jellyseerr-4k-popup-item";
      const display4k = export11(item.mediaInfo ? item.mediaInfo.status4k : 1, false);
      if (display4k === export0.AVAILABLE) {
        button.innerHTML = `<span>4K Available</span>${icons().available}`;
        button.disabled = true;
        button.classList.add("jellyseerr-4k-available", "chip-available");
      } else if (display4k === export0.PENDING || display4k === export0.REQUESTED || display4k === export0.PROCESSING) {
        button.innerHTML = `<span>4K Requested</span>${icons().pending}`;
        button.disabled = true;
        button.classList.add(display4k === export0.PROCESSING ? "chip-processing" : "chip-pending");
      } else if (display4k === export0.BLOCKED) {
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_blocklisted")}</span>${icons().cancel}`;
        button.disabled = true;
        button.classList.add("chip-blocklisted");
      } else {
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_request_4k")}</span>`;
        button.dataset.tmdbId = String(item.id);
        button.dataset.mediaType = item.mediaType || "movie";
        button.dataset.action = "request4k";
        button.classList.add("chip-requested");
      }
      popup.appendChild(button);
      document2.body.appendChild(popup);
      state.active4KPopup = popup;
      const rect = buttonGroup.getBoundingClientRect();
      popup.style.position = "fixed";
      popup.style.left = `${rect.left}px`;
      popup.style.top = `${rect.bottom + 4}px`;
      popup.style.width = `${rect.width}px`;
      window2.setTimeout(() => popup.classList.add("show"), 10);
    }
    const hoverItems = /* @__PURE__ */ new WeakMap();
    const hoverBound = /* @__PURE__ */ new WeakSet();
    function addDownloadProgressHover(button, item) {
      hoverItems.set(button, item);
      if (hoverBound.has(button)) return;
      hoverBound.add(button);
      const show = (event) => {
        const current = hoverItems.get(button);
        const popover = current ? fillHoverPopover(current) : null;
        if (!current || !popover) return;
        const target = event.target instanceof Element ? event.target : button;
        const clientX = event instanceof MouseEvent && event.clientX || target.getBoundingClientRect().right;
        const clientY = event instanceof MouseEvent && event.clientY || target.getBoundingClientRect().top - 8;
        showAt(popover, current, clientX, clientY);
      };
      button.addEventListener("mouseenter", show);
      button.addEventListener("mousemove", (event) => {
        const popover = state.jellyseerrHoverPopover;
        if (popover?.classList.contains("show") && !state.jellyseerrHoverLock) {
          popover.dataset.clientX = String(event.clientX);
          popover.dataset.clientY = String(event.clientY);
          positionHoverPopover(popover, event.clientX, event.clientY);
        }
      });
      button.addEventListener("mouseleave", () => ui.hideHoverPopover?.());
      button.addEventListener("focus", show);
      button.addEventListener("blur", () => {
        ui.toggleHoverPopoverLock?.(false);
        ui.hideHoverPopover?.();
      });
      JE.core?.ui?.addTouchTapListener?.(button, (event) => {
        event.preventDefault();
        const current = hoverItems.get(button);
        const popover = current ? fillHoverPopover(current) : null;
        if (!current || !popover) return;
        const rect = button.getBoundingClientRect();
        ui.toggleHoverPopoverLock?.();
        if (state.jellyseerrHoverLock) showAt(popover, current, rect.left + rect.width / 2, rect.top - 8);
        else popover.classList.remove("show");
      });
    }
    function clearDownloadProgressHover(button) {
      hoverItems.delete(button);
    }
    ui.hideHoverPopover = hideHoverPopover;
    ui.toggleHoverPopoverLock = toggleHoverPopoverLock;
    ui.formatEtaText = etaText;
    internals.ensureHoverPopover = ensureHoverPopover;
    internals.formatEtaText = etaText;
    internals.fillHoverPopover = fillHoverPopover;
    internals.positionHoverPopover = positionHoverPopover;
    internals.createInlineProgress = createInlineProgress;
    internals.hide4KPopup = hide4KPopup;
    internals.show4KPopup = show4KPopup;
    internals.addDownloadProgressHover = addDownloadProgressHover;
    internals.clearDownloadProgressHover = clearDownloadProgressHover;
  }

  // client/src/features/seerr/core/ui/popover-entry.ts
  installPopover(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-popover.js.map
