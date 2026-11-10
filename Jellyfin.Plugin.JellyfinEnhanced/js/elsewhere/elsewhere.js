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

  // client/generated-shared/stub/client/src/features/details-providers/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/details-providers/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "api");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "lookupDetailsItem");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "sessionLease");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "visibleDetailPage");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "externalLink");
  var export2 = /* @__PURE__ */ sharedExport(shared3, "pathSegment");
  var export32 = /* @__PURE__ */ sharedExport(shared3, "safeHref");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export5 = /* @__PURE__ */ sharedExport(shared4, "field");
  var export6 = /* @__PURE__ */ sharedExport(shared4, "int");
  var export72 = /* @__PURE__ */ sharedExport(shared4, "isRecord");
  var export8 = /* @__PURE__ */ sharedExport(shared4, "list");
  var export112 = /* @__PURE__ */ sharedExport(shared4, "str");
  var export13 = /* @__PURE__ */ sharedExport(shared4, "text");

  // client/src/features/details-providers/elsewhere-domain.ts
  function parseProviderList(raw) {
    return raw ? raw.replace(/'/g, "").replace(/\n/g, ",").split(",").map((s) => s.trim()).filter((s) => s) : [];
  }
  function decodeService(value) {
    if (!export72(value)) return null;
    const service = { provider_name: export112(value.provider_name) ?? "", logo_path: export112(value.logo_path) ?? "" };
    const id = export6(value.provider_id);
    if (id !== void 0) service.provider_id = id;
    return service;
  }
  function decodeRegion(value) {
    const region = {};
    const link = export13(export5(value, "link"));
    if (link !== void 0) region.link = link;
    const flatrate = export5(value, "flatrate");
    if (Array.isArray(flatrate)) region.flatrate = flatrate.map(decodeService).filter((service) => service !== null);
    return region;
  }
  function decodeWatchProviders(value) {
    const results = {};
    const raw = export5(value, "results");
    if (export72(raw)) for (const [code, region] of Object.entries(raw)) results[code] = decodeRegion(region);
    return { results };
  }
  function regionOf(data, region) {
    return data && Object.prototype.hasOwnProperty.call(data.results, region) ? data.results[region] : void 0;
  }
  function applyProviderFilters(services, filters, report) {
    let filtered = services || [];
    if (filters.defaults.length > 0) filtered = filtered.filter((service) => filters.defaults.includes(service.provider_name));
    if (filters.ignore.length > 0) {
      try {
        const patterns = filters.ignore.map((pattern) => new RegExp(pattern, "i"));
        filtered = filtered.filter((service) => !patterns.some((regex) => regex.test(service.provider_name)));
      } catch (error) {
        report(error);
      }
    }
    return filtered;
  }
  function isDefaultSeasonOrder(order) {
    const value = (order || "").toString().trim().toLowerCase();
    return value === "" || value === "aired" || value === "airdate" || value === "default";
  }
  async function mapWithLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        if (item !== void 0) results[index] = await mapper(item);
      }
    });
    await Promise.all(workers);
    return results;
  }
  function seasonLabelParts(seasonNumbers) {
    const numbers = seasonNumbers.filter((n) => n > 0);
    const ranges = [];
    for (let i = 0; i < numbers.length; ) {
      let j = i;
      while (j + 1 < numbers.length && numbers[j + 1] === (numbers[j] ?? NaN) + 1) j++;
      ranges.push(j > i ? `${numbers[i]}–${numbers[j]}` : String(numbers[i]));
      i = j + 1;
    }
    const hasSpecials = seasonNumbers.includes(0);
    return {
      single: ranges.length === 1 && !hasSpecials && numbers.length === 1 ? numbers[0] ?? null : null,
      specialsOnly: ranges.length === 0 && hasSpecials,
      ranges,
      hasSpecials
    };
  }
  function groupSeasonsByProviders(seasons) {
    const byProviders = /* @__PURE__ */ new Map();
    for (const season of seasons) {
      const key = season.services.map((service) => service.provider_id ?? NaN).sort((a, b) => a - b).join(",");
      let group = byProviders.get(key);
      if (!group) byProviders.set(key, group = { services: season.services, numbers: [] });
      group.numbers.push(season.number);
    }
    if (byProviders.size <= 1) return null;
    const groups = [...byProviders.values()].filter((group) => group.services.length > 0);
    return groups.length > 0 ? groups : null;
  }
  function joinRegionNames(names) {
    if (names.length === 1) return names[0] ?? "";
    if (names.length === 2) return names.join(" and ");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
  }
  function parseRegions(textContent) {
    const regions = {};
    for (const line of textContent.trim().split("\n")) {
      if (line.startsWith("#")) continue;
      const [code, name] = line.split("	");
      if (code && name) regions[code] = name;
    }
    return regions;
  }
  function parseProviders(textContent) {
    return textContent.trim().split("\n").filter((line) => !line.startsWith("#") && line.trim() !== "");
  }
  var FALLBACK_REGIONS = {
    US: "United States",
    GB: "United Kingdom",
    IN: "India",
    CA: "Canada",
    DE: "Germany",
    FR: "France",
    JP: "Japan",
    AU: "Australia",
    BR: "Brazil",
    MX: "Mexico",
    IE: "Ireland",
    IT: "Italy",
    ES: "Spain",
    NL: "Netherlands",
    SE: "Sweden",
    NO: "Norway",
    DK: "Denmark",
    FI: "Finland"
  };
  var FALLBACK_PROVIDERS = [
    "Netflix",
    "Amazon Prime Video",
    "Disney Plus",
    "HBO Max",
    "Hulu",
    "Apple TV Plus",
    "Paramount Plus",
    "Peacock",
    "JioCinema",
    "Disney+ Hotstar",
    "ZEE5",
    "SonyLIV"
  ];
  function streamingErrorMessage(error) {
    const message = export112(export5(error, "message")) || "";
    if (error instanceof TypeError && message === "Failed to fetch") return "TMDB API is unreachable.";
    if (error instanceof SyntaxError) return "Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.";
    if (message.includes("401")) return "Invalid TMDB API Key.";
    if (message.includes("404")) return "The requested item could not be found on TMDB.";
    if (message.includes("429")) return "Too many requests. Please wait a moment and try again.";
    if (message.startsWith("HTTP 5")) return "The TMDB service is temporarily unavailable. Please try again later.";
    return message || "An unknown error occurred";
  }
  function readUserElsewhere(value, defaultRegion) {
    return {
      region: export13(export5(value, "Region")) || defaultRegion,
      regions: Array.isArray(export5(value, "Regions")) ? export8(export5(value, "Regions")).filter((code) => typeof code === "string") : [],
      services: Array.isArray(export5(value, "Services")) ? export8(export5(value, "Services")).filter((name) => typeof name === "string") : [],
      seasonProviders: export5(value, "SeasonProviders") !== false
    };
  }

  // client/src/features/details-providers/elsewhere.ts
  var JE = export1("Jellyfin Elsewhere");
  var LOG = "🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:";
  JE.initializeElsewhereScript = function initializeElsewhereScript() {
    const config = JE.pluginConfig;
    if (!config.ElsewhereEnabled) {
      console.log(`${LOG} Feature is disabled in plugin settings.`);
      return;
    }
    const TmdbEnabled = !!config.TmdbEnabled;
    const DEFAULT_REGION = config.DEFAULT_REGION || "US";
    const filters = { defaults: parseProviderList(config.DEFAULT_PROVIDERS), ignore: parseProviderList(config.IGNORE_PROVIDERS) };
    const BRANDING_TEXT = config.ElsewhereCustomBrandingText || "";
    const BRANDING_IMAGE_URL = config.ElsewhereCustomBrandingImageUrl || "";
    const SEASON_PROVIDERS_ADMIN = config.ElsewhereSeasonProviders !== false;
    if (!TmdbEnabled) {
      console.log(`${LOG} TMDB is not configured, skipping initialization`);
      return;
    }
    let userRegion = DEFAULT_REGION;
    let userRegions = [];
    let userServices = [];
    let availableRegions = {};
    let availableProviders = [];
    let userSeasonProviders = true;
    let settingsGeneration = 0;
    let formRequest = 0;
    const filterServices = (services) => applyProviderFilters(services, filters, (error) => console.error(`${LOG} Invalid regex in IGNORE_PROVIDERS.`, error));
    const regionName = (code) => (Object.prototype.hasOwnProperty.call(availableRegions, code) ? availableRegions[code] : void 0) || code;
    console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...");
    function loadRegionsAndProviders() {
      fetch(JE.cdn.url("elsewhere-res", "regions.txt")).then((response) => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))).then((body) => {
        availableRegions = { ...availableRegions, ...parseRegions(body) };
      }).catch(() => {
        availableRegions = { ...FALLBACK_REGIONS };
      });
      fetch(JE.cdn.url("elsewhere-res", "providers.txt")).then((response) => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))).then((body) => {
        availableProviders = parseProviders(body);
      }).catch(() => {
        availableProviders = [...FALLBACK_PROVIDERS];
      });
    }
    function createMaterialIcon(iconName, size = "18px") {
      const icon = document.createElement("span");
      icon.className = "material-icons";
      icon.textContent = iconName;
      icon.style.fontSize = size;
      icon.style.lineHeight = "1";
      return icon;
    }
    function createAutocompleteInput(placeholder, options, selectedValues) {
      const container = document.createElement("div");
      container.style.cssText = "position: relative; margin-bottom: 6px;";
      let debounceTimer;
      const filterOptions = (filterText) => {
        const value = filterText.toLowerCase();
        if (value.length === 0) {
          dropdown.style.display = "none";
          return;
        }
        showDropdown(options.filter((option) => option.toLowerCase().includes(value) && !selectedValues.includes(option)));
      };
      const debounce = JE.helpers.debounce;
      let pendingText = "";
      const debouncedFilter = debounce ? debounce.call(JE.helpers, () => filterOptions(pendingText), 300) : null;
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = placeholder;
      input.style.cssText = `
                width: 100%;
                padding: 10px;
                border: 1px solid #444;
                border-radius: 6px;
                box-sizing: border-box;
                background: #2a2a2a;
                color: #fff;
                font-size: 14px;
            `;
      const dropdown = document.createElement("div");
      dropdown.style.cssText = `
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: #1a1a1a;
                border: 1px solid #444;
                border-top: none;
                border-radius: 6px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
                z-index: 1000;
            `;
      const selectedContainer = document.createElement("div");
      selectedContainer.style.cssText = `
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            `;
      let selectedIndex = -1;
      let filteredOptions = [];
      function updateSelected() {
        selectedContainer.replaceChildren();
        for (const value of selectedValues) {
          const tag = document.createElement("span");
          tag.className = "selected-tag";
          tag.style.cssText = `
                        background: #0078d4;
                        color: white;
                        padding: 4px 10px;
                        border-radius: 16px;
                        font-size: 12px;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    `;
          tag.textContent = value;
          tag.dataset.value = value;
          const remove = document.createElement("span");
          remove.textContent = "×";
          remove.style.cssText = "cursor: pointer; font-weight: bold; font-size: 14px;";
          remove.onclick = () => {
            const index = selectedValues.indexOf(value);
            if (index > -1) {
              selectedValues.splice(index, 1);
              updateSelected();
            }
          };
          tag.appendChild(remove);
          selectedContainer.appendChild(tag);
        }
      }
      function showDropdown(matches) {
        dropdown.replaceChildren();
        dropdown.style.display = "block";
        filteredOptions = matches;
        selectedIndex = -1;
        matches.forEach((option, index) => {
          const item = document.createElement("div");
          item.textContent = option;
          item.style.cssText = `
                        padding: 10px;
                        cursor: pointer;
                        border-bottom: 1px solid #333;
                        color: #fff;
                        font-size: 14px;
                    `;
          item.dataset.index = String(index);
          item.onmouseenter = () => {
            clearSelection();
            item.style.background = "#333";
            selectedIndex = index;
          };
          item.onmouseleave = () => {
            item.style.background = "#1a1a1a";
          };
          item.onclick = () => selectOption(option);
          dropdown.appendChild(item);
        });
      }
      function clearSelection() {
        dropdown.querySelectorAll("div").forEach((item) => {
          item.style.background = "#1a1a1a";
        });
      }
      function updateSelection() {
        clearSelection();
        if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
          const item = dropdown.querySelector(`[data-index="${selectedIndex}"]`);
          if (item) {
            item.style.background = "#333";
            item.scrollIntoView({ block: "nearest" });
          }
        }
      }
      function selectOption(option) {
        if (!selectedValues.includes(option)) {
          selectedValues.push(option);
          updateSelected();
        }
        input.value = "";
        dropdown.style.display = "none";
        selectedIndex = -1;
      }
      input.oninput = () => {
        if (debouncedFilter) {
          pendingText = input.value;
          debouncedFilter();
        } else {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => filterOptions(input.value), 300);
        }
      };
      input.onkeydown = (event) => {
        if (dropdown.style.display === "none") return;
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, filteredOptions.length - 1);
            updateSelection();
            break;
          case "ArrowUp":
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateSelection();
            break;
          case "Enter": {
            event.preventDefault();
            const option = filteredOptions[selectedIndex];
            if (selectedIndex >= 0 && option !== void 0) selectOption(option);
            break;
          }
          case "Escape":
            dropdown.style.display = "none";
            selectedIndex = -1;
            break;
        }
      };
      input.onblur = () => {
        setTimeout(() => {
          if (!dropdown.contains(document.activeElement)) dropdown.style.display = "none";
        }, 200);
      };
      container.append(input, dropdown, selectedContainer);
      updateSelected();
      return container;
    }
    const MODAL_ID = "streaming-settings-modal";
    function closeSettingsForm() {
      const modal = document.getElementById(MODAL_ID);
      if (modal instanceof HTMLElement) {
        modal.style.display = "none";
        modal.replaceChildren();
      }
    }
    function settingsModal() {
      const existing = document.getElementById(MODAL_ID);
      if (existing instanceof HTMLDivElement) return existing;
      const modal = document.createElement("div");
      modal.id = MODAL_ID;
      modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.85);
                display: none;
                z-index: 10000;
                align-items: center;
                justify-content: center;
            `;
      modal.onclick = (event) => {
        if (event.target === modal) modal.style.display = "none";
      };
      document.body.appendChild(modal);
      return modal;
    }
    function element(tag, cssText, textContent) {
      const node = document.createElement(tag);
      node.style.cssText = cssText;
      if (textContent !== void 0) node.textContent = textContent;
      return node;
    }
    function renderSettingsContent(modal, source) {
      const sameSession = export10(JE.session);
      const generation = settingsGeneration;
      const current = () => sameSession() && generation === settingsGeneration;
      let saving = false;
      const content = element("div", `
                background: #181818;
                padding: 20px;
                border-radius: 8px;
                max-width: 500px;
                width: 90%;
                max-height: 80vh;
                overflow-y: auto;
                color: #fff;
                border: 1px solid #333;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            `);
      content.appendChild(element("h3", "margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;", JE.t("elsewhere_settings_title")));
      const countryBlock = element("div", "margin-bottom: 16px;");
      const countryHeader = element("div", "display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;");
      countryHeader.appendChild(element("label", "font-weight: 600; color: #ccc;", JE.t("elsewhere_settings_country")));
      const resetRegionBtn = element("button", "display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;");
      resetRegionBtn.type = "button";
      resetRegionBtn.id = "reset-region-btn";
      resetRegionBtn.title = "Reset to plugin default";
      resetRegionBtn.appendChild(createMaterialIcon("restart_alt", "16px"));
      countryHeader.appendChild(resetRegionBtn);
      countryBlock.appendChild(countryHeader);
      const regionSelect = element("select", "width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;");
      regionSelect.id = "region-select";
      for (const [code, name] of Object.entries(availableRegions)) {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = name;
        if (code === userRegion) option.selected = true;
        regionSelect.appendChild(option);
      }
      for (const code of /* @__PURE__ */ new Set([userRegion, DEFAULT_REGION])) {
        if (Array.from(regionSelect.options).some((option2) => option2.value === code)) continue;
        const option = document.createElement("option");
        option.value = code;
        option.textContent = code;
        regionSelect.appendChild(option);
      }
      regionSelect.value = userRegion;
      countryBlock.appendChild(regionSelect);
      content.appendChild(countryBlock);
      const regionsBlock = element("div", "margin-bottom: 16px;");
      regionsBlock.appendChild(element("label", "display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;", JE.t("elsewhere_settings_other_countries")));
      const regionsContainer = document.createElement("div");
      regionsContainer.id = "regions-autocomplete";
      regionsBlock.appendChild(regionsContainer);
      content.appendChild(regionsBlock);
      const servicesBlock = element("div", "margin-bottom: 16px;");
      servicesBlock.appendChild(element("label", "display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;", JE.t("elsewhere_settings_providers")));
      const servicesContainer = document.createElement("div");
      servicesContainer.id = "services-autocomplete";
      servicesBlock.appendChild(servicesContainer);
      content.appendChild(servicesBlock);
      let seasonCheckbox = null;
      if (SEASON_PROVIDERS_ADMIN) {
        const seasonLabel = element("label", "display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;");
        seasonCheckbox = element("input", "width: 16px; height: 16px; cursor: pointer;");
        seasonCheckbox.type = "checkbox";
        seasonCheckbox.id = "season-providers-checkbox";
        seasonCheckbox.checked = userSeasonProviders;
        seasonLabel.append(seasonCheckbox, element("span", "", JE.t("elsewhere_settings_season_providers")));
        content.appendChild(seasonLabel);
      }
      const buttons = element("div", "display: flex; gap: 12px; justify-content: flex-end;");
      const cancel = element("button", "padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;", JE.t("elsewhere_settings_cancel"));
      cancel.id = "cancel-settings";
      const save = element("button", "padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;", JE.t("elsewhere_settings_save"));
      save.id = "save-settings";
      buttons.append(cancel, save);
      content.appendChild(buttons);
      resetRegionBtn.onmouseenter = () => {
        resetRegionBtn.style.color = "#fff";
      };
      resetRegionBtn.onmouseleave = () => {
        resetRegionBtn.style.color = "#999";
      };
      resetRegionBtn.onclick = () => {
        regionSelect.value = DEFAULT_REGION;
      };
      const regionOptions = Object.entries(availableRegions).map(([code, name]) => `${name} (${code})`);
      regionsContainer.appendChild(createAutocompleteInput(
        JE.t("elsewhere_settings_add_countries_placeholder"),
        regionOptions,
        userRegions.map((code) => `${regionName(code)} (${code})`)
      ));
      servicesContainer.appendChild(createAutocompleteInput(
        JE.t("elsewhere_settings_add_providers_placeholder"),
        availableProviders,
        userServices.slice()
      ));
      cancel.onclick = () => {
        modal.style.display = "none";
      };
      save.onclick = async () => {
        if (saving || !current() || !modal.isConnected || modal.style.display === "none") return;
        saving = true;
        save.disabled = true;
        const region = regionSelect.value;
        const selectedRegions = [];
        regionsContainer.querySelectorAll(".selected-tag").forEach((tag) => {
          const match = (tag.dataset.value ?? "").match(/\(([A-Z]{2})\)$/);
          if (match?.[1]) selectedRegions.push(match[1]);
        });
        const regions = selectedRegions;
        const selectedServices = [];
        servicesContainer.querySelectorAll(".selected-tag").forEach((tag) => {
          selectedServices.push((tag.dataset.value ?? "").trim());
        });
        const services = selectedServices;
        const seasonProviders = seasonCheckbox?.checked ?? userSeasonProviders;
        const elsewhereSettings = {
          ...source,
          Region: region,
          Regions: regions,
          Services: services,
          SeasonProviders: seasonProviders
        };
        try {
          await JE.saveUserSettings("elsewhere.json", elsewhereSettings, { throwOnError: true, isCurrent: current });
          if (!current()) return;
          JE.userConfig.elsewhere = elsewhereSettings;
          loadSettings();
        } catch (_) {
          if (current() && modal.isConnected) {
            let error = content.querySelector(".je-elsewhere-save-error");
            if (!error) {
              error = document.createElement("p");
              error.className = "je-elsewhere-save-error";
              error.setAttribute("role", "alert");
              buttons.before(error);
            }
            error.textContent = settingsText("elsewhere_settings_save_failed", "Could not save your choices. Try again.");
          }
        } finally {
          saving = false;
          if (current()) save.disabled = false;
        }
      };
      modal.replaceChildren(content);
    }
    function validPreferenceDocument(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const region = export5(value, "Region");
      const regions = export5(value, "Regions");
      const services = export5(value, "Services");
      const season = export5(value, "SeasonProviders");
      return (region == null || typeof region === "string") && (regions == null || Array.isArray(regions) && regions.every((x) => typeof x === "string")) && (services == null || Array.isArray(services) && services.every((x) => typeof x === "string")) && (season == null || typeof season === "boolean");
    }
    function settingsText(key, fallback) {
      const text = JE.t(key);
      return text && text !== key ? text : fallback;
    }
    function openSettings() {
      const modal = settingsModal();
      const request = ++formRequest;
      const sameSession = export10(JE.session);
      const current = () => request === formRequest && sameSession() && modal.isConnected && modal.style.display !== "none";
      modal.replaceChildren(element("p", "color: #fff;", settingsText("elsewhere_settings_loading", "Loading your settings…")));
      modal.style.display = "flex";
      const client = export0();
      const user = client.getCurrentUserId();
      void Promise.resolve().then(() => {
        if (!current() || !user) throw new Error("Settings opening cancelled");
        return client.ajax({ type: "GET", url: client.getUrl(`/JellyfinEnhanced/user-settings/${user}/elsewhere.json?_=${Date.now()}`), dataType: "json" });
      }).then((response) => {
        if (!current()) return;
        if (!validPreferenceDocument(response)) throw new Error("Invalid Elsewhere settings document");
        const settings = readUserElsewhere(response, DEFAULT_REGION);
        userRegion = settings.region;
        userRegions = settings.regions;
        userServices = settings.services;
        userSeasonProviders = settings.seasonProviders;
        invalidateProviderPanels();
        renderSettingsContent(modal, response);
        addStreamingLookup();
      }).catch(() => {
        if (!current()) return;
        const message = element("div", "padding: 24px; background: #181818; color: #fff;", settingsText("elsewhere_settings_load_failed", "Your settings could not be loaded. No changes were saved."));
        const retry = element("button", "", settingsText("elsewhere_settings_retry", "Retry"));
        retry.type = "button";
        retry.onclick = openSettings;
        const cancel = element("button", "", JE.t("elsewhere_settings_cancel"));
        cancel.type = "button";
        cancel.onclick = () => {
          modal.style.display = "none";
          formRequest++;
        };
        message.append(retry, cancel);
        modal.replaceChildren(message);
      });
    }
    function invalidateProviderPanels() {
      settingsGeneration++;
      document.querySelectorAll(".streaming-lookup-container").forEach((panel) => panel.remove());
      seasonProvidersCache.clear();
      tmdbSeasonNumbersCache.clear();
      seasonFallbackInFlight.clear();
    }
    function loadSettings(rebuild = true) {
      const settings = readUserElsewhere(JE.userConfig.elsewhere, DEFAULT_REGION);
      userRegion = settings.region;
      userRegions = settings.regions;
      userServices = settings.services;
      userSeasonProviders = settings.seasonProviders;
      if (!rebuild) return;
      formRequest++;
      closeSettingsForm();
      invalidateProviderPanels();
      if (rebuild) addStreamingLookup();
    }
    document.addEventListener("je:user-data-loaded", () => loadSettings());
    JE.session?.onUserChange("elsewhere", () => {
      userRegion = DEFAULT_REGION;
      userRegions = [];
      userServices = [];
      userSeasonProviders = true;
      formRequest++;
      closeSettingsForm();
      invalidateProviderPanels();
    });
    function createServiceBadge(service) {
      const badge = element("div", `
                display: inline-flex;
                align-items: center;
                padding: 6px 10px;
                margin: 3px 5px 3px 0;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                transition: all 500ms ease;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                backdrop-filter: blur(10px);
            `);
      const logo = document.createElement("img");
      logo.src = `https://image.tmdb.org/t/p/w92${service.logo_path}`;
      logo.alt = service.provider_name;
      logo.style.cssText = `
                width: 20px;
                height: 20px;
                margin-right: 8px;
                object-fit: contain;
                border-radius: 4px;
            `;
      logo.onerror = () => {
        logo.style.display = "none";
      };
      badge.appendChild(logo);
      const label = document.createElement("span");
      label.textContent = service.provider_name;
      badge.appendChild(label);
      badge.onmouseenter = () => {
        badge.style.transform = "translateY(-2px)";
        badge.style.background = "rgba(255, 255, 255, 0.2)";
        badge.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)";
      };
      badge.onmouseleave = () => {
        badge.style.transform = "translateY(0)";
        badge.style.background = "rgba(255, 255, 255, 0.1)";
        badge.style.boxShadow = "none";
      };
      return badge;
    }
    function fetchStreamingData(tmdbId, mediaType, callback) {
      const sameSession = export10(JE.session);
      const generation = settingsGeneration;
      const current = () => sameSession() && generation === settingsGeneration;
      const path = `/${mediaType}/${export2(tmdbId)}/watch/providers`;
      const url = export0().getUrl(`/JellyfinEnhanced/tmdb${path}`);
      JE.core.api.fetch(url, { cacheKey: `tmdb:${path}` }).then((data) => {
        if (current()) callback(null, decodeWatchProviders(data));
      }).catch((error) => {
        if (current()) callback(streamingErrorMessage(error), null);
      });
    }
    const SEASON_FETCH_CONCURRENCY = 4;
    const seasonProvidersCache = /* @__PURE__ */ new Map();
    const tmdbSeasonNumbersCache = /* @__PURE__ */ new Map();
    function fetchSeasonProviders(tmdbId, seasonNumber) {
      const key = `${tmdbId}:${seasonNumber}`;
      let pending = seasonProvidersCache.get(key);
      if (!pending) {
        const url = export0().getUrl(`/JellyfinEnhanced/tmdb/tv/${export2(tmdbId)}/season/${seasonNumber}/watch/providers`);
        pending = JE.core.api.fetch(url).then(decodeWatchProviders).catch(() => {
          seasonProvidersCache.delete(key);
          return null;
        });
        seasonProvidersCache.set(key, pending);
      }
      return pending;
    }
    function fetchTmdbSeasonNumbers(tmdbId) {
      let pending = tmdbSeasonNumbersCache.get(tmdbId);
      if (!pending) {
        const url = export0().getUrl(`/JellyfinEnhanced/tmdb/tv/${export2(tmdbId)}`);
        pending = JE.core.api.fetch(url).then((data) => {
          const seasons = export5(data, "seasons");
          return Array.isArray(seasons) ? new Set(seasons.map((season) => export6(export5(season, "season_number"))).filter((n) => n !== void 0)) : null;
        }).catch(() => {
          tmdbSeasonNumbersCache.delete(tmdbId);
          return null;
        });
        tmdbSeasonNumbersCache.set(tmdbId, pending);
      }
      return pending;
    }
    async function fetchJellyfinSeasonNumbers(seriesId) {
      const client = export0();
      const url = client.getUrl(`Shows/${seriesId}/Seasons`, { userId: client.getCurrentUserId() ?? "" });
      const result = await JE.core.api.fetch(url);
      return export8(export5(result, "Items")).map((season) => export5(season, "IndexNumber")).filter((number) => Number.isInteger(number)).sort((a, b) => a - b);
    }
    async function resolveSeasonContext(expectedTmdbId) {
      if (!SEASON_PROVIDERS_ADMIN || !userSeasonProviders) return null;
      const itemId = export3();
      if (!itemId) return null;
      const item = await export7(JE.helpers, itemId, false);
      if (!item) return null;
      let series;
      let seasonNumber = null;
      if (item.Type === "Series") {
        series = item;
      } else if (item.Type === "Season" && item.SeriesId && Number.isInteger(item.IndexNumber)) {
        series = await export7(JE.helpers, item.SeriesId, false);
        seasonNumber = item.IndexNumber ?? null;
      } else {
        return null;
      }
      if (!series || !series.Id || !isDefaultSeasonOrder(series.DisplayOrder)) return null;
      const tmdbId = series.ProviderIds.Tmdb;
      if (!tmdbId || expectedTmdbId && tmdbId !== expectedTmdbId) return null;
      return { kind: seasonNumber === null ? "series" : "season", seriesId: series.Id, tmdbId, seasonNumber };
    }
    function formatSeasonLabel(seasonNumbers) {
      const parts = seasonLabelParts(seasonNumbers);
      if (parts.single !== null) return JE.t("elsewhere_season_label", { number: parts.single });
      if (parts.specialsOnly) return JE.t("jellyseerr_season_specials");
      const ranges = [...parts.ranges];
      if (parts.hasSpecials) ranges.push(JE.t("jellyseerr_season_specials"));
      return JE.t("elsewhere_seasons_label", { range: ranges.join(", ") });
    }
    async function buildSeasonView(ctx, seriesData) {
      const seriesServices = filterServices(regionOf(seriesData, userRegion)?.flatrate);
      const tmdbSeasons = await fetchTmdbSeasonNumbers(ctx.tmdbId);
      const seasonNumbers = ctx.kind === "season" && ctx.seasonNumber !== null ? [ctx.seasonNumber] : await fetchJellyfinSeasonNumbers(ctx.seriesId);
      if (seasonNumbers.length === 0) return null;
      const entries = await mapWithLimit(seasonNumbers, SEASON_FETCH_CONCURRENCY, async (number) => {
        const knownToTmdb = !tmdbSeasons || tmdbSeasons.has(number);
        const data = knownToTmdb ? await fetchSeasonProviders(ctx.tmdbId, number) : null;
        const own = filterServices(regionOf(data, userRegion)?.flatrate);
        if (own.length > 0) return { number, services: own, link: regionOf(data, userRegion)?.link };
        if (number === 0) return null;
        return { number, services: seriesServices, link: void 0 };
      });
      const seasons = entries.filter((entry) => !!entry);
      const [first] = seasons;
      if (!first) return null;
      if (ctx.kind === "season") return { servicesOverride: first.services, link: first.link };
      const groups = groupSeasonsByProviders(seasons);
      return groups ? { groups: groups.map((group) => ({ label: formatSeasonLabel(group.numbers), services: group.services })) } : null;
    }
    function controlButton(className, icon, extraCss) {
      const button = document.createElement("button");
      button.className = className;
      button.appendChild(createMaterialIcon(icon, "16px"));
      button.style.cssText = extraCss;
      button.onmouseenter = () => {
        button.style.background = "rgba(255, 255, 255, 0.2)";
      };
      button.onmouseleave = () => {
        button.style.background = "rgba(255, 255, 255, 0.1)";
      };
      return button;
    }
    function closeButton(target) {
      const button = document.createElement("button");
      button.appendChild(createMaterialIcon("close", "16px"));
      button.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
            `;
      button.onmouseenter = () => {
        button.style.background = "rgba(255, 0, 0, 0.2)";
        button.style.borderColor = "rgba(255, 0, 0, 0.3)";
      };
      button.onmouseleave = () => {
        button.style.background = "rgba(255, 255, 255, 0.1)";
        button.style.borderColor = "rgba(255, 255, 255, 0.2)";
      };
      button.onclick = () => target.remove();
      return button;
    }
    function processDefaultRegionData(data, tmdbId, mediaType, seasonView = {}) {
      const regionData = regionOf(data, userRegion);
      const container = element("div", `
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `);
      const header = element("div", `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `);
      const hasServices = !!regionData?.flatrate && regionData.flatrate.length > 0;
      let filteredServices = hasServices ? filterServices(regionData?.flatrate) : [];
      if (seasonView.servicesOverride) filteredServices = seasonView.servicesOverride;
      const seasonGroups = seasonView.groups || null;
      const linkUrl = seasonView.link || regionData?.link || "";
      const hasFilteredServices = !!seasonGroups || filteredServices.length > 0;
      const brandedEmpty = !hasFilteredServices && !!BRANDING_TEXT;
      const title = export02(JE.helpers, hasFilteredServices && linkUrl ? linkUrl : "#", { title: "JustWatch" });
      if (hasFilteredServices) {
        title.textContent = JE.t("elsewhere_panel_available_in", { region: regionName(userRegion) });
      } else if (BRANDING_TEXT) {
        title.textContent = BRANDING_TEXT;
        title.classList.add("elsewhere-custom-branding");
        title.style.cursor = "default";
        if (BRANDING_IMAGE_URL) {
          title.style.display = "flex";
          title.style.alignItems = "center";
          title.style.gap = "8px";
          const icon = document.createElement("img");
          icon.src = BRANDING_IMAGE_URL;
          icon.alt = "Custom Branding";
          icon.className = "elsewhere-custom-branding-icon";
          icon.style.cssText = `
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `;
          icon.onerror = () => {
            icon.style.display = "none";
          };
          title.appendChild(icon);
        }
      } else {
        title.textContent = JE.t("elsewhere_panel_not_available_in", { region: regionName(userRegion) });
      }
      title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `;
      if (hasFilteredServices && linkUrl) {
        title.classList.add("elsewhere-link-reset");
        title.href = export32(linkUrl);
        title.style.padding = "0";
        title.style.margin = "0";
      } else if (brandedEmpty) {
        title.style.cursor = "default";
      }
      const controls = element("div", `
                display: flex;
                gap: 8px;
                align-items: center;
            `);
      const searchButton = controlButton("elsewhere-search-button", "search", `
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 500ms ease;
                opacity: ${brandedEmpty ? "0" : "1"};
            `);
      searchButton.appendChild(document.createTextNode(""));
      const settingsButton = controlButton("elsewhere-settings-button", "settings", `
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
                opacity: ${brandedEmpty ? "0" : "1"};
            `);
      settingsButton.onclick = () => openSettings();
      controls.append(searchButton, settingsButton);
      header.append(title, controls);
      container.appendChild(header);
      if (brandedEmpty) {
        container.onmouseenter = () => {
          searchButton.style.opacity = "1";
          settingsButton.style.opacity = "1";
        };
        container.onmouseleave = () => {
          searchButton.style.opacity = "0";
          settingsButton.style.opacity = "0";
        };
      }
      if (hasServices || hasFilteredServices) {
        if (seasonGroups) {
          for (const group of seasonGroups) {
            container.appendChild(element("div", "font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;", group.label));
            const groupServices = element("div", "display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;");
            for (const service of group.services) groupServices.appendChild(createServiceBadge(service));
            container.appendChild(groupServices);
          }
        } else if (hasFilteredServices) {
          const servicesContainer = element("div", "display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;");
          for (const service of filteredServices) servicesContainer.appendChild(createServiceBadge(service));
          container.appendChild(servicesContainer);
        } else if (filters.defaults.length > 0) {
          container.appendChild(element("div", "color: #999; font-size: 13px; margin-bottom: 12px;", JE.t("elsewhere_panel_no_configured_services")));
        }
      }
      const resultContainer = document.createElement("div");
      resultContainer.id = "streaming-result-container";
      container.appendChild(resultContainer);
      searchButton.onclick = () => {
        searchButton.disabled = true;
        searchButton.replaceChildren();
        const loadingIcon = createMaterialIcon("refresh", "16px");
        loadingIcon.style.animation = "spin 1s linear infinite";
        searchButton.append(loadingIcon, document.createTextNode(" " + JE.t("elsewhere_panel_search_button")));
        searchButton.style.opacity = "0.7";
        resultContainer.replaceChildren();
        if (!document.querySelector("style[data-jellyfin-elsewhere]")) {
          const style = document.createElement("style");
          style.textContent = `
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `;
          style.setAttribute("data-jellyfin-elsewhere", "true");
          document.head.appendChild(style);
        }
        fetchStreamingData(tmdbId, mediaType, (error, result) => {
          searchButton.disabled = false;
          searchButton.replaceChildren(createMaterialIcon("search", "16px"), document.createTextNode(""));
          searchButton.style.opacity = "1";
          if (error || !result) {
            resultContainer.replaceChildren(element("div", "color: #ff6b6b; font-size: 13px; margin-top: 8px;", JE.t("elsewhere_panel_error", { error: error ?? "" })));
            return;
          }
          const regionsToSearch = userRegions.length > 0 ? userRegions : [userRegion];
          let hasAnyResults = false;
          const unavailableRegions = [];
          regionsToSearch.forEach((region, index) => {
            const data2 = regionOf(result, region);
            const offered = data2?.flatrate ?? [];
            const services = userServices.length > 0 ? offered.filter((service) => userServices.includes(service.provider_name)) : offered;
            if (offered.length > 0 && services.length > 0) {
              hasAnyResults = true;
              const regionResult = processRegionData(result, region);
              if (regionResult) {
                if (index > 0 || unavailableRegions.length > 0) regionResult.style.marginTop = "6px";
                resultContainer.appendChild(regionResult);
              }
            } else {
              unavailableRegions.push(region);
            }
          });
          if (unavailableRegions.length > 0) {
            resultContainer.insertBefore(createUnavailableRegionsDisplay(unavailableRegions), resultContainer.firstChild);
          }
          if (!hasAnyResults && unavailableRegions.length === 0) {
            resultContainer.appendChild(element("div", "color: #6c757d; font-size: 13px; margin-top: 8px;", JE.t("elsewhere_panel_no_services_in_regions")));
          }
        });
      };
      return container;
    }
    function createUnavailableRegionsDisplay(unavailableRegions) {
      const container = element("div", `
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `);
      const header = element("div", `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `);
      const title = element("div", `
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `, JE.t("elsewhere_panel_not_available_in_regions", { regions: joinRegionNames(unavailableRegions.map(regionName)) }));
      const close = closeButton(container);
      close.title = "Close";
      header.append(title, close);
      container.appendChild(header);
      return container;
    }
    function processRegionData(data, region) {
      const regionData = regionOf(data, region);
      if (!regionData?.flatrate) return null;
      const services = regionData.flatrate.filter((service) => userServices.length === 0 || userServices.includes(service.provider_name));
      if (services.length === 0) return null;
      const container = element("div", `
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `);
      const header = element("div", `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `);
      const title = export02(JE.helpers, regionData.link || "#", { title: "JustWatch" });
      title.textContent = JE.t("elsewhere_panel_available_in_region", { region: regionName(region) });
      title.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `;
      if (regionData.link) {
        title.classList.add("elsewhere-link-reset");
        title.href = export32(regionData.link);
        title.style.padding = "0";
        title.style.margin = "0";
      }
      header.append(title, closeButton(container));
      container.appendChild(header);
      const servicesContainer = element("div", "display: flex; flex-wrap: wrap; gap: 3px;");
      for (const service of services) servicesContainer.appendChild(createServiceBadge(service));
      container.appendChild(servicesContainer);
      return container;
    }
    function autoLoadStreamingData(tmdbId, mediaType, container) {
      const sameSession = export10(JE.session);
      const generation = settingsGeneration;
      const current = () => sameSession() && generation === settingsGeneration && container.isConnected;
      fetchStreamingData(tmdbId, mediaType, async (error, data) => {
        if (!current()) return;
        if (error || !data) {
          container.appendChild(element("div", "font-size: 13px; margin-top: 8px; color: #ff6b6b;", JE.t("elsewhere_panel_error", { error: error ?? "" })));
          return;
        }
        let seasonView = {};
        if (mediaType === "tv" && SEASON_PROVIDERS_ADMIN && userSeasonProviders) {
          try {
            const ctx = await resolveSeasonContext(tmdbId);
            if (!current()) return;
            if (ctx) seasonView = await buildSeasonView(ctx, data) || {};
          } catch (e) {
            console.warn(`${LOG} Per-season providers unavailable, using series providers.`, e);
          }
        }
        if (current()) container.appendChild(processDefaultRegionData(data, tmdbId, mediaType, seasonView));
      });
    }
    function mountStreamingLookup(section, tmdbId, mediaType) {
      const container = document.createElement("div");
      container.className = "streaming-lookup-container";
      container.style.cssText = "margin: 16px 0;";
      autoLoadStreamingData(tmdbId, mediaType, container);
      const externalLinks = section.querySelector(".itemExternalLinks");
      if (externalLinks?.parentNode) externalLinks.parentNode.insertBefore(container, externalLinks.nextSibling);
      else section.appendChild(container);
    }
    const seasonFallbackInFlight = /* @__PURE__ */ new Set();
    function mountSeasonPageFallback(section) {
      if (!SEASON_PROVIDERS_ADMIN || !userSeasonProviders) return;
      const page = section.closest("#itemDetailPage") ?? document;
      if (page !== document && page !== export11()) return;
      if (page.querySelector(".streaming-lookup-container")) return;
      if (section !== page.querySelector(".detailSectionContent")) return;
      const itemId = export3();
      if (!itemId || seasonFallbackInFlight.has(itemId)) return;
      seasonFallbackInFlight.add(itemId);
      const sameSession = export10(JE.session);
      const generation = settingsGeneration;
      resolveSeasonContext().then((ctx) => {
        if (!sameSession() || generation !== settingsGeneration || !ctx || ctx.kind !== "season") return;
        if (!section.isConnected || export3() !== itemId || page.querySelector(".streaming-lookup-container")) return;
        mountStreamingLookup(section, ctx.tmdbId, "tv");
      }).catch(() => {
      }).finally(() => seasonFallbackInFlight.delete(itemId));
    }
    function addStreamingLookup() {
      document.querySelectorAll(".detailSectionContent").forEach((section) => {
        const page = section.closest("#itemDetailPage");
        if (page && page !== export11()) return;
        if (section.querySelector(".streaming-lookup-container")) return;
        const tmdbLink = section.querySelector('a[href*="themoviedb.org"]');
        if (!tmdbLink) {
          mountSeasonPageFallback(section);
          return;
        }
        const match = tmdbLink.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
        if (!match?.[1] || !match[2]) return;
        mountStreamingLookup(section, match[2], match[1]);
      });
    }
    loadRegionsAndProviders();
    loadSettings(false);
    const idle = (callback, timeout, fallbackDelay) => {
      if (typeof requestIdleCallback !== "undefined") requestIdleCallback(callback, { timeout });
      else setTimeout(callback, fallbackDelay);
    };
    idle(() => {
      settingsModal();
    }, 2e3, 2e3);
    let processingElsewhere = false;
    const scheduleStreamingLookup = () => {
      if (processingElsewhere) return;
      processingElsewhere = true;
      idle(() => {
        addStreamingLookup();
        processingElsewhere = false;
      }, 500, 100);
    };
    JE.helpers.createObserver("elsewhere", scheduleStreamingLookup, document.body, { childList: true, subtree: true });
    JE.helpers.onViewPage(scheduleStreamingLookup);
    idle(() => addStreamingLookup(), 1e3, 1e3);
    console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!");
  };
})();
})();
//# sourceMappingURL=elsewhere.js.map
