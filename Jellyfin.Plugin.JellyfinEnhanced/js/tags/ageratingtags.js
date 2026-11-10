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
  var export2 = /* @__PURE__ */ sharedExport(shared, "mediaTagsContext");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export4 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export13 = /* @__PURE__ */ sharedExport(shared2, "text");

  // client/src/features/media-tags/types/age-rating/ageratingtags.ts
  function createAgeRatingTags(ctx) {
    const JE = ctx.core;
    const logPrefix = "🪼 Jellyfin Enhanced: Age Rating Tags:";
    const containerClass = "age-rating-overlay-container";
    const tagClass = "age-rating-tag";
    const colourStyleId = "jellyfin-enhanced-age-rating-colours-css";
    let colourCssPromise = null;
    function normalizeRating(raw) {
      if (raw === null || raw === void 0) return null;
      const text = String(raw).replace(/\s+/g, " ").trim();
      if (!text) return null;
      const shared3 = JE.normalizeOfficialRating;
      return export13(typeof shared3 === "function" ? shared3(text) : text);
    }
    function scopeRatingColours(cssText) {
      const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
      const rules = [];
      const blockRe = /([^{}]+)\{([^{}]*)\}/g;
      let match;
      while ((match = blockRe.exec(withoutComments)) !== null) {
        const [, selectorList = "", body = ""] = match;
        const selectors = selectorList.split(",").map((s) => s.trim()).filter((s) => s.startsWith(".mediaInfoOfficialRating[rating=")).map((s) => s.replace(".mediaInfoOfficialRating", `.${tagClass}`));
        if (selectors.length === 0) continue;
        const declarations = body.replace(/\s*!important/g, "").trim();
        rules.push(`${selectors.join(",\n")} { ${declarations} }`);
      }
      return rules.join("\n");
    }
    function ensureColourCss() {
      if (colourCssPromise) return colourCssPromise;
      if (document.getElementById(colourStyleId)) return colourCssPromise = Promise.resolve();
      colourCssPromise = (async () => {
        try {
          const response = await fetch(JE.cdn.url("je-css", "ratings.css"));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const scoped = scopeRatingColours(await response.text());
          if (!scoped) throw new Error("no [rating=] rules found");
          JE.core.ui.injectCss(colourStyleId, scoped);
        } catch (e) {
          console.warn(`${logPrefix} Could not load rating colours, badges will use the default colour.`, e);
          colourCssPromise = null;
        }
      })();
      return colourCssPromise;
    }
    function isGuardedSeries(seriesId) {
      if (!seriesId) return false;
      try {
        const cfg = JE.pluginConfig;
        if (!cfg || cfg.SpoilerBlurEnabled !== true || cfg.SpoilerStripRatings === false) return false;
        const sg = ctx.peer("spoilerBlur");
        if (!sg || typeof sg.isEnabledFor !== "function") return false;
        const prefs = typeof sg.getUserPrefs === "function" && sg.getUserPrefs() || {};
        if (prefs.HideRatings === false) return false;
        if (typeof sg.isLoadOk === "function" && sg.isLoadOk() !== true) return true;
        return sg.isEnabledFor(seriesId) === true;
      } catch {
        return true;
      }
    }
    function getCachedEntry(ctx2, itemId) {
      const entry = ctx2.getPersistent(itemId) ?? ctx2.hot?.get(itemId);
      if (!export4(entry)) return null;
      return { rating: export13(entry.rating), seriesId: export13(entry.s) };
    }
    function setCachedEntry(ctx2, itemId, rating, seriesId) {
      const entry = seriesId ? { rating, s: seriesId } : { rating };
      ctx2.setPersistent(itemId, entry);
      ctx2.hot?.set(itemId, entry);
    }
    function applyAgeRatingTag(ctx2, el, rating) {
      if (!rating) return;
      ctx2.removeExistingOverlay(el);
      const container = document.createElement("div");
      container.className = containerClass;
      const tag = document.createElement("div");
      tag.className = tagClass;
      tag.setAttribute("rating", rating);
      tag.textContent = rating;
      container.appendChild(tag);
      ctx2.commitOverlay(el, container);
    }
    const spec = {
      logPrefix,
      settingKey: "ageRatingTagsEnabled",
      containerClass,
      taggedAttr: "jeAgeRatingTagged",
      styleId: "jellyfin-enhanced-age-rating-tags-css",
      position: { userKey: "ageRatingTagsPosition", pluginKey: "AgeRatingTagsPosition", fallback: "bottom-right" },
      cache: {
        key: "JellyfinEnhanced-ageRatingTagsCache",
        legacyPrefix: "ageRatingTagsCache",
        hotBucket: "ageRating",
        saveOnUnload: false
      },
      buildCss() {
        return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    /* Neutral fallback, same as the Colored Ratings default, until a
                       [rating=...] rule matches (or if the colour sheet fails to load). */
                    background-color: #607D8B;
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.25);
                    border-radius: 4px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 700;
                    line-height: 1;
                    letter-spacing: 0.02em;
                    text-transform: uppercase;
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    pointer-events: none;
                }

                /* Card-width sizing, matching the rating tag rules in tag-pipeline.js */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                    }
                }

                .layout-mobile .${tagClass} {
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    font-size: calc(11px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }

                @media (max-width: 768px) {
                    .${tagClass} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }

                @media (max-width: 480px) {
                    .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }
            `;
      },
      pipeline: {
        needsFirstEpisode: false,
        needsParentSeries: false,
        render(ctx2, el, item, extras) {
          if (ctx2.shouldIgnore(el)) return;
          if (ctx2.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          const rating = normalizeRating(item.OfficialRating) ?? normalizeRating(extras?.parentSeries?.OfficialRating);
          const isChild = item.Type === "Episode" || item.Type === "Season";
          if (!isChild || item.SeriesId) {
            setCachedEntry(ctx2, String(item.Id), rating, isChild ? String(item.SeriesId) : null);
          }
          applyAgeRatingTag(ctx2, el, rating);
        },
        renderFromCache(ctx2, el, itemId) {
          if (ctx2.isTagged(el)) return true;
          if (ctx2.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          const cached = getCachedEntry(ctx2, itemId);
          if (!cached) return false;
          if (isGuardedSeries(cached.seriesId)) return false;
          applyAgeRatingTag(ctx2, el, cached.rating);
          return true;
        },
        renderFromServerCache(ctx2, el, entry) {
          if (ctx2.isTagged(el)) return;
          if (ctx2.shouldIgnore(el)) return;
          applyAgeRatingTag(ctx2, el, normalizeRating(entry.OfficialRating));
        }
      }
    };
    JE.initializeAgeRatingTags = function() {
      console.log(`${logPrefix} Starting...`);
      const ctx2 = JE.core.tagRenderer.register("agerating", spec);
      ctx2.injectCss();
      ensureColourCss();
      console.log(`${logPrefix} Initialized successfully.`);
    };
    JE.reinitializeAgeRatingTags = function() {
      JE.core.tagRenderer.reinitialize("agerating", spec);
      ensureColourCss();
    };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/age-rating/ageratingtags-entry.ts
  createAgeRatingTags(export2());
})();
})();
//# sourceMappingURL=ageratingtags.js.map
