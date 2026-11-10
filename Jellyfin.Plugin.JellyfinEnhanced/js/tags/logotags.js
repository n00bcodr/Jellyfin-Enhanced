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
  var export0 = /* @__PURE__ */ sharedExport(shared, "apiClient");
  var export1 = /* @__PURE__ */ sharedExport(shared, "hasApiClient");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/src/features/media-tags/types/logo/logotags.ts
  function createLogoTags(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: Logos Tags:";
    const containerClass = "logo-overlay-container";
    const chipClass = "je-logo-chip";
    const imageClass = "je-logo-img";
    const TEXT_MAX_LENGTH = 12;
    const KINDS = /* @__PURE__ */ new Set(["provider", "network", "studio"]);
    const LOGO_PATH = /^\/[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|webp)$/;
    const failedUrls = /* @__PURE__ */ new Map();
    const FAILED_RETRY_MS = 5 * 60 * 1e3;
    const FAILED_MAX = 500;
    function recentlyFailed(url) {
      const at = failedUrls.get(url);
      if (at === void 0) return false;
      if (Date.now() - at < FAILED_RETRY_MS) return true;
      failedUrls.delete(url);
      return false;
    }
    let errorListener = false;
    function shortName(name) {
      const text = String(name || "").trim();
      if (text.length <= TEXT_MAX_LENGTH) return text;
      const words = text.split(/[\s\-–—/&+]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
      if (words.length >= 2) {
        return words.slice(0, 4).map((w) => (w.match(/[\p{L}\p{N}]/u) || [""])[0].toUpperCase()).join("");
      }
      return `${text.slice(0, TEXT_MAX_LENGTH - 1)}…`;
    }
    function logoUrl(path) {
      if (typeof path !== "string" || !LOGO_PATH.test(path)) return null;
      const route = `JellyfinEnhanced/logo/w92${path}`;
      return export1() && typeof export0().getUrl === "function" ? export0().getUrl(route) : `/${route}`;
    }
    function readLogos(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const entry of raw) {
        const fact = export10(entry);
        const kind = String(fact.kind ?? fact.Kind ?? "");
        const name = String(fact.name ?? fact.Name ?? "").trim();
        if (!KINDS.has(kind) || !name) continue;
        const logo = fact.logo ?? fact.Logo;
        out.push({ kind, name, logo: typeof logo === "string" && LOGO_PATH.test(logo) ? logo : null });
        if (out.length === 2) break;
      }
      return out;
    }
    function asText(chip, name) {
      chip.textContent = shortName(name);
      chip.dataset.jeLogoStyle = "text";
      chip.classList.add("je-logo-text");
      chip.removeAttribute("role");
      chip.removeAttribute("aria-label");
    }
    function buildChip(logo, src) {
      const chip = document.createElement("span");
      chip.className = chipClass;
      chip.dataset.jeLogoKind = logo.kind;
      chip.title = logo.name;
      const url = src || logoUrl(logo.logo);
      if (!url || recentlyFailed(url)) {
        asText(chip, logo.name);
        return chip;
      }
      chip.dataset.jeLogoStyle = logo.kind === "provider" ? "provider" : "company";
      const img = document.createElement("img");
      img.className = imageClass;
      img.alt = logo.name;
      img.decoding = "async";
      img.draggable = false;
      img.src = url;
      chip.appendChild(img);
      return chip;
    }
    function listenForImageErrors() {
      if (errorListener || typeof document.addEventListener !== "function") return;
      errorListener = true;
      document.addEventListener("error", (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !img.classList.contains(imageClass)) return;
        const src = img.getAttribute("src") || "";
        failedUrls.delete(src);
        failedUrls.set(src, Date.now());
        if (failedUrls.size > FAILED_MAX) failedUrls.delete(failedUrls.keys().next().value ?? "");
        const chip = img.closest(`.${chipClass}`);
        if (chip) asText(chip, img.alt);
      }, true);
    }
    function applyLogoTags(ctx, el, logos) {
      if (!logos.length) return;
      ctx.removeExistingOverlay(el);
      const container = document.createElement("div");
      container.className = containerClass;
      for (const logo of logos) container.appendChild(buildChip(logo));
      ctx.commitOverlay(el, container);
    }
    const spec = {
      logPrefix,
      settingKey: "logoTagsEnabled",
      containerClass,
      taggedAttr: "jeLogoTagged",
      styleId: "jellyfin-enhanced-logo-tags-css",
      position: { userKey: "logoTagsPosition", pluginKey: "LogoTagsPosition", fallback: "bottom-left" },
      cache: {
        key: "JellyfinEnhanced-logoTagsCache",
        legacyPrefix: "logoTagsCache",
        hotBucket: "logos",
        saveOnUnload: false
      },
      buildCss() {
        return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${chipClass} {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                    height: calc(28px * var(--je-tag-scale, 1));
                    max-width: 100%;
                    padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    overflow: hidden;
                    background-color: rgba(0, 0, 0, 0.6);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    font-size: calc(12px * var(--je-tag-scale, 1));
                    font-weight: 700;
                    line-height: 1;
                    letter-spacing: 0.02em;
                    white-space: nowrap;
                    pointer-events: none;
                }

                .${chipClass}[data-je-logo-style="provider"] { padding: calc(2px * var(--je-tag-scale, 1)); }

                .${chipClass}[data-je-logo-style="company"] {
                    background-color: rgba(255, 255, 255, 0.9);
                    color: #111111;
                    border-color: rgba(0, 0, 0, 0.12);
                }

                .${chipClass}[data-je-logo-style="text"] {
                    background-color: rgba(0, 0, 0, 0.75);
                    border-color: rgba(255, 255, 255, 0.25);
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                }

                .${imageClass} {
                    display: block;
                    height: 100%;
                    width: auto;
                    max-width: calc(72px * var(--je-tag-scale, 1));
                    object-fit: contain;
                    border-radius: 3px;
                }

                /* Card-width sizing, like the age rating chip */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${chipClass} {
                        height: calc(clamp(18px, 13cqw, 28px) * var(--je-tag-scale, 1));
                        font-size: calc(clamp(9px, 6.4cqw, 12px) * var(--je-tag-scale, 1));
                    }
                }

                .layout-mobile .${chipClass} { height: calc(22px * var(--je-tag-scale, 1)); font-size: calc(10px * var(--je-tag-scale, 1)); }
            `;
      },
      pipeline: {
        needsFirstEpisode: false,
        needsParentSeries: false,
        render(ctx, el, item) {
          if (ctx.shouldIgnore(el)) return;
          if (ctx.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          const logos = readLogos(item.Logos);
          const entry = { l: logos };
          ctx.setPersistent(String(item.Id), entry);
          ctx.hot?.set(String(item.Id), entry);
          applyLogoTags(ctx, el, logos);
        },
        renderFromCache(ctx, el, itemId) {
          if (ctx.isTagged(el)) return true;
          if (ctx.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          const cached = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
          if (!export42(cached) || !Array.isArray(cached.l)) return false;
          applyLogoTags(ctx, el, readLogos(cached.l));
          return true;
        },
        renderFromServerCache(ctx, el, entry) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          applyLogoTags(ctx, el, readLogos(entry?.Logos));
        }
      }
    };
    JE.initializeLogoTags = function() {
      console.log(`${logPrefix} Starting...`);
      listenForImageErrors();
      const ctx = JE.core.tagRenderer.register("logos", spec);
      ctx.injectCss();
      console.log(`${logPrefix} Initialized successfully.`);
    };
    JE.reinitializeLogoTags = function() {
      JE.core.tagRenderer.reinitialize("logos", spec);
    };
    JE.logoTags = { buildChip, readLogos, shortName, logoUrl };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/logo/logotags-entry.ts
  createLogoTags(export4());
})();
})();
//# sourceMappingURL=logotags.js.map
