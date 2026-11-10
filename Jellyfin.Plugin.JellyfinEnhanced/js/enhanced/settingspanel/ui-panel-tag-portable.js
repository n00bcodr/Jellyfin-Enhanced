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

  // client/src/features/media-tags/settings/host.ts
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
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
  function queryButton(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLButtonElement ? found : null;
  }
  function queryElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
  }
  function setDisabled(node, disabled) {
    if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) node.disabled = disabled;
  }
  function focusElement(node, options) {
    if (node instanceof HTMLElement || node instanceof SVGElement) node.focus(options);
  }

  // client/src/features/media-tags/settings/portable-model.ts
  var record = (value) => value !== null && typeof value === "object" ? value : {};
  var get = (value, key) => Reflect.get(record(value), key);
  var list = (value) => Array.isArray(value) ? value : [];
  var changesOf = (value) => list(value).map((c) => ({ field: get(c, "field"), from: get(c, "from"), to: get(c, "to") }));
  var skipsOf = (value) => list(value).map((s) => ({ field: get(s, "field"), reason: get(s, "reason"), detail: get(s, "detail") }));
  function decodePreview(value) {
    const imported = get(value, "imported");
    return {
      changes: changesOf(get(value, "changes")),
      skipped: skipsOf(get(value, "skipped")),
      imported: imported !== null && typeof imported === "object" ? Object.keys(imported) : [],
      name: get(value, "name")
    };
  }
  var presetOf = (value) => ({ id: get(value, "id"), name: get(value, "name"), description: get(value, "description"), v: get(value, "v"), settings: get(value, "settings") });
  var isPresetSource = (value) => value === "builtIn" || value === "offered" || value === "mine";
  function decodePresets(value) {
    return {
      max: Number(get(value, "max")) || 10,
      builtIn: list(get(value, "builtIn")).map(presetOf),
      offered: list(get(value, "offered")).map(presetOf),
      mine: list(get(value, "mine")).map(presetOf)
    };
  }
  function exportedParts(value) {
    const settings = get(value, "settings");
    return { v: get(value, "v"), settings, fieldCount: Object.keys(record(settings)).length };
  }
  function savedPreset(value) {
    return { name: get(get(value, "preset"), "name"), skipped: skipsOf(get(value, "skipped")) };
  }
  function refusal(body) {
    const code = get(body, "error");
    return typeof code === "string" ? { code, max: get(body, "max") } : { code: "save" };
  }
  var statusOf = (err) => get(err, "status");

  // client/src/features/shared/settings-values.ts
  function isJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    if (typeof value === "object") return Object.values(value).every(isJson);
    return false;
  }

  // client/src/features/media-tags/settings/ui-panel-tag-portable.ts
  var PRESET_KIND = "je-media-tags-preset";
  var UNDO_MS = 1e4;
  var MAX_NAME = 60;
  var MAX_DESCRIPTION = 240;
  var MAX_VALUE_TEXT = 80;
  var ERROR_CODES = ["not-json", "not-object", "kind", "version", "newer", "settings", "name", "description", "empty", "full", "save"];
  var SKIP_REASONS = ["unknown", "secret", "signal", "invalid"];
  var FIELD_LABELS = {
    TagLayout: "common_layout",
    TagLabelDensity: "panel_settings_ui_tag_density",
    TagScale: "tag_scale_label",
    TagGap: "tag_gap_label",
    TagEdgeSpacing: "panel_settings_ui_tag_edge",
    TagKindLooks: "tag_kind_looks_title",
    TagStylePreset: "panel_settings_ui_tag_style_preset"
  };
  var GROUP_FIELDS = {
    QualityTagsEnabled: "quality",
    GenreTagsEnabled: "genre",
    LanguageTagsEnabled: "language",
    RatingTagsEnabled: "rating",
    AgeRatingTagsEnabled: "age_rating",
    StatusTagsEnabled: "status",
    AwardsTagsEnabled: "awards",
    LogoTagsEnabled: "logos",
    CustomTagsEnabled: "custom"
  };
  var own = (map, key) => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : void 0;
  function installUiPanelTagPortable(JE) {
    const internal = registry(JE);
    const GROUP_SWITCHES = [
      { key: "qualityTagsEnabled", group: "quality", container: "quality-overlay-container", init: () => JE.initializeQualityTags?.(), reinit: () => JE.reinitializeQualityTags?.() },
      { key: "genreTagsEnabled", group: "genre", container: "genre-overlay-container", init: () => JE.initializeGenreTags?.(), reinit: () => JE.reinitializeGenreTags?.() },
      { key: "languageTagsEnabled", group: "language", container: "language-overlay-container", init: () => JE.initializeLanguageTags?.(), reinit: () => JE.reinitializeLanguageTags?.() },
      { key: "ratingTagsEnabled", group: "rating", container: "rating-overlay-container", init: () => JE.initializeRatingTags?.(), reinit: () => JE.reinitializeRatingTags?.() },
      { key: "ageRatingTagsEnabled", group: "ageRating", container: "age-rating-overlay-container", init: () => JE.initializeAgeRatingTags?.(), reinit: () => JE.reinitializeAgeRatingTags?.() },
      { key: "statusTagsEnabled", group: "status", container: "status-overlay-container", init: () => JE.initializeStatusTags?.(), reinit: () => JE.reinitializeStatusTags?.() },
      { key: "awardsTagsEnabled", group: "awards", container: "awards-overlay-container", init: () => JE.initializeAwardsTags?.(), reinit: () => JE.reinitializeAwardsTags?.() },
      { key: "logoTagsEnabled", group: "logos", container: "logo-overlay-container", init: () => JE.initializeLogoTags?.(), reinit: () => JE.reinitializeLogoTags?.() },
      { key: "customTagsEnabled", group: "custom", container: "custom-overlay-container", init: () => JE.initializeCustomTags?.(), reinit: () => JE.reinitializeCustomTags?.() }
    ];
    const esc = (value) => JE.escapeHtml(String(value ?? ""));
    const tx = (key, params) => esc(JE.t(key, params));
    let lastImport = null;
    const fieldName = (field) => {
      const key = String(field);
      const vocab = JE.core?.tagLayout?.VOCABULARY_KEYS;
      const label = own(FIELD_LABELS, key);
      if (label && JE.t(label) !== label) return JE.t(label);
      const groupKey = own(GROUP_FIELDS, key);
      const groupLabel = groupKey ? vocab?.group?.[groupKey] : void 0;
      if (groupLabel) {
        const group = JE.t(groupLabel);
        if (group !== groupLabel) return JE.t("tag_portable_field_group", { group });
      }
      return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    };
    function optionText(field, value) {
      const L = JE.core?.tagLayout;
      if (!L || typeof value !== "string" || !value) return null;
      const vocab = L.VOCABULARY_KEYS;
      let key;
      if (field === "TagScale" && L.TAG_SCALES?.[value] !== void 0) return L.sizeLabel("scale", value);
      if (field === "TagLayout") key = vocab.layout?.[value];
      else if (field === "TagLabelDensity") key = `panel_settings_ui_tag_density_${value}`;
      else if (field === "TagGap") key = vocab.gap?.[value];
      else if (field === "TagEdgeSpacing") key = vocab.edge?.[value];
      else if (field === "TagStylePreset") key = vocab.preset?.[value];
      if (!key) return null;
      const text = JE.t(key);
      return text === key ? null : text;
    }
    function valueText(value, field) {
      if (value === null || value === void 0) return JE.t("tag_portable_value_inherit");
      if (typeof value === "boolean") return JE.t(value ? "tag_portable_value_on" : "tag_portable_value_off");
      const option = field ? optionText(field, value) : null;
      if (option) return option;
      const text = typeof value === "string" ? value === "" ? JE.t("tag_portable_value_empty") : value : String(JSON.stringify(value));
      return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT - 1)}…` : text;
    }
    function previewHtml(preview, opts = {}) {
      const { changes, skipped } = decodePreview(preview);
      const rows = changes.map((c) => `<li class="je-pt-change"><span class="je-pt-field" data-je-field="${esc(c.field)}">${esc(fieldName(c.field))}</span><span class="je-pt-values"><span class="je-pt-sr">${tx("tag_portable_was")} </span><span class="je-pt-from">${esc(valueText(c.from, String(c.field)))}</span><span class="je-pt-arrow" aria-hidden="true">→</span><span class="je-pt-sr"> ${tx("tag_portable_becomes")} </span><span class="je-pt-to">${esc(valueText(c.to, String(c.field)))}</span></span></li>`).join("");
      const skips = skipped.map((s) => `<li class="je-pt-skip"><span class="je-pt-field" data-je-field="${esc(s.field)}">${esc(fieldName(s.field))}</span><span class="je-pt-reason">${tx(`tag_portable_skip_${typeof s.reason === "string" && SKIP_REASONS.includes(s.reason) ? s.reason : "unknown"}`)}${s.detail ? ` <span class="je-pt-detail">(${esc(s.detail)})</span>` : ""}</span></li>`).join("");
      return (opts.summary === false ? "" : `<p class="je-pt-summary" data-je-summary>${tx(changes.length ? "tag_portable_changes_count" : "tag_portable_no_changes", { count: changes.length })}</p>`) + (changes.length ? `<ul class="je-pt-changes" aria-label="${tx("tag_portable_changes")}">${rows}</ul>` : "") + (skipped.length ? `<h4 class="je-pt-subtitle">${tx("tag_portable_skipped_count", { count: skipped.length })}</h4><p class="je-pt-hint">${tx("tag_portable_skipped_desc")}</p><ul class="je-pt-skips">${skips}</ul>` : "");
    }
    const errorText = (code, params) => JE.t(`tag_portable_error_${ERROR_CODES.includes(code) ? code : "save"}`.replace(/-/g, "_"), params);
    async function errorOf(err) {
      try {
        const json = err !== null && typeof err === "object" ? Reflect.get(err, "json") : void 0;
        const body = typeof json === "function" ? await Reflect.apply(json, err, []) : err;
        return refusal(body);
      } catch {
      }
      return { code: "save" };
    }
    function parseDocument(text) {
      try {
        const document2 = JSON.parse(String(text || "").trim());
        if (!document2 || typeof document2 !== "object" || Array.isArray(document2)) return { error: "not-object" };
        return { document: document2 };
      } catch {
        return { error: "not-json" };
      }
    }
    function download(document2, name) {
      const blob = new Blob([`${JSON.stringify(document2, null, 2)}
