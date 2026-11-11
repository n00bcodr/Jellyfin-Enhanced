(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared2 = core.core?.featureContext;
    if (typeof shared2 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared2(feature, core, slots);
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
  var export1 = /* @__PURE__ */ sharedExport(shared, "decodeAdvancedData");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export20 = /* @__PURE__ */ sharedExport(shared, "isSafeTmdbImagePath");

  // client/src/features/seerr/core/runtime.ts
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

  // client/src/features/seerr/core/modal.ts
  var LOG = "🪼 Jellyfin Enhanced: Jellyseerr Modal:";
  var FOCUSABLE_TRAP = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var FOCUSABLE_FIRST = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]';
  var TV_BACK_KEYS = ["Escape", "BrowserBack", "GoBack"];
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i] ?? "Bytes"}`;
  }
  function formatFolderLabel(folder) {
    return typeof folder.freeSpace === "number" ? `${folder.path} (${formatBytes(folder.freeSpace)})` : folder.path;
  }
  function installModal(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "modal")) return;
    const escapeHtml = escapeWith(JE);
    const historyKey = "jeSeerrModal";
    let nextModal = 0;
    const retiredEntries = /* @__PURE__ */ new Map();
    const historyToken = () => {
      const state = window2.history.state;
      return export19(state) && typeof state[historyKey] === "string" ? state[historyKey] : null;
    };
    window2.addEventListener("popstate", () => {
      const token = historyToken();
      if (token && retiredEntries.get(token) === window2.location.href) {
        retiredEntries.delete(token);
        window2.history.back();
      }
    });
    function enableTvSelectPicker(modalElement, bodyEl) {
      let picker = null;
      let owner = null;
      const closePicker = (restoreFocus = true) => {
        if (!picker) return;
        document2.removeEventListener("keydown", onPickerKey, true);
        picker.remove();
        picker = null;
        if (restoreFocus) owner?.focus();
        owner = null;
      };
      function onPickerKey(event) {
        if (!TV_BACK_KEYS.includes(event.key) && event.keyCode !== 10009 && event.keyCode !== 461) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closePicker();
      }
      const openPicker = (select) => {
        closePicker();
        owner = select;
        const list = document2.createElement("div");
        list.className = "jellyseerr-tv-picker";
        list.setAttribute("role", "listbox");
        for (const option of Array.from(select.options)) {
          const item = document2.createElement("button");
          item.type = "button";
          item.className = "jellyseerr-tv-picker-option focusable";
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", String(option.value === select.value));
          item.textContent = option.textContent;
          item.addEventListener("click", () => {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            closePicker();
          });
          list.appendChild(item);
        }
        picker = list;
        select.insertAdjacentElement("afterend", list);
        document2.addEventListener("keydown", onPickerKey, true);
        const selected = list.querySelector('[aria-selected="true"]') || list.firstElementChild;
        if (selected instanceof HTMLElement) selected.focus();
      };
      const intercept = (event) => {
        const select = event.target instanceof Element ? event.target.closest("select") : null;
        if (!select || !bodyEl.contains(select)) return;
        if (event.type === "keydown" && (!(event instanceof KeyboardEvent) || event.key !== "Enter")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type !== "mousedown") openPicker(select);
      };
      for (const type of ["mousedown", "click", "keydown"]) modalElement.addEventListener(type, intercept, true);
      return () => {
        document2.removeEventListener("keydown", onPickerKey, true);
        for (const type of ["mousedown", "click", "keydown"]) modalElement.removeEventListener(type, intercept, true);
        closePicker(false);
      };
    }
    function create(options) {
      const { title, subtitle, bodyHtml, backdropPath, backdropUrl, onSave, onClose, buttonText } = options;
      const modalElement = document2.createElement("div");
      modalElement.className = "jellyseerr-season-modal";
      modalElement.setAttribute("role", "dialog");
      modalElement.setAttribute("aria-modal", "true");
      modalElement.setAttribute("tabindex", "-1");
      let backdropImage;
      if (backdropUrl) backdropImage = `url('${backdropUrl.replace(/['"\\\s]/g, (c) => c === "'" ? "%27" : encodeURIComponent(c))}')`;
      else if (backdropPath && export20(backdropPath)) backdropImage = `url('https://image.tmdb.org/t/p/w1280${escapeHtml(backdropPath)}')`;
      else backdropImage = "linear-gradient(45deg, #3b82f6, #8b5cf6)";
      const contentEl = document2.createElement("div");
      contentEl.className = "jellyseerr-season-content";
      contentEl.setAttribute("role", "document");
      contentEl.setAttribute("aria-labelledby", "jellyseerr-modal-title");
      const headerEl = document2.createElement("div");
      headerEl.className = "jellyseerr-season-header";
      headerEl.style.cssText = `background-image: ${backdropImage}; background-size: cover; background-position: center;`;
      const titleEl = document2.createElement("div");
      titleEl.id = "jellyseerr-modal-title";
      titleEl.className = "jellyseerr-season-title";
      titleEl.textContent = title;
      const subtitleEl = document2.createElement("div");
      subtitleEl.className = "jellyseerr-season-subtitle";
      subtitleEl.textContent = subtitle;
      headerEl.append(titleEl, subtitleEl);
      const bodyEl = document2.createElement("div");
      bodyEl.className = "jellyseerr-modal-body";
      bodyEl.style.cssText = "padding: 24px; max-height: calc(80vh - 200px); overflow-y: auto;";
      bodyEl.innerHTML = bodyHtml;
      const footerEl = document2.createElement("div");
      footerEl.className = "jellyseerr-modal-footer";
      const cancelBtn = document2.createElement("button");
      cancelBtn.className = "jellyseerr-modal-button jellyseerr-modal-button-secondary";
      cancelBtn.setAttribute("aria-label", JE.t("jellyseerr_modal_cancel"));
      cancelBtn.textContent = JE.t("jellyseerr_modal_cancel");
      const primaryBtn = document2.createElement("button");
      primaryBtn.className = "jellyseerr-modal-button jellyseerr-modal-button-primary";
      const primaryLabel = buttonText || JE.t("jellyseerr_modal_request");
      primaryBtn.setAttribute("aria-label", primaryLabel);
      primaryBtn.textContent = primaryLabel;
      footerEl.append(cancelBtn, primaryBtn);
      contentEl.append(headerEl, bodyEl, footerEl);
      modalElement.appendChild(contentEl);
      const handleKeydown = (event) => {
        if (!ownsHistory()) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(modalElement.querySelectorAll(FOCUSABLE_TRAP));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey) {
          if (document2.activeElement === first || document2.activeElement === modalElement) {
            event.preventDefault();
            last.focus();
          }
        } else if (document2.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      const disposePicker = JE.core?.ui?.isTvLayout?.() ? enableTvSelectPicker(modalElement, bodyEl) : () => {
      };
      let isClosing = false;
      let shown = false;
      const token = String(Date.now()) + ":" + String(++nextModal);
      let openedUrl = "";
      const ownsHistory = () => shown && historyToken() === token && window2.location.href === openedUrl;
      const dismiss = (restoreHistory) => {
        if (isClosing) return;
        isClosing = true;
        disposePicker();
        if (typeof onClose === "function") {
          try {
            onClose();
          } catch (error) {
            console.error(LOG + " onClose handler failed:", error);
          }
        }
        window2.removeEventListener("popstate", onHistoryChange);
        document2.removeEventListener("keydown", handleKeydown);
        modalElement.classList.remove("show");
        modalElement.setAttribute("aria-hidden", "true");
        if (!document2.querySelector('.jellyseerr-season-modal:not([aria-hidden="true"])')) {
          document2.body.classList.remove("jellyseerr-modal-is-open");
        }
        window2.setTimeout(() => modalElement.remove(), 300);
        if (restoreHistory && shown) {
          if (ownsHistory()) window2.history.back();
          else retiredEntries.set(token, openedUrl);
        }
      };
      const close = () => dismiss(true);
      const onHistoryChange = (event) => {
        const state = event.state;
        if (!export19(state) || state[historyKey] !== token || !ownsHistory()) dismiss(false);
      };
      const show = () => {
        if (shown || isClosing) return;
        shown = true;
        openedUrl = window2.location.href;
        for (const closing of Array.from(document2.querySelectorAll('.jellyseerr-season-modal[aria-hidden="true"]'))) closing.remove();
        document2.body.appendChild(modalElement);
        document2.body.classList.add("jellyseerr-modal-is-open");
        const previous = window2.history.state;
        window2.history.pushState({ ...export19(previous) ? previous : {}, [historyKey]: token }, "", openedUrl);
        window2.addEventListener("popstate", onHistoryChange);
        document2.addEventListener("keydown", handleKeydown);
        window2.setTimeout(() => {
          if (isClosing || !modalElement.isConnected) return;
          modalElement.classList.add("show");
          const first = modalElement.querySelector(FOCUSABLE_FIRST);
          if (first instanceof HTMLElement) first.focus();
          else modalElement.focus();
        }, 10);
      };
      cancelBtn.addEventListener("click", close);
      modalElement.addEventListener("click", (event) => {
        if (event.target === modalElement) close();
      });
      primaryBtn.addEventListener("click", () => {
        void onSave(modalElement, primaryBtn, close);
      });
      return { modalElement, show, close };
    }
    function createAdvancedOptionsHTML(idPrefix) {
      const id = escapeHtml(idPrefix);
      return `
            <div class="jellyseerr-advanced-options">
                <h3>${JE.t("jellyseerr_advanced_options")}</h3>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${id}-server">${JE.t("jellyseerr_server_select")}</label>
                        <select is="emby-select" id="${id}-server" class="emby-select"></select>
                    </div>
                    <div class="jellyseerr-form-group">
                        <label for="${id}-quality">${JE.t("jellyseerr_quality_select")}</label>
                        <select is="emby-select" id="${id}-quality" class="emby-select"></select>
                    </div>
                </div>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${id}-folder">${JE.t("jellyseerr_folder_select")}</label>
                        <select is="emby-select" id="${id}-folder" class="emby-select"></select>
                    </div>
                </div>
            </div>
        `;
    }
    function populateAdvancedOptions(modalElement, value, idPrefix, is4k) {
      const data = export1(value);
      if (!/^[A-Za-z0-9_-]+$/.test(idPrefix)) return;
      let attempts = 0;
      const maxAttempts = 50;
      const interval = window2.setInterval(() => {
        const find = (suffix) => {
          const element = modalElement.querySelector(`#${idPrefix}-${suffix}`);
          return element instanceof HTMLSelectElement ? element : null;
        };
        const serverSelect = find("server");
        const qualitySelect = find("quality");
        const folderSelect = find("folder");
        if (!serverSelect || !qualitySelect || !folderSelect) {
          attempts++;
          if (attempts > maxAttempts) {
            window2.clearInterval(interval);
            console.error(`${LOG} Could not find advanced options elements in modal after ${maxAttempts} attempts.`);
          }
          return;
        }
        window2.clearInterval(interval);
        serverSelect.innerHTML = `<option value="">${JE.t("jellyseerr_server_placeholder")}</option>`;
        qualitySelect.innerHTML = `<option value="">${JE.t("jellyseerr_quality_placeholder")}</option>`;
        folderSelect.innerHTML = `<option value="">${JE.t("jellyseerr_folder_placeholder")}</option>`;
        const sorted = [...data.servers].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        for (const server of sorted) {
          const option = document2.createElement("option");
          option.value = String(server.id);
          option.textContent = server.name || `Server ${server.id}`;
          if (server.isDefault && (is4k === void 0 || !!server.is4k === !!is4k)) option.selected = true;
          serverSelect.appendChild(option);
        }
        const updateServerDependentOptions = () => {
          const selected = data.servers.find((server) => String(server.id) === serverSelect.value);
          qualitySelect.innerHTML = `<option value="">${JE.t("jellyseerr_quality_placeholder")}</option>`;
          folderSelect.innerHTML = `<option value="">${JE.t("jellyseerr_folder_placeholder")}</option>`;
          if (!selected) return;
          for (const profile of selected.qualityProfiles) {
            const option = document2.createElement("option");
            option.value = String(profile.id);
            option.textContent = profile.name || `Profile ${profile.id}`;
            if (profile.id === selected.activeProfileId) option.selected = true;
            qualitySelect.appendChild(option);
          }
          for (const folder of selected.rootFolders) {
            const option = document2.createElement("option");
            option.value = folder.path;
            option.textContent = formatFolderLabel(folder);
            if (folder.path === selected.activeDirectory) option.selected = true;
            folderSelect.appendChild(option);
          }
        };
        serverSelect.addEventListener("change", updateServerDependentOptions);
        if (serverSelect.value) updateServerDependentOptions();
      }, 100);
    }
    const modal = { create, createAdvancedOptionsHTML, populateAdvancedOptions };
    JE.jellyseerrModal = modal;
  }

  // client/src/features/seerr/core/modal-entry.ts
  installModal(seerrCoreHost());
})();
})();
//# sourceMappingURL=modal.js.map
