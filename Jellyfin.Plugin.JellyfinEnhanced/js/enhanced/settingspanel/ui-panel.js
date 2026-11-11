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
  function settingsPanelContext(JE) {
    return featureContext("settings-panel", JE, {
      internalSlots: ["enhancedUi"],
      internalsObject: () => JE.internals = JE.internals || {}
    });
  }
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }
  function settingsDocumentContract() {
    const host = window;
    const contract = host.__JE_BOOTSTRAP_CONTRACT__;
    const parse = contract?.parseSettingsDocument;
    if (!contract || typeof parse !== "function") return void 0;
    return {
      parseSettingsDocument(value, isAdmin) {
        const result = Reflect.apply(parse, contract, [value, isAdmin]);
        if (!isRevisioned(result)) throw new TypeError("Settings validator returned an unexpected value");
        return result;
      }
    };
  }
  function isRevisioned(value) {
    if (value === null || typeof value !== "object") return false;
    const settings = Reflect.get(value, "Settings");
    return typeof Reflect.get(value, "Revision") === "string" && settings !== null && typeof settings === "object";
  }

  // client/src/features/shared/dom.ts
  function targetElement(event) {
    return event.target instanceof Element ? event.target : null;
  }
  function closestTarget(event, selector) {
    const found = targetElement(event)?.closest(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryElement(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryInput(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLInputElement ? found : null;
  }
  function querySelect(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLSelectElement ? found : null;
  }
  function queryButton(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLButtonElement ? found : null;
  }
  function queryElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
  }

  // client/src/features/settings-panel/panel-refresh.ts
  function shouldApplyRefresh(startRevision, currentRevision, responseRevision) {
    return responseRevision !== (startRevision ?? null) && (currentRevision ?? null) === (startRevision ?? null);
  }
  function isTextEntryType(tag, type, editable) {
    if (editable) return true;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    return tag === "INPUT" && !["checkbox", "radio", "button", "range", "color"].includes(type);
  }
  var paneSlug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // client/src/features/settings-panel/shortcut-rules.ts
  function pluginShortcutList(value) {
    if (!Array.isArray(value)) return [];
    const list = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const name = entry.Name;
      if (typeof name !== "string") continue;
      const key = entry.Key;
      list.push({ ...entry, Name: name, Key: typeof key === "string" ? key : "" });
    }
    return list;
  }

  // client/src/features/settings-panel/ui-panel.ts
  var PANEL_ID = "jellyfin-enhanced-panel";
  var POINTER_EVENTS = ["pointerdown", "mousedown", "click"];
  var MAX_RESULTS = 8;
  function installUiPanel(JE, featureCtx = settingsPanelContext(JE)) {
    const internal = registry(JE);
    let closeOpenPanel = null;
    let cancelOpening = null;
    async function hostAdministrator(client) {
      const flagOf = (user) => {
        const policy = user !== null && typeof user === "object" ? Reflect.get(user, "Policy") : void 0;
        const flag2 = policy !== null && typeof policy === "object" ? Reflect.get(policy, "IsAdministrator") : void 0;
        return typeof flag2 === "boolean" ? flag2 : void 0;
      };
      if (typeof client.getCurrentUser === "function") {
        const flag2 = flagOf(await client.getCurrentUser());
        if (flag2 !== void 0) return flag2;
      }
      const loadedFlag = JE.userConfig?.settings?.isAdmin;
      if (JE.userConfig?.settingsRevision && typeof loadedFlag === "boolean") return loadedFlag;
      const flag = flagOf(await client.ajax({ type: "GET", url: client.getUrl("/Users/Me"), dataType: "json" }));
      if (flag === void 0) throw new Error("Current user policy unavailable. Please reopen settings to retry.");
      return flag;
    }
    async function refreshSettings(currentUserId, sameOpeningIdentity) {
      const client = apiClient();
      const startRevision = JE.userConfig?.settingsRevision;
      const startedSettings = JE.currentSettings;
      const startedDocument = JE.userConfig;
      const startedState = JE.getSettingsSaveState?.();
      if (startedState?.pending) return true;
      const startedContents = JSON.stringify(startedSettings);
      const mayReplace = () => {
        const state = JE.getSettingsSaveState?.();
        return sameOpeningIdentity() && JE.currentSettings === startedSettings && JE.userConfig === startedDocument && !state?.pending && state?.version === startedState?.version && JSON.stringify(startedSettings) === startedContents;
      };
      const response = await client.ajax({
        type: "GET",
        url: client.getUrl(`/JellyfinEnhanced/user-settings/${currentUserId}/settings-document?_=${Date.now()}`),
        dataType: "json"
      });
      if (!sameOpeningIdentity()) return false;
      if (!response) {
        if (!startRevision) throw new Error("Settings document unavailable. Please reopen settings to retry.");
        return true;
      }
      const contract = settingsDocumentContract();
      if (!contract) throw new Error("Settings validator unavailable");
      const isAdmin = await hostAdministrator(client);
      if (!sameOpeningIdentity()) return false;
      const snapshot = contract.parseSettingsDocument(response, isAdmin);
      if (!mayReplace()) return true;
      if (!shouldApplyRefresh(startRevision, JE.userConfig?.settingsRevision, snapshot.Revision)) return true;
      const settings = JE.toCamelCase(snapshot.Settings);
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) throw new TypeError("Settings document is not an object");
      JE.userConfig = JE.userConfig || { shortcuts: { Shortcuts: [] } };
      JE.userConfig.settings = { ...settings };
      JE.userConfig.settingsRevision = snapshot.Revision;
      if (typeof JE.loadSettings === "function") {
        JE.currentSettings = JE.loadSettings();
      }
      return true;
    }
    JE.showEnhancedPanel = async () => {
      if (cancelOpening) {
        cancelOpening();
        return;
      }
      if (document.getElementById(PANEL_ID)) {
        if (closeOpenPanel) closeOpenPanel();
        else document.getElementById(PANEL_ID)?.remove();
        return;
      }
      const client = apiClient();
      const currentUserId = client.getCurrentUserId();
      const openingEpoch = JE.session?.getEpoch();
      const serverId = () => {
        const c = apiClient();
        return typeof c.serverId === "function" ? c.serverId() : c.serverId;
      };
      const openingServerId = serverId();
      const openingUrl = client.getUrl("/");
      const openingToken = client.accessToken?.();
      const openingHash = window.location.hash;
      let cancelled = false;
      let stopOpeningNavigation;
      const releaseOpening = () => {
        stopOpeningNavigation?.();
        stopOpeningNavigation = void 0;
        window.removeEventListener("hashchange", cancel);
        window.removeEventListener("popstate", cancel);
        window.removeEventListener("pagehide", cancelOnUnload);
        if (cancelOpening === cancel) cancelOpening = null;
      };
      const cancel = () => {
        cancelled = true;
        releaseOpening();
      };
      const cancelOnUnload = (event) => {
        if ((event.target === window || event.target === document) && !event.persisted) cancel();
      };
      cancelOpening = cancel;
      stopOpeningNavigation = JE.core?.navigation?.onNavigate(cancel);
      window.addEventListener("hashchange", cancel);
      window.addEventListener("popstate", cancel);
      window.addEventListener("pagehide", cancelOnUnload);
      const sameOpeningIdentity = () => !cancelled && apiClient() === client && client.getCurrentUserId() === currentUserId && client.getUrl("/") === openingUrl && client.accessToken?.() === openingToken && window.location.hash === openingHash && serverId() === openingServerId && JE.session?.getEpoch() === openingEpoch;
      try {
        if (currentUserId && !await refreshSettings(currentUserId, sameOpeningIdentity)) return;
      } catch (e) {
        if (!sameOpeningIdentity()) return;
        console.warn("🪼 Jellyfin Enhanced: Could not refresh settings for panel display:", e);
        if (!JE.userConfig?.settingsRevision) {
          const key = "toast_settings_load_failed";
          const translated = JE.t(key);
          JE.toast?.(translated && translated !== key ? translated : "Settings could not be loaded. Please try opening the panel again.");
          return;
        }
      } finally {
        releaseOpening();
      }
      if (!sameOpeningIdentity()) return;
      if (typeof JE.initializeShortcuts === "function") {
        JE.initializeShortcuts();
      }
      const existing = document.getElementById(PANEL_ID);
      if (existing) {
        if (closeOpenPanel) closeOpenPanel();
        else existing.remove();
        return;
      }
      const themeVars = JE.themer.getThemeVariables();
      const primaryAccentColor = themeVars.primaryAccent;
      const theme = {
        panelBgColor: themeVars.panelBg,
        headerFooterBg: themeVars.secondaryBg,
        detailsBackground: themeVars.secondaryBg,
        primaryAccentColor,
        toggleAccentColor: primaryAccentColor,
        kbdBackground: themeVars.altAccent,
        presetBoxBackground: themeVars.altAccent,
        githubButtonBg: `rgba(102, 179, 255, 0.1)`,
        releaseNotesBg: primaryAccentColor,
        checkUpdatesBorder: `1px solid ${primaryAccentColor}`,
        releaseNotesTextColor: themeVars.textColor,
        logoUrl: themeVars.logo
      };
      const panelBlurValue = themeVars.blur;
      const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      const help = document.createElement("div");
      help.id = PANEL_ID;
      help.setAttribute("role", "dialog");
      help.setAttribute("aria-modal", "true");
      help.setAttribute("aria-labelledby", "jePanelTitle");
      help.tabIndex = -1;
      Object.assign(help.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "rgb(24, 24, 24)",
        color: "#fff",
        padding: "0",
        borderRadius: "16px",
        zIndex: 999999,
        fontSize: "14px",
        backdropFilter: `blur(${panelBlurValue})`,
        // Two-column (nav rail + one open section) layout needs a stable
        // canvas, so the panel takes a fixed size instead of hugging its
        // content. The <=760px media query in the panel stylesheet drops
        // this to a full-screen sheet.
        width: "min(1040px, 94vw)",
        height: "min(720px, 90vh)",
        minWidth: "350px",
        maxWidth: "94vw",
        maxHeight: "90vh",
        boxShadow: "0 10px 30px rgba(0,0,0,0.7)",
        border: "1px solid rgba(255,255,255,0.1)",
        // The dialog clips its rounded frame but must never become an
        // extra scroll container when a focused control is re-presented.
        overflow: "clip",
        display: "flex",
        fontFamily: "inherit",
        flexDirection: "column"
      });
      const pluginShortcuts = pluginShortcutList(JE.pluginConfig.Shortcuts);
      if (!JE.state.activeShortcuts || Object.keys(JE.state.activeShortcuts).length === 0) {
        console.warn("🪼 Jellyfin Enhanced: activeShortcuts not initialized, initializing now...");
        if (typeof JE.initializeShortcuts === "function") {
          JE.initializeShortcuts();
        }
      }
      let isDragging = false;
      let offset = { x: 0, y: 0 };
      let autoCloseTimer = null;
      let isMouseInside = false;
      const panelMediaCleanups = [];
      const runPanelCleanups = () => {
        for (let cleanup = panelMediaCleanups.pop(); cleanup; cleanup = panelMediaCleanups.pop()) cleanup();
      };
      const inertBackground = [];
      let lastFocusInside = null;
      const isInside = (target) => target instanceof Node && help.contains(target);
      const restoreFocus = () => {
        if (!help.isConnected || isInside(document.activeElement)) return;
        const back = lastFocusInside && lastFocusInside.isConnected && help.contains(lastFocusInside) && !lastFocusInside.matches(":disabled") && !lastFocusInside.closest("[inert], [hidden]") ? lastFocusInside : help;
        back.focus({ preventScroll: true });
        if (!isInside(document.activeElement)) help.focus({ preventScroll: true });
      };
      const trackFocusInside = (e) => {
        if (e.target instanceof HTMLElement) lastFocusInside = e.target;
      };
      const guardFocus = (e) => {
        if (!isInside(e.target)) restoreFocus();
      };
      const guardBlur = (e) => {
        if (!isInside(e.relatedTarget)) queueMicrotask(restoreFocus);
      };
      const guardPointer = (e) => {
        if (isInside(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        restoreFocus();
      };
      const holdBackground = () => {
        for (const node of Array.from(document.body.children)) {
          if (node === help || !(node instanceof HTMLElement) || node.hasAttribute("inert")) continue;
          node.setAttribute("inert", "");
          inertBackground.push(node);
        }
        help.addEventListener("focusin", trackFocusInside);
        help.addEventListener("focusout", guardBlur);
        document.addEventListener("focusin", guardFocus, true);
        for (const type of POINTER_EVENTS) document.addEventListener(type, guardPointer, true);
      };
      const releaseBackground = () => {
        for (let node = inertBackground.pop(); node; node = inertBackground.pop()) node.removeAttribute("inert");
        help.removeEventListener("focusin", trackFocusInside);
        help.removeEventListener("focusout", guardBlur);
        document.removeEventListener("focusin", guardFocus, true);
        for (const type of POINTER_EVENTS) document.removeEventListener(type, guardPointer, true);
      };
      let closed = false;
      const closePanel = () => {
        if (closed) return;
        closed = true;
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        if (closeOpenPanel === closePanel) closeOpenPanel = null;
        help.remove();
        runPanelCleanups();
        releaseBackground();
        if (opener && opener.isConnected) opener.focus({ preventScroll: true });
        document.removeEventListener("keydown", closeHelp);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        if (!JE.pluginConfig.DisableAllShortcuts) {
          document.addEventListener("keydown", JE.keyListener, true);
        }
      };
      const resetAutoCloseTimer = () => {
        if (closed) return;
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        autoCloseTimer = setTimeout(() => {
          if (!isMouseInside && document.getElementById(PANEL_ID)) closePanel();
        }, Number(JE.CONFIG.HELP_PANEL_AUTOCLOSE_DELAY));
      };
      const setHeaderCursor = (cursor) => {
        const header = queryElement(help, ".panel-header");
        if (header) header.style.cursor = cursor;
      };
      const handleMouseDown = (e) => {
        if (!closestTarget(e, ".panel-header")) return;
        if (closestTarget(e, ".preset-box, button, a, input, select")) return;
        isDragging = true;
        offset = { x: e.clientX - help.getBoundingClientRect().left, y: e.clientY - help.getBoundingClientRect().top };
        setHeaderCursor("grabbing");
        e.preventDefault();
        resetAutoCloseTimer();
      };
      const handleMouseMove = (e) => {
        if (isDragging) {
          help.style.left = `${e.clientX - offset.x}px`;
          help.style.top = `${e.clientY - offset.y}px`;
          help.style.transform = "none";
        }
        resetAutoCloseTimer();
      };
      const handleMouseUp = () => {
        isDragging = false;
        setHeaderCursor("grab");
        resetAutoCloseTimer();
      };
      help.addEventListener("mousedown", handleMouseDown);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      help.addEventListener("mouseenter", () => {
        isMouseInside = true;
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
      });
      help.addEventListener("mouseleave", () => {
        isMouseInside = false;
        resetAutoCloseTimer();
      });
      help.addEventListener("click", resetAutoCloseTimer);
      help.addEventListener("wheel", (e) => {
        e.stopPropagation();
        resetAutoCloseTimer();
      });
      for (const type of ["keydown", "focusin", "touchstart"]) help.addEventListener(type, resetAutoCloseTimer, { capture: true, passive: true });
      const searchProviders = [];
      const createToast = (featureKey, isEnabled) => {
        const feature = JE.t(featureKey);
        const status = JE.t(isEnabled ? "status_enabled" : "status_disabled");
        return JE.t("toast_feature_status", { feature, status });
      };
      const ctx = {
        help,
        pluginShortcuts,
        resetAutoCloseTimer,
        onClose: (fn) => {
          panelMediaCleanups.push(fn);
        },
        closePanel: () => closePanel(),
        /**
         * Let the settings search find a section's controls. Choosing a
         * result opens the provider's pane first, then runs the result.
         * Returns a function that unregisters it.
         */
        registerSearch: (provider) => {
          searchProviders.push(provider);
          return () => {
            const i = searchProviders.indexOf(provider);
            if (i >= 0) searchProviders.splice(i, 1);
          };
        },
        /** Show a pane by its data-pane slug (set by the section nav below). */
        openPane: () => false,
        createToast,
        ...theme
      };
      help.innerHTML = internal.buildPanelHtml ? internal.buildPanelHtml(ctx) : "";
      document.body.appendChild(help);
      closeOpenPanel = closePanel;
      holdBackground();
      const stopNavigation = JE.core?.navigation?.onNavigate(closePanel);
      if (stopNavigation) panelMediaCleanups.push(stopNavigation);
      help.focus({ preventScroll: true });
      const tabbables = () => {
        const checkedGroups = new Set(queryElements(help, 'input[type="radio"]:checked').map((r) => r instanceof HTMLInputElement ? r.name : ""));
        return queryElements(help, 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').filter((el) => !el.closest("[inert], [hidden]") && el.getClientRects().length > 0 && !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked && checkedGroups.has(el.name)));
      };
      help.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const list = tabbables();
        const first = list[0];
        const last = list[list.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === help)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      });
      internal.wirePanelResize?.(ctx);
      internal.wireShortcutEditor?.(ctx);
      resetAutoCloseTimer();
      (function buildSectionNav() {
        const navHost = queryElement(help, ".je-panel-nav-items");
        const body = queryElement(help, ".je-panel-body");
        const panes = queryElements(help, ".je-pane");
        if (!navHost || !body || panes.length === 0) return;
        const items = [];
        const navColumn = queryElement(help, ".je-panel-nav");
        const mainColumn = queryElement(help, ".je-panel-main");
        const phoneMedia = window.matchMedia("(max-width: 760px)");
        const dock = queryElement(help, ".je-panel-dock");
        const sectionSelect = querySelect(help, "#jePanelSection");
        const searchInput = queryInput(help, "#jePanelSearch");
        const searchResults = queryElement(help, "#jePanelSearchResults");
        const syncLayerFocus = (moveFocus) => {
          if (!navColumn || !mainColumn) return;
          if (dock && searchInput && searchResults) {
            if (phoneMedia.matches) dock.append(searchInput, searchResults);
            else navColumn.prepend(searchInput, searchResults);
          }
          if (phoneMedia.matches) {
            const detailOpen = body.classList.contains("je-pane-open");
            navColumn.inert = detailOpen;
            mainColumn.inert = !detailOpen;
            if (moveFocus) {
              const target = detailOpen ? queryElement(help, "#jePanelBack") : items.find((b) => b.classList.contains("active")) || items[0];
              if (target) target.focus();
            }
          } else {
            navColumn.inert = false;
            mainColumn.inert = false;
          }
        };
        const handlePhoneMediaChange = () => syncLayerFocus(false);
        phoneMedia.addEventListener("change", handlePhoneMediaChange);
        const activate = (pane, persist) => {
          panes.forEach((p) => p.classList.toggle("active", p === pane));
          items.forEach((b) => b.classList.toggle("active", b.dataset.tab === pane.dataset.pane));
          if (sectionSelect) sectionSelect.value = pane.dataset.pane ?? "";
          body.classList.add("je-pane-open");
          syncLayerFocus(persist);
          if (persist) {
            JE.currentSettings.lastOpenedTab = pane.dataset.pane;
            JE.saveUserSettings("settings.json", JE.currentSettings);
          }
          resetAutoCloseTimer();
        };
        panes.forEach((pane, index) => {
          const title = pane.querySelector(".je-pane-title");
          const label = (pane.dataset.paneLabel || title && title.textContent || "").trim();
          if (!pane.dataset.pane) pane.dataset.pane = paneSlug(label) || `pane-${index}`;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "tab-button";
          button.dataset.tab = pane.dataset.pane;
          if (title) {
            button.innerHTML = title.innerHTML;
          } else {
            button.textContent = label;
          }
          button.addEventListener("click", () => activate(pane, true));
          navHost.appendChild(button);
          items.push(button);
          if (sectionSelect) {
            const option = document.createElement("option");
            option.value = pane.dataset.pane;
            option.textContent = label;
            sectionSelect.appendChild(option);
          }
        });
        sectionSelect?.addEventListener("change", () => ctx.openPane(sectionSelect.value));
        ctx.openPane = (slug) => {
          const pane = panes.find((p) => p.dataset.pane === slug);
          if (pane) activate(pane, true);
          return !!pane;
        };
        help.addEventListener("click", (e) => {
          const pointer = closestTarget(e, "[data-je-open-pane]");
          if (!pointer) return;
          const slug = pointer.dataset.jeOpenPane ?? "";
          ctx.openPane(slug);
          const pane = panes.find((p) => p.dataset.pane === slug);
          const heading = pane && (queryElement(pane, '[role="tab"][aria-selected="true"]') || queryElement(pane, ".je-pane-title")) || null;
          if (heading) {
            if (!heading.matches("button")) heading.tabIndex = -1;
            heading.focus();
          }
        });
        const backButton = help.querySelector("#jePanelBack");
        if (backButton) {
          backButton.addEventListener("click", () => {
            body.classList.remove("je-pane-open");
            syncLayerFocus(true);
            resetAutoCloseTimer();
          });
        }
        const search = searchInput;
        const results = searchResults;
        const renderResults = (query) => {
          if (!results) return;
          const found = [];
          if (query) {
            for (const provider of searchProviders) {
              try {
                for (const hit of provider.search(query) || []) found.push({ label: hit.label, path: hit.path, run: () => hit.run(), pane: provider.pane });
              } catch (err) {
                console.warn("🪼 Jellyfin Enhanced: settings search provider failed", err);
              }
            }
          }
          const shown = found.slice(0, MAX_RESULTS);
          results.replaceChildren(...shown.map((hit) => {
            const li = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.className = "je-panel-search-result";
            button.textContent = hit.label;
            const where = document.createElement("span");
            where.textContent = hit.path;
            button.appendChild(where);
            button.addEventListener("click", () => {
              if (hit.pane) ctx.openPane(hit.pane);
              hit.run();
              resetAutoCloseTimer();
            });
            li.appendChild(button);
            return li;
          }));
          results.hidden = shown.length === 0;
        };
        if (search) {
          search.addEventListener("input", () => {
            const query = search.value.trim().toLowerCase();
            items.forEach((button) => {
              const pane = panes.find((p) => p.dataset.pane === button.dataset.tab);
              const hit = !query || !!pane && (pane.textContent || "").toLowerCase().includes(query);
              button.style.display = hit ? "" : "none";
            });
            renderResults(query);
            resetAutoCloseTimer();
          });
          search.addEventListener("keydown", (e) => {
            const first = results ? queryButton(results, "button") : null;
            if (!first) return;
            if (e.key === "Enter") {
              e.preventDefault();
              first.click();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              first.focus();
            }
          });
          results?.addEventListener("keydown", (e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            const buttons = queryElements(results, "button");
            const at = buttons.findIndex((button) => button === document.activeElement);
            if (at < 0) return;
            e.preventDefault();
            const next = at + (e.key === "ArrowDown" ? 1 : -1);
            (next < 0 ? search : buttons[Math.min(next, buttons.length - 1)])?.focus();
          });
        }
        const lastTab = JE.currentSettings.lastOpenedTab;
        const initial = panes.find((p) => p.dataset.pane === lastTab) || panes[0];
        if (phoneMedia.matches) {
          panes.forEach((p) => p.classList.remove("active"));
          syncLayerFocus(false);
        } else if (initial) {
          activate(initial, false);
        }
        panelMediaCleanups.push(() => phoneMedia.removeEventListener("change", handlePhoneMediaChange));
      })();
      const isEditableKeyboardTarget = (target) => target instanceof HTMLElement && isTextEntryType(target.tagName, target instanceof HTMLInputElement ? target.type : "", target.isContentEditable);
      const closeHelp = (ev) => {
        const keyboardClose = ev instanceof KeyboardEvent && ev.type === "keydown" && (ev.key === "Escape" || ev.key === "?" && !isEditableKeyboardTarget(ev.target));
        if (keyboardClose || ev.type === "click" && ev.target instanceof Element && ev.target.id === "closeSettingsPanel") {
          ev.stopPropagation();
          closePanel();
        }
      };
      document.addEventListener("keydown", closeHelp);
      const closeButton = document.getElementById("closeSettingsPanel");
      if (!closeButton) throw new TypeError("Missing panel control #closeSettingsPanel");
      closeButton.addEventListener("click", closeHelp);
      if (!JE.pluginConfig.DisableAllShortcuts) {
        document.removeEventListener("keydown", JE.keyListener, true);
      }
      internal.wireSettingsListeners?.(ctx);
      internal.wireTagLooks?.(ctx);
      internal.wireHiddenContentListeners?.(ctx);
      featureCtx.peer("spoilerBlur")?.wireSettings?.(ctx);
      internal.wireMiscSettingsControls?.(ctx);
      internal.wireTagGroupEditor?.(ctx);
      internal.wireLanguageControls?.(ctx);
      internal.wireMediaTagsHub?.(ctx);
    };
  }
  installUiPanel(panelHost());
})();
})();
//# sourceMappingURL=ui-panel.js.map