`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement("a");
      a.href = url;
      a.download = `${name}.json`;
      a.style.display = "none";
      window.document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    }
    async function copyText(text, fallback) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
      }
      if (!fallback) return false;
      fallback.closest("details")?.setAttribute("open", "");
      fallback.focus();
      fallback.select();
      try {
        return window.document.execCommand("copy");
      } catch {
        return false;
      }
    }
    function readFile(file) {
      if (typeof file.text === "function") return file.text();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });
    }
    const stamp = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    function openDialog({ host, title, className = "", onClose }) {
      const active = window.document.activeElement;
      const opener = active instanceof HTMLElement ? active : null;
      const id = `jePt${Math.random().toString(36).slice(2, 8)}`;
      const backdrop = window.document.createElement("div");
      backdrop.className = `je-pt-backdrop ${className}`.trim();
      backdrop.innerHTML = `<div class="je-pt-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}Title" tabindex="-1"><div class="je-pt-head"><h3 class="je-pt-title" id="${id}Title">${esc(title)}</h3><button type="button" class="je-pt-close" data-pt-close aria-label="${tx("awards_close")}"><span class="material-icons" aria-hidden="true">close</span></button></div><div class="je-pt-body"></div><p class="je-pt-status" role="status" aria-live="polite"></p><div class="je-pt-foot"></div></div>`;
      host.appendChild(backdrop);
      const dialog = backdrop.firstElementChild;
      const statusEl = dialog?.querySelector(".je-pt-status");
      const body = dialog?.querySelector(".je-pt-body");
      const foot = dialog?.querySelector(".je-pt-foot");
      if (!(dialog instanceof HTMLElement) || !(statusEl instanceof HTMLElement) || !(body instanceof HTMLElement) || !(foot instanceof HTMLElement)) {
        throw new TypeError("The dialog markup is incomplete");
      }
      let isClosed = false;
      const focusables = () => queryElements(dialog, "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary").filter((el) => !el.closest("[hidden]") && !(el.tagName !== "SUMMARY" && el.closest("details:not([open])")) && el.tabIndex >= 0);
      const close = () => {
        if (isClosed) return;
        isClosed = true;
        backdrop.remove();
        onClose?.();
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      };
      dialog.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        if (e.key !== "Tab") return;
        const items = focusables();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        e.stopPropagation();
        const at = items.findIndex((el) => el === window.document.activeElement);
        if (e.shiftKey && at <= 0) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === items.length - 1) {
          e.preventDefault();
          first.focus();
        }
      });
      backdrop.addEventListener("click", (e) => {
        if (closestTarget(e, "[data-pt-close]")) close();
      });
      const focusFirst = () => {
        const first = queryElement(dialog, "[data-pt-autofocus]") || focusables().find((el) => !el.matches("[data-pt-close]"));
        (first || dialog).focus({ preventScroll: true });
      };
      return {
        el: dialog,
        body,
        foot,
        status(message, kind = "") {
          statusEl.textContent = message;
          statusEl.dataset.kind = kind;
        },
        close,
        focusFirst,
        closed: () => isClosed
      };
    }
    function sourceHtml(hintKey) {
      return `<p class="je-pt-hint">${tx(hintKey)}</p>
            <label class="je-pt-file"><span class="material-icons" aria-hidden="true">upload_file</span><span>${tx("tag_portable_choose_file")}</span><input type="file" accept=".json,application/json" data-pt-file></label>
            <label class="je-pt-label" for="jePtPaste">${tx("tag_portable_paste")}</label>
            <textarea id="jePtPaste" class="je-pt-text" rows="8" spellcheck="false" data-pt-paste data-pt-autofocus placeholder='{"v":1,"kind":"je-media-tags-user","settings":{…}}'></textarea>`;
    }
    function wireSource(dialog) {
      const file = dialog.body.querySelector("[data-pt-file]");
      const paste = dialog.body.querySelector("[data-pt-paste]");
      if (!(file instanceof HTMLInputElement)) return;
      file.addEventListener("change", async () => {
        const chosen = file.files?.[0];
        if (!chosen) return;
        try {
          const text = await readFile(chosen);
          if (!(paste instanceof HTMLTextAreaElement)) throw new TypeError("The paste box is missing");
          paste.value = text;
          dialog.status(JE.t("tag_portable_file_loaded", { name: chosen.name }));
        } catch {
          dialog.status(errorText("not-json"), "error");
        }
      });
    }
    const DIALOG_CSS = `
        .je-pt-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: flex-start; justify-content: center; padding: 24px 12px; box-sizing: border-box; background: rgba(0,0,0,0.6); overflow-y: auto; }
        .je-pt-dialog { width: min(640px, 100%); box-sizing: border-box; margin: auto 0; padding: 0; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: #1d2026; color: #fff; box-shadow: 0 10px 40px rgba(0,0,0,0.5); font-size: 14px; text-align: left; }
        .je-pt-dialog:focus { outline: none; }
        .je-pt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px 6px 16px; }
        .je-pt-title { margin: 0; font-size: 17px; font-weight: 600; }
        .je-pt-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 0; border-radius: 6px; background: transparent; color: #fff; cursor: pointer; }
        .je-pt-close:hover { background: rgba(255,255,255,0.08); }
        .je-pt-body { padding: 0 16px; max-height: min(60vh, 520px); overflow-y: auto; }
        .je-pt-hint { margin: 4px 0 10px; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.7); }
        .je-pt-label { display: block; margin: 10px 0 4px; font-size: 13px; font-weight: 600; }
        .je-pt-text, .je-pt-input { box-sizing: border-box; width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #80868f; background: #12141a; color: #fff; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
        .je-pt-input { font: inherit; font-size: 14px; min-height: 40px; }
        .je-pt-text[readonly] { color: #d6dbe4; }
        .je-pt-file { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; border-radius: 6px; border: 1px dashed rgba(255,255,255,0.35); cursor: pointer; font-size: 13px; font-weight: 600; }
        .je-pt-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
        .je-pt-file:focus-within { outline: 2px solid #fff; outline-offset: 2px; }
        .je-pt-summary { margin: 4px 0 8px; font-weight: 600; }
        .je-pt-doc { margin: 4px 0 8px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }
        .je-pt-doc > :not(summary) { margin-left: 10px; margin-right: 10px; }
        .je-pt-doc > textarea { width: calc(100% - 20px); margin-bottom: 10px; }
        .je-pt-doc-toggle { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 10px 0 6px; list-style: none; cursor: pointer; font-weight: 600; border-radius: 8px; }
        .je-pt-doc-toggle::-webkit-details-marker { display: none; }
        .je-pt-doc-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .je-pt-doc-toggle .material-icons { font-size: 20px; transition: transform 0.2s ease; }
        .je-pt-doc[open] > .je-pt-doc-toggle .material-icons { transform: rotate(180deg); }
        .je-pt-subtitle { margin: 14px 0 2px; font-size: 13px; font-weight: 600; color: #ffd699; }
        .je-pt-changes, .je-pt-skips { list-style: none; margin: 0 0 6px; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        .je-pt-change, .je-pt-skip { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 12px; padding: 9px 12px; font-size: 14px; }
        .je-pt-change + .je-pt-change, .je-pt-skip + .je-pt-skip { border-top: 1px solid rgba(255,255,255,0.07); }
        .je-pt-field { font-weight: 600; }
        .je-pt-values { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; font-size: 13px; }
        .je-pt-from { color: rgba(255,255,255,0.62); text-decoration: line-through; overflow-wrap: anywhere; }
        .je-pt-to { color: #8fe3a5; font-weight: 600; overflow-wrap: anywhere; }
        .je-pt-arrow { color: rgba(255,255,255,0.5); }
        .je-pt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .je-pt-reason { color: #ffd699; font-size: 13px; }
        .je-pt-detail { color: rgba(255,255,255,0.6); }
        .je-pt-status { min-height: 18px; margin: 8px 16px 0; font-size: 13px; color: #8fe3a5; }
        .je-pt-status:empty { min-height: 0; margin-top: 0; }
        .je-pt-status[data-kind="error"] { color: #ff8a80; }
        .je-pt-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; }
        .je-pt-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.46); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .je-pt-btn:hover { background: rgba(255,255,255,0.12); }
        .je-pt-btn[data-primary] { background: #0077a3; border-color: #0077a3; }
        .je-pt-btn[data-primary]:hover { background: #00688f; }
        .je-pt-btn:is(:disabled, [aria-disabled="true"]) { opacity: 0.45; cursor: default; }
        .je-pt-btn .material-icons { font-size: 18px; }
        :is(.je-pt-btn, .je-pt-close, .je-pt-text, .je-pt-input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        @media (max-width: 480px) {
            .je-pt-backdrop { padding: 8px; }
            .je-pt-foot .je-pt-btn { flex: 1 1 auto; justify-content: center; }
            .je-pt-btn, .je-pt-file { min-height: 44px; }
            .je-pt-close { width: 44px; height: 44px; }
            .je-pt-text, .je-pt-input { font-size: 16px; }
        }
    `;
    const injectDialogCss = () => {
      JE.core?.ui?.injectCss?.("je-tag-portable-dialog", DIALOG_CSS);
    };
    const buttonHtml = (action, labelKey, opts = {}) => `<button type="button" class="je-pt-btn" data-pt-action="${esc(action)}"${opts.primary ? " data-primary" : ""}>${opts.icon ? `<span class="material-icons" aria-hidden="true">${esc(opts.icon)}</span>` : ""}${tx(labelKey, opts.params)}</button>`;
    const tools = { openDialog, previewHtml, valueText, fieldName, errorText, errorOf, parseDocument, download, copyText, readFile, sourceHtml, wireSource, buttonHtml, injectDialogCss, stamp };
    internal.tagPortable = tools;
    const userId = () => optionalApiClient()?.getCurrentUserId?.() || "";
    const userUrl = (path) => apiClient().getUrl(`/JellyfinEnhanced/user-settings/${userId()}/media-tags/${path}`);
    const serverId = () => {
      try {
        const client = optionalApiClient();
        return client && (typeof client.serverId === "function" ? client.serverId() : client.serverId) || "";
      } catch {
        return "";
      }
    };
    function sessionCheck() {
      const user = userId();
      const server = serverId();
      const epoch = JE.session?.getEpoch?.();
      return () => userId() === user && serverId() === server && JE.session?.getEpoch?.() === epoch;
    }
    internal.buildTagPortableHtml = function() {
      return `
            <section class="je-mth-card je-mth-tp" id="jeMthPresets" aria-labelledby="jeMthPresetsTitle">
                <h4 class="je-mth-card-title" id="jeMthPresetsTitle">${tx("tag_presets_title")}</h4>
                <p class="je-mth-hint">${tx("tag_presets_desc")}</p>
                <div class="je-mth-tp-list" data-tp-list aria-live="polite"><p class="je-mth-hint">${tx("hidden_content_admin_loading")}</p></div>
                <div class="je-mth-tp-error" data-tp-error role="alert" hidden><span data-tp-error-text></span><button type="button" class="je-mth-button" data-tp="delete-retry">${tx("admin_tags_retry")}</button></div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-tp="save-preset"><span class="material-icons" aria-hidden="true">bookmark_add</span><span data-je-label>${tx("tag_presets_save")}</span></button>
                    <button type="button" class="je-mth-button" data-tp="import-preset"><span class="material-icons" aria-hidden="true">file_open</span><span data-je-label>${tx("tag_presets_import")}</span></button>
                </div>
            </section>
            <section class="je-mth-card je-mth-tp" id="jeMthPortable" aria-labelledby="jeMthPortableTitle">
                <h4 class="je-mth-card-title" id="jeMthPortableTitle">${tx("tag_portable_title")}</h4>
                <p class="je-mth-hint">${tx("tag_portable_desc")}</p>
                <div class="je-mth-tp-undo" data-tp-undo role="status" hidden></div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-tp="export"><span class="material-icons" aria-hidden="true">download</span><span data-je-label>${tx("tag_portable_export")}</span></button>
                    <button type="button" class="je-mth-button" data-tp="import"><span class="material-icons" aria-hidden="true">upload</span><span data-je-label>${tx("tag_portable_import")}</span></button>
                </div>
            </section>`;
    };
    const CARD_CSS = `
        #jellyfin-enhanced-panel .je-mth-tp-list { display: flex; flex-direction: column; gap: 10px; }
        #jellyfin-enhanced-panel .je-mth-tp-group-title { margin: 4px 0 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
        #jellyfin-enhanced-panel .je-mth-tp-items { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-tp-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 8px 10px 8px 12px; }
        #jellyfin-enhanced-panel .je-mth-tp-item + .je-mth-tp-item { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-tp-text { flex: 1 1 220px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-tp-name { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-tp-desc { font-size: 12px; line-height: 1.4; color: rgba(255,255,255,0.65); }
        #jellyfin-enhanced-panel .je-mth-tp-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-tp-buttons .je-mth-button { min-height: 34px; padding: 0 10px; }
        #jellyfin-enhanced-panel .je-mth-tp-undo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 4px 0 6px; padding: 8px 10px; border-radius: 6px; background: rgba(0,164,220,0.14); border: 1px solid rgba(0,164,220,0.4); font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-tp-undo[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-tp-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 8px 0 0; padding: 8px 10px; border-radius: 6px; background: rgba(255,138,128,0.12); border: 1px solid rgba(255,138,128,0.45); font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-tp-error[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-tp-count { font-weight: 400; color: rgba(255,255,255,0.55); text-transform: none; letter-spacing: 0; }
    `;
    const toClient = (value) => {
      const converted = typeof JE.toCamelCase === "function" ? Reflect.get(Object(JE.toCamelCase({ v: value })), "v") : value;
      if (converted === void 0) return null;
      if (!isJson(converted)) throw new TypeError("An imported value is not JSON");
      return converted;
    };
    const clientKey = (field) => {
      const name = String(field);
      return name.charAt(0).toLowerCase() + name.slice(1);
    };
    async function writeChanges(changes, isCurrent) {
      const settings = JE.currentSettings;
      const before = {};
      const inheritedBefore = {};
      const wasOn = Object.fromEntries(GROUP_SWITCHES.map((g) => [g.key, !!settings[g.key]]));
      const nativeBefore = JE.userConfig?.settings?.useNativePosterTags;
      let nativeWritten;
      for (const change of changes) {
        const key = clientKey(change.field);
        before[key] = settings[key];
        inheritedBefore[key] = JE.isSettingInherited?.(settings, key) === true;
        const value = toClient(change.to);
        if (key === "useNativePosterTags") {
          JE.userConfig = JE.userConfig || { shortcuts: { Shortcuts: [] } };
          JE.userConfig.settings = JE.userConfig.settings || {};
          JE.userConfig.settings.useNativePosterTags = value;
          nativeWritten = value;
          settings.useNativePosterTags = value !== false;
        } else if (JE.setSettingInherited?.(settings, key, value === null)) {
          if (value !== null) settings[key] = value;
        } else settings[key] = value;
      }
      const owned = (key) => JSON.stringify([settings[key] ?? null, JE.isSettingInherited?.(settings, key) === true]);
      const written = Object.fromEntries(Object.keys(before).map((key) => [key, owned(key)]));
      let rolledBack = false;
      const rollback = () => {
        rolledBack = true;
        for (const key of Object.keys(before)) {
          if (owned(key) !== written[key]) continue;
          if (key === "useNativePosterTags") {
            const native = JE.userConfig?.settings;
            if (native?.useNativePosterTags !== nativeWritten) continue;
            if (native) native.useNativePosterTags = nativeBefore;
          }
          settings[key] = before[key];
          if (JE.setSettingInherited?.(settings, key, inheritedBefore[key] === true)) settings[key] = before[key];
        }
      };
      try {
        await JE.saveUserSettings("settings.json", settings, { throwOnError: true, isCurrent, onError: rollback });
      } catch (err) {
        if (rolledBack && isCurrent()) {
          JE.core?.tagLayout?.invalidateSettings?.();
          JE.reinitializeTagLayout?.();
        }
        throw err;
      }
      if (!isCurrent()) return false;
      JE.core?.tagLayout?.invalidateSettings?.();
      for (const g of GROUP_SWITCHES) {
        const on = !!settings[g.key];
        try {
          if (on && !wasOn[g.key]) g.init();
          else if (on) g.reinit();
          else if (wasOn[g.key]) internal.removeTagGroup?.(g.group, g.container);
        } catch (err) {
          console.warn(`🪼 Jellyfin Enhanced: could not redraw the ${g.group} tags after an import`, err);
        }
      }
      JE.reinitializeTagLayout?.();
      return true;
    }
    const wireTagPortable = function(hub, ctx, hooks) {
      const presetsCard = queryElement(hub, "#jeMthPresets");
      const portableCard = queryElement(hub, "#jeMthPortable");
      const client = optionalApiClient();
      if (!presetsCard || !portableCard || !client) return () => {
      };
      const list2 = queryElement(presetsCard, "[data-tp-list]");
      const undoBar = queryElement(portableCard, "[data-tp-undo]");
      const deleteError = queryElement(presetsCard, "[data-tp-error]");
      if (!list2 || !undoBar || !deleteError) return () => {
      };
      JE.core?.ui?.injectCss?.("je-media-tags-portable", CARD_CSS);
      injectDialogCss();
      const host = ctx.help || hub;
      const touch = () => {
        try {
          ctx.resetAutoCloseTimer?.();
        } catch {
        }
      };
      const viewSession = sessionCheck();
      let disposed = false;
      let dialog = null;
      let undoTimer;
      let presets = null;
      let failedDelete = null;
      const ajax = (request) => apiClient().ajax(request);
      const live = () => !disposed && viewSession();
      const presetText = (preset, source) => {
        if (source !== "builtIn") return { name: String(preset.name || ""), description: String(preset.description || "") };
        const builtin = JE.core.tagLayout?.VOCABULARY_KEYS.builtin;
        return { name: JE.t(builtin?.[`${preset.id}`] ?? ""), description: JE.t(builtin?.[`${preset.id}_desc`] ?? "") };
      };
      const drawPresets = () => {
        if (!presets) return;
        const loaded = presets;
        const group = (source, titleKey, items, count) => items.length || source === "mine" ? `
                <div class="je-mth-tp-group" data-tp-source="${source}">
                    <h5 class="je-mth-tp-group-title">${tx(titleKey)}${count ? ` <span class="je-mth-tp-count">${esc(count)}</span>` : ""}</h5>
                    ${items.length ? `<ul class="je-mth-tp-items">${items.map((p, i) => {
          const text = presetText(p, source);
          return `<li class="je-mth-tp-item" data-tp-index="${i}" data-tp-id="${esc(p.id ?? "")}">
                            <div class="je-mth-tp-text"><div class="je-mth-tp-name" data-je-label>${esc(text.name)}</div>${text.description ? `<div class="je-mth-tp-desc">${esc(text.description)}</div>` : ""}</div>
                            <div class="je-mth-tp-buttons">
                                <button type="button" class="je-mth-button" data-tp="apply" aria-label="${tx("tag_presets_apply_named", { name: text.name })}">${tx("tag_presets_apply")}</button>
                                <button type="button" class="je-mth-button" data-tp="share" aria-label="${tx("tag_presets_share_named", { name: text.name })}">${tx("tag_presets_share")}</button>
                                ${source === "mine" ? `<button type="button" class="je-mth-button" data-tp="delete" aria-label="${tx("admin_tags_rules_delete", { name: text.name })}">${tx("reviews_delete")}</button>` : ""}
                            </div>
                        </li>`;
        }).join("")}</ul>` : `<p class="je-mth-hint">${tx("tag_presets_none_yet")}</p>`}
                </div>` : "";
        const active = window.document.activeElement;
        const keep = active instanceof HTMLElement && list2.contains(active) && active.dataset.tp ? {
          source: active.closest("[data-tp-source]")?.getAttribute("data-tp-source"),
          id: active.closest("[data-tp-id]")?.getAttribute("data-tp-id"),
          action: active.dataset.tp
        } : null;
        list2.innerHTML = group("builtIn", "tag_presets_builtin", loaded.builtIn) + group("offered", "tag_presets_offered", loaded.offered) + group("mine", "tag_presets_mine", loaded.mine, JE.t("tag_looks_condition_count", { count: loaded.mine.length, max: loaded.max }));
        if (keep) {
          const again = Array.from(list2.querySelectorAll(`[data-tp-source="${keep.source}"] [data-tp="${keep.action}"]`)).find((el) => el.closest("[data-tp-id]")?.getAttribute("data-tp-id") === keep.id);
          focusElement(again || presetsCard.querySelector('[data-tp="save-preset"]:not([disabled])'), { preventScroll: true });
        }
        const full = loaded.mine.length >= loaded.max;
        for (const button of queryElements(presetsCard, '[data-tp="save-preset"], [data-tp="import-preset"]')) {
          setDisabled(button, full);
          button.title = full ? JE.t("tag_presets_full", { max: loaded.max }) : "";
        }
      };
      const loadPresets = async () => {
        try {
          const answer = await ajax({ type: "GET", url: userUrl("presets"), dataType: "json" });
          if (!live()) return;
          presets = decodePresets(answer);
          drawPresets();
        } catch (err) {
          if (!live()) return;
          console.warn("🪼 Jellyfin Enhanced: could not load the Media Tags presets", err);
          const hadFocus = list2.contains(window.document.activeElement);
          list2.innerHTML = `<p class="je-mth-off">${tx("tag_presets_load_failed")}</p>`;
          if (hadFocus) focusElement(presetsCard.querySelector('[data-tp="save-preset"]'), { preventScroll: true });
        }
      };
      const saveFirst = async (isCurrent) => {
        try {
          await JE.saveUserSettings("settings.json", JE.currentSettings, { throwOnError: true, isCurrent });
          return true;
        } catch (err) {
          console.warn("🪼 Jellyfin Enhanced: the Media Tags settings are not saved yet", err);
          return false;
        }
      };
      const fetchExport = async (isCurrent) => {
        const saved = await saveFirst(isCurrent);
        if (!isCurrent()) return null;
        if (!saved) return { unsaved: true };
        return { document: await ajax({ type: "GET", url: userUrl("export"), dataType: "json" }) };
      };
      const clientSnapshot = (fields) => JSON.stringify(fields.map((field) => {
        const key = clientKey(field);
        const settings = JE.currentSettings || {};
        return [
          settings[key] ?? null,
          JE.isSettingInherited?.(settings, key) === true,
          key === "useNativePosterTags" ? JE.userConfig?.settings?.useNativePosterTags ?? null : null
        ];
      }));
      const showLoading = (d, on) => {
        const line = queryElement(d.body, "[data-pt-loading]");
        if (line) line.hidden = !on;
      };
      const show = (title) => {
        dialog?.close();
        const opened = openDialog({ host, title, onClose: () => {
          dialog = null;
          touch();
        } });
        dialog = opened;
        opened.el.addEventListener("input", touch);
        opened.el.addEventListener("click", touch);
        return opened;
      };
      const actionOf = (e) => closestTarget(e, "[data-pt-action]");
      const openExport = async () => {
        const current = sessionCheck();
        const d = show(JE.t("tag_portable_export_title"));
        d.body.innerHTML = `<p class="je-pt-hint">${tx("tag_portable_export_desc")}</p><p class="je-pt-hint" data-pt-loading>${tx("hidden_content_admin_loading")}</p>`;
        d.foot.innerHTML = buttonHtml("close", "awards_close");
        d.foot.onclick = (e) => {
          const button = actionOf(e);
          const action = button?.getAttribute("data-pt-action");
          if (button && action === "retry") {
            if (button.getAttribute("aria-disabled") === "true") return;
            button.setAttribute("aria-disabled", "true");
            showLoading(d, true);
            d.status(JE.t("tag_portable_checking"));
            load();
          } else if (action === "close") d.close();
        };
        d.focusFirst();
        const offerRetry = () => {
          const retry = d.foot.querySelector('[data-pt-action="retry"]');
          if (retry) {
            retry.removeAttribute("aria-disabled");
            return;
          }
          d.foot.innerHTML = buttonHtml("close", "awards_close") + buttonHtml("retry", "admin_tags_retry", { primary: true });
          focusElement(d.foot.querySelector('[data-pt-action="retry"]'));
        };
        const load = async () => {
          let result;
          try {
            result = await fetchExport(current);
          } catch (err) {
            if (!live() || !current() || d.closed()) return;
            console.warn("🪼 Jellyfin Enhanced: could not export the Media Tags settings", err);
            showLoading(d, false);
            d.status(JE.t("tag_portable_export_failed"), "error");
            offerRetry();
            return;
          }
          if (!live() || !current() || d.closed() || !result) return;
          if (result.unsaved) {
            showLoading(d, false);
            d.status(JE.t("tag_portable_export_unsaved"), "error");
            offerRetry();
            return;
          }
          d.status("");
          showExport(d, result.document);
        };
        await load();
      };
      const showExport = (d, document2) => {
        const text = JSON.stringify(document2, null, 2);
        const { fieldCount } = exportedParts(document2);
        d.body.innerHTML = `<p class="je-pt-hint">${tx("tag_portable_export_desc")}</p>
                <details class="je-pt-doc"><summary class="je-pt-doc-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${tx("tag_portable_show_document", { count: fieldCount })}</summary>
                <label class="je-pt-label" for="jePtExport">${tx("tag_portable_export_document", { count: fieldCount })}</label>
                <textarea id="jePtExport" class="je-pt-text" rows="12" readonly spellcheck="false">${esc(text)}</textarea></details>`;
        d.foot.innerHTML = buttonHtml("close", "awards_close") + buttonHtml("copy", "tag_portable_copy", { icon: "content_copy" }) + buttonHtml("download", "tag_portable_download", { icon: "download", primary: true });
        const area = d.body.querySelector("textarea");
        d.foot.onclick = async (e) => {
          const action = actionOf(e)?.getAttribute("data-pt-action");
          if (action === "download") {
            download(document2, `jellyfin-media-tags-${stamp()}`);
            d.status(JE.t("tag_portable_downloaded"));
          } else if (action === "copy") {
            d.status(JE.t(await copyText(text, area ?? void 0) ? "tag_portable_copied" : "tag_portable_copy_failed"), "");
          } else if (action === "close") d.close();
        };
        focusElement(d.foot.querySelector('[data-pt-action="download"]'));
      };
      const showPreview = async (d, document2, back, note) => {
        const current = sessionCheck();
        d.status(JE.t("tag_portable_checking"));
        showLoading(d, true);
        const failed = (message) => {
          showLoading(d, false);
          d.status(message, "error");
          if (d.body.querySelector("[data-pt-paste]")) return;
          const again = d.foot.querySelector('[data-pt-action="retry"]');
          if (again) {
            again.removeAttribute("aria-disabled");
            return;
          }
          d.foot.innerHTML = (back ? buttonHtml("back", "tag_portable_back") : "") + buttonHtml("cancel", "jellyseerr_modal_cancel") + buttonHtml("retry", "admin_tags_retry", { primary: true });
          d.foot.onclick = (e) => {
            const button = actionOf(e);
            const action = button?.getAttribute("data-pt-action");
            if (action === "back") back?.();
            else if (action === "cancel") d.close();
            else if (button && action === "retry" && button.getAttribute("aria-disabled") !== "true") {
              button.setAttribute("aria-disabled", "true");
              showPreview(d, document2, back, note);
            }
          };
          focusElement(d.foot.querySelector('[data-pt-action="retry"]'));
        };
        const saved = await saveFirst(current);
        if (!live() || !current() || d.closed()) return;
        if (!saved) {
          failed(JE.t("tag_portable_import_unsaved"));
          return;
        }
        let answer;
        try {
          answer = await ajax({ type: "POST", url: userUrl("preview"), data: JSON.stringify(document2), contentType: "application/json", dataType: "json" });
        } catch (err) {
          if (!live() || d.closed()) return;
          const { code } = await errorOf(err);
          if (!live() || !current() || d.closed()) return;
          failed(errorText(code));
          return;
        }
        if (!live() || !current() || d.closed()) return;
        d.status(note || "");
        const preview = decodePreview(answer);
        const changes = preview.changes;
        const fields = Array.from(/* @__PURE__ */ new Set([...preview.imported, ...changes.map((c) => c.field)]));
        const compared = clientSnapshot(fields);
        d.body.innerHTML = (preview.name ? `<p class="je-pt-hint">${tx("tag_portable_preset_named", { name: String(preview.name) })}</p>` : "") + previewHtml(answer || {});
        d.foot.innerHTML = (back ? buttonHtml("back", "tag_portable_back") : "") + buttonHtml("cancel", "jellyseerr_modal_cancel") + (changes.length ? buttonHtml("apply", "tag_portable_apply_count", { primary: true, params: { count: changes.length } }) : "");
        d.foot.onclick = async (e) => {
          const button = actionOf(e);
          const action = button?.dataset.ptAction;
          if (action === "back") back?.();
          else if (action === "cancel") d.close();
          else if (action === "apply" && button) {
            if (clientSnapshot(fields) !== compared) {
              showPreview(d, document2, back, JE.t("tag_portable_import_changed"));
              return;
            }
            setDisabled(button, true);
            d.status(JE.t("tag_portable_applying"));
            try {
              await apply(changes);
            } catch (err) {
              if (!live()) return;
              console.warn("🪼 Jellyfin Enhanced: could not apply the imported Media Tags settings", err);
              if (d.closed()) {
                hooks.announce(JE.t("tag_portable_apply_failed"));
                return;
              }
              setDisabled(button, false);
              d.status(JE.t("tag_portable_apply_failed"), "error");
            }
          }
        };
        focusElement(d.foot.querySelector('[data-pt-action="apply"]') || d.foot.querySelector('[data-pt-action="cancel"]'));
      };
      const openSource = ({ titleKey, hintKey, onDocument, nextKey = "tag_portable_preview" }) => {
        const d = show(JE.t(titleKey));
        const step = () => {
          d.body.innerHTML = sourceHtml(hintKey);
          d.foot.innerHTML = buttonHtml("cancel", "jellyseerr_modal_cancel") + buttonHtml("next", nextKey, { primary: true });
          wireSource(d);
          d.foot.onclick = (e) => {
            const action = actionOf(e)?.getAttribute("data-pt-action");
            if (action === "cancel") {
              d.close();
              return;
            }
            if (action !== "next") return;
            const paste = d.body.querySelector("[data-pt-paste]");
            if (!(paste instanceof HTMLTextAreaElement)) throw new TypeError("The paste box is missing");
            const parsed = parseDocument(paste.value);
            if (parsed.error || !parsed.document) {
              d.status(errorText(parsed.error ?? "not-object"), "error");
              return;
            }
            onDocument(d, parsed.document, () => {
              d.status("");
              step();
              d.focusFirst();
            });
          };
          d.focusFirst();
        };
        step();
      };
      const apply = async (changes, opts = {}) => {
        const current = sessionCheck();
        if (!live() || !await writeChanges(changes, current)) return;
        if (!opts.undo) lastImport = { changes: changes.slice(), until: Date.now() + UNDO_MS, count: changes.length, isCurrent: current };
        if (!live()) return;
        dialog?.close();
        reopen(opts.undo ? "tag_portable_undone" : null);
      };
      const reopen = (messageKey) => {
        internal.tagPortableReopen = { messageKey };
        ctx.closePanel?.();
        Promise.resolve(JE.showEnhancedPanel?.()).catch((err) => console.warn("🪼 Jellyfin Enhanced: could not open the settings again", err));
      };
      const drawUndo = () => {
        clearTimeout(undoTimer);
        const left = lastImport ? lastImport.until - Date.now() : 0;
        if (!lastImport || left <= 0 || !lastImport.isCurrent() || !live()) {
          const hadFocus = undoBar.contains(window.document.activeElement);
          undoBar.hidden = true;
          undoBar.innerHTML = "";
          if (hadFocus) focusElement(portableCard.querySelector('[data-tp="import"]'), { preventScroll: true });
          return;
        }
        undoBar.hidden = false;
        undoBar.innerHTML = `<span>${tx("tag_portable_applied", { count: lastImport.count })}</span><button type="button" class="je-mth-button" data-tp="undo">${tx("hidden_content_undo")}</button>`;
        undoTimer = setTimeout(() => {
          if (!disposed) drawUndo();
        }, left);
      };
      const undo = async () => {
        const last = lastImport;
        if (!last || !last.isCurrent() || !live()) return;
        lastImport = null;
        drawUndo();
        try {
          await apply(last.changes.map((c) => ({ field: c.field, from: c.to, to: c.from })), { undo: true });
        } catch (err) {
          console.warn("🪼 Jellyfin Enhanced: could not undo the Media Tags import", err);
          if (live()) hooks.announce(JE.t("tag_portable_apply_failed"));
        }
      };
      const presetOf2 = (button) => {
        const item = button.closest("[data-tp-index]");
        const source = button.closest("[data-tp-source]")?.getAttribute("data-tp-source");
        if (!item || !isPresetSource(source) || !presets) return null;
        const preset = presets[source][Number(item.getAttribute("data-tp-index"))];
        return preset ? { preset, source } : null;
      };
      const shareable = (preset, source) => {
        const text = presetText(preset, source);
        return { v: preset.v || 1, kind: PRESET_KIND, name: text.name, description: text.description, settings: preset.settings || {} };
      };
      const openSavePreset = () => {
        const d = show(JE.t("tag_presets_save"));
        d.body.innerHTML = `<p class="je-pt-hint">${tx("tag_presets_save_desc")}</p>
                <label class="je-pt-label" for="jePtName">${tx("tag_presets_name")}</label>
                <input id="jePtName" class="je-pt-input" type="text" maxlength="${MAX_NAME}" data-pt-autofocus required>
                <label class="je-pt-label" for="jePtDesc">${tx("tag_presets_description")}</label>
                <textarea id="jePtDesc" class="je-pt-input" rows="2" maxlength="${MAX_DESCRIPTION}"></textarea>`;
        d.foot.innerHTML = buttonHtml("cancel", "jellyseerr_modal_cancel") + buttonHtml("save", "elsewhere_settings_save", { primary: true });
        d.foot.onclick = async (e) => {
          const button = actionOf(e);
          if (button?.dataset.ptAction === "cancel") {
            d.close();
            return;
          }
          if (!button || button.dataset.ptAction !== "save") return;
          const nameInput = d.body.querySelector("#jePtName");
          const descInput = d.body.querySelector("#jePtDesc");
          if (!(nameInput instanceof HTMLInputElement) || !(descInput instanceof HTMLTextAreaElement)) return;
          const name = nameInput.value.trim();
          const description = descInput.value.trim();
          if (!name) {
            d.status(errorText("name"), "error");
            nameInput.focus();
            return;
          }
          const current = sessionCheck();
          setDisabled(button, true);
          try {
            const exported = await fetchExport(current);
            if (!live() || !current() || d.closed() || !exported) return;
            if (exported.unsaved) {
              setDisabled(button, false);
              d.status(JE.t("tag_presets_save_unsaved"), "error");
              return;
            }
            const parts = exportedParts(exported.document);
            await savePreset(d, { v: parts.v, kind: PRESET_KIND, name, description, settings: parts.settings }, current);
          } catch (err) {
            if (!live() || !current() || d.closed()) return;
            setDisabled(button, false);
            d.status(errorText((await errorOf(err)).code, { max: presets?.max || 10 }), "error");
          }
        };
        d.focusFirst();
      };
      const savePreset = async (d, document2, isCurrent = sessionCheck()) => {
        if (!live() || !isCurrent()) return;
        const answer = await ajax({ type: "POST", url: userUrl("presets"), data: JSON.stringify(document2), contentType: "application/json", dataType: "json" });
        if (!live() || !isCurrent()) return;
        await loadPresets();
        const saved = savedPreset(answer);
        const shownName = String(saved.name || Reflect.get(document2, "name"));
        if (!saved.skipped.length || d.closed()) {
          d.close();
          hooks.announce(JE.t("tag_presets_saved", { name: shownName }));
          return;
        }
        d.body.innerHTML = `<p class="je-pt-summary">${tx("tag_presets_saved", { name: shownName })}</p>` + previewHtml({ skipped: saved.skipped }, { summary: false });
        d.foot.innerHTML = buttonHtml("close", "awards_close", { primary: true });
        d.foot.onclick = () => d.close();
        d.focusFirst();
      };
      const openImportPreset = () => openSource({
        titleKey: "tag_presets_import_title",
        hintKey: "tag_presets_import_desc",
        nextKey: "tag_presets_import_button",
        onDocument: async (d, document2) => {
          if (!Reflect.get(document2, "name")) {
            d.status(errorText("name"), "error");
            return;
          }
          try {
            await savePreset(d, document2);
          } catch (err) {
            if (!live() || d.closed()) return;
            d.status(errorText((await errorOf(err)).code, { max: presets?.max || 10 }), "error");
          }
        }
      });
      const sharePreset = async (preset, source, button) => {
        const text = JSON.stringify(shareable(preset, source), null, 2);
        if (await copyText(text)) {
          hooks.announce(JE.t("tag_presets_shared", { name: presetText(preset, source).name }));
          const old = button.textContent;
          button.textContent = JE.t("tag_portable_copied");
          setTimeout(() => {
            if (button.isConnected) button.textContent = old;
          }, 1500);
          return;
        }
        const d = show(JE.t("tag_presets_share_title", { name: presetText(preset, source).name }));
        d.body.innerHTML = `<p class="je-pt-hint">${tx("tag_presets_share_desc")}</p><textarea class="je-pt-text" rows="10" readonly spellcheck="false" aria-label="${tx("tag_presets_share_title", { name: presetText(preset, source).name })}">${esc(text)}</textarea>`;
        d.foot.innerHTML = buttonHtml("download", "tag_portable_download", { icon: "download" }) + buttonHtml("close", "awards_close", { primary: true });
        d.foot.onclick = (e) => {
          const action = actionOf(e)?.getAttribute("data-pt-action");
          if (action === "download") download(shareable(preset, source), `jellyfin-media-tags-preset-${String(preset.id || "shared")}`);
          if (action === "close") d.close();
        };
        const area = d.body.querySelector("textarea");
        area?.focus();
        area?.select();
      };
      const showDeleteError = (preset) => {
        failedDelete = preset;
        deleteError.hidden = !preset;
        const text = deleteError.querySelector("[data-tp-error-text]");
        if (text) text.textContent = preset ? JE.t("tag_presets_delete_failed", { name: preset.name }) : "";
      };
      const deletePreset = async (preset) => {
        try {
          await ajax({ type: "DELETE", url: userUrl(`presets/${encodeURIComponent(String(preset.id))}`) });
        } catch (err) {
          if (statusOf(err) !== 404) {
            console.warn("🪼 Jellyfin Enhanced: could not delete the preset", err);
            if (!live()) return;
            showDeleteError(preset);
            focusElement(deleteError.querySelector('[data-tp="delete-retry"]'));
            return;
          }
        }
        if (!live()) return;
        showDeleteError(null);
        await loadPresets();
        hooks.announce(JE.t("tag_presets_deleted", { name: preset.name }));
        focusElement(presetsCard.querySelector('[data-tp="save-preset"]'));
      };
      const onClick = (e) => {
        const button = closestTarget(e, "[data-tp]");
        if (!button || button instanceof HTMLButtonElement && button.disabled || !live()) return;
        const action = button.dataset.tp;
        touch();
        if (action === "export") openExport();
        else if (action === "import") openSource({ titleKey: "tag_portable_import_title", hintKey: "tag_portable_import_desc", onDocument: (d, doc, back) => showPreview(d, doc, back) });
        else if (action === "undo") undo();
        else if (action === "save-preset") openSavePreset();
        else if (action === "import-preset") openImportPreset();
        else if (action === "delete-retry") {
          if (failedDelete) deletePreset(failedDelete);
        } else {
          const found = presetOf2(button);
          if (!found) return;
          if (action === "apply") {
            const d = show(JE.t("tag_presets_apply_named", { name: presetText(found.preset, found.source).name }));
            d.body.innerHTML = `<p class="je-pt-hint" data-pt-loading>${tx("hidden_content_admin_loading")}</p>`;
            d.foot.innerHTML = buttonHtml("cancel", "jellyseerr_modal_cancel");
            d.foot.onclick = () => d.close();
            d.focusFirst();
            showPreview(d, shareable(found.preset, found.source));
          } else if (action === "share") sharePreset(found.preset, found.source, button);
          else if (action === "delete") deletePreset({ id: found.preset.id, name: String(found.preset.name) });
        }
      };
      presetsCard.addEventListener("click", onClick);
      portableCard.addEventListener("click", onClick);
      const presetsLoaded = loadPresets();
      drawUndo();
      const reopened = internal.tagPortableReopen;
      if (reopened) {
        internal.tagPortableReopen = null;
        presetsLoaded.then(() => setTimeout(() => {
          if (disposed) return;
          ctx.openPane?.("media-tags");
          internal.mediaTagsHub?.openTab?.("layout");
          const target = queryButton(undoBar, "button") || queryElement(portableCard, '[data-tp="import"]');
          const main = portableCard.closest(".je-panel-main");
          if (main && target) {
            const box = main.getBoundingClientRect();
            main.scrollTop += target.getBoundingClientRect().top - box.top - box.height / 2;
          }
          target?.focus({ preventScroll: true });
          if (reopened.messageKey) hooks.announce(JE.t(reopened.messageKey));
          else if (lastImport?.isCurrent()) hooks.announce(JE.t("tag_portable_applied", { count: lastImport.count }));
        }, 0));
      }
      return () => {
        disposed = true;
        clearTimeout(undoTimer);
        dialog?.close();
        presetsCard.removeEventListener("click", onClick);
        portableCard.removeEventListener("click", onClick);
      };
    };
    internal.wireTagPortable = wireTagPortable;
    JE.session?.onUserChange?.("tag-portable", () => {
      lastImport = null;
      internal.tagPortableReopen = null;
    });
  }
  installUiPanelTagPortable(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-tag-portable.js.map
