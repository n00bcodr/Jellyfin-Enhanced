(() => {
"use strict";
(() => {
  // client/src/features/media-tags/admin/dom.ts
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function findAs(scope, selector, type) {
    const el = scope?.querySelector(selector);
    return el instanceof type ? el : null;
  }

  // client/src/features/media-tags/admin/format.ts
  function word(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
  }

  // client/src/features/media-tags/admin/host.ts
  var host = () => window;
  function adminBridge() {
    const JE = host().JellyfinEnhanced;
    if (!JE) throw new TypeError("Jellyfin Enhanced must load before the Media Tags admin tab");
    return JE;
  }
  function adminTagsApi(JE) {
    const facade = JE.adminTags;
    return facade && isCore(facade) ? facade : null;
  }
  function isCore(facade) {
    return typeof facade.registerSection === "function" && typeof facade.fmt === "function" && Array.isArray(facade.sections);
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/colours.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'colours',
      title: 'Tag colours and text',
      writes: ['TagStyleOverrides', 'TagStylePreset', 'TagHiddenValues', 'TagTextOverrides'],
          { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours' },
          { id: 'tagStyleTarget', key: 'TagStyleTarget', type: 'pills', label: 'Apply to' },
          { id: 'tagStylesAllowUserPreset', key: 'TagStylesAllowUserPreset', type: 'switch', label: 'Let users pick their own preset' },
  */
  var RENDERERS = ["quality", "genre", "rating", "agerating", "status", "language", "awards", "logos", "custom"];
  var TEXT_RENDERERS = ["quality", "genre", "status", "awards"];
  function textDoc(value) {
    const doc = {};
    let parsed = null;
    try {
      parsed = typeof value === "string" && value ? JSON.parse(value) : null;
    } catch {
      return doc;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return doc;
    for (const [group, labels] of Object.entries(parsed)) {
      if (!labels || typeof labels !== "object" || Array.isArray(labels)) continue;
      const texts = {};
      for (const [label, text] of Object.entries(labels)) if (typeof text === "string") texts[label] = text;
      doc[group] = texts;
    }
    return doc;
  }
  function hiddenDoc(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const doc = {};
    for (const [group, list] of Object.entries(value)) if (Array.isArray(list)) doc[group] = list.map(String);
    return doc;
  }
  installSection((A, JE) => {
    let editor = null;
    let last = "";
    function load(ctx) {
      if (!editor) return;
      editor.load(ctx.config.TagStyleOverrides, ctx.config.TagStylePreset);
      last = editor.snapshot();
    }
    A.registerSection({
      id: "colours",
      tab: "colours",
      order: 10,
      title: "Tag colours and text",
      hint: "Colours for quality, age rating, rating, genre, status, language, awards, logo and custom tags, and the words of quality, genre, status and awards tags.",
      writes: ["TagStyleOverrides", "TagStylePreset", "TagHiddenValues", "TagTextOverrides"],
      fields: [
        { id: "tagStylesEnabled", key: "TagStylesEnabled", type: "switch", label: "Use tag colours", desc: "Off shows the original colours (custom CSS keeps working). Your edits are kept. Hidden tags apply either way.", master: true },
        { id: "tagStyleTarget", key: "TagStyleTarget", type: "pills", label: "Apply to", desc: "Web recolours the overlays and wins over custom CSS colours. Native posters draws the colours into the posters of apps such as Android TV (needs Native Poster Tags; status tags are not drawn there).", options: [["web", "Web"], ["native", "Native posters"], ["both", "Both"]], read: (v) => typeof v === "string" && ["web", "native", "both"].includes(v) ? v : "both", when: (c) => c.TagStylesEnabled === true },
        { id: "tagStylesAllowUserPreset", key: "TagStylesAllowUserPreset", type: "switch", label: "Let users pick their own preset", desc: "Shows a colour preset choice in each user's Media Tags settings. Your group and label colours stay on top of their preset.", break: true }
      ],
      render(ctx, body) {
        body.innerHTML = `<div id="tagStylesBody" style="margin-top:14px">${A.EDITOR_HTML ?? ""}
                <div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="tagStyleResetAll"><span class="material-icons" aria-hidden="true">restart_alt</span>${ctx.tx("Reset all colours")}</button></div></div>`;
        const label = (selector, value) => {
          const el = body.querySelector(selector);
          if (el) el.textContent = value;
        };
        label("#tagStylePresetLabel", A.fmt("Preset"));
        label("#tagStyleTargetsLabel", A.fmt("Editing"));
        label("#tagStylePreviewLabel", A.fmt("Preview"));
        label("#tagStylePresets", A.fmt("Loading…"));
        body.querySelector("#tagStyleTabs")?.setAttribute("aria-label", A.fmt("Tag group"));
        const section = body.closest("[data-section]");
        const wraps = ["tagStyleTarget", "tagStylesAllowUserPreset"].map((id) => section?.querySelector(`[data-field-row="${id}"]`)?.parentElement).filter((w) => !!w);
        const first = wraps[0];
        if (section && first && !section.querySelector(".je-ta-more")) {
          const more = document.createElement("details");
          more.className = "je-ta-more";
          more.innerHTML = '<summary class="je-ta-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span><span data-more-text></span></summary>';
          first.before(more);
          wraps.forEach((w) => more.appendChild(w));
          const sum = () => {
            const target = findAs(more, '[name="tagStyleTarget"]:checked', HTMLInputElement);
            const allow = findAs(more, "#tagStylesAllowUserPreset", HTMLInputElement);
            const parts = [A.fmt("Options")];
            if (target && ctx.config.TagStylesEnabled === true) parts.push(word(A.WORDS.colourTarget, ["web", "native", "both"].includes(target.value) ? target.value : "both") || "");
            if (allow) parts.push(A.fmt(allow.checked ? "User presets allowed" : "No user presets"));
            const textEl = more.querySelector("[data-more-text]");
            if (textEl) textEl.textContent = parts.filter(Boolean).join(" · ");
          };
          sum();
          section.addEventListener("change", () => setTimeout(sum), { signal: ctx.signal });
        }
        const create = A.createTagStylesEditor;
        if (!create) {
          editor = null;
          return;
        }
        const customLabels = () => {
          const rules = Array.isArray(ctx.config.CustomTagRules) ? ctx.config.CustomTagRules : [];
          const labels = [];
          for (const r of rules) {
            if (!r || typeof r !== "object" || Array.isArray(r)) continue;
            const value = r.Label || r.label;
            if (value) labels.push(String(value));
          }
          return [...new Set(labels)];
        };
        const setHiddenDoc = (doc, ages) => {
          ctx.setMany({ TagHiddenValues: doc }, { redraw: false });
          if (JE.pluginConfig) Object.assign(JE.pluginConfig, { TagHiddenValues: doc, TagHiddenAgeRatings: ages });
          for (const name of RENDERERS) JE.core.tagRenderer?.reinitialize?.(name);
        };
        const hiddenStore = {
          get: () => ctx.config.TagHiddenValues || null,
          set(doc, ages, change) {
            const before = hiddenDoc(ctx.config.TagHiddenValues);
            const beforeAges = Array.isArray(JE.pluginConfig?.TagHiddenAgeRatings) ? JE.pluginConfig.TagHiddenAgeRatings.map(String) : [];
            setHiddenDoc(doc, ages);
            const message = change.orphan && !change.hidden ? A.fmt("{name} is no longer hidden", { name: change.label.key }) : change.count > 1 ? A.fmt(change.hidden ? "{count} ratings hidden" : "{count} ratings show again", { count: change.count }) : A.fmt(change.hidden ? "{name} hidden" : "{name} shown again", { name: change.noun || change.label.name });
            ctx.snack(message, () => {
              setHiddenDoc(before, beforeAges);
              editor?.refreshHidden();
            });
          }
        };
        const setTextDoc = (docText) => {
          ctx.setMany({ TagTextOverrides: docText }, { redraw: false });
          if (JE.pluginConfig) Object.assign(JE.pluginConfig, { TagTextOverrides: docText });
          for (const name of TEXT_RENDERERS) JE.core.tagRenderer?.reinitialize?.(name);
        };
        const textStore = {
          get: () => textDoc(ctx.config.TagTextOverrides),
          set(group, label2, text) {
            const before = typeof ctx.config.TagTextOverrides === "string" && ctx.config.TagTextOverrides ? ctx.config.TagTextOverrides : null;
            const doc = textDoc(before);
            const labels = { ...doc[group] || {} };
            if (text) labels[label2.key] = text;
            else delete labels[label2.key];
            if (Object.keys(labels).length) doc[group] = labels;
            else delete doc[group];
            setTextDoc(Object.keys(doc).length ? JSON.stringify(doc) : null);
            ctx.snack(text ? A.fmt('{name} now reads "{text}"', { name: label2.name, text }) : A.fmt("{name} shows its own text again", { name: label2.name }), () => {
              setTextDoc(before);
              editor?.refreshHidden();
            });
          }
        };
        const own = create(ctx.root, customLabels, () => ctx.isCurrent(), hiddenStore, textStore);
        editor = own;
        ctx.root.addEventListener("je-custom-labels", () => {
          if (ctx.isCurrent()) own.refreshLabels();
        }, { signal: ctx.signal });
        ctx.root.addEventListener("click", (e) => {
          const link = e.target instanceof Element ? e.target.closest("[data-je-colours-group]") : null;
          if (link && ctx.isCurrent()) setTimeout(() => editor?.openGroup(link.dataset.jeColoursGroup || ""));
        }, { signal: ctx.signal });
        const changed = () => {
          const now = own.snapshot();
          if (now === last) return;
          last = now;
          ctx.setMany({ TagStyleOverrides: own.serialize(), TagStylePreset: own.settings().preset }, { redraw: false });
        };
        const editorEl = find(body, "#tagStyleEditor");
        editorEl?.addEventListener("click", changed);
        editorEl?.addEventListener("input", changed);
        body.querySelector("#tagStyleResetAll")?.addEventListener("click", async () => {
          const ok = await ctx.confirm(A.fmt("Every group and label colour goes back to the Default preset."), A.fmt("Reset all colours"));
          if (!ok) return;
          const before = { json: ctx.config.TagStyleOverrides || "", preset: ctx.config.TagStylePreset || "default" };
          own.load("", "default");
          last = own.snapshot();
          ctx.setMany({ TagStyleOverrides: "", TagStylePreset: "default" }, { redraw: false });
          ctx.snack(A.fmt("All colours reset"), () => {
            own.load(before.json, before.preset);
            last = own.snapshot();
            ctx.setMany({ TagStyleOverrides: before.json, TagStylePreset: before.preset }, { redraw: false });
          });
        });
        load(ctx);
      },
      load,
      refresh(ctx, body) {
        find(body, "#tagStylesBody")?.classList.toggle("je-ts-colours-off", ctx.config.TagStylesEnabled !== true);
        editor?.setColoursOffNote(ctx.config.TagStylesEnabled !== true, () => {
          const input = find(ctx.root, "#tagStylesEnabled");
          input?.scrollIntoView?.({ block: "center" });
          input?.focus();
        });
        editor?.refreshHidden();
      }
    });
  });
})();
})();
//# sourceMappingURL=colours.js.map
