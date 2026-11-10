(() => {
"use strict";
(() => {
  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }
  function apiClient() {
    const client = optionalApiClient();
    if (!client) throw new ReferenceError("ApiClient is not defined");
    return client;
  }
  function optionalApiClient() {
    const host = window;
    return host.ApiClient;
  }

  // client/src/features/settings-panel/host.ts
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }

  // client/src/features/shared/dom.ts
  function selectById(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLSelectElement ? element : null;
  }

  // client/src/features/settings-panel/language-options.ts
  var text = (record, key) => {
    const value = Reflect.get(record, key);
    return typeof value === "string" ? value : "";
  };
  function decodeCultures(value) {
    if (!Array.isArray(value)) throw new TypeError("Cultures response is not a list");
    return value.filter((entry) => entry !== null && typeof entry === "object").map((entry) => ({
      twoLetter: text(entry, "TwoLetterISOLanguageName"),
      threeLetter: text(entry, "ThreeLetterISOLanguageName"),
      displayName: text(entry, "DisplayName"),
      name: text(entry, "Name")
    }));
  }
  function decodeLocaleCodes(value) {
    if (!Array.isArray(value)) throw new TypeError("Locale response is not a list");
    return value.filter((code) => typeof code === "string");
  }
  var CUSTOM_DISPLAY_NAMES = {
    "pr": "Pirate",
    "en-GB": "English (United Kingdom)",
    "en-US": "English (United States)",
    "zh-CN": "Chinese (Simplified)",
    "zh-HK": "Chinese (Hong Kong)",
    "pt-BR": "Portuguese (Brazil)"
  };
  function displayLanguageOptions(localeCodes, cultures) {
    const cultureMap = /* @__PURE__ */ new Map();
    for (const c of cultures) cultureMap.set(c.twoLetter.toLowerCase(), c);
    const localeSet = new Set(localeCodes.map((c) => c.toLowerCase()));
    const options = localeCodes.map((code) => {
      let displayName = (Object.prototype.hasOwnProperty.call(CUSTOM_DISPLAY_NAMES, code) ? CUSTOM_DISPLAY_NAMES[code] : void 0) || cultureMap.get(code.toLowerCase())?.displayName;
      if (!displayName && code.includes("-")) {
        const [base = "", region = ""] = code.split("-");
        const baseName = cultureMap.get(base.toLowerCase())?.displayName;
        displayName = baseName && localeSet.has(base.toLowerCase()) ? `${baseName} (${region})` : baseName;
      }
      return { code, displayName: displayName || code };
    });
    options.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return options;
  }
  function normalizeSavedLanguage(saved, optionValues) {
    if (!saved) return "";
    const [base = "", region = ""] = saved.split("-");
    const normalized = saved.includes("-") ? `${base.toLowerCase()}-${region.toUpperCase()}` : saved.toLowerCase();
    const exact = optionValues.some((value) => value.toLowerCase() === normalized.toLowerCase());
    return exact ? normalized : normalized.split("-")[0] ?? "";
  }
  function normalizeLangCode(code) {
    if (!code) return code;
    const parts = code.split("-");
    if (parts.length === 1) return (parts[0] ?? "").toLowerCase();
    if (parts.length === 2) return `${(parts[0] ?? "").toLowerCase()}-${(parts[1] ?? "").toUpperCase()}`;
    return code;
  }

  // client/src/features/settings-panel/ui-panel-language.ts
  var CACHE_PREFIX = "JE_translation_";
  var CACHE_TIMESTAMP_PREFIX = "JE_translation_ts_";
  function installUiPanelLanguage(JE) {
    const internal = registry(JE);
    internal.wireLanguageControls = function(ctx) {
      const { resetAutoCloseTimer } = ctx;
      const candidateSelect = selectById("displayLanguageSelect");
      if (candidateSelect) {
        const displayLanguageSelect = candidateSelect;
        const client = apiClient();
        const userId = client.getCurrentUserId();
        const languageKey = `${userId}-language`;
        const origin = JE.userConfig;
        const settings = JE.currentSettings;
        const epoch = JE.session?.getEpoch();
        const serverRoot = client.getUrl("/");
        const token = client.accessToken?.();
        const serverId = () => typeof client.serverId === "function" ? client.serverId() : client.serverId;
        const server = serverId();
        let closed = false;
        let reloadTimer = null;
        const sameDocument = () => apiClient() === client && client.getCurrentUserId() === userId && client.getUrl("/") === serverRoot && client.accessToken?.() === token && serverId() === server && JE.session?.getEpoch() === epoch && JE.userConfig === origin && JE.currentSettings === settings;
        const current = () => !closed && displayLanguageSelect.isConnected && sameDocument();
        const dispose = () => {
          closed = true;
          if (reloadTimer !== null) clearTimeout(reloadTimer);
          displayLanguageSelect.removeEventListener("change", saveLanguage);
        };
        ctx.onClose?.(dispose);
        const localStorageLang = localStorage.getItem(languageKey);
        const fromSettings = settings.displayLanguage;
        const savedLanguage = typeof fromSettings === "string" && fromSettings || localStorageLang || "";
        let userChanged = false;
        let saving = false;
        let localeCodes = [];
        let cultures = [];
        const renderOptions = () => {
          if (!current()) return;
          const selected = userChanged ? displayLanguageSelect.value : savedLanguage;
          Array.from(displayLanguageSelect.options).forEach((option) => {
            if (option.value) option.remove();
          });
          displayLanguageOptions(localeCodes, cultures).forEach(({ code, displayName }) => {
            const option = document.createElement("option");
            option.value = code;
            option.textContent = displayName;
            option.style.background = "rgba(30,30,30,1)";
            option.style.color = "#fff";
            displayLanguageSelect.appendChild(option);
          });
          const normalized = normalizeSavedLanguage(selected, Array.from(displayLanguageSelect.options, (option) => option.value));
          displayLanguageSelect.value = Array.from(displayLanguageSelect.options).find((option) => option.value.toLowerCase() === normalized.toLowerCase())?.value ?? "";
        };
        void client.ajax({ type: "GET", url: client.getUrl("/JellyfinEnhanced/locales"), dataType: "json" }).then((response) => {
          if (current()) {
            localeCodes = decodeLocaleCodes(response);
            renderOptions();
          }
        }).catch((err) => {
          if (current()) console.warn("🪼 Jellyfin Enhanced: Failed to load language options:", err);
        });
        void client.ajax({ type: "GET", url: client.getUrl("/Localization/Cultures"), dataType: "json" }).then((response) => {
          if (current()) {
            cultures = decodeCultures(response);
            renderOptions();
          }
        }).catch(() => void 0);
        async function saveLanguage() {
          if (!current() || saving) return;
          userChanged = true;
          saving = true;
          const newLang = displayLanguageSelect.value;
          const previous = settings.displayLanguage;
          const hadValue = Object.prototype.hasOwnProperty.call(settings, "displayLanguage");
          displayLanguageSelect.disabled = true;
          settings.displayLanguage = newLang;
          const rollback = () => {
            if (!sameDocument() || settings.displayLanguage !== newLang) return;
            if (hadValue) settings.displayLanguage = previous;
            else delete settings.displayLanguage;
            displayLanguageSelect.value = typeof previous === "string" ? previous : "";
          };
          try {
            await JE.saveUserSettings("settings.json", settings, { throwOnError: true, isCurrent: sameDocument, notifyOnError: current, onError: rollback });
            if (!sameDocument()) return;
            localStorage.setItem(languageKey, normalizeLangCode(newLang) || "");
            if (!current()) return;
            JE.toast(JE.t("toast_language_changed"));
            reloadTimer = setTimeout(() => {
              if (current()) window.location.reload();
            }, 1500);
          } catch (_) {
            rollback();
          } finally {
            saving = false;
            if (current()) displayLanguageSelect.disabled = false;
          }
        }
        displayLanguageSelect.addEventListener("change", saveLanguage);
      }
      const clearTranslationCacheButton = document.getElementById("clearTranslationCacheButton");
      if (clearTranslationCacheButton) {
        clearTranslationCacheButton.addEventListener("click", () => {
          const cacheKeys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith(CACHE_PREFIX) || key.startsWith(CACHE_TIMESTAMP_PREFIX))) {
              cacheKeys.push(key);
            }
          }
          cacheKeys.forEach((key) => localStorage.removeItem(key));
          JE.toast(JE.t("toast_translation_cache_cleared", { count: cacheKeys.length }));
          setTimeout(() => window.location.reload(), 2e3);
          resetAutoCloseTimer();
        });
      }
    };
  }
  installUiPanelLanguage(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-language.js.map
