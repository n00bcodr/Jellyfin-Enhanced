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
  var export5 = /* @__PURE__ */ sharedExport(shared2, "memberRecord");
  var export6 = /* @__PURE__ */ sharedExport(shared2, "memberText");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "members");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/src/features/media-tags/types/language/languagetags.ts
  function isImage(element) {
    return element.tagName === "IMG";
  }
  function createLanguageTags(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: Language Tags:";
    const containerClass = "language-overlay-container";
    const flagClass = "language-flag";
    const partialFlagClass = "language-flag-partial";
    const langDisplayNames = new Intl.DisplayNames(["en"], { type: "language" });
    const displayNameByCode = /* @__PURE__ */ new Map();
    function displayName(code) {
      let name = displayNameByCode.get(code);
      if (name === void 0) {
        try {
          name = langDisplayNames.of(code) || code.toUpperCase();
        } catch (e) {
          name = code.toUpperCase();
        }
        displayNameByCode.set(code, name);
      }
      return name;
    }
    function extractLanguagesFromItem(sourceItem, type = "Audio") {
      if (!sourceItem) return [];
      const languages = /* @__PURE__ */ new Set();
      const processStreams = function(streams) {
        export7(streams).map(export5).filter(function(s) {
          return s.Type === type && !(type === "Audio" ? JE.core.mediaLanguage.isSecondaryAudio(s) : s.IsForced === true);
        }).forEach(function(stream) {
          const langCode = stream.Language;
          if (typeof langCode === "string" && langCode && !JE.core.mediaLanguage.isLanguageless(langCode)) {
            languages.add(JSON.stringify({ name: displayName(langCode), code: langCode, sdh: type === "Subtitle" && (stream.IsHearingImpaired === true || /\b(SDH|CC)\b/i.test(`${String(stream.Title || "")} ${String(stream.DisplayTitle || "")}`)) }));
          }
        });
      };
      export7(sourceItem.MediaSources).forEach(function(source) {
        processStreams(export5(source).MediaStreams);
      });
      processStreams(sourceItem.MediaStreams);
      return normalizeLanguages(Array.from(languages, (fact) => JSON.parse(fact)));
    }
    function subtitleFacts(sourceItem, item) {
      const tracks = extractLanguagesFromItem(sourceItem, "Subtitle");
      const codes = sourceItem.SubtitleLanguages || item.SubtitleLanguages;
      if (!codes) return tracks;
      const sdh = export7(sourceItem.SdhSubtitleLanguages || item.SdhSubtitleLanguages || tracks.filter((track) => track.sdh).map((track) => track.code));
      return export7(codes).map((code) => ({ code, sdh: sdh.some((track) => JE.core.mediaLanguage.matchesLanguage(code, track, { requireRegion: true })) }));
    }
    function normalizeLanguages(languages) {
      if (!Array.isArray(languages)) return [];
      const norm = [];
      const seen = /* @__PURE__ */ new Set();
      for (const entry of languages) {
        let obj = null;
        if (!entry) continue;
        if (typeof entry === "string") {
          const code = entry.toLowerCase();
          obj = { name: displayName(code), code };
        } else if (export42(entry)) {
          const code = String(entry.code || entry.Code || "");
          const name = String(entry.name || entry.Name || "") || null;
          if (code) {
            obj = { name: name || displayName(code), code };
            if (entry.partial) obj.partial = true;
            if (entry.sdh) obj.sdh = true;
          }
        }
        if (!obj) continue;
        const key = `${obj.code.toLowerCase()}|${(obj.name || "").toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          norm.push(obj);
        } else if (obj.sdh) {
          const same = norm.find((lang) => `${lang.code.toLowerCase()}|${(lang.name || "").toLowerCase()}` === key);
          if (same) same.sdh = true;
        }
      }
      return norm;
    }
    function languageLabel(lang) {
      const name = lang.code && JE.core.mediaLanguage?.localName?.(lang.code) || lang.name;
      return lang.partial ? `${name} (${JE.t("language_tags_partial_tooltip")})` : name;
    }
    function orderByPriority(flags) {
      const policy = JE.core.mediaLanguage.priorityPolicy();
      const priority = policy.terms;
      if (!priority.length) return flags;
      const matchesLanguage = JE.core.mediaLanguage.matchesLanguage;
      const rank = (flag) => {
        const code = (flag.code || "").toLowerCase();
        const candidates = policy.personal ? flag.allCodes.map((c) => baseOf(c)) : [code, code.split("-")[0], ...flag.allLanguages.map((n) => n.toLowerCase())];
        const codes = policy.personal ? [] : flag.allCodes;
        let best = -1;
        for (let idx = 0; idx < priority.length; idx++) {
          if (best !== -1 && idx >= best) break;
          const term = priority[idx];
          if (candidates.includes(term) || codes.some((c) => matchesLanguage(c, term))) best = idx;
        }
        return best;
      };
      return flags.map((flag, i) => ({ flag, i, rank: rank(flag) })).filter((entry) => !policy.strict || entry.rank !== -1).sort((a, b) => {
        const ra = a.rank === -1 ? priority.length : a.rank;
        const rb = b.rank === -1 ? priority.length : b.rank;
        return ra - rb || a.i - b.i;
      }).map((entry) => entry.flag);
    }
    function readSettings() {
      const value = (key, fallback) => JE.currentSettings?.[key] ?? JE.pluginConfig?.[key.charAt(0).toUpperCase() + key.slice(1)] ?? fallback;
      const style = String(value("languageTagsStyle", "flags")).trim().toLowerCase();
      const badge = String(value("languageTagsCountBadge", "off")).trim().toLowerCase();
      return {
        audio: value("languageTagsShowAudio", true) !== false,
        subtitles: value("languageTagsShowSubtitles", false) === true,
        style: style === "codes" ? "codes" : "flags",
        badge: ["only", "both"].includes(badge) ? badge : "off"
      };
    }
    function baseOf(code) {
      return JE.core.mediaLanguage.canonicalBase(JE.core.mediaLanguage.parseLanguageTag(code)?.base ?? "");
    }
    function flagOf(lang) {
      const flag = JE.core.mediaLanguage.resolveFlag(lang);
      if (flag != null) return flag;
      const inherited = [lang.name, lang.code].find((key) => key in Object.prototype);
      return inherited === void 0 ? flag : { unrenderable: inherited };
    }
    function resolveChips(languages, style) {
      const unique = /* @__PURE__ */ new Map();
      for (const lang of normalizeLanguages(languages)) {
        const countryCode = flagOf(lang);
        const code = JE.core.mediaLanguage.displayCode(lang.code);
        const parsed = JE.core.mediaLanguage.parseLanguageTag(lang.code);
        const asCode = style === "codes" || countryCode == null;
        const key = asCode ? "code:" + JE.core.mediaLanguage.canonicalBase(parsed?.base ?? "") + (JE.pluginConfig?.LanguageTagsMergeRegions ? "" : ":" + (parsed?.region || parsed?.script || "")) : typeof countryCode === "object" && countryCode ? `unrenderable:${countryCode.unrenderable}` : countryCode;
        if (!key || asCode && !code) continue;
        const name = lang.name || lang.code.toUpperCase();
        const existing = unique.get(key);
        if (!existing) unique.set(key, { countryCode, asCode, code: lang.code, text: code, partial: !!lang.partial, sdh: !!lang.sdh, allCodes: [lang.code], allLanguages: [name], labels: [languageLabel({ name, code: lang.code, partial: lang.partial })] });
        else {
          existing.partial = existing.partial && !!lang.partial;
          existing.sdh || (existing.sdh = !!lang.sdh);
          if (!existing.allCodes.includes(lang.code)) existing.allCodes.push(lang.code);
          if (!existing.allLanguages.includes(name)) existing.allLanguages.push(name);
          const label = languageLabel({ name, code: lang.code, partial: lang.partial });
          if (!existing.labels.includes(label)) existing.labels.push(label);
        }
      }
      return orderByPriority(Array.from(unique.values()).sort((a, b) => Number(a.partial) - Number(b.partial)));
    }
    function buildGroup(languages, cap = 3, flagSource = JE.core.mediaLanguage.flagSrc) {
      const data = Array.isArray(languages) ? { audio: languages } : export10(languages);
      const conf = readSettings();
      const audio = conf.audio ? resolveChips(data.audio, conf.style) : [];
      const subtitles = conf.subtitles ? resolveChips(data.subtitles, conf.style) : [];
      const counted = conf.audio && conf.badge !== "off" ? resolveChips(data.audio, "codes").filter((chip) => baseOf(chip.code) !== "zxx") : [];
      const count = new Set(counted.map((chip) => baseOf(chip.code))).size;
      const badge = conf.badge !== "off" && count >= 2;
      const chips = [];
      if (badge) chips.push({ badge: count === 2 ? "dual" : "multi" });
      if (!badge || conf.badge !== "only") chips.push(...audio);
      chips.push(...subtitles.map((chip) => ({ ...chip, subtitle: true })));
      const wrap = document.createElement("div");
      wrap.className = containerClass;
      const visible = cap > 0 ? chips.slice(0, cap) : chips;
      if (visible.some((chip) => !chip.badge && !chip.asCode && typeof chip.countryCode !== "string")) return wrap;
      for (const info of chips) {
        if (!info.badge && !info.asCode && typeof info.countryCode !== "string") continue;
        const asCode = !info.badge && info.asCode;
        const chip = document.createElement(info.badge || info.subtitle || asCode ? "span" : "img");
        chip.className = info.badge ? "language-count-badge language-chip" : asCode ? "language-code language-chip" : info.subtitle ? "language-subtitle language-chip" : flagClass;
        if (info.partial) {
          chip.classList.add(partialFlagClass);
          chip.dataset.partial = "true";
        }
        chip.dataset.jeLanguage = info.badge ? "countBadge" : info.subtitle ? "subtitles" : "flag";
        if (chip.tagName !== "IMG") chip.dataset.jeLanguageLabel = info.badge || info.text.toLowerCase();
        if (info.badge) {
          chip.textContent = JE.t(JE.core.tagLayout?.VOCABULARY_KEYS.language[`${info.badge}`] ?? "");
          chip.title = `${JE.t("language_tags_count_tooltip", { count })}: ${counted.flatMap((chip2) => chip2.labels).join(", ")}`;
        } else {
          const label = info.labels.join(", ");
          chip.title = `${JE.t(info.subtitle ? info.sdh ? "language_tags_subtitles_sdh" : "jellyseerr_report_issue_type_subtitles" : "jellyseerr_report_issue_type_audio")}: ${label}`;
          chip.dataset.langName = info.allLanguages.join(", ");
          const flag = typeof info.countryCode === "string" ? info.countryCode : "";
          chip.dataset.lang = asCode ? info.text.toLowerCase() : flag.toLowerCase();
          if (info.subtitle) {
            const cc = document.createElement("span");
            cc.className = "language-cc";
            cc.textContent = info.sdh ? "SDH" : "CC";
            if (info.sdh) chip.dataset.jeSdh = "true";
            cc.setAttribute("aria-hidden", "true");
            chip.appendChild(cc);
          }
          if (asCode) chip.appendChild(document.createTextNode(info.text));
          else {
            const img = isImage(chip) ? chip : document.createElement("img");
            img.src = flagSource(flag);
            img.className = info.subtitle ? flagClass : chip.className;
            img.alt = chip.title;
            img.loading = "lazy";
            img.onerror = () => chip.remove();
            if (info.subtitle) chip.appendChild(img);
          }
        }
        if (chip.tagName !== "IMG") chip.setAttribute("role", "img");
        chip.setAttribute("aria-label", chip.title);
        wrap.appendChild(chip);
      }
      return wrap;
    }
    function insertLanguageTags(ctx, container, languages) {
      if (!container || ctx.isTagged(container)) return;
      ctx.removeExistingOverlay(container);
      if (container.style.position !== "relative") container.style.position = "relative";
      const cap = JE.core.tagLayout ? JE.core.tagLayout.resolveLayout(container).caps.language : 3;
      ctx.commitOverlay(container, buildGroup(languages, cap));
    }
    JE.core.languageTags = { readSettings, buildGroup };
    const spec = {
      logPrefix,
      settingKey: "languageTagsEnabled",
      containerClass,
      taggedAttr: "jeLanguageTagged",
      styleId: "language-tags-styles",
      position: { userKey: "languageTagsPosition", pluginKey: "LanguageTagsPosition", fallback: "bottom-left" },
      cache: {
        // v3: entries keep both audio and subtitle facts. v2 kept region subtags instead of stripped
        // base codes; the old key is cleaned up via legacyPrefix so stale
        // stripped entries can't pin the wrong flag for the 30-day TTL.
        // Both prior generations are listed — dropping the ancient
        // un-namespaced stem would leave its keys orphaned forever.
        key: "JellyfinEnhanced-languageTagsCache-v4",
        legacyPrefix: ["JellyfinEnhanced-languageTagsCache-v3", "JellyfinEnhanced-languageTagsCache-v2", "JellyfinEnhanced-languageTagsCache", "languageTagsCache"],
        hotBucket: "language"
      },
      buildCss() {
        return JE.core.tagRenderer.chipBaseCss(".language-chip") + JE.core.tagRenderer.chipBaseCss('.language-code:not([data-je-language="subtitles"])', true) + `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: hidden;
                }
                .${flagClass} {
                    width: calc(clamp(24px, 6vw, 32px) * var(--je-tag-scale, 1));
                    height: auto;
                    border-radius: 2px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    flex-shrink: 0;
                    object-fit: cover;
                }
                /* The host is otherwise below Jellyfin's full-card image link.
                   Its empty space remains pointer-transparent; only language
                   chips receive hover through native anchors supplied by the layout. */
                .je-tag-host:has(.${containerClass}) { z-index: 2; }
                .${containerClass} > * { pointer-events: auto; }
                .language-link { display: inline-flex; color: inherit; text-decoration: none; }
                .je-tag-pill[href] { pointer-events: auto; text-decoration: none; }
                .language-chip {
                    display: inline-flex; align-items: center; gap: calc(3px * var(--je-tag-scale, 1));
                    align-self: flex-start; flex-shrink: 0; width: max-content;
                    background: rgba(15,15,15,0.72); color: #fff;
                    font-family: inherit;
                }
                .language-cc { font-size: inherit; }
                .language-subtitle .language-flag { box-shadow: none; }
                /* Dub that doesn't cover every episode: dimmed, washed out and
                   dash-outlined so it reads as "incomplete" next to a full flag.
                   The dark ring keeps the white dashes (and a white flag's edge)
                   visible on light posters. */
                .${partialFlagClass} { opacity: 0.55; }
                img.${partialFlagClass} {
                    opacity: 0.55;
                    filter: saturate(0.5);
                    outline: 1px dashed rgba(255, 255, 255, 0.95);
                    outline-offset: -1px;
                    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
                }
                .layout-mobile .${flagClass} {
                    width: calc(clamp(20px, 5vw, 26px) * var(--je-tag-scale, 1));
                }
                .layout-mobile .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                @media (max-width: 768px) {
                    .${flagClass} {
                        width: calc(clamp(20px, 5vw, 26px) * var(--je-tag-scale, 1));
                        gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${flagClass} {
                        width: calc(clamp(16px, 4vw, 20px) * var(--je-tag-scale, 1));
                    }
                    .${containerClass} {
                        gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
            `;
      },
      pipeline: {
        needsFirstEpisode: true,
        needsParentSeries: false,
        render(ctx, el, item, extras) {
          if (ctx.shouldIgnore(el)) return;
          if (ctx.isTagged(el)) return;
          if (el.closest(".je-hidden")) return;
          const itemId = String(item.Id);
          const hot = export10(ctx.hot?.get(itemId));
          if (typeof hot.timestamp === "number" && Date.now() - hot.timestamp < ctx.cacheTtl) {
            if (hot.value) insertLanguageTags(ctx, el, hot.value);
            return;
          }
          let sourceItem = item;
          if (item.Type === "Series" || item.Type === "Season") {
            if (extras.firstEpisode) {
              sourceItem = extras.firstEpisode;
            } else {
              return;
            }
          }
          const languages = { audio: extractLanguagesFromItem(sourceItem), subtitles: subtitleFacts(sourceItem, item) };
          {
            ctx.setPersistent(itemId, languages);
            ctx.hot?.set(itemId, { value: languages, timestamp: Date.now() });
            insertLanguageTags(ctx, el, languages);
          }
        },
        renderFromCache(ctx, el, itemId) {
          if (ctx.isTagged(el)) return true;
          if (ctx.shouldIgnore(el)) return true;
          if (el.closest(".je-hidden")) return true;
          const hot = ctx.hot?.get(itemId);
          const cached = hot || ctx.getPersistent(itemId);
          if (cached) {
            const entry = export10(cached);
            const languages = Array.isArray(cached) ? cached : entry.value || entry.languages || cached;
            if (languages && !Array.isArray(languages)) {
              insertLanguageTags(ctx, el, languages);
              return true;
            }
          }
          return false;
        },
        renderFromServerCache(ctx, el, entry) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          const codes = export7(entry.AudioLanguages);
          const partial = new Set(export7(entry.PartialAudioLanguages));
          const languages = codes.map(function(member) {
            const code = export6(member);
            return { name: displayName(code), code, partial: partial.has(code) };
          });
          const sdhCodes = export7(entry.SdhSubtitleLanguages);
          insertLanguageTags(ctx, el, { audio: languages, subtitles: export7(entry.SubtitleLanguages).map((code) => ({ code, sdh: sdhCodes.some((sdh) => JE.core.mediaLanguage.matchesLanguage(code, sdh, { requireRegion: true })) })) });
        }
      }
    };
    JE.initializeLanguageTags = function() {
      JE.core.tagRenderer.register("language", spec);
    };
    JE.reinitializeLanguageTags = function() {
      JE.core.tagRenderer.reinitialize("language", spec);
    };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/language/languagetags-entry.ts
  createLanguageTags(export4());
})();
})();
//# sourceMappingURL=languagetags.js.map
