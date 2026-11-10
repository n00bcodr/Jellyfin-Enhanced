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

  // client/src/features/downloads/runtime.ts
  var runtime_exports = {};
  __export(runtime_exports, {
    runtime: () => runtime
  });
  function runtime(deps) {
    if (deps.P.runtime) return deps.P.runtime;
    const { JE, P, host } = deps;
    let generation = 0, disposed = false;
    const lanes = /* @__PURE__ */ new Map();
    const removers = [];
    const identityLease = () => {
      const api = host.ApiClient, epoch = JE.session?.getEpoch();
      const serverId = () => typeof api?.serverId === "function" ? api.serverId() : api?.serverId;
      const identity = api?.getCurrentUserId(), server = api?.serverAddress?.(), base = api?.getUrl("/"), token = api?.accessToken?.(), id = serverId();
      return { current: () => !disposed && host.ApiClient === api && (epoch === void 0 || JE.session?.isCurrent(epoch) === true) && api?.getCurrentUserId() === identity && api?.serverAddress?.() === server && api?.getUrl("/") === base && api?.accessToken?.() === token && serverId() === id };
    };
    const owner = {
      cleanup(callback) {
        removers.push(callback);
      },
      installed: /* @__PURE__ */ new Set(),
      mutations: /* @__PURE__ */ new Map(),
      captureIdentity: identityLease,
      capture(lane) {
        const version = generation, identity = identityLease();
        const route = host.location.pathname + host.location.hash;
        const container = P.state?._customTabContainer || document.getElementById("je-downloads-container");
        const serial = lane ? (lanes.get(lane) || 0) + 1 : 0;
        if (lane) lanes.set(lane, serial);
        return { current: () => !disposed && generation === version && (!lane || lanes.get(lane) === serial) && identity.current() && host.location.pathname + host.location.hash === route && (!container || container.isConnected && !container.closest(".hide, [hidden]") && (!container.closest(".tabContent") || container.closest(".tabContent")?.classList.contains("is-active") === true)) };
      },
      invalidate() {
        generation++;
        if (P.state) {
          P.state.isLoading = false;
          if (P.state.searchDebounceTimer !== null) {
            clearTimeout(P.state.searchDebounceTimer);
            P.state.searchDebounceTimer = null;
          }
        }
      },
      listen(target, event, callback, capture = false) {
        target.addEventListener(event, callback, capture);
        removers.push(() => target.removeEventListener(event, callback, capture));
      },
      dispose() {
        disposed = true;
        owner.invalidate();
        removers.splice(0).forEach((remove) => remove());
        if (P.state?.pollTimer) {
          clearInterval(P.state.pollTimer);
          P.state.pollTimer = null;
        }
      }
    };
    P.runtime = owner;
    owner.listen(host, "hashchange", () => owner.invalidate());
    owner.listen(host, "popstate", () => owner.invalidate());
    owner.listen(host, "je:navigate", () => owner.invalidate());
    owner.listen(document, "viewhide", (event) => {
      if (event.target instanceof Element && (event.target.id === "je-downloads-page" || event.target.contains(P.state?._customTabContainer || document.getElementById("je-downloads-container")))) owner.invalidate();
    });
    JE.core?.lifecycle?.register("arr-requests-page").track(() => owner.dispose());
    return owner;
  }

  // client/src/features/downloads/host.ts
  var host_exports = {};
  __export(host_exports, {
    downloadsHost: () => downloadsHost
  });
  function downloadsHost() {
    var _a;
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Downloads loaded before Jellyfin Enhanced");
    const ctx = featureContext("downloads", JE, {
      facades: ["downloadsPage", "initializeDownloadsPage"],
      internalSlots: ["requestsPage"],
      internalsObject: () => JE.internals || (JE.internals = {})
    });
    const P = (_a = ctx.own).requestsPage || (_a.requestsPage = {});
    return { JE, P, host, ctx, getApi: () => {
      if (!host.ApiClient) throw new Error("API client unavailable");
      return host.ApiClient;
    } };
  }

  // client/generated-shared/publish/js/arr/requests/requests-page-styles.js.ts
  publishSharedModules({ "features/downloads/runtime": runtime_exports, "features/downloads/host": host_exports });

  // client/src/features/downloads/downloads.css
  var downloads_default = "\n        .je-msym-rounded {\n            font-family: 'JE Material Symbols Rounded';\n            font-weight: normal;\n            font-style: normal;\n            font-size: 24px;\n            line-height: 1;\n            letter-spacing: normal;\n            text-transform: none;\n            display: inline-block;\n            white-space: nowrap;\n            word-wrap: normal;\n            direction: ltr;\n            -webkit-font-feature-settings: 'liga';\n            -moz-font-feature-settings: 'liga';\n            font-feature-settings: 'liga';\n            -webkit-font-smoothing: antialiased;\n        }\n        .je-downloads-page {\n            padding: 2em;\n            max-width: 85vw;\n            margin: 0 auto;\n            position: relative;\n            z-index: 1;\n        }\n        .je-downloads-section {\n            margin-bottom: 2em;\n        }\n        .je-downloads-section h2 {\n            display: flex;\n            align-items: center;\n            gap: 0.5em;\n            font-size: 1.5em;\n            margin-bottom: 1em;\n        }\n        .je-downloads-section h2 .je-section-icon {\n            font-size: 1.15em;\n            /* centred on the lowercase letters rather than the capitals */\n            position: relative;\n            top: 0.06em;\n        }\n        .je-downloads-grid {\n          display: grid;\n          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));\n          gap: 1.1em;\n        }\n        .je-download-card, .je-request-card {\n            background: rgba(128,128,128,0.1);\n            border-radius: 0.25em;\n            overflow: hidden;\n        }\n        .je-download-card-content {\n          display: flex;\n          gap: 1em;\n          padding: 1.15em;\n        }\n        .je-download-poster, .je-request-poster {\n            border-radius: 0.5em;\n            object-fit: cover;\n            flex-shrink: 0;\n        }\n        .je-download-poster {\n          width: 72px;\n          height: 108px;\n        }\n        .je-request-poster {\n            width: 80px;\n            height: 120px;\n            max-height: 120px;\n        }\n        .je-download-poster.placeholder, .je-request-poster.placeholder {\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            background: rgba(128,128,128,0.15);\n            opacity: 0.5;\n        }\n        .je-download-info, .je-request-info {\n            flex: 1;\n            min-width: 0;\n            display: flex;\n            flex-direction: column;\n            gap: 0.3em;\n        }\n        .je-download-title, .je-request-title {\n            font-weight: 600;\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: ellipsis;\n        }\n        .je-download-subtitle, .je-request-year {\n            font-size: 0.85em;\n            opacity: 0.7;\n        }\n        .je-download-meta {\n            display: flex;\n            gap: 0.5em;\n            flex-wrap: wrap;\n            margin-top: auto;\n        }\n        .je-download-badge, .je-request-status {\n          font-size: 0.95em;\n          padding: 0.35em 0.7em;\n          border-radius: 999px;\n          text-transform: uppercase;\n          font-weight: 700;\n          color: #fff;\n        }\n        .je-arr-badge {\n          display: inline-flex;\n          align-items: center;\n          justify-content: center;\n          gap: 0.25em;\n          padding: 0;\n          background: transparent;\n        }\n        .je-arr-badge img {\n          width: 18px;\n          height: 18px;\n          object-fit: contain;\n          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));\n        }\n        .je-download-progress-container {\n            padding: 0 1em 1em;\n        }\n        .je-download-progress {\n            height: 4px;\n            background: rgba(128,128,128,0.2);\n            border-radius: 2px;\n            overflow: hidden;\n        }\n        .je-download-progress-bar {\n            height: 100%;\n            transition: width 0.3s ease;\n        }\n        .je-download-stats {\n          display: flex;\n          justify-content: space-between;\n          font-size: 1em;\n          opacity: 0.95;\n          margin-top: 0.6em;\n        }\n        .je-requests-tabs,\n        .je-issues-tabs {\n            display: flex;\n            gap: 0.5em;\n            margin-bottom: 1em;\n            flex-wrap: wrap;\n        }\n        .je-requests-tab.emby-button,\n        .je-issues-tab.emby-button {\n            background: transparent;\n            border: 1px solid rgba(255,255,255,0.3);\n            color: inherit;\n            padding: 0.5em 1em;\n            border-radius: 4px;\n            cursor: pointer;\n            opacity: 0.7;\n            transition: all 0.2s;\n        }\n        .je-requests-tab.emby-button:hover,\n        .je-issues-tab.emby-button:hover {\n            opacity: 1;\n            background: rgba(255,255,255,0.1);\n        }\n        .je-requests-tab.emby-button.active,\n        .je-issues-tab.emby-button.active {\n            opacity: 1;\n        }\n        .je-request-card {\n            display: flex;\n            gap: 1em;\n            padding: 1em .75em;\n            overflow: visible;\n        }\n        .je-request-poster-col {\n            display: flex;\n            flex-direction: column;\n            align-items: center;\n            flex-shrink: 0;\n        }\n        .je-request-info {\n            overflow: hidden;\n            min-width: 0;\n        }\n        .je-request-header {\n            display: flex;\n            justify-content: space-between;\n            align-items: flex-start;\n            gap: 0.5em;\n            margin-bottom: 0.5em;\n            min-width: 0;\n        }\n        .je-request-header > div:first-child {\n            min-width: 0;\n            flex: 1;\n            overflow: hidden;\n        }\n        .je-request-title {\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: ellipsis;\n            display: block;\n        }\n        .je-request-title-link {\n            cursor: pointer;\n        }\n        .je-request-title-link:hover {\n            text-decoration: underline;\n        }\n        .je-request-status {\n            flex-shrink: 0;\n        }\n        .je-request-meta {\n          display: flex;\n          align-items: center;\n          justify-content: space-between;\n          gap: 0.5em;\n          font-size: 0.85em;\n          opacity: 0.8;\n          margin-top: 0.5em;\n        }\n        .je-request-meta-left { display: inline-flex; align-items: center; gap: 0.5em; min-width: 0; }\n        .je-request-avatar {\n            width: 24px;\n            height: 24px;\n            border-radius: 50%;\n            object-fit: cover;\n        }\n        .je-request-actions {\n            margin-top: 1em;\n        }\n        .je-request-watch-btn {\n          color: inherit;\n          border: none;\n          padding: 0.45em;\n          border-radius: 50%;\n          cursor: pointer;\n          width: 36px;\n          height: 36px;\n          display: inline-flex;\n          align-items: center;\n          justify-content: center;\n          box-shadow: 0 4px 12px rgba(0,0,0,0.25);\n        }\n        .je-request-watch-btn:hover { opacity: 0.9; }\n        .je-request-watch-btn .material-icons { font-size: 20px; }\n        .je-request-external-links {\n          display: flex;\n          align-items: center;\n          justify-content: center;\n        }\n        .je-request-external-link {\n          display: inline-flex;\n          align-items: center;\n          justify-content: center;\n          opacity: 0.75;\n          transition: opacity 0.15s;\n          margin: 1em 0em 0em 0em;\n          padding: 0.75em;\n        }\n        .je-request-external-link:hover { opacity: 1; }\n        .je-request-external-link img {\n          width: 16px;\n          height: 16px;\n          object-fit: contain;\n          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));\n        }\n        .je-request-external-links:empty { display: none; }\n        .je-request-approve-btn, .je-request-decline-btn {\n          border: none;\n          padding: 0.45em;\n          border-radius: 50%;\n          cursor: pointer;\n          width: 36px;\n          height: 36px;\n          display: inline-flex;\n          align-items: center;\n          justify-content: center;\n          box-shadow: 0 4px 12px rgba(0,0,0,0.25);\n          margin-left: 6px;\n        }\n        .je-request-approve-btn { background: #4caf50; color: #fff; }\n        .je-request-decline-btn { background: #f44336; color: #fff; }\n        .je-request-approve-btn:hover { background: #43a047; }\n        .je-request-decline-btn:hover { background: #e53935; }\n        .je-request-approve-btn .material-icons,\n        .je-request-decline-btn .material-icons { font-size: 20px; }\n        .je-request-approve-btn:disabled,\n        .je-request-decline-btn:disabled { opacity: 0.5; cursor: default; }\n        .je-issues-section h2 {\n          font-size: 1.5em;\n          margin-bottom: 1em;\n        }\n        .je-issue-card {\n          display: flex;\n          gap: 1em;\n          padding: 1em;\n          background: rgba(128,128,128,0.1);\n          border-radius: 0.25em;\n          overflow: visible;\n        }\n        .je-issue-info {\n          flex: 1;\n          min-width: 0;\n          display: flex;\n          flex-direction: column;\n          gap: 0.35em;\n        }\n        .je-issue-title-row {\n          display: flex;\n          align-items: center;\n          flex-wrap: wrap;\n          gap: 0.4em;\n          min-width: 0;\n        }\n        .je-issue-title {\n          font-weight: 600;\n          white-space: nowrap;\n          overflow: hidden;\n          text-overflow: ellipsis;\n          max-width: 100%;\n        }\n        .je-issue-summary {\n          font-size: 0.85em;\n          opacity: 0.8;\n          display: flex;\n          flex-wrap: wrap;\n          gap: 0.4em;\n          align-items: center;\n          width: 100%;\n        }\n        .je-issue-view-btn {\n          background: transparent;\n          border: none;\n          color: inherit;\n          width: 28px;\n          height: 28px;\n          border-radius: 50%;\n          display: inline-flex;\n          align-items: center;\n          justify-content: center;\n          cursor: pointer;\n          opacity: 0.8;\n          margin-left: auto;\n          transition: opacity 0.2s;\n        }\n        .je-issue-view-btn:hover { opacity: 1; }\n        .je-issue-view-btn.is-disabled { opacity: 0.35; cursor: not-allowed; }\n        .je-issue-view-btn .material-icons { font-size: 18px; }\n        .je-issue-message {\n          font-size: 0.9em;\n          opacity: 0.85;\n          display: -webkit-box;\n          -webkit-line-clamp: 2;\n          -webkit-box-orient: vertical;\n          overflow: hidden;\n          text-overflow: ellipsis;\n        }\n        .je-issue-status-chip {\n          font-size: 0.7em;\n          font-weight: 700;\n          letter-spacing: 0.04em;\n          text-transform: uppercase;\n          padding: 0.25em 0.6em;\n          border-radius: 999px;\n          border: 1px solid rgba(255,255,255,0.12);\n        }\n        .je-issue-status-open { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }\n        .je-issue-status-resolved { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }\n        .je-issue-type-chip {\n          font-size: 0.7em;\n          font-weight: 700;\n          text-transform: uppercase;\n          letter-spacing: 0.04em;\n          padding: 0.25em 0.6em;\n          border-radius: 999px;\n          background: rgba(59, 130, 246, 0.25);\n          border: 1px solid rgba(59, 130, 246, 0.5);\n          color: #f0f9ff;\n        }\n        .je-pagination {\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            gap: 1em;\n            margin-top: 1.5em;\n        }\n        .je-pagination .emby-button {\n            background: transparent;\n            border: 1px solid rgba(255,255,255,0.3);\n            color: inherit;\n            padding: 0.5em 1em;\n            border-radius: 4px;\n            cursor: pointer;\n            opacity: 0.7;\n            transition: all 0.2s;\n        }\n        .je-pagination .emby-button:hover:not(:disabled) {\n            opacity: 1;\n            background: rgba(255,255,255,0.1);\n        }\n        .je-pagination .emby-button:disabled { opacity: 0.3; cursor: not-allowed; }\n        .je-empty-state {\n            text-align: center;\n            padding: 3em;\n            opacity: 0.5;\n        }\n        .je-loading {\n            display: flex;\n            justify-content: center;\n            padding: 2em;\n        }\n        .je-requests-status-chip {\n          display: inline-flex;\n          align-items: center;\n          padding: 0.3rem 0.6rem;\n          margin-top: 0.7rem;\n          border-radius: 999px;\n          font-weight: 700;\n          letter-spacing: 0.02em;\n          font-size: 0.72rem;\n          text-transform: uppercase;\n          background: rgba(255, 255, 255, 0.08);\n          border: 1px solid rgba(255, 255, 255, 0.12);\n        }\n        .je-requests-status-chip.je-chip-available { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }\n        .je-requests-status-chip.je-chip-partial { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }\n        .je-requests-status-chip.je-chip-processing { background: rgba(59, 130, 246, 0.25); color: #f0f9ff; border-color: rgba(59, 130, 246, 0.5); }\n        .je-requests-status-chip.je-chip-requested { background: rgba(168, 85, 247, 0.25); color: #f0f9ff; border-color: rgba(168, 85, 247, 0.5); }\n        .je-requests-status-chip.je-chip-pending { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }\n        .je-requests-status-chip.je-chip-rejected,\n        .je-requests-status-chip.je-chip-declined { background: rgba(248, 113, 113, 0.25); color: #f0f9ff; border-color: rgba(248, 113, 113, 0.5); }\n        .je-requests-status-chip.je-chip-blocklisted { background: rgba(245, 158, 11, 0.25); color: #f0f9ff; border-color: rgba(245, 158, 11, 0.5); }\n        .je-requests-status-chip.je-chip-deleted { background: rgba(220, 38, 38, 0.22); color: #ffe4e6; border-color: rgba(248, 113, 113, 0.55); }\n        .je-requests-status-chip.je-chip-coming-soon { background: rgba(156, 39, 176, 0.25); color: #f0f9ff; border-color: rgba(156, 39, 176, 0.5); }\n        .je-requests-status-chip.je-chip-orphaned { background: rgba(148, 163, 184, 0.14); color: #aab4c4; border: 1px dashed rgba(148, 163, 184, 0.6); }\n        .je-request-card-orphaned { opacity: 0.82; }\n        .je-request-card-orphaned .je-request-poster { filter: grayscale(0.7); }\n        .je-release-date-chip {\n          display: inline-flex;\n          align-items: center;\n          padding: 0.25rem 0.5rem;\n          margin-left: 0.5rem;\n          border-radius: 999px;\n          font-weight: 600;\n          letter-spacing: 0.02em;\n          font-size: 0.68rem;\n          text-transform: uppercase;\n          background: rgba(156, 39, 176, 0.25);\n          border: 1px solid rgba(156, 39, 176, 0.5);\n          color: #f0f9ff;\n        }\n        .je-release-date-icon { font-size: 1em; margin-right: 3px; vertical-align: middle; line-height: 1; }\n        .je-release-date-chip sup,\n        .je-requests-status-chip sup,\n        .je-request-title sup {\n          font-size: 0.6em;\n          opacity: 0.85;\n          margin-bottom: 1em;\n          margin-right: 0.25em;\n          text-transform: lowercase;\n        }\n        .je-refresh-btn:hover {\n          opacity: 1 !important;\n          background: rgba(255,255,255,0.1) !important;\n        }\n        .je-downloads-controls {\n          display: flex;\n          flex-direction: column;\n          gap: 1em;\n          margin-bottom: 1.5em;\n        }\n        .je-downloads-tabs {\n          display: flex;\n          gap: 0.5em;\n          flex-wrap: wrap;\n          align-items: center;\n        }\n        .je-downloads-tab.emby-button {\n          background: transparent;\n          border: 1px solid rgba(255,255,255,0.3);\n          color: inherit;\n          padding: 0.5em 1em;\n          border-radius: 4px;\n          cursor: pointer;\n          opacity: 0.7;\n          transition: all 0.2s;\n          display: inline-flex;\n          align-items: center;\n          gap: 0.5em;\n        }\n        .je-downloads-tab.emby-button:hover {\n          opacity: 1;\n          background: rgba(255,255,255,0.1);\n        }\n        .je-downloads-tab.emby-button.active {\n          opacity: 1;\n        }\n        .je-downloads-search-toggle {\n          background: transparent;\n          border: 1px solid rgba(255,255,255,0.3);\n          color: inherit;\n          padding: 0.5em;\n          border-radius: 4px;\n          cursor: pointer;\n          opacity: 0.7;\n          transition: all 0.2s;\n          display: inline-flex;\n          align-items: center;\n          justify-content: center;\n          width: 36px;\n          height: 36px;\n        }\n        .je-downloads-search-toggle:hover {\n          opacity: 1;\n          background: rgba(255,255,255,0.1);\n        }\n        .je-downloads-search-toggle.active {\n          opacity: 1;\n          background: rgba(255,255,255,0.15);\n        }\n        .je-downloads-search-toggle .material-icons {\n          font-size: 20px;\n        }\n        .je-downloads-tab-count {\n          font-size: 0.8em;\n          padding: 0.2em 0.5em;\n          background: rgba(255,255,255,0.5);\n          border-radius: 999px;\n          min-width: 20px;\n          text-align: center;\n        }\n        .je-downloads-search-container {\n          display: flex;\n          align-items: center;\n          gap: 0.5em;\n          position: relative;\n          width: 100%;\n          animation: slideDown 0.2s ease-out;\n        }\n        @keyframes slideDown {\n          from {\n            opacity: 0;\n            transform: translateY(-10px);\n          }\n          to {\n            opacity: 1;\n            transform: translateY(0);\n          }\n        }\n        .je-downloads-search-icon {\n          position: absolute;\n          left: 0.7em;\n          font-size: 20px;\n          opacity: 0.5;\n          pointer-events: none;\n        }\n        .je-downloads-search-input {\n          background: rgba(255,255,255,0.08);\n          border: 1px solid rgba(255,255,255,0.2);\n          color: inherit;\n          padding: 0.6em 0.9em 0.6em 2.5em;\n          border-radius: 4px;\n          font-size: 0.9em;\n          flex: 1;\n          width: 100%;\n          transition: all 0.2s;\n        }\n        .je-downloads-search-input:focus {\n          outline: none;\n          border-color: rgba(255,255,255,0.4);\n          background: rgba(255,255,255,0.12);\n        }\n        .je-downloads-search-input:focus + .je-downloads-search-icon {\n          opacity: 0.7;\n        }\n        @keyframes spin {\n          from { transform: rotate(0deg); }\n          to { transform: rotate(360deg); }\n        }\n    ";

  // client/src/features/downloads/styles.ts
  function install(deps) {
    const { JE, P, host, getApi } = deps;
    const life = runtime(deps);
    if (life.installed.has("styles")) return;
    life.installed.add("styles");
    const CSS_STYLES = downloads_default;
    function injectStyles() {
      if (document.getElementById("je-downloads-styles")) return;
      JE.core.ui.injectCss("je-downloads-styles", CSS_STYLES);
      injectThemeColors();
    }
    function injectThemeColors() {
      const themeVars = JE.themer?.getThemeVariables() || {};
      const primaryAccent = themeVars.primaryAccent || "#00a4dc";
      JE.core.ui.injectCss("je-downloads-theme-colors", `
      .je-requests-tab.emby-button.active,
      .je-issues-tab.emby-button.active,
      .je-downloads-tab.emby-button.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-request-watch-btn {
        background: ${primaryAccent} !important;
      }
    `);
    }
    P.injectStyles = injectStyles;
  }

  // client/src/features/downloads/styles-entry.ts
  install(downloadsHost());
})();
})();
//# sourceMappingURL=requests-page-styles.js.map
