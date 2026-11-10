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
  function resetBundleGlobals() {
    const host = loaderWindow();
    host.__JE_BUNDLE_PROGRESS = -1;
    host.__JE_BUNDLE_MODULES = void 0;
  }
  function takeBundle() {
    const host = loaderWindow();
    const bundle = { modules: host.__JE_BUNDLE_MODULES, total: host.__JE_BUNDLE_TOTAL };
    delete host.__JE_BUNDLE_MODULES;
    return bundle;
  }
  function reportBundleProgress(count) {
    loaderWindow().__JE_BUNDLE_PROGRESS = count;
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
  async function loadScripts(scripts, basePath) {
    await Promise.allSettled(scripts.map((name) => new Promise((resolve) => {
      appendScript(
        client().getUrl(`${basePath}/${name}?v=${getScriptVersion()}`),
        (script) => {
          script.async = false;
        },
        resolve,
        (error) => {
          console.error(`🪼 Jellyfin Enhanced: Failed to load script '${name}'`, error);
          resolve();
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
    throw new Error(`Could not load the component-script manifest: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
  async function runBundleModules(modules, fromBootstrap) {
    const names = filterComponentManifest(fromBootstrap) || [];
    let deadline = await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
    let sliceStart = performance.now();
    for (const [index, module] of modules.entries()) {
      try {
        module();
      } catch (error) {
        console.error(`🪼 Jellyfin Enhanced: Module '${names[index] || `#${index + 1}`}' threw while loading; continuing with the next module.`, error);
        setTimeout(() => {
          throw error;
        }, 0);
      }
      reportBundleProgress(index + 1);
      if (index + 1 >= modules.length) break;
      const budgetSpent = performance.now() - sliceStart >= BUNDLE_RUN_BUDGET_MS;
      const idleOver = !!deadline && !deadline.didTimeout && deadline.timeRemaining() < 1;
      if (budgetSpent || idleOver) {
        deadline = await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
        sliceStart = performance.now();
      }
    }
  }
  var isModuleList = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "function");
  async function loadComponentBundle(fromBootstrap) {
    const url = client().getUrl(`/JellyfinEnhanced/bundle.js?v=${getScriptVersion()}`);
    resetBundleGlobals();
    await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
    const requestOk = await scriptLoaded(url, (script) => {
      script.setAttribute("fetchpriority", "low");
    });
    const { modules, total } = takeBundle();
    if (requestOk && isModuleList(modules) && modules.length === total) {
      await runBundleModules(modules, fromBootstrap);
      return;
    }
    const scripts = await getComponentScriptList(fromBootstrap);
    console.warn(requestOk ? "🪼 Jellyfin Enhanced: Component bundle did not define its modules (syntax error?) — loading the component scripts individually." : "🪼 Jellyfin Enhanced: Component bundle request failed — loading the component scripts individually.");
    await loadScripts(scripts, COMPONENT_SCRIPTS_BASE_PATH);
  }
  async function loadComponentScripts(fromBootstrap) {
    if (isDevMode()) {
      await loadScripts(await getComponentScriptList(fromBootstrap), COMPONENT_SCRIPTS_BASE_PATH);
      return;
    }
    await loadComponentBundle(fromBootstrap);
  }

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
    "CatchUpUseCustomTabs"
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
  function initializeFeatures(JE) {
    const config = () => JE.pluginConfig;
    const settings = () => JE.currentSettings;
    if (typeof JE.initializePluginRevisions === "function") JE.initializePluginRevisions();
    if (typeof JE.initializeEnhancedScript === "function") JE.initializeEnhancedScript();
    if (typeof JE.initializeElsewhereScript === "function" && config().ElsewhereEnabled) JE.initializeElsewhereScript();
    if (typeof JE.initializeJellyseerrScript === "function" && config().JellyseerrEnabled && config().JellyseerrShowSearchResults !== false) JE.initializeJellyseerrScript();
    if (typeof JE.jellyseerrIssueReporter?.initialize === "function" && config().JellyseerrEnabled && config().JellyseerrShowReportButton) JE.jellyseerrIssueReporter.initialize();
    if (typeof JE.initializePauseScreen === "function") JE.initializePauseScreen();
    if (typeof JE.initializeBookmarks === "function") JE.initializeBookmarks();
    if (typeof JE.initializeQualityTags === "function" && settings()?.qualityTagsEnabled) JE.initializeQualityTags();
    if (typeof JE.initializeGenreTags === "function" && settings()?.genreTagsEnabled) JE.initializeGenreTags();
    if (typeof JE.initializeRatingTags === "function" && settings()?.ratingTagsEnabled) JE.initializeRatingTags();
    if (typeof JE.initializeAgeRatingTags === "function" && settings()?.ageRatingTagsEnabled) JE.initializeAgeRatingTags();
    if (typeof JE.initializeStatusTags === "function" && settings()?.statusTagsEnabled) JE.initializeStatusTags();
    if (typeof JE.initializeAwardsTags === "function" && settings()?.awardsTagsEnabled && config().AwardsTagsEnabled !== false) JE.initializeAwardsTags();
    if (typeof JE.initializeCustomTags === "function" && settings()?.customTagsEnabled) JE.initializeCustomTags();
    if (typeof JE.initializeTagStyles === "function" && config().TagStyleWebActive) JE.initializeTagStyles();
    if (typeof JE.initializeUserReviewTags === "function" && config().ShowUserReviews && config().ShowUserRatingOnPosters && settings()?.ratingTagsEnabled) JE.initializeUserReviewTags();
    if (typeof JE.initializeArrLinksScript === "function" && config().ArrLinksEnabled) JE.initializeArrLinksScript();
    if (typeof JE.initializeArrTagLinksScript === "function" && config().ArrTagsShowAsLinks) JE.initializeArrTagLinksScript();
    if (typeof JE.initializeSeerrDetailLinkScript === "function" && config().JellyseerrEnabled && config().JellyseerrShowDetailPageLink) JE.initializeSeerrDetailLinkScript();
    if (typeof JE.initializeLetterboxdLinksScript === "function" && config().LetterboxdEnabled) JE.initializeLetterboxdLinksScript();
    if (typeof JE.initializeReviewsScript === "function" && (config().ShowReviews || config().ShowUserReviews || config().ShowAnilistReviews)) JE.initializeReviewsScript();
    if (typeof JE.initializeAwardsScript === "function" && config().ShowAwards) JE.initializeAwardsScript();
    if (typeof JE.initializeDoesTheDogDieScript === "function" && config().DoesTheDogDieEnabled) JE.initializeDoesTheDogDieScript();
    if (typeof JE.initializeMdblistRatingsScript === "function" && config().MdblistRatingsEnabled && config().MdblistRatingsShowOnItemDetails) JE.initializeMdblistRatingsScript();
    if (typeof JE.initializeLanguageTags === "function" && settings()?.languageTagsEnabled) JE.initializeLanguageTags();
    if (typeof JE.initializeLogoTags === "function" && settings()?.logoTagsEnabled) JE.initializeLogoTags();
    if (typeof JE.initializePeopleTags === "function" && settings()?.peopleTagsEnabled) JE.initializePeopleTags();
    if (typeof JE.tagPipeline?.initialize === "function") JE.tagPipeline.initialize();
    if (typeof JE.initializeOsdRating === "function") JE.initializeOsdRating();
    if (typeof JE.initializePlaybackRatingBadge === "function" && config().ShowPlaybackRatingBadge) JE.initializePlaybackRatingBadge();
    if (typeof JE.initializeHiddenContent === "function" && config().HiddenContentEnabled) JE.initializeHiddenContent();
    if (config().SpoilerBlurEnabled && typeof JE.spoilerBlur?.init === "function") JE.spoilerBlur.init();
    if (config().ColoredRatingsEnabled && typeof JE.initializeColoredRatings === "function") JE.initializeColoredRatings();
    if (config().ThemeSelectorEnabled && typeof JE.initializeThemeSelector === "function") JE.initializeThemeSelector();
    if (config().ColoredActivityIconsEnabled && typeof JE.initializeActivityIcons === "function") JE.initializeActivityIcons();
    if (config().PluginIconsEnabled && typeof JE.initializePluginIcons === "function") JE.initializePluginIcons();
    if (config().ActiveStreamsEnabled && typeof JE.activeStreams?.initialize === "function") JE.activeStreams.initialize();
    if (config().DownloadsPageEnabled && typeof JE.initializeDownloadsPage === "function") JE.initializeDownloadsPage();
    if (config().CalendarPageEnabled && typeof JE.initializeCalendarPage === "function") JE.initializeCalendarPage();
    if (config().HiddenContentEnabled && typeof JE.initializeHiddenContentPage === "function") JE.initializeHiddenContentPage();
  }

  // client/src/bootstrap/loader/session-integration.ts
  async function loadTranslations(JE) {
    if (typeof JE.loadTranslations === "function") return JE.loadTranslations();
    console.warn("🪼 Jellyfin Enhanced: Translations module not loaded, falling back to empty translations");
    return {};
  }
  async function rebootstrapUser(JE, config, userId, epoch, detail) {
    const session = JE.session;
    if (!session?.isCurrent(epoch)) return;
    try {
      if (!await config.reloadUserScopedData(userId, () => session.isCurrent(epoch))) return;
      JE.currentSettings = JE.loadSettings();
      JE.initializeShortcuts();
      seedDisplayLanguage(JE, userId);
      reinitializeUserTags(JE);
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
  function registerSessionIntegration(JE, config) {
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
        void rebootstrapUser(JE, config, userId, epoch, detail);
      }, 0);
    });
  }

  // client/src/bootstrap/loader/boot.ts
  var INIT_POLL_INTERVAL_MS = 50;
  var MAX_MISMATCH_RETRIES = 600;
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
      return {};
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
    return { JE, identity, contracts, config: createConfigLoader(JE, contracts, identity) };
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
    const { JE, identity, contracts, config } = dependencies2;
    let mismatchRetryCount = 0;
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
          JE.pluginConfig = isRecord(publicConfig) ? publicConfig : {};
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
        await loadComponentScripts(bootstrap ? bootstrap.ComponentScripts : null);
        console.log("🪼 Jellyfin Enhanced: All component scripts loaded.");
        registerSessionIntegration(JE, config);
        if (!unchanged()) userId = await recoverSessionChangedDuringBoot(dependencies2);
        if (typeof JE.loadSettings !== "function" || typeof JE.initializeShortcuts !== "function") {
          console.error("🪼 Jellyfin Enhanced: FATAL - config.js functions not defined after script loading.");
          JE.hideSplashScreen?.();
          return;
        }
        JE.currentSettings = JE.loadSettings();
        JE.initializeShortcuts();
        if (userId) seedDisplayLanguage(JE, userId);
        if (typeof JE.themer?.init === "function") {
          JE.themer.init();
          console.log("🪼 Jellyfin Enhanced: Theme system initialized.");
        }
        window.addEventListener("beforeunload", () => {
          JE._cacheManager.forceSave();
        });
        initializeFeatures(JE);
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
  loadSplashScreenEarly(dependencies.JE);
  loadLoginImageEarly(dependencies.contracts, dependencies.identity);
  void createInitializer(dependencies)();
})();
})();
//# sourceMappingURL=plugin.js.map
