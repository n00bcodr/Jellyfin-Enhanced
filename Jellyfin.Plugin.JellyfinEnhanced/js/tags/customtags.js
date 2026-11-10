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

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");

  // client/src/features/media-tags/types/custom/customtags.ts
  function createCustomTags(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: Custom Tags:";
    const containerClass = "custom-overlay-container";
    const tagClass = "custom-tag";
    const ICONS = [
      "theaters",
      "sports_martial_arts",
      "explore",
      "animation",
      "mood",
      "local_police",
      "article",
      "theater_comedy",
      "family_restroom",
      "auto_awesome",
      "history_edu",
      "skull",
      "music_note",
      "psychology_alt",
      "favorite",
      "science",
      "tv",
      "psychology",
      "military_tech",
      "landscape",
      "domino_mask",
      "music_video",
      "menu_book",
      "sports_soccer",
      "quiz",
      "live_tv"
    ];
    function pick(obj, key) {
      if (!export42(obj)) return void 0;
      if (obj[key] !== void 0 && obj[key] !== null) return obj[key];
      const pascal = key.charAt(0).toUpperCase() + key.slice(1);
      return obj[pascal] ?? void 0;
    }
    let rulesMemo = null;
    function currentRules() {
      const source = JE.pluginConfig?.CustomTagRules;
      const sources = JE.pluginConfig?.CustomTagRuleSources;
      if (rulesMemo && rulesMemo.source === source && rulesMemo.sources === sources) return rulesMemo;
      const matches = /* @__PURE__ */ new Map();
      for (const raw of Array.isArray(sources) ? sources : []) {
        const id = String(pick(raw, "id") || "");
        const match = String(pick(raw, "match") || "").toLowerCase();
        const value = String(pick(raw, "value") || "").trim();
        if (id && (match === "tag" || match === "collection") && value) matches.set(id, { match, value });
      }
      const rules = /* @__PURE__ */ new Map();
      for (const raw of Array.isArray(source) ? source : []) {
        const id = String(pick(raw, "id") || "");
        const label = String(pick(raw, "label") || "").trim();
        if (!id || !label || rules.has(id)) continue;
        const icon = String(pick(raw, "icon") || "").toLowerCase();
        const from = matches.get(id);
        rules.set(id, { id, label, icon: ICONS.includes(icon) ? icon : null, match: from?.match ?? null, value: from?.value ?? null });
      }
      const key = [...rules.keys()].sort().join("\n");
      rulesMemo = { source, sources, rules, key };
      return rulesMemo;
    }
    function rulesFor(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const matched = new Set(ids.map(String));
      const out = [];
      for (const [id, rule] of currentRules().rules) {
        if (matched.has(id)) out.push(rule);
      }
      return out;
    }
    function titleOf(rule) {
      if (!rule.match || !rule.value) return rule.label;
      const source = JE.t(rule.match === "collection" ? "custom_tags_source_collection" : "custom_tags_source_tag", { name: rule.value });
      return `${rule.label}
${source}`;
    }
    function buildChip(rule) {
      const tag = document.createElement("div");
      tag.className = rule.icon ? `${tagClass} ${tagClass}--icon` : tagClass;
      tag.dataset.jeCustom = rule.label;
      tag.dataset.jeCustomRule = rule.id;
      tag.title = titleOf(rule);
      if (rule.icon) {
        const icon = document.createElement("span");
        icon.className = `${tagClass}-icon`;
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = rule.icon;
        tag.appendChild(icon);
      }
      const text = document.createElement("span");
      text.className = `${tagClass}-text`;
      text.textContent = rule.label;
      tag.appendChild(text);
      return tag;
    }
    function applyCustomTags(ctx, el, ids) {
      const rules = rulesFor(ids);
      if (rules.length === 0) return;
      ctx.removeExistingOverlay(el);
      const container = document.createElement("div");
      container.className = containerClass;
      for (const rule of rules) container.appendChild(buildChip(rule));
      ctx.commitOverlay(el, container);
    }
    function getCachedEntry(ctx, itemId) {
      const entry = ctx.hot?.get(itemId) ?? ctx.getPersistent(itemId);
      if (export42(entry) && entry.r === currentRules().key && Array.isArray(entry.ids)) return entry.ids.map(String);
      if (entry !== void 0) ctx.deletePersistent(itemId);
      return null;
    }
    function setCachedEntry(ctx, itemId, ids) {
      ctx.setPersistent(itemId, {
        ids: Array.isArray(ids) ? ids.map(String) : [],
        r: currentRules().key,
        timestamp: Date.now()
      });
    }
    const spec = {
      logPrefix,
      settingKey: "customTagsEnabled",
      containerClass,
      taggedAttr: "jeCustomTagged",
      styleId: "jellyfin-enhanced-custom-tags-css",
      position: { userKey: "customTagsPosition", pluginKey: "CustomTagsPosition", fallback: "top-left" },
      cache: {
        key: "JellyfinEnhanced-customTagsCache",
        legacyPrefix: "customTagsCache",
        hotBucket: "custom",
        pruneOnSave: true,
        saveOnUnload: false
      },
      buildCss() {
        return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }
                .je-tag-slot > .${containerClass} { max-width: 100%; }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3em;
                    box-sizing: border-box;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    background-color: rgba(38, 50, 56, 0.88);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.22);
                    border-radius: 4px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 600;
                    line-height: 1.15;
                    letter-spacing: 0.01em;
                    text-transform: none;
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                    pointer-events: none;
                }
                .${tagClass}-text { overflow: hidden; text-overflow: ellipsis; }
                .${tagClass}-icon {
                    font-family: 'JE Material Symbols Outlined';
                    font-weight: normal;
                    font-style: normal;
                    font-size: 1.2em;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    flex-shrink: 0;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }

                /* Card-width sizing, matching the age rating and status chips. */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                    }
                }
                .layout-mobile .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(11px * var(--je-tag-scale, 1)); border-radius: 3px; }
                @media (max-width: 768px) {
                    .${tagClass} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }
                @media (max-width: 480px) {
                    .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }

                /* Caption strip and the minimal corner: the other chips' smaller size. */
                .je-tag-caption .${tagClass} {
                    font-size: calc(clamp(9px, 6.4cqw, 11.5px) * var(--je-tag-scale, 1));
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                    box-shadow: none;
                }
                html .je-tag-host > .je-tag-slot[data-je-slot="corner"] .${tagClass} { font-size: calc(11px * var(--je-tag-scale, 1)); padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1)); }
            `;
      },
      pipeline: {
        needsFirstEpisode: false,
        needsParentSeries: false,
        render(ctx, el, item) {
          if (ctx.shouldIgnore(el)) return;
          if (ctx.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          setCachedEntry(ctx, String(item.Id), item.CustomTags);
          applyCustomTags(ctx, el, item.CustomTags);
        },
        renderFromCache(ctx, el, itemId) {
          if (ctx.isTagged(el)) return true;
          if (ctx.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          const ids = getCachedEntry(ctx, itemId);
          if (!ids) return false;
          applyCustomTags(ctx, el, ids);
          return true;
        },
        renderFromServerCache(ctx, el, entry) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          applyCustomTags(ctx, el, entry.CustomTags);
        },
        // The fallback copies were filtered for this user like the server
        // cache: when that is replaced (access or Spoiler Guard changed, a
        // rebuild) they go too, and a delta drops the items it carries.
        // A tag strip changed elsewhere is caught by the stamp instead.
        onServerCacheRefresh(ctx, updatedIds) {
          if (!updatedIds) {
            ctx.clearPersistent();
            ctx.hot?.clear();
            return;
          }
          for (const id of updatedIds) {
            ctx.deletePersistent(String(id));
            ctx.hot?.delete(String(id));
          }
        }
      }
    };
    JE.initializeCustomTags = function() {
      console.log(`${logPrefix} Starting...`);
      const ctx = JE.core.tagRenderer.register("custom", spec);
      ctx.injectCss();
      console.log(`${logPrefix} Initialized successfully.`);
    };
    JE.reinitializeCustomTags = function() {
      rulesMemo = null;
      JE.core.tagRenderer.reinitialize("custom", spec);
    };
    JE.customTags = { ICONS, rulesFor, currentRules, buildChip };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/custom/customtags-entry.ts
  createCustomTags(export4());
})();
})();
//# sourceMappingURL=customtags.js.map
