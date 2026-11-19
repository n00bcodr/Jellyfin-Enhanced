(() => {
"use strict";
(() => {
  // client/src/host/bootstrap-pages-host.ts
  var loaderWindow = () => window;
  function installNamespace(namespace) {
    loaderWindow().JellyfinEnhanced = namespace;
    return namespace;
  }
  var liveNamespace = () => loaderWindow().JellyfinEnhanced;
  var optionalClient = () => loaderWindow().ApiClient;
  function client() {
    const api = optionalClient();
    if (!api) throw new Error("Jellyfin ApiClient is not available");
    return api;
  }
  function readBootstrapValidator() {
    const contract = loaderWindow().__JE_BOOTSTRAP_CONTRACT__;
    const { parseBootstrap, parseSettingsDocument, parseBookmarkDocument } = contract ?? {};
    if (typeof parseBootstrap !== "function" || typeof parseSettingsDocument !== "function" || typeof parseBookmarkDocument !== "function") return null;
    return { parseBootstrap, parseSettingsDocument, parseBookmarkDocument };
  }

  // client/src/host/component-groups-host.ts
  var bundleWindow = () => window;
  function resetBundleGlobals() {
    bundleWindow().__JE_BUNDLE_MODULES = void 0;
  }
  function takeBundle() {
    const host = bundleWindow();
    const bundle = { modules: host.__JE_BUNDLE_MODULES, total: host.__JE_BUNDLE_TOTAL };
    delete host.__JE_BUNDLE_MODULES;
    return bundle;
  }
  function takeGroupBundles(ids) {
    const defined = bundleWindow().__JE_BUNDLES ?? {};
    const taken = /* @__PURE__ */ Object.create(null);
    for (const id of ids) {
      const bundle = defined[id];
      taken[id] = typeof bundle === "object" && bundle !== null && "modules" in bundle && "total" in bundle ? { modules: bundle.modules, total: bundle.total } : void 0;
      delete defined[id];
    }
    return taken;
  }
  function countBundleModule() {
    const host = bundleWindow();
    host.__JE_BUNDLE_PROGRESS = Math.max(0, host.__JE_BUNDLE_PROGRESS || 0) + 1;
  }
  function aliasNamespace(namespace) {
    const host = bundleWindow();
    if (!host.JE) host.JE = namespace;
  }

  // client/src/bootstrap/loader/keys.ts
  var isRecord = (value) => typeof value === "object" && value !== null;
  var isDocument = (value) => isRecord(value) && !Array.isArray(value);
  function convertKeys(value, convert) {
    if (!isDocument(value)) return value;
    return Object.fromEntries(Object.keys(value).map((key) => [convert(key), convertKeys(value[key], convert)]));
  }
  var toCamelCase = (value) => convertKeys(value, (key) => key.charAt(0).toLowerCase() + key.slice(1));
  var toPascalCase = (value) => convertKeys(value, (key) => key.charAt(0).toUpperCase() + key.slice(1));

  // client/src/bootstrap/loader/identity.ts
  function sameUser(left, right) {
    const normalize = (id) => String(id || "").replace(/-/g, "").toLowerCase();
    const expected = normalize(left);
    return !!expected && expected === normalize(right);
  }
  function currentUserId(client2) {
    const id = client2.getCurrentUserId?.();
    return typeof id === "string" && id ? id : null;
  }
  function hostAdministrator(user, userId, message) {
    const policy = isRecord(user) && sameUser(user.Id, userId) ? user.Policy : null;
    const administrator = isRecord(policy) ? policy.IsAdministrator : null;
    if (typeof administrator !== "boolean") throw new Error(message);
    return administrator;
  }
  function createIdentityScope(target) {
    let epoch = 0;
    target.addEventListener("je:user-changed", () => {
      epoch++;
    });
    return {
      key: (client2) => JSON.stringify([
        epoch,
        client2.getCurrentUserId?.(),
        typeof client2.serverId === "function" ? client2.serverId() : client2.serverId,
        client2.getUrl("/"),
        client2.accessToken?.()
      ])
    };
  }
  var requireObject = (value) => isRecord(value) ? value : null;

  // client/src/bootstrap/loader/script-tag.ts
  var scriptTag = () => document.querySelector('script[plugin="Jellyfin Enhanced"]');
  var isDevMode = () => scriptTag()?.getAttribute("dev") === "true";
  function getScriptVersion() {
    if (isDevMode()) return Date.now();
    return scriptTag()?.getAttribute("version") || liveNamespace()?.pluginVersion || Date.now();
  }
  function scriptTagVersion() {
    return (scriptTag()?.getAttribute("version") || "").split("-")[0] ?? "";
  }

  // client/src/bootstrap/loader/script-loader.ts
  function appendScript(src, configure, onLoad, onError) {
    const script = document.createElement("script");
    script.src = src;
    configure?.(script);
    if (onLoad) script.onload = () => onLoad();
    if (onError) script.onerror = (error) => onError(error);
    document.head.appendChild(script);
  }
  var scriptLoaded = (src, configure) => new Promise((resolve) => {
    appendScript(src, configure, () => resolve(true), () => resolve(false));
  });
  function loadScripts(scripts, basePath) {
    return Promise.all(scripts.map((name) => new Promise((resolve) => {
      appendScript(
        client().getUrl(`${basePath}/${name}?v=${getScriptVersion()}`),
        (script) => {
          script.async = false;
        },
        () => resolve(true),
        (error) => {
          console.error(`🪼 Jellyfin Enhanced: Failed to load script '${name}'`, error);
          resolve(false);
        }
      );
    })));
  }

  // client/src/bootstrap/loader/bootstrap-client.ts
  var PREFETCHED_DEFAULT_MAX_AGE_MS = 1e4;
  function createBootstrapClient(JE, identity) {
    let contractPromise = null;
    let prefetched = null;
    let bootstrapPromise = null;
    let bootstrapUserId = null;
    let bootstrapIdentityKey = null;
    function loadBootstrapContract() {
      contractPromise ?? (contractPromise = new Promise((resolve, reject) => {
        appendScript(client().getUrl(`/JellyfinEnhanced/js/contracts/bootstrap.js?v=${getScriptVersion()}`), void 0, () => {
          const contract = readBootstrapValidator();
          if (contract) resolve(contract);
          else reject(new Error("Bootstrap validator unavailable"));
        }, () => reject(new Error("Bootstrap validator failed to load")));
      }).catch((error) => {
        contractPromise = null;
        throw error;
      }));
      return contractPromise;
    }
    async function fetchBootstrap(expectedUserId) {
      const api = client();
      const started = identity.key(api);
      const [contract, hostUser, payload] = await Promise.all([
        loadBootstrapContract(),
        typeof api.getCurrentUser === "function" ? api.getCurrentUser() : Promise.reject(new Error("Authenticated host user unavailable")),
        api.ajax({ type: "GET", url: api.getUrl(`/JellyfinEnhanced/bootstrap?_=${Date.now()}`), dataType: "json" })
      ]);
      if (api !== client() || started !== identity.key(api)) throw new Error("Bootstrap identity changed");
      const isAdministrator = hostAdministrator(hostUser, expectedUserId, "Authenticated host user unavailable");
      return contract.parseBootstrap(payload, expectedUserId, isAdministrator);
    }
    function storePrefetched(bootstrap, userId) {
      const parts = bootstrap.Prefetched;
      prefetched = parts && typeof parts === "object" ? { userId, identity: identity.key(client()), receivedAt: Date.now(), parts: { ...parts } } : null;
    }
    JE.takePrefetched = (name, maxAgeMs = PREFETCHED_DEFAULT_MAX_AGE_MS) => {
      if (!prefetched || prefetched.identity !== identity.key(client()) || !Object.prototype.hasOwnProperty.call(prefetched.parts, name)) return void 0;
      const value = prefetched.parts[name];
      delete prefetched.parts[name];
      if (!sameUser(prefetched.userId, currentUserId(client()))) return void 0;
      if (Date.now() - prefetched.receivedAt > maxAgeMs) return void 0;
      return value == null ? void 0 : value;
    };
    function getBootstrap(userId) {
      const key = identity.key(client());
      if (bootstrapPromise && bootstrapUserId === userId && bootstrapIdentityKey === key) return bootstrapPromise;
      bootstrapIdentityKey = key;
      bootstrapUserId = userId;
      const promise = fetchBootstrap(userId).then((payload) => {
        if (!sameUser(payload.UserId, userId)) throw new Error("Bootstrap response is for a different user");
        storePrefetched(payload, userId);
        return payload;
      }).catch((error) => {
        if (bootstrapPromise === promise) bootstrapPromise = null;
        throw error;
      });
      bootstrapPromise = promise;
      return promise;
    }
    const clearPrefetched = () => {
      prefetched = null;
    };
    return { loadBootstrapContract, fetchBootstrap, getBootstrap, clearPrefetched };
  }
  var sessionUnchanged = (api, identity, key) => api === client() && key === identity.key(api);

  // client/src/bootstrap/loader/translate.ts
  var PLURAL_PARAMS = ["count", "days", "n", "items", "hours", "minutes", "seconds"];
  function createTranslator(scope) {
    return (key, params = {}) => {
      const translations = scope()?.translations ?? {};
      let text = translations[key] || key;
      const counted = params ? PLURAL_PARAMS.find((name) => {
        const value = params[name];
        return typeof value === "number" && Number.isFinite(value);
      }) : void 0;
      if (params && counted && translations[key]) {
        const english = scope()?.translationsFromEnglish;
        const ownLang = scope()?.translationsLang || "en";
        const keyIsEnglish = !!english?.has(key);
        const lang = keyIsEnglish ? "en" : ownLang;
        const sameSource = (variant2) => variant2 in translations && (!english || keyIsEnglish === english.has(variant2) || /^en\b/i.test(ownLang));
        let category = "other";
        try {
          category = new Intl.PluralRules([lang, "en"]).select(Number(params[counted]));
        } catch {
        }
        const variant = [`${key}_${category}`, `${key}_other`].find(sameSource);
        if (variant) text = translations[variant] ?? text;
      }
      if (params) {
        for (const [param, value] of Object.entries(params)) {
          text = text.replace(new RegExp(`{${param}}`, "g"), () => String(value));
        }
      }
      return text.replace(/\{\{icon:([a-zA-Z]+)\}\}/g, (match, iconName) => {
        const iconKey = iconName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
        const iconConstant = scope()?.IconName?.[iconKey];
        if (!iconConstant) {
          console.debug(`[JE.t] IconName.${iconKey} not available yet, keeping placeholder`);
          return match;
        }
        const iconResult = scope()?.icon?.(iconConstant);
        if (iconResult && iconResult.startsWith("{{ICON_PENDING:")) {
          console.debug(`[JE.t] Icon system not ready, keeping placeholder for ${iconName}`);
          return match;
        }
        return iconResult || match;
      });
    };
  }

  // client/src/bootstrap/loader/namespace.ts
  var emptyUserConfig = () => ({
    settings: {},
    shortcuts: { Shortcuts: [] },
    bookmark: { bookmarks: {} },
    elsewhere: {},
    hiddenContent: { items: {}, settings: {} }
  });
  function createNamespace() {
    return installNamespace({
      // Populated by js/core/*.js (navigation, lifecycle, dom, api, ui).
      core: {},
      pluginConfig: {},
      userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } },
      translations: {},
      pluginVersion: "unknown",
      // Every third-party static asset is served from the plugin's own route
      // (/JellyfinEnhanced/cdn/{source}/{path}), so the client never contacts an external CDN.
      cdn: {
        url(source, path) {
          const clean = String(path == null ? "" : path).replace(/^\/+/, "");
          return client().getUrl(`/JellyfinEnhanced/cdn/${source}/${clean}`);
        },
        selfhst(file) {
          return this.url("selfhst", file);
        },
        flagPng(code, size = "w20") {
          return this.url("flagcdn", `${size}/${String(code).toLowerCase()}.png`);
        },
        flagSvg(code) {
          return this.url("flag-icons", `flags/4x3/${String(code).toLowerCase()}.svg`);
        },
        // Bundled and served immutable, so the plugin version keys the cache.
        font(name) {
          return client().getUrl(`/JellyfinEnhanced/fonts/${name}?v=${getScriptVersion()}`);
        }
      },
      // Until icons.js loads, keep the token so t() can keep its placeholder.
      icon: (name) => name ? `{{ICON_PENDING:${name}}}` : "",
      IconName: {},
      state: {
        activeShortcuts: {},
        // { itemId, surface, ts } captured on a menu trigger so the action-sheet
        // observer knows which Remove button (if any) to add.
        removeContext: null,
        pauseScreenClickTimer: null
      },
      // Unified cache manager for tag systems.
      _cacheManager: {
        callbacks: /* @__PURE__ */ new Set(),
        dirty: false,
        scheduleId: null,
        register(saveCallback) {
          this.callbacks.add(saveCallback);
        },
        unregister(saveCallback) {
          this.callbacks.delete(saveCallback);
        },
        markDirty() {
          this.dirty = true;
          if (!this.scheduleId) {
            this.scheduleId = typeof requestIdleCallback !== "undefined" ? requestIdleCallback(() => this._flush(), { timeout: 5e3 }) : setTimeout(() => this._flush(), 1e3);
          }
        },
        _flush() {
          if (this.dirty) {
            this.callbacks.forEach((callback) => {
              try {
                callback();
              } catch (error) {
                console.error("Cache save error:", error);
              }
            });
            this.dirty = false;
          }
          this.scheduleId = null;
        },
        forceSave() {
          this.dirty = true;
          this._flush();
        }
      },
      // Bootstrap copy only; replaced by JE.core.ui.escapeHtml when js/core/ui-kit.js loads.
      escapeHtml: (value) => {
        if (typeof value !== "string") return String(value ?? "");
        return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
      },
      t: createTranslator(liveNamespace),
      loadSettings: () => {
        console.warn("🪼 Jellyfin Enhanced: loadSettings called before config.js loaded");
        return {};
      },
      initializeShortcuts: () => {
        console.warn("🪼 Jellyfin Enhanced: initializeShortcuts called before config.js loaded");
      },
      saveUserSettings: async (fileName) => {
        console.warn(`🪼 Jellyfin Enhanced: saveUserSettings(${fileName}) called before config.js loaded`);
      },
      toPascalCase,
      toCamelCase,
      takePrefetched: () => void 0
    });
  }

  // client/src/bootstrap/loader/user-config.ts
  var USER_CONFIG_DOCUMENTS = {
    settings: "settings.json",
    shortcuts: "shortcuts.json",
    bookmark: "bookmark.json",
    elsewhere: "elsewhere.json",
    hiddenContent: "hidden-content.json"
  };
  var DOCUMENT_NAMES = Object.keys(USER_CONFIG_DOCUMENTS);
  var CAMEL_CASED = /* @__PURE__ */ new Set(["settings", "bookmark", "hiddenContent"]);
  var BOOKMARK_FIELDS = /* @__PURE__ */ new Set(["ItemId", "TmdbId", "TvdbId", "MediaType", "Name", "Timestamp", "Label", "CreatedAt", "UpdatedAt", "SyncedFrom", "SeasonNumber", "EpisodeNumber", "Progress"]);
  function buildUserConfig(documents) {
    const userConfig = emptyUserConfig();
    for (const name of DOCUMENT_NAMES) {
      const value = documents[name];
      if (value === null && (name === "hiddenContent" || name === "shortcuts")) userConfig[name] = null;
      if (!isRecord(value)) continue;
      const converted = CAMEL_CASED.has(name) ? toCamelCase(value) : value;
      if (name === "settings") userConfig.settings = requireObject(converted) ?? {};
      else userConfig[name] = converted;
    }
    return userConfig;
  }
  function bookmarkSnapshotView(snapshot, api) {
    if (!snapshot) return { bookmark: { bookmarks: {} }, bookmarkRevision: null };
    const document2 = JSON.parse(snapshot.Document);
    const fields = isRecord(document2) ? document2 : {};
    const records = Object.entries(fields).find(([key]) => key.toLowerCase() === "bookmarks")?.[1] ?? {};
    if (!isRecord(records) || Array.isArray(records)) throw new Error("Invalid bookmark records");
    const bookmarks = Object.fromEntries(Object.entries(records).map(([id, value]) => [
      id,
      isRecord(value) && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [BOOKMARK_FIELDS.has(key) ? key.charAt(0).toLowerCase() + key.slice(1) : key, child])) : value
    ]));
    return {
      bookmark: { ...fields, bookmarks },
      bookmarkRevision: snapshot.Revision,
      bookmarkBinding: { client: api, userId: api.getCurrentUserId?.(), token: api.accessToken?.(), baseUrl: api.getUrl("/") }
    };
  }
  function buildUserConfigFromBootstrap(documents) {
    return Object.assign(buildUserConfig({
      settings: documents.Settings,
      shortcuts: documents.Shortcuts,
      bookmark: documents.Bookmark,
      elsewhere: documents.Elsewhere,
      hiddenContent: documents.HiddenContent
    }), { settingsRevision: documents.SettingsRevision || null }, bookmarkSnapshotView(documents.BookmarkSnapshot, client()));
  }
  async function fetchUserScopedConfig(userId, contracts, identity) {
    const api = client();
    const started = identity.key(api);
    const documents = {};
    let settingsRevision = null;
    let bookmarkSnapshot = null;
    const route = (name) => name === "settings" ? "settings-document" : name === "bookmark" ? "bookmark-document" : USER_CONFIG_DOCUMENTS[name];
    await Promise.all(DOCUMENT_NAMES.map(
      (name) => api.ajax({ type: "GET", url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${route(name)}?_=${Date.now()}`), dataType: "json" }).then(async (data) => {
        if (name === "settings") {
          const [contract, hostUser] = await Promise.all([contracts.loadBootstrapContract(), api.getCurrentUser?.()]);
          const snapshot = contract.parseSettingsDocument(data, hostAdministrator(hostUser, userId, "Settings identity changed"));
          documents[name] = snapshot.Settings;
          settingsRevision = snapshot.Revision;
        } else if (name === "bookmark") {
          bookmarkSnapshot = (await contracts.loadBootstrapContract()).parseBookmarkDocument(data);
        } else documents[name] = data;
      }).catch(() => {
        documents[name] = null;
      })
    ));
    if (!sessionUnchanged(api, identity, started)) return null;
    return Object.assign(buildUserConfig(documents), { settingsRevision }, bookmarkSnapshotView(bookmarkSnapshot, api));
  }
  function seedDisplayLanguage(JE, userId) {
    if (!userId) return;
    const languageKey = `${userId}-language`;
    if (localStorage.getItem(languageKey) !== null) return;
    const desired = (JE.currentSettings?.displayLanguage || "").trim();
    if (!desired) return;
    const parts = desired.split("-");
    const normalized = parts.length === 1 ? (parts[0] ?? "").toLowerCase() : parts.length === 2 ? `${(parts[0] ?? "").toLowerCase()}-${(parts[1] ?? "").toUpperCase()}` : desired;
    localStorage.setItem(languageKey, normalized);
  }

  // client/src/bootstrap/loader/config-loader.ts
  var USER_SCOPED_PUBLIC_KEYS = ["TagLookItemOverrides"];
  var CUSTOM_TAB_FLAGS = [
    "BookmarksUseCustomTabs",
    "CalendarUseCustomTabs",
    "HiddenContentUseCustomTabs",
    "DownloadsUseCustomTabs",
    "RecommendationsUseCustomTabs",
    "ActivityFeedUseCustomTabs",
    "CatchUpUseCustomTabs",
    "LeavingSoonPageUseCustomTabs"
  ];
  var PLUGIN_PAGE_FLAGS = ["BookmarksUsePluginPages", "HiddenContentUsePluginPages", "DownloadsUsePluginPages", "CalendarUsePluginPages"];
  var NOT_RUNNING = ["Disabled", "NotSupported", "Malfunctioned"];
  function createConfigLoader(JE, contracts, identity) {
    let privateConfigKeys = [];
    function stripPrivateConfig() {
      for (const key of privateConfigKeys) delete JE.pluginConfig[key];
      privateConfigKeys = [];
    }
    function applyPrivateConfig(privateConfig) {
      stripPrivateConfig();
      const value = requireObject(privateConfig) ?? {};
      privateConfigKeys = Object.keys(value);
      Object.assign(JE.pluginConfig, value);
    }
    function applyUserPublicConfig(publicConfig) {
      const value = requireObject(publicConfig);
      for (const key of USER_SCOPED_PUBLIC_KEYS) JE.pluginConfig[key] = value ? value[key] ?? null : null;
    }
    function resetUserScopedGlobals() {
      JE.userConfig = emptyUserConfig();
      JE.currentSettings = {};
      JE.state.activeShortcuts = {};
      stripPrivateConfig();
      applyUserPublicConfig(null);
      contracts.clearPrefetched();
    }
    async function loadUserPublicConfig(api, isCurrent) {
      try {
        const config = await api.ajax({ type: "GET", url: api.getUrl(`/JellyfinEnhanced/public-config?_=${Date.now()}`), dataType: "json" });
        if (isCurrent()) applyUserPublicConfig(requireObject(config));
      } catch (error) {
        console.warn("🪼 Jellyfin Enhanced: Could not reload the per-user public configuration.", error);
      }
    }
    function applyDeliveryPluginFlags(hasCustomTabs, hasPluginPages) {
      JE.hasCustomTabs = hasCustomTabs;
      if (!hasCustomTabs) for (const flag of CUSTOM_TAB_FLAGS) JE.pluginConfig[flag] = false;
      if (!hasPluginPages) for (const flag of PLUGIN_PAGE_FLAGS) JE.pluginConfig[flag] = false;
    }
    async function loadDeliveryPluginFlags() {
      try {
        const api = client();
        const installed = await api.ajax({ type: "GET", url: api.getUrl("/Plugins"), dataType: "json" });
        if (!Array.isArray(installed)) throw new Error("Unexpected /Plugins response");
        const running = (name) => installed.some((plugin) => isRecord(plugin) && plugin.Name === name && !NOT_RUNNING.includes(String(plugin.Status)));
        applyDeliveryPluginFlags(running("Custom Tabs"), running("Plugin Pages"));
      } catch (error) {
        console.warn("🪼 Jellyfin Enhanced: Could not verify installed plugins:", error);
      }
    }
    async function loadPrivateConfig() {
      const api = client();
      const started = identity.key(api);
      const requestEpoch = JE.session?.getEpoch() ?? 0;
      try {
        const privateConfig = await api.ajax({ type: "GET", url: api.getUrl("/JellyfinEnhanced/private-config"), dataType: "json" });
        if (!sessionUnchanged(api, identity, started) || JE.session && !JE.session.isCurrent(requestEpoch)) return;
        privateConfigKeys = Object.keys(requireObject(privateConfig) ?? {});
        Object.assign(JE.pluginConfig, privateConfig);
      } catch (error) {
        console.warn("🪼 Jellyfin Enhanced: Could not load private configuration. Some features may be limited.", error);
      }
    }
    function applyBootstrapUserScope(bootstrap) {
      JE.userConfig = buildUserConfigFromBootstrap(bootstrap.UserSettings);
      applyUserPublicConfig(bootstrap.PublicConfig);
      applyPrivateConfig(bootstrap.PrivateConfig);
    }
    async function reloadUserScopedData(userId, callerIsCurrent) {
      const api = client();
      const started = identity.key(api);
      const isCurrent = () => callerIsCurrent() && sessionUnchanged(api, identity, started);
      const bootstrap = await contracts.fetchBootstrap(userId).catch((error) => {
        console.warn("🪼 Jellyfin Enhanced: Bootstrap request failed, reloading user data per endpoint.", error);
        return null;
      });
      if (!isCurrent()) return false;
      if (bootstrap) {
        applyBootstrapUserScope(bootstrap);
        return true;
      }
      const [userConfig] = await Promise.all([fetchUserScopedConfig(userId, contracts, identity), loadUserPublicConfig(api, isCurrent)]);
      if (!isCurrent() || !userConfig) return false;
      JE.userConfig = userConfig;
      await loadPrivateConfig();
      return isCurrent();
    }
    return { applyPrivateConfig, applyDeliveryPluginFlags, loadDeliveryPluginFlags, loadPrivateConfig, reloadUserScopedData, resetUserScopedGlobals };
  }

  // client/src/bootstrap/loader/features.ts
  var reinitialize = (hook, enabled, run) => {
    if (enabled && typeof hook === "function") run();
  };
  function reinitializeUserTags(JE) {
    const settings = JE.currentSettings;
    reinitialize(JE.initializeQualityTags, settings?.qualityTagsEnabled, () => JE.initializeQualityTags?.());
    reinitialize(JE.initializeGenreTags, settings?.genreTagsEnabled, () => JE.initializeGenreTags?.());
    reinitialize(JE.initializeRatingTags, settings?.ratingTagsEnabled, () => JE.initializeRatingTags?.());
    reinitialize(JE.initializeAgeRatingTags, settings?.ageRatingTagsEnabled, () => JE.initializeAgeRatingTags?.());
    reinitialize(JE.initializeStatusTags, settings?.statusTagsEnabled, () => JE.initializeStatusTags?.());
    reinitialize(JE.initializeAwardsTags, settings?.awardsTagsEnabled && JE.pluginConfig?.AwardsTagsEnabled !== false, () => JE.initializeAwardsTags?.());
    reinitialize(JE.initializeCustomTags, settings?.customTagsEnabled, () => JE.initializeCustomTags?.());
    reinitialize(JE.initializeLanguageTags, settings?.languageTagsEnabled, () => JE.initializeLanguageTags?.());
    reinitialize(JE.initializeLogoTags, settings?.logoTagsEnabled, () => JE.initializeLogoTags?.());
  }
  var FEATURE_INITIALIZERS = [
    ["dashboard", "initializePluginRevisions"],
    ["core", "initializeEnhancedScript"],
    ["elsewhere", "initializeElsewhereScript", (c) => c.ElsewhereEnabled],
    ["seerr", "initializeJellyseerrScript", (c) => c.JellyseerrEnabled && c.JellyseerrShowSearchResults !== false],
    ["seerr", "jellyseerrIssueReporter.initialize", (c) => c.JellyseerrEnabled && c.JellyseerrShowReportButton],
    ["player", "initializePauseScreen"],
    ["bookmarks", "initializeBookmarks"],
    ["tags", "initializeQualityTags", (_c, s) => s.qualityTagsEnabled],
    ["tags", "initializeGenreTags", (_c, s) => s.genreTagsEnabled],
    ["tags", "initializeRatingTags", (_c, s) => s.ratingTagsEnabled],
    ["tags", "initializeAgeRatingTags", (_c, s) => s.ageRatingTagsEnabled],
    ["tags", "initializeStatusTags", (_c, s) => s.statusTagsEnabled],
    ["tags", "initializeAwardsTags", (c, s) => s.awardsTagsEnabled && c.AwardsTagsEnabled !== false],
    ["tags", "initializeCustomTags", (_c, s) => s.customTagsEnabled],
    ["tags", "initializeTagStyles", (c) => c.TagStyleWebActive],
    ["tags", "initializeUserReviewTags", (c, s) => c.ShowUserReviews && c.ShowUserRatingOnPosters && s.ratingTagsEnabled],
    ["arr-links", "initializeArrLinksScript", (c) => c.ArrLinksEnabled],
    ["arr-tag-links", "initializeArrTagLinksScript", (c) => c.ArrTagsShowAsLinks],
    ["seerr", "initializeSeerrDetailLinkScript", (c) => c.JellyseerrEnabled && c.JellyseerrShowDetailPageLink],
    ["letterboxd", "initializeLetterboxdLinksScript", (c) => c.LetterboxdEnabled],
    ["reviews", "initializeReviewsScript", (c) => c.ShowReviews || c.ShowUserReviews || c.ShowAnilistReviews],
    ["awards", "initializeAwardsScript", (c) => c.ShowAwards],
    ["content-warnings", "initializeDoesTheDogDieScript", (c) => c.DoesTheDogDieEnabled],
    ["mdblist", "initializeMdblistRatingsScript", (c) => c.MdblistRatingsEnabled && c.MdblistRatingsShowOnItemDetails],
    ["tags", "initializeLanguageTags", (_c, s) => s.languageTagsEnabled],
    ["tags", "initializeLogoTags", (_c, s) => s.logoTagsEnabled],
    ["tag-people", "initializePeopleTags", (_c, s) => s.peopleTagsEnabled],
    // The unified tag pipeline initializes after all tag renderers have registered.
    ["tags", "tagPipeline.initialize"],
    ["player", "initializeOsdRating"],
    ["player-badge", "initializePlaybackRatingBadge", (c) => c.ShowPlaybackRatingBadge],
    // Disabled server-wide, JE.hiddenContent stays undefined, safely disabling all downstream consumers.
    ["hidden-content", "initializeHiddenContent", (c) => c.HiddenContentEnabled],
    // Spoiler Guard loads its per-user enabled-series list once at startup.
    ["spoiler-guard", "spoilerBlur.init", (c) => c.SpoilerBlurEnabled],
    ["core", "initializeColoredRatings", (c) => c.ColoredRatingsEnabled],
    ["theme-selector", "initializeThemeSelector", (c) => c.ThemeSelectorEnabled],
    ["dashboard", "initializeActivityIcons", (c) => c.ColoredActivityIconsEnabled],
    ["dashboard", "initializePluginIcons", (c) => c.PluginIconsEnabled],
    ["active-streams", "activeStreams.initialize", (c) => c.ActiveStreamsEnabled],
    ["requests-page", "initializeDownloadsPage", (c) => c.DownloadsPageEnabled],
    ["calendar-page", "initializeCalendarPage", (c) => c.CalendarPageEnabled],
    ["hidden-content-page", "initializeHiddenContentPage", (c) => c.HiddenContentEnabled],
    // Seerr search used to make this check as it started, on every page: it caches the user's Seerr
    // status for the session and shows the one-time "not linked / unreachable" notice. Search now loads
    // on its own pages, so the check is made here, at the same moment as before.
    ["seerr-api", "jellyseerrAPI.checkUserStatus", (c) => c.JellyseerrEnabled && c.JellyseerrShowSearchResults !== false]
  ];
  var lazyGroupOf = (value) => typeof value === "function" && "jeLazyGroup" in value && typeof value.jeLazyGroup === "string" ? value.jeLazyGroup : void 0;
  function readExport(JE, path) {
    const parts = path.split(".");
    const name = parts.pop() ?? "";
    let owner = JE;
    for (const part of parts) owner = isRecord(owner) || typeof owner === "function" ? Reflect.get(owner, part) : void 0;
    return { owner, value: isRecord(owner) || typeof owner === "function" ? Reflect.get(owner, name) : void 0 };
  }
  function groupHasEnabledFeature(JE, id) {
    const config = JE.pluginConfig || {};
    const settings = JE.currentSettings || {};
    return FEATURE_INITIALIZERS.some(([group, , condition]) => group === id && (!condition || !!condition(config, settings)));
  }
  function initializeGroupFeatures(JE, ids, known) {
    const config = JE.pluginConfig || {};
    const settings = JE.currentSettings || {};
    for (const [group, path, condition] of FEATURE_INITIALIZERS) {
      if (!ids.includes(known(group) ? group : "core")) continue;
      if (condition && !condition(config, settings)) continue;
      const { owner, value } = readExport(JE, path);
      if (typeof value === "function" && !lazyGroupOf(value)) Reflect.apply(value, owner, []);
    }
  }

  // client/src/bootstrap/loader/component-loader.ts
  var COMPONENT_SCRIPTS_BASE_PATH = "/JellyfinEnhanced/js";
  var BUNDLE_RUN_BUDGET_MS = 10;
  var BUNDLE_IDLE_TIMEOUT_MS = 100;
  function filterComponentManifest(manifest) {
    if (!Array.isArray(manifest)) return null;
    const scripts = manifest.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith("//"));
    return scripts.length ? scripts : null;
  }
  var MANIFEST_ATTEMPTS = 2;
  var MANIFEST_RETRY_DELAY_MS = 1e3;
  async function getComponentScriptList(fromBootstrap) {
    const fromPayload = filterComponentManifest(fromBootstrap);
    if (fromPayload) return fromPayload;
    let lastError;
    for (let attempt = 1; attempt <= MANIFEST_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, MANIFEST_RETRY_DELAY_MS));
      try {
        const api = client();
        const manifest = await api.ajax({
          type: "GET",
          url: api.getUrl(`${COMPONENT_SCRIPTS_BASE_PATH}/component-scripts.json?v=${getScriptVersion()}`),
          dataType: "json"
        });
        const scripts = filterComponentManifest(manifest);
        if (scripts) return scripts;
        lastError = new Error("Manifest is empty or malformed");
      } catch (error) {
        lastError = error;
      }
      if (attempt < MANIFEST_ATTEMPTS) console.warn("🪼 Jellyfin Enhanced: Could not load the component-script manifest; retrying.", lastError);
    }
    const status = typeof lastError === "object" && lastError !== null && "status" in lastError ? lastError.status : void 0;
    const reason = lastError instanceof Error ? lastError.message : typeof status === "number" ? `HTTP ${status}` : String(lastError);
    throw new Error(`Could not load the component-script manifest: ${reason}`);
  }
  function yieldToEventLoop() {
    return new Promise((resolve) => {
      if (typeof MessageChannel === "function") {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      } else {
        setTimeout(resolve, 0);
      }
    });
  }
  function waitForIdle(timeoutMs) {
    if (typeof requestIdleCallback === "function") {
      return new Promise((resolve) => {
        requestIdleCallback(resolve, { timeout: timeoutMs });
      });
    }
    return yieldToEventLoop().then(() => null);
  }
  async function runBundleModules(steps, idle) {
    const nextSlice = () => idle ? waitForIdle(BUNDLE_IDLE_TIMEOUT_MS) : yieldToEventLoop().then(() => null);
    let deadline = await nextSlice();
    let sliceStart = performance.now();
    for (const [index, step] of steps.entries()) {
      try {
        step.run();
      } catch (error) {
        console.error(`🪼 Jellyfin Enhanced: Module '${step.name || `#${index + 1}`}' threw while loading; continuing with the next module.`, error);
        setTimeout(() => {
          throw error;
        }, 0);
      }
      if (!step.loaderStep) countBundleModule();
      if (index + 1 >= steps.length) break;
      const budgetSpent = performance.now() - sliceStart >= BUNDLE_RUN_BUDGET_MS;
      const idleOver = !!deadline && !deadline.didTimeout && deadline.timeRemaining() < 1;
      if (budgetSpent || idleOver) {
        deadline = await nextSlice();
        sliceStart = performance.now();
      }
    }
  }

  // client/src/bootstrap/loader/group-loader.ts
  var CORE_GROUP = "core";
  var GROUP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
  var GROUP_RETRY_DELAY_MS = 5e3;
  var GROUP_RETRY_MAX_DELAY_MS = 6e4;
  function resolveComponentGroups(scripts, rawGroups) {
    if (!Array.isArray(rawGroups)) return null;
    const position = new Map(scripts.map((path, index) => [path, index]));
    const owner = /* @__PURE__ */ new Set();
    const order = [CORE_GROUP];
    const byId = /* @__PURE__ */ Object.create(null);
    byId[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts: [] };
    for (const entry of rawGroups) {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
      if (!isRecord(entry) || !GROUP_ID_PATTERN.test(id) || byId[id]) return null;
      const after = [];
      if (entry.after !== void 0) {
        if (!Array.isArray(entry.after)) return null;
        for (const name of entry.after) {
          if (typeof name !== "string" || name === id || !byId[name]) return null;
          if (name !== CORE_GROUP && !after.includes(name)) after.push(name);
        }
      }
      if (!Array.isArray(entry.modules) || entry.modules.length === 0) return null;
      const own = [];
      for (const module of entry.modules) {
        const path = typeof module === "string" ? module.trim() : "";
        if (!position.has(path) || owner.has(path)) return null;
        owner.add(path);
        own.push(path);
      }
      own.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
      byId[id] = { id, after, scripts: own };
      order.push(id);
    }
    byId[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts: scripts.filter((path) => !owner.has(path)) };
    return { order, byId, whole: false };
  }
  var isModuleList = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "function");
  function createGroupLoader(hooks) {
    let groups = null;
    let manifestError = null;
    const states = /* @__PURE__ */ Object.create(null);
    let queue = Promise.resolve();
    const retryAfter = /* @__PURE__ */ Object.create(null);
    const retryCount = /* @__PURE__ */ Object.create(null);
    async function setGroups(bootstrap) {
      let scripts = [];
      try {
        scripts = await getComponentScriptList(bootstrap ? bootstrap.ComponentScripts : null);
      } catch (error) {
        if (isDevMode()) throw error;
        manifestError = error;
      }
      let rawGroups = bootstrap ? bootstrap.ComponentGroups : null;
      if (!Array.isArray(rawGroups) && !bootstrap && scripts.length) {
        try {
          const api = client();
          const file = await api.ajax({
            type: "GET",
            url: api.getUrl(`${COMPONENT_SCRIPTS_BASE_PATH}/component-groups.json?v=${getScriptVersion()}`),
            dataType: "json"
          });
          rawGroups = isRecord(file) ? file.groups : null;
        } catch (error) {
          console.warn("🪼 Jellyfin Enhanced: Could not load the component-group file — loading every component script.", error);
        }
      }
      const resolved = scripts.length ? resolveComponentGroups(scripts, rawGroups) : null;
      if (!resolved && Array.isArray(rawGroups)) {
        console.warn("🪼 Jellyfin Enhanced: The component-group file is not usable — loading every component script.");
      }
      const whole = /* @__PURE__ */ Object.create(null);
      whole[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts };
      groups = resolved ?? { order: [CORE_GROUP], byId: whole, whole: true };
    }
    function withRequired(ids) {
      const current = groups;
      if (!current) return [];
      const wanted = /* @__PURE__ */ new Set([CORE_GROUP]);
      const add = (id) => {
        const group = current.byId[id];
        if (!group || wanted.has(id)) return;
        wanted.add(id);
        group.after.forEach(add);
        hooks.companions(id).forEach(add);
      };
      ids.forEach(add);
      return current.order.filter((id) => wanted.has(id));
    }
    async function requestBundle(current, ids, idle) {
      if (isDevMode()) return null;
      if (idle) await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
      const version = getScriptVersion();
      const url = client().getUrl(current.whole ? `/JellyfinEnhanced/bundle.js?v=${version}` : `/JellyfinEnhanced/bundle.js?g=${ids.join(",")}&v=${version}`);
      if (current.whole) resetBundleGlobals();
      const requestOk = await scriptLoaded(url, (script) => {
        if (idle) script.setAttribute("fetchpriority", "low");
      });
      const bundles = current.whole ? { [CORE_GROUP]: takeBundle() } : takeGroupBundles(ids);
      return requestOk ? bundles : null;
    }
    const isComplete = (current, group, bundle) => !!bundle && isModuleList(bundle.modules) && bundle.modules.length === bundle.total && (current.whole || bundle.total === group.scripts.length);
    function filesOf(current, group) {
      if (current.whole && !group.scripts.length) {
        throw manifestError ?? new Error("Could not load the component-script manifest: it is empty");
      }
      return group.scripts;
    }
    async function runBatch(current, ids, pending, idle) {
      const bundles = await pending;
      const defined = (id) => {
        const group = current.byId[id];
        const bundle = bundles?.[id];
        return group && isComplete(current, group, bundle) ? bundle.modules : null;
      };
      if (!isDevMode() && !ids.every((id) => defined(id))) {
        console.warn(bundles ? "🪼 Jellyfin Enhanced: Component bundle did not define its modules (syntax error?) — loading the component scripts individually." : "🪼 Jellyfin Enhanced: Component bundle request failed — loading the component scripts individually.");
      }
      let files = [];
      let fileGroups = [];
      const flushFiles = async () => {
        if (!fileGroups.length) return;
        const loading = fileGroups;
        const names = files;
        files = [];
        fileGroups = [];
        const results = await loadScripts(names, COMPONENT_SCRIPTS_BASE_PATH);
        const anyLoaded = results.some(Boolean);
        for (const id of loading) {
          if (anyLoaded || id === CORE_GROUP) {
            states[id] = "ready";
          } else {
            delete states[id];
            const failures = retryCount[id] = (retryCount[id] ?? 0) + 1;
            retryAfter[id] = Date.now() + Math.min(GROUP_RETRY_MAX_DELAY_MS, GROUP_RETRY_DELAY_MS * 2 ** (failures - 1));
          }
        }
      };
      let steps = [];
      let bundleGroups = [];
      const flushBundles = async () => {
        if (!bundleGroups.length) return;
        const running = bundleGroups;
        const list = steps;
        steps = [];
        bundleGroups = [];
        await runBundleModules(list, idle);
        for (const id of running) states[id] = "ready";
      };
      for (const id of ids) {
        const group = current.byId[id];
        if (!group) continue;
        const needsTabs = id === CORE_GROUP && !current.whole;
        const modules = defined(id);
        if (modules) {
          await flushFiles();
          modules.forEach((run, index) => steps.push({ run, name: group.scripts[index] ?? "" }));
          bundleGroups.push(id);
          if (needsTabs) steps.push({ run: hooks.afterCore, name: "plugin.js (Home tab registration)", loaderStep: true });
        } else {
          await flushBundles();
          files = files.concat(filesOf(current, group));
          fileGroups.push(id);
          if (needsTabs) {
            await flushFiles();
            if (states[CORE_GROUP] === "ready") hooks.afterCore();
          }
        }
      }
      await flushBundles();
      await flushFiles();
    }
    function ensure(ids, options = {}) {
      const current = groups;
      if (!current) return Promise.resolve();
      const missing = withRequired(ids).filter((id) => !states[id]);
      if (!missing.length) return queue;
      for (const id of missing) states[id] = "loading";
      const pending = requestBundle(current, missing, options.pace === "boot").catch(() => null);
      const batch = queue.then(() => runBatch(current, missing, pending, options.pace === "boot" || options.pace === "background")).then(() => {
        if (options.boot) return;
        const loaded = missing.filter((id) => states[id] === "ready");
        for (const id of loaded) {
          delete retryAfter[id];
          delete retryCount[id];
        }
        if (loaded.length < missing.length) hooks.failed();
        if (loaded.length) hooks.loaded(loaded);
      });
      queue = batch.catch((error) => {
        if (!options.boot) console.error("🪼 Jellyfin Enhanced: Failed to load component groups", missing, error);
        for (const id of missing) if (states[id] === "loading") states[id] = "ready";
      });
      return options.boot ? batch : queue;
    }
    return {
      setGroups,
      ensure,
      groups: () => groups,
      state: (id) => states[id],
      states: () => ({ ...states }),
      ready: () => Object.keys(states).filter((id) => states[id] === "ready"),
      /** When a group whose last load failed entirely may be asked for again on a page change (0: at once). */
      retryAt: (id) => retryAfter[id] ?? 0,
      settled: () => queue
    };
  }

  // client/src/bootstrap/loader/group-rules.ts
  function currentRoute() {
    const hash = String(window.location.hash || "").replace(/^#!?\/?/, "");
    const at = hash.search(/[?#]/);
    const path = (at < 0 ? hash : hash.slice(0, at)).toLowerCase().replace(/\.html$/, "").replace(/\/+$/, "");
    return { path, query: at < 0 ? "" : hash.slice(at + 1) };
  }
  function safeDecode(text) {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }
  var FEATURE_PAGES = [
    { group: "hidden-content-page", flag: "HiddenContentEnabled", delivery: "HiddenContent", tab: ["hidden-content", "hidden_content_manage_title", "Hidden Content", "remove_red_eye"], marker: "jellyfinenhanced hidden-content", routes: ["hidden-content"], pluginPage: "hiddencontentpage" },
    { group: "catchup", flag: "CatchUpEnabled", delivery: "CatchUp", tab: ["catchup", "catchup_title", "Catch Up", "style"], marker: "jellyfinenhanced catchup", pluginPage: "catchuppage" },
    { group: "recommendations", flag: "RecommendationsPageEnabled", delivery: "Recommendations", tab: ["recommendations", "recommendations_title", void 0, "auto_awesome"], marker: "jellyfinenhanced recommendations", routes: ["recommendations"], pluginPage: "recommendationspage" },
    { group: "requests-page", flag: "DownloadsPageEnabled", delivery: "Downloads", tab: ["requests", "requests_requests", "Requests", "download"], marker: "jellyfinenhanced requests", routes: ["downloads"], pluginPage: "downloadspage" },
    { group: "calendar-page", flag: "CalendarPageEnabled", delivery: "Calendar", tab: ["calendar", "calendar_title", "Calendar", "calendar_month"], marker: "jellyfinenhanced calendar", routes: ["calendar"], pluginPage: "calendarpage" },
    { group: "activity-page", flag: "ActivityFeedEnabled", delivery: "ActivityFeed", tab: ["activity", "activity_title", "Activity", "history"], marker: "jellyfinenhanced activity", pluginPage: "activitypage" },
    // The Leaving Soon page ships in the item menu's output in this tree (js/tags/tag-item-menu.js), which is in the
    // tags group: upstream's leavingsoon-page group has no module here.
    { group: "tags", flag: "LeavingSoonPageEnabled", delivery: "LeavingSoonPage", tab: ["leavingsoon", "leavingsoon_title", "Leaving Soon", "auto_delete"], marker: "jellyfinenhanced leavingsoon", pluginPage: "leavingsoonpage" },
    // Last: the Bookmarks library registers its tab from a timer once its data is ready, after the others.
    { group: "bookmarks-library", flag: "BookmarksEnabled", delivery: "Bookmarks", tab: ["bookmarks", null, "Bookmarks", "location_on"], marker: "sections bookmarks", routes: ["bookmarks"], pluginPage: "bookmarkspage" }
  ];
  var markerSelector = (page) => `.${page.marker.split(" ").join(".")}`;
  var POSTER_TAG_SETTINGS = [
    "qualityTagsEnabled",
    "genreTagsEnabled",
    "ratingTagsEnabled",
    "ageRatingTagsEnabled",
    "statusTagsEnabled",
    "awardsTagsEnabled",
    "customTagsEnabled",
    "languageTagsEnabled",
    "logoTagsEnabled"
  ];
  var isHomeRoute = (route) => route.path === "" || route.path === "home";
  var isDetailsRoute = (route) => route.path === "details";
  var isVideoRoute = (route) => route.path === "video";
  var isDashboardRoute = (route) => /^(dashboard|configurationpage|settings)(\/|$)/.test(route.path);
  var isOwnConfigPage = (route) => route.path === "configurationpage" && /jellyfin[\s+_.-]*enhanced/i.test(safeDecode(route.query));
  var isSeerrRoute = (route) => isDetailsRoute(route) || route.path === "list" || route.path === "search";
  function createGroupRules(JE) {
    const config = () => JE.pluginConfig || {};
    let videoSeen = false;
    function userSetting(key) {
      const current = JE.currentSettings;
      if (current && Object.prototype.hasOwnProperty.call(current, key)) return current[key] === true;
      const saved = JE.userConfig?.settings ? JE.userConfig.settings[key] : void 0;
      if (typeof saved === "boolean") return saved;
      const settings = config();
      const fallback = settings[key] !== null && settings[key] !== void 0 ? settings[key] : settings[key.charAt(0).toUpperCase() + key.slice(1)];
      return fallback === true;
    }
    const posterTagsOn = () => POSTER_TAG_SETTINGS.some(userSetting);
    const playerWanted = (route) => videoSeen || isVideoRoute(route);
    const isTabbedPage = (page) => !!(config()[`${page.delivery}UseNativeTab`] || config()[`${page.delivery}UseCustomTabs`]);
    function pageNeeded(page, route) {
      if (!config()[page.flag]) return false;
      if (page.routes && !isTabbedPage(page)) return true;
      if (page.routes?.includes(route.path)) return true;
      if (route.path.startsWith("userpluginsettings")) {
        const address = safeDecode(route.query).toLowerCase();
        return address.includes("jellyfinenhanced/") ? address.includes(`jellyfinenhanced/${page.pluginPage}`) : true;
      }
      if (isHomeRoute(route)) {
        const query = safeDecode(route.query);
        if (new RegExp(`(^|[?&#])jeTab=${page.tab[0]}(&|#|$)`).test(query)) return true;
        if (page.group === "recommendations" && /(^|[?&#])jeCategory=/.test(query)) return true;
      }
      const isActive = JE.helpers?.isActiveTabContainer;
      return typeof isActive === "function" && Array.from(document.querySelectorAll(markerSelector(page))).some((element) => isActive(element));
    }
    const pageRule = (group) => (route) => FEATURE_PAGES.some((page) => page.group === group && pageNeeded(page, route));
    const onDetails = (group) => (route) => isDetailsRoute(route) && groupHasEnabledFeature(JE, group);
    const removalOffered = () => config().MaintainerrActionsAvailable === true || config().RemovalRequestsAvailable === true;
    const FEATURE_GROUPS = {
      // Poster tags are on every card surface, so they load at boot, but only when the user has a tag type
      // on. The settings panel is "after" every tag group, so switching a type on there finds its code
      // loaded. This tree's js/tags/tag-item-menu.js (in this group) also carries upstream's removal-menu
      // module (Maintainerr / removal-request rows, whose item-menu hook has to see the first menu that opens,
      // so with removal rows it loads at boot) and its leavingsoon-page modules (the Leaving Soon page and
      // tab): the group loads wherever upstream loads any of the three.
      "tags": { needed: (route) => posterTagsOn() || removalOffered() || pageRule("tags")(route) },
      "tag-direct-play": { needed: () => posterTagsOn() && userSetting("statusTagsEnabled") && userSetting("statusTagsDirectPlay") },
      "tag-poster-colours": { needed: () => posterTagsOn() && !!config().TagStyleWebActive },
      // Asked for by tags/statustags.js when the first status tag is drawn (JE.loader.ensure), never at boot.
      "tag-status-backdrop": { needed: () => false },
      "tag-people": { needed: (route) => isDetailsRoute(route) && userSetting("peopleTagsEnabled") },
      // Both act before content paints, so they are never deferred.
      "spoiler-guard": { needed: () => !!config().SpoilerBlurEnabled },
      "hidden-content": { needed: () => !!config().HiddenContentEnabled },
      "details": { needed: isDetailsRoute },
      "player": {
        needed: playerWanted,
        // The player shortcuts (enhanced/events.js): one pressed while the group is still arriving is
        // carried out when it has.
        exports: [
          "cycleAspect",
          "togglePlaybackInfo",
          "cycleSubtitleTrack",
          "cycleAudioTrack",
          "resetPlaybackSpeed",
          "adjustPlaybackSpeed",
          "skipIntroOutro",
          "frameStep",
          "adjustSubtitleOffset",
          "jumpToLastPosition",
          "jumpToPercentage",
          "toggleSubtitleSync"
        ]
      },
      // Listens for the first "playing" event, which can come before the video page.
      "player-badge": { needed: () => !!config().ShowPlaybackRatingBadge },
      "bookmarks": { needed: (route) => !!config().BookmarksEnabled && playerWanted(route) },
      "bookmarks-library": { needed: pageRule("bookmarks-library") },
      "hidden-content-page": { needed: pageRule("hidden-content-page") },
      "catchup": { needed: pageRule("catchup") },
      "settings": {
        // The admin page's Media Tags tab draws with the panel's preview and editors.
        needed: isOwnConfigPage,
        // The panel's "Manage hidden content" asks the page, synchronously, whether it can show itself.
        with: () => config().HiddenContentEnabled ? ["hidden-content-page"] : [],
        exports: ["showEnhancedPanel"]
      },
      "elsewhere": { needed: onDetails("elsewhere") },
      "reviews": { needed: onDetails("reviews") },
      "awards": { needed: onDetails("awards") },
      "mdblist": { needed: onDetails("mdblist") },
      "content-warnings": { needed: onDetails("content-warnings") },
      "letterboxd": { needed: onDetails("letterboxd") },
      "arr-tag-links": { needed: onDetails("arr-tag-links") },
      // Administrators only (its start-up checks), and it reports a broken Sonarr/Radarr setup as it
      // starts, so it keeps starting at boot.
      "arr-links": { needed: () => !!config().ArrLinksEnabled && userSetting("isAdmin") },
      "seerr-api": { needed: () => !!config().JellyseerrEnabled },
      "seerr": {
        needed: (route) => !!config().JellyseerrEnabled && isSeerrRoute(route),
        // Opened from outside its own pages: Home Screen Sections' discover cards and Hidden Content
        // lists (More Info), the Requests page (issues).
        exports: ["jellyseerrMoreInfo.open", "jellyseerrIssueReporter.showReportModal"]
      },
      "recommendations": { needed: pageRule("recommendations") },
      "requests-page": { needed: pageRule("requests-page") },
      "calendar-page": { needed: pageRule("calendar-page") },
      "activity-page": { needed: pageRule("activity-page") },
      // No flag: plugin revision lists always start, and the configuration page's "Test custom links"
      // uses the plugin-icons module either way.
      "dashboard": { needed: isDashboardRoute },
      "theme-selector": { needed: () => !!config().ThemeSelectorEnabled },
      "active-streams": { needed: () => !!config().ActiveStreamsEnabled }
    };
    return {
      FEATURE_GROUPS,
      isTabbedPage,
      /** The groups a group's rule asks to load along with it. */
      companions(id) {
        try {
          return FEATURE_GROUPS[id]?.with?.() ?? [];
        } catch {
          return [];
        }
      },
      /** Which of the given groups (in order) the current page, config and user need right now. */
      needed(order) {
        const route = currentRoute();
        return order.filter((id) => {
          if (id === "core") return true;
          const rule = FEATURE_GROUPS[id];
          if (!rule) return true;
          try {
            return !!rule.needed?.(route);
          } catch (error) {
            console.error(`🪼 Jellyfin Enhanced: Could not decide whether component group '${id}' is needed; loading it.`, error);
            return true;
          }
        });
      },
      /** A <video> has started loading or playing. */
      sawVideo() {
        videoSeen = true;
      }
    };
  }

  // client/src/bootstrap/loader/group-triggers.ts
  var VIDEO_EVENTS = ["loadstart", "play", "playing"];
  function createComponentGroups(JE) {
    const rules = createGroupRules(JE);
    const startedWith = /* @__PURE__ */ new WeakMap();
    let retryTimer = 0;
    const loader = createGroupLoader({
      companions: (id) => rules.companions(id),
      afterCore: registerPageTabs,
      loaded(ids) {
        startFeatures(ids);
        nudgeObservers();
      },
      failed: scheduleRetry
    });
    const isGroup = (id) => !!loader.groups()?.byId[id];
    const neededGroups = () => rules.needed(loader.groups()?.order ?? []);
    function startFeatures(ids) {
      const settings = JE.currentSettings;
      if (settings) {
        const started = startedWith.get(settings) ?? /* @__PURE__ */ new Set();
        for (const id of ids) started.add(id);
        startedWith.set(settings, started);
      }
      initializeGroupFeatures(JE, ids, isGroup);
    }
    function registerPageTabs() {
      const config = JE.pluginConfig || {};
      if (typeof JE.nativeTabs?.register !== "function") return;
      for (const page of FEATURE_PAGES) {
        if (!config[page.flag] || !config[`${page.delivery}UseNativeTab`]) continue;
        const [id, titleKey, fallbackTitle, icon] = page.tab;
        const title = titleKey ? JE.t(titleKey) || fallbackTitle : fallbackTitle;
        JE.nativeTabs.register(id, title ?? "", (panel) => {
          const marker = document.createElement("div");
          marker.className = page.marker;
          panel.appendChild(marker);
        }, icon);
      }
    }
    function nudgeObservers() {
      if (!document.body) return;
      const marker = document.createElement("span");
      marker.hidden = true;
      document.body.appendChild(marker);
      marker.remove();
    }
    function loadNeeded() {
      const now = Date.now();
      const due = neededGroups().filter((id) => loader.state(id) || loader.retryAt(id) <= now);
      const loading = loader.ensure(due, { pace: "background" });
      scheduleRetry();
      return loading;
    }
    function scheduleRetry() {
      if (retryTimer) return;
      const now = Date.now();
      const waiting = neededGroups().filter((id) => !loader.state(id) && loader.retryAt(id) > now).map((id) => loader.retryAt(id));
      if (!waiting.length) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        void loadNeeded();
      }, Math.max(0, Math.min(...waiting) - Date.now()) + 50);
    }
    function installLazyExports() {
      for (const [id, rule] of Object.entries(rules.FEATURE_GROUPS)) {
        if (!rule.exports || !isGroup(id) || loader.state(id)) continue;
        for (const path of rule.exports) {
          const parts = path.split(".");
          const name = parts.pop() ?? "";
          let owner = JE;
          for (const part of parts) {
            let next = Reflect.get(owner, part);
            if (next === void 0 || next === null) Reflect.set(owner, part, next = {});
            if (!isRecord(next) && typeof next !== "function") break;
            owner = next;
          }
          if (Reflect.get(owner, name) !== void 0) continue;
          const standIn = Object.assign(function(...args) {
            return loader.ensure([id]).then(() => {
              const real = readExport(JE, path);
              if (typeof real.value === "function" && real.value !== standIn) return Reflect.apply(real.value, real.owner, args);
              console.error(`🪼 Jellyfin Enhanced: '${path}' is not available (component group '${id}' did not load).`);
              return void 0;
            });
          }, { jeLazyGroup: id });
          Reflect.set(owner, name, standIn);
        }
      }
    }
    function watchTriggers() {
      const onNavigate = JE.core.navigation?.onNavigate;
      if (typeof onNavigate === "function") onNavigate(() => {
        void loadNeeded();
      });
      else window.addEventListener("hashchange", () => {
        void loadNeeded();
      });
      const config = JE.pluginConfig || {};
      const tabbed = FEATURE_PAGES.filter((page) => isGroup(page.group) && config[page.flag] && rules.isTabbedPage(page));
      if (tabbed.length && typeof JE.helpers?.observeTabContainers === "function") {
        const watcher = JE.helpers.observeTabContainers("je-component-groups", tabbed.map(markerSelector).join(", "), () => {
          if (tabbed.every((page) => loader.state(page.group))) watcher?.teardown();
          else void loadNeeded();
        });
      }
      if (isGroup("player") && !loader.state("player")) {
        const onVideo = (event) => {
          if (!(event.target instanceof Node) || event.target.nodeName !== "VIDEO") return;
          rules.sawVideo();
          for (const type of VIDEO_EVENTS) document.removeEventListener(type, onVideo, true);
          void loadNeeded();
        };
        for (const type of VIDEO_EVENTS) document.addEventListener(type, onVideo, true);
      }
      return loadNeeded();
    }
    const api = {
      ensure: (ids, options) => loader.ensure(typeof ids === "string" ? [ids] : ids, options?.pace ? { pace: options.pace } : {}),
      state: () => loader.states(),
      needed: () => neededGroups(),
      settled: () => loader.settled(),
      catalog: () => ({
        groups: Object.entries(rules.FEATURE_GROUPS).map(([id, rule]) => ({ id, exports: [...rule.exports ?? []] })),
        initializers: FEATURE_INITIALIZERS.map(([group, path]) => ({ group, path })),
        pages: FEATURE_PAGES.map((page) => ({ group: page.group, flag: page.flag, delivery: page.delivery, tab: [...page.tab], marker: page.marker }))
      })
    };
    JE.loader = api;
    return {
      setGroups: loader.setGroups,
      /** Stage 3: the groups this page needs, as one request made and run in idle time. Rejects when nothing can be loaded. */
      loadBootGroups: () => loader.ensure(neededGroups(), { pace: "boot", boot: true }),
      /** Stage 6 for every group loaded so far; groups loaded later run their own entries right after their modules. */
      startLoadedFeatures: () => {
        startFeatures(loader.ready());
      },
      installLazyExports,
      watchTriggers,
      loadNeeded,
      /** Whether a group's stage 6 last ran with exactly these settings (it has only just started for this user). */
      startedWith: (id, settings) => !!settings && isGroup(id) && id !== CORE_GROUP && !!startedWith.get(settings)?.has(id)
    };
  }

  // client/src/bootstrap/loader/session-integration.ts
  async function loadTranslations(JE) {
    if (typeof JE.loadTranslations === "function") return JE.loadTranslations();
    console.warn("🪼 Jellyfin Enhanced: Translations module not loaded, falling back to empty translations");
    return {};
  }
  async function rebootstrapUser(JE, config, groups, userId, epoch, detail) {
    const session = JE.session;
    if (!session?.isCurrent(epoch)) return;
    try {
      if (!await config.reloadUserScopedData(userId, () => session.isCurrent(epoch))) return;
      JE.currentSettings = JE.loadSettings();
      JE.initializeShortcuts();
      seedDisplayLanguage(JE, userId);
      await groups.loadNeeded();
      if (!session.isCurrent(epoch)) return;
      if (!groups.startedWith("tags", JE.currentSettings)) reinitializeUserTags(JE);
      try {
        const translations = await loadTranslations(JE);
        if (!session.isCurrent(epoch)) return;
        if (translations) JE.translations = translations;
      } catch {
      }
      document.dispatchEvent(new CustomEvent("je:user-data-loaded", { detail }));
      console.log("🪼 Jellyfin Enhanced: Reloaded user-scoped data after user switch.");
    } catch (error) {
      console.error("🪼 Jellyfin Enhanced: Failed to reload user data after user switch:", error);
    }
  }
  function registerSessionIntegration(JE, config, groups) {
    if (!JE.session) {
      console.error("🪼 Jellyfin Enhanced: session.js missing — user-switch handling disabled.");
      return;
    }
    JE.session.onUserChange("plugin-globals", config.resetUserScopedGlobals);
    document.addEventListener("je:user-changed", (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (!isRecord(detail)) return;
      const { userId, epoch } = detail;
      if (typeof userId !== "string" || !userId || typeof epoch !== "number") return;
      setTimeout(() => {
        void rebootstrapUser(JE, config, groups, userId, epoch, detail);
      }, 0);
    });
  }

  // client/src/bootstrap/loader/boot.ts
  var INIT_POLL_INTERVAL_MS = 50;
  var MAX_MISMATCH_RETRIES = 600;
  var CONFIG_RETRY_MS = 1e3;
  var CONFIG_RETRY_MAX_MS = 6e4;
  function hasServerIdMismatch() {
    try {
      const api = optionalClient();
      if (!api) return false;
      const credentials = localStorage.getItem("jellyfin_credentials");
      if (!credentials) return false;
      const parsed = JSON.parse(credentials);
      const servers = isRecord(parsed) ? parsed.Servers : null;
      if (!Array.isArray(servers) || servers.length === 0) return false;
      const currentServerId = api._serverInfo?.Id || (typeof api.serverId === "function" ? api.serverId() : api.serverId);
      if (!currentServerId) return false;
      return !servers.some((server) => isRecord(server) && (server.Id === currentServerId || server.ServerId === currentServerId));
    } catch {
      return false;
    }
  }
  async function loadTranslationsModule(JE) {
    if (typeof JE.loadTranslations === "function") return;
    await new Promise((resolve) => {
      appendScript(client().getUrl(`/JellyfinEnhanced/js/enhanced/translations.js?v=${getScriptVersion()}`), void 0, resolve, (error) => {
        console.error("🪼 Jellyfin Enhanced: Failed to load translations module", error);
        resolve();
      });
    });
  }
  function loadPluginData() {
    const api = client();
    const configPromise = api.ajax({ type: "GET", url: api.getUrl("/JellyfinEnhanced/public-config"), dataType: "json" }).catch((error) => {
      console.error("🪼 Jellyfin Enhanced: Failed to fetch public config", error);
      return null;
    });
    const versionPromise = api.ajax({ type: "GET", url: api.getUrl("/JellyfinEnhanced/version"), dataType: "text" }).catch((error) => {
      console.error("🪼 Jellyfin Enhanced: Failed to fetch version", error);
      return "unknown";
    });
    return Promise.all([configPromise, versionPromise]);
  }
  function injectMetadataIcons(JE, enabled) {
    const existing = document.getElementById("metadataIconsCss");
    if (enabled && !existing) {
      const link = document.createElement("link");
      link.id = "metadataIconsCss";
      link.rel = "stylesheet";
      link.href = JE.cdn.url("icon-metadata", "public-icon.css");
      document.head.appendChild(link);
    } else if (!enabled && existing) {
      existing.remove();
    }
    const flatStyle = document.getElementById("metadataIconsFlatCss");
    if (enabled && !flatStyle) {
      const style = document.createElement("style");
      style.id = "metadataIconsFlatCss";
      style.textContent = `
                .itemExternalLinks > a.letterboxd-link-icon,
                .itemExternalLinks > a.seerr-link,
                .itemExternalLinks > a.arr-link,
                .itemExternalLinks > a.arr-tag-link {
                    background: none !important;
                    padding: 0 !important;
                    border-radius: 0 !important;
                }
                .itemExternalLinks > a.letterboxd-link-icon::before {
                    margin-right: 0 !important;
                }
            `;
      document.head.appendChild(style);
    } else if (!enabled && flatStyle) {
      flatStyle.remove();
    }
  }
  async function applyTranslationCacheClear(JE) {
    const serverClear = Number(JE.pluginConfig.ClearTranslationCacheTimestamp) || 0;
    const localClear = parseInt(localStorage.getItem("JE_translation_clear_ts") || "0", 10);
    if (serverClear <= localClear) return;
    console.log(`🪼 Jellyfin Enhanced: Server-triggered translation cache clear (${new Date(serverClear).toISOString()})`);
    let removedAny = false;
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith("JE_translation_")) continue;
      const timestampKey = key.startsWith("JE_translation_ts_") ? key : `JE_translation_ts_${key.slice("JE_translation_".length)}`;
      if (parseInt(localStorage.getItem(timestampKey) || "0", 10) > serverClear) continue;
      localStorage.removeItem(key);
      removedAny = true;
    }
    localStorage.setItem("JE_translation_clear_ts", serverClear.toString());
    if (removedAny) JE.translations = await loadTranslations(JE) || {};
  }
  function createBootDependencies(JE) {
    const identity = createIdentityScope(document);
    const contracts = createBootstrapClient(JE, identity);
    return { JE, identity, contracts, config: createConfigLoader(JE, contracts, identity), groups: createComponentGroups(JE) };
  }
  async function recoverSessionChangedDuringBoot(dependencies2) {
    const { JE, config } = dependencies2;
    const liveUserId = currentUserId(client());
    console.warn("🪼 Jellyfin Enhanced: User changed during boot — reloading user-scoped data.");
    config.resetUserScopedGlobals();
    if (!liveUserId) return null;
    const recoveryEpoch = JE.session?.getEpoch() ?? 0;
    await config.reloadUserScopedData(liveUserId, () => !JE.session || JE.session.isCurrent(recoveryEpoch));
    return liveUserId;
  }
  function createInitializer(dependencies2) {
    const { JE, identity, contracts, config, groups } = dependencies2;
    let mismatchRetryCount = 0;
    let configRetryCount = 0;
    const retry = () => {
      setTimeout(() => {
        void initialize();
      }, INIT_POLL_INTERVAL_MS);
    };
    async function initialize() {
      if (hasServerIdMismatch()) {
        mismatchRetryCount++;
        if (mismatchRetryCount >= MAX_MISMATCH_RETRIES) {
          console.warn("🪼 Jellyfin Enhanced: Server ID mismatch detected - stopping to allow re-authentication");
          JE.hideSplashScreen?.();
          return;
        }
        retry();
        return;
      }
      const api = optionalClient();
      let userId = api ? currentUserId(api) : null;
      if (!api || !userId) {
        retry();
        return;
      }
      mismatchRetryCount = 0;
      try {
        const bootIdentity = identity.key(api);
        const unchanged = () => bootIdentity === identity.key(client());
        if (!JE.pluginVersion || JE.pluginVersion === "unknown") {
          const version = scriptTagVersion();
          if (version) JE.pluginVersion = version;
        }
        const [bootstrap, translations] = await Promise.all([
          contracts.getBootstrap(userId).catch((error) => {
            console.warn("🪼 Jellyfin Enhanced: Bootstrap request failed, falling back to individual requests.", error);
            return null;
          }),
          loadTranslationsModule(JE).then(() => loadTranslations(JE))
        ]);
        if (!unchanged()) {
          retry();
          return;
        }
        if (bootstrap) {
          JE.pluginConfig = { ...bootstrap.PublicConfig };
          JE.pluginVersion = bootstrap.Version || "unknown";
        } else {
          const [publicConfig, version] = await loadPluginData();
          if (!unchanged()) {
            retry();
            return;
          }
          if (!isRecord(publicConfig)) {
            setTimeout(() => {
              void initialize();
            }, Math.min(CONFIG_RETRY_MAX_MS, CONFIG_RETRY_MS * 2 ** configRetryCount++));
            return;
          }
          JE.pluginConfig = publicConfig;
          JE.pluginVersion = typeof version === "string" && version ? version : "unknown";
        }
        JE.translations = translations || {};
        if (bootstrap) config.applyPrivateConfig(bootstrap.PrivateConfig);
        else await config.loadPrivateConfig();
        if (bootstrap) config.applyDeliveryPluginFlags(bootstrap.HasCustomTabs === true, bootstrap.HasPluginPages === true);
        else await config.loadDeliveryPluginFlags();
        await applyTranslationCacheClear(JE);
        try {
          injectMetadataIcons(JE, !!JE.pluginConfig.MetadataIconsEnabled);
        } catch (error) {
          console.warn("🪼 Jellyfin Enhanced: Failed to inject Metadata icons CSS", error);
        }
        if (!unchanged()) {
          retry();
          return;
        }
        const loadedUserConfig = bootstrap ? buildUserConfigFromBootstrap(bootstrap.UserSettings) : await fetchUserScopedConfig(userId, contracts, identity);
        if (!loadedUserConfig || !unchanged()) {
          retry();
          return;
        }
        JE.userConfig = loadedUserConfig;
        if (typeof JE.initializeSplashScreen === "function") JE.initializeSplashScreen();
        await groups.setGroups(bootstrap);
        await groups.loadBootGroups();
        console.log("🪼 Jellyfin Enhanced: Component scripts loaded.");
        if (JE.pluginConfig?.BookmarksEnabled) aliasNamespace(JE);
        registerSessionIntegration(JE, config, groups);
        if (!unchanged()) userId = await recoverSessionChangedDuringBoot(dependencies2);
        if (typeof JE.loadSettings !== "function" || typeof JE.initializeShortcuts !== "function") {
          console.error("🪼 Jellyfin Enhanced: FATAL - config.js functions not defined after script loading.");
          JE.hideSplashScreen?.();
          return;
        }
        JE.currentSettings = JE.loadSettings();
        JE.initializeShortcuts();
        if (userId) seedDisplayLanguage(JE, userId);
        groups.installLazyExports();
        if (typeof JE.themer?.init === "function") {
          JE.themer.init();
          console.log("🪼 Jellyfin Enhanced: Theme system initialized.");
        }
        window.addEventListener("beforeunload", () => {
          JE._cacheManager.forceSave();
        });
        groups.startLoadedFeatures();
        await groups.watchTriggers();
        console.log("🪼 Jellyfin Enhanced: All components initialized successfully.");
        JE.initialized = true;
        JE.hideSplashScreen?.();
      } catch (error) {
        console.error("🪼 Jellyfin Enhanced: CRITICAL INITIALIZATION FAILURE:", error);
        JE.hideSplashScreen?.();
      }
    }
    return initialize;
  }

  // client/src/bootstrap/loader/maintenance.ts
  var DEFAULT_MESSAGE = "This server is currently undergoing maintenance. Please try again later.";
  function formatMaintenanceCountdown(msRemaining) {
    const totalMinutes = Math.max(0, Math.ceil(msRemaining / 6e4));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
  }
  function formatMaintenanceText(message, endsAt) {
    const text = (message || "").trim() || DEFAULT_MESSAGE;
    if (!endsAt) return text.replace(/\{countdown\}/gi, "").replace(/\{ends_at\}/gi, "").trim();
    const countdown = formatMaintenanceCountdown(endsAt.getTime() - Date.now());
    const endsAtText = endsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const hasToken = /\{countdown\}/i.test(text);
    const out = text.replace(/\{countdown\}/gi, () => countdown).replace(/\{ends_at\}/gi, () => endsAtText).trim();
    return hasToken ? out : `${out} Time remaining: ${countdown}.`;
  }
  var offsetRules = (height) => [
    `body { padding-top: ${height}px !important; }`,
    `.skinHeader { top: ${height}px !important; }`,
    `.mainDrawer { top: ${height}px !important; }`,
    // Jellyfin 12 Modern Layout: MUI app bar and side drawers are fixed at top:0 too.
    `.MuiAppBar-positionFixed { top: ${height}px !important; }`,
    `.MuiDrawer-paperAnchorLeft, .MuiDrawer-paperAnchorRight { top: ${height}px !important; height: calc(100% - ${height}px) !important; }`,
    ".videoOsdBottom { bottom: 0 !important; }"
  ].join("\n");
  function injectMaintenanceBanner(message, endsAtIso) {
    if (document.getElementById("je-maintenance-banner")) return;
    const endsAt = endsAtIso && !isNaN(Date.parse(endsAtIso)) ? new Date(endsAtIso) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) return;
    const banner = document.createElement("div");
    banner.id = "je-maintenance-banner";
    banner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:9990",
      "background:#b71c1c",
      "color:#fff",
      "text-align:center",
      "padding:10px 48px",
      "font-size:14px",
      "font-weight:600",
      "letter-spacing:0.02em",
      "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
      "font-family:inherit"
    ].join(";");
    const label = document.createTextNode(formatMaintenanceText(message, endsAt));
    banner.append(label);
    let appliedHeight = -1;
    const applyOffset = () => {
      const height = banner.isConnected ? banner.offsetHeight : 0;
      if (height === appliedHeight) return;
      appliedHeight = height;
      const existing = document.getElementById("je-maintenance-banner-style");
      if (height <= 0) {
        existing?.remove();
        return;
      }
      const style = existing ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: "je-maintenance-banner-style" }));
      style.textContent = offsetRules(height);
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(applyOffset) : null;
    const remove = () => {
      banner.remove();
      resizeObserver?.disconnect();
      applyOffset();
    };
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    const closeLabel = liveNamespace()?.t?.("awards_close") ?? "";
    closeButton.setAttribute("aria-label", closeLabel && closeLabel !== "awards_close" ? closeLabel : "Close");
    closeButton.style.cssText = "position:absolute;top:50%;right:12px;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px;opacity:0.85";
    closeButton.addEventListener("click", remove);
    document.body.appendChild(banner);
    requestAnimationFrame(applyOffset);
    resizeObserver?.observe(banner);
    banner.appendChild(closeButton);
    if (!endsAt) return;
    const tick = setInterval(() => {
      if (!document.body.contains(banner)) {
        clearInterval(tick);
        return;
      }
      if (endsAt.getTime() <= Date.now()) {
        clearInterval(tick);
        remove();
        return;
      }
      label.nodeValue = formatMaintenanceText(message, endsAt);
    }, 15e3);
  }

  // client/src/bootstrap/loader/early.ts
  var HOST_POLL_MS = 50;
  function registerWholePixelProperties() {
    try {
      if (navigator.vendor !== "Google Inc." || typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return;
      for (const name of ["--je-snap-x", "--je-snap-y", "--je-band-left"]) {
        try {
          CSS.registerProperty({ name, syntax: "*", inherits: false });
        } catch {
        }
      }
    } catch {
    }
  }
  function loadSplashScreenEarly(JE) {
    const api = optionalClient();
    if (!api) {
      setTimeout(() => loadSplashScreenEarly(JE), HOST_POLL_MS);
      return;
    }
    appendScript(
      api.getUrl(`/JellyfinEnhanced/js/others/splashscreen.js?v=${getScriptVersion()}`),
      void 0,
      () => {
        if (typeof JE.initializeSplashScreen === "function") JE.initializeSplashScreen();
      },
      () => console.error("🪼 Jellyfin Enhanced: Failed to load splash screen script.")
    );
  }
  function loadLoginImageEarly(contracts, identity) {
    const api = optionalClient();
    if (!api) {
      setTimeout(() => loadLoginImageEarly(contracts, identity), HOST_POLL_MS);
      return;
    }
    const fetchPublicConfig = () => api.ajax({ type: "GET", url: api.getUrl("/JellyfinEnhanced/public-config"), dataType: "json" });
    const userId = currentUserId(api);
    const earlyIdentity = identity.key(api);
    const configPromise = userId && !hasServerIdMismatch() ? contracts.getBootstrap(userId).then((bootstrap) => bootstrap.PublicConfig).catch(() => fetchPublicConfig()) : fetchPublicConfig();
    configPromise.then((config) => {
      if (earlyIdentity !== identity.key(client()) || !isRecord(config)) return;
      if (config.MaintenanceModeEnabled === true) {
        const message = config.MaintenanceModeMessage;
        const endsAt = config.MaintenanceModeEndsAt;
        injectMaintenanceBanner(typeof message === "string" ? message : "", typeof endsAt === "string" && endsAt ? endsAt : null);
      }
      if (config.EnableLoginImage === true) {
        appendScript(
          client().getUrl(`/JellyfinEnhanced/js/extras/login-image.js?v=${getScriptVersion()}`),
          void 0,
          void 0,
          () => console.error("🪼 Jellyfin Enhanced: Failed to load login image script.")
        );
      }
    }).catch(() => {
      console.warn("🪼 Jellyfin Enhanced: Could not fetch config for login image, skipping.");
    });
  }

  // client/src/bootstrap/loader/entry.ts
  var dependencies = createBootDependencies(createNamespace());
  registerWholePixelProperties();
  loadSplashScreenEarly(dependencies.JE);
  loadLoginImageEarly(dependencies.contracts, dependencies.identity);
  void createInitializer(dependencies)();
})();
})();
//# sourceMappingURL=plugin.js.map
