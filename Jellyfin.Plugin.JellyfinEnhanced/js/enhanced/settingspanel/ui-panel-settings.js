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

  // client/src/features/shared/dom.ts
  function requireId(id) {
    const element = document.getElementById(id);
    if (!element) throw new TypeError(`Missing panel control #${id}`);
    return element;
  }
  function inputById(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement ? element : null;
  }
  function selectById(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLSelectElement ? element : null;
  }
  function targetElement(event) {
    return event.target instanceof Element ? event.target : null;
  }
  function closestTarget(event, selector) {
    const found = targetElement(event)?.closest(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryInput(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLInputElement ? found : null;
  }
  function queryElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
  }
  function controlValue(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement ? target.value : void 0;
  }
  function controlChecked(target) {
    return target instanceof HTMLInputElement ? target.checked : void 0;
  }
  function setDisabled(node, disabled) {
    if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) node.disabled = disabled;
  }
  function isDisabled(node) {
    return (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) && node.disabled;
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
  function audioLanguageOptions(cultures) {
    const seen = /* @__PURE__ */ new Set();
    return cultures.map((c) => ({ code: c.twoLetter || c.threeLetter, name: c.displayName || c.name })).filter((o) => o.code && o.name && !seen.has(o.code) && seen.add(o.code)).sort((a, b) => a.name.localeCompare(b.name));
  }

  // client/src/features/shared/settings-values.ts
  function indexKey(value) {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : void 0;
    if (typeof value === "string" && value !== "" && String(Number(value)) === value) {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 ? n : void 0;
    }
    return void 0;
  }
  function entryAt(list, value, fallback) {
    const key = indexKey(value ?? fallback);
    return key === void 0 ? void 0 : list[key];
  }

  // client/src/features/settings-panel/subtitle-format.ts
  var NON_TEXT_CODECS = /* @__PURE__ */ new Set(["ass", "ssa", "pgssub", "pgs", "dvdsub", "dvbsub", "vobsub"]);
  var field = (value, key) => value !== null && typeof value === "object" ? Reflect.get(value, key) : void 0;
  function activeSubtitleIsBitmap(sessions) {
    if (!Array.isArray(sessions)) return false;
    const session = sessions.find((s) => !!field(s, "NowPlayingItem"));
    const streams = field(field(session, "NowPlayingItem"), "MediaStreams");
    const activeIndex = field(field(session, "PlayState"), "SubtitleStreamIndex");
    if (activeIndex == null || !Array.isArray(streams)) return false;
    const active = streams.find((s) => field(s, "Type") === "Subtitle" && field(s, "Index") === activeIndex);
    const codec = field(active, "Codec");
    return !!active && NON_TEXT_CODECS.has((typeof codec === "string" ? codec : "").toLowerCase());
  }
  function colorWithAlpha(swatch, alpha) {
    return swatch + parseInt(alpha).toString(16).padStart(2, "0").toUpperCase();
  }
  function clampPauseDelay(raw) {
    return Math.max(1, Math.min(60, parseInt(raw, 10) || 5));
  }
  function clampPosition(pct) {
    return Math.max(2, Math.min(98, pct));
  }

  // client/src/features/settings-panel/ui-panel-settings.ts
  var TAG_GROUP_TOGGLES = ["qualityTagsToggle", "genreTagsToggle", "languageTagsToggle", "ratingTagsToggle", "ageRatingTagsToggle", "statusTagsToggle", "awardsTagsToggle", "logoTagsToggle", "customTagsToggle"];
  var anyEntryHasLogos = (entries) => {
    for (const entry of entries) {
      const logos = entry !== null && typeof entry === "object" ? Reflect.get(entry, "Logos") : void 0;
      if (Array.isArray(logos) && logos.length > 0) return true;
    }
    return false;
  };
  var sourceItems = (response) => {
    const items = response !== null && typeof response === "object" ? Reflect.get(response, "Items") : void 0;
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item !== null && typeof item === "object").map((item) => {
      const id = Reflect.get(item, "Id");
      const name = Reflect.get(item, "Name");
      return { id: typeof id === "string" ? id : String(id), name: typeof name === "string" ? name : "", type: Reflect.get(item, "Type") };
    });
  };
  function installUiPanelSettings(JE, featureCtx = settingsPanelContext(JE)) {
    const internal = registry(JE);
    const { showReleaseNotesNotification } = internal;
    const fontSizeAt = (value) => entryAt(JE.fontSizePresets, value, 2) || JE.fontSizePresets[2];
    const fontFamilyAt = (value) => entryAt(JE.fontFamilyPresets, value, 0) || JE.fontFamilyPresets[0];
    const requirePreset = (preset, what) => {
      if (preset === void 0) throw new TypeError(`Missing subtitle ${what} preset`);
      return preset;
    };
    const updatePositionPreviewFont = (fontSizePreset, fontFamilyPreset) => {
      const posPreviewEl = document.getElementById("subtitlePositionPreview");
      const normal = JE.fontSizePresets[2];
      if (!posPreviewEl || !fontSizePreset || !fontFamilyPreset || !normal) return;
      const px = Math.max(8, Math.min(22, 13 * (fontSizePreset.size / normal.size)));
      posPreviewEl.style.fontSize = `${px}px`;
      posPreviewEl.style.fontFamily = fontFamilyPreset.family;
    };
    const restackTagCorners = () => {
      const restack = JE.core?.tagRenderer?.applyCornerStacking;
      if (typeof restack !== "function") return;
      const hosts = /* @__PURE__ */ new Set();
      document.querySelectorAll("[data-je-corner]").forEach((el) => {
        if (el.parentElement) hosts.add(el.parentElement);
      });
      hosts.forEach((host) => restack(host));
    };
    const removeTagGroup = (group, containerClass) => {
      JE.core?.tagLayout?.removeGroupEverywhere(group);
      document.querySelectorAll(`.${containerClass}`).forEach((el) => el.remove());
      restackTagCorners();
    };
    internal.removeTagGroup = removeTagGroup;
    const redrawLogosWhenServerHasThem = () => {
      const pipeline = featureCtx.peer("tagPipeline");
      if (!pipeline?.waitForServerCache || anyEntryHasLogos(pipeline.serverEntries?.() || [])) return;
      pipeline.waitForServerCache(anyEntryHasLogos).then((ready) => {
        if (ready && JE.currentSettings?.logoTagsEnabled) featureCtx.peer("reinitializeLogoTags")?.();
      }).catch(() => {
      });
    };
    const TAG_TOGGLE_ACTIONS = {
      qualityTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeQualityTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("quality", "quality-overlay-container") },
      genreTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeGenreTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("genre", "genre-overlay-container") },
      languageTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeLanguageTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("language", "language-overlay-container") },
      ratingTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeRatingTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("rating", "rating-overlay-container") },
      ageRatingTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeAgeRatingTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("ageRating", "age-rating-overlay-container") },
      logoTagsToggle: {
        on: () => {
          const peerFn = featureCtx.peer("initializeLogoTags");
          if (typeof peerFn === "function") peerFn();
          redrawLogosWhenServerHasThem();
        },
        off: () => {
          featureCtx.peer("tagPipeline")?.stopWaitingForServerCache?.();
          removeTagGroup("logos", "logo-overlay-container");
        }
      },
      statusTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeStatusTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("status", "status-overlay-container") },
      awardsTagsToggle: { on: () => featureCtx.peer("initializeAwardsTags")?.(), off: () => removeTagGroup("awards", "awards-overlay-container") },
      customTagsToggle: { on: () => {
        const peerFn = featureCtx.peer("initializeCustomTags");
        if (typeof peerFn === "function") peerFn();
      }, off: () => removeTagGroup("custom", "custom-overlay-container") },
      peopleTagsToggle: {
        on: () => {
          const peerFn = featureCtx.peer("initializePeopleTags");
          if (typeof peerFn === "function") peerFn();
        },
        off: () => {
          document.querySelectorAll(".je-people-place-banner").forEach((el) => el.remove());
          document.querySelectorAll(".je-people-age-container").forEach((el) => el.remove());
          document.querySelectorAll(".je-deceased-poster").forEach((el) => el.classList.remove("je-deceased-poster"));
        }
      }
    };
    function refreshQualityCatArrowStates(group) {
      const rows = queryElements(group, ".je-quality-cat-row");
      rows.forEach((row, idx) => {
        const upBtn = row.querySelector(".je-cat-up");
        const downBtn = row.querySelector(".je-cat-down");
        const isFirst = idx === 0;
        const isLast = idx === rows.length - 1;
        if (upBtn instanceof HTMLElement) {
          setDisabled(upBtn, isFirst);
          upBtn.style.cursor = isFirst ? "not-allowed" : "pointer";
          upBtn.style.opacity = isFirst ? "0.4" : "1";
        }
        if (downBtn instanceof HTMLElement) {
          setDisabled(downBtn, isLast);
          downBtn.style.cursor = isLast ? "not-allowed" : "pointer";
          downBtn.style.opacity = isLast ? "0.4" : "1";
        }
      });
    }
    const wireNestedList = (masterId, wrapId, groupId, expanderId) => {
      const master = inputById(masterId);
      const wrap = document.getElementById(wrapId);
      const group = document.getElementById(groupId);
      const expander = document.getElementById(expanderId);
      if (master && wrap) {
        master.addEventListener("change", () => {
          wrap.style.display = master.checked ? "block" : "none";
          if (!master.checked && group && expander) {
            group.style.display = "none";
            expander.setAttribute("aria-expanded", "false");
          }
        });
      }
      if (expander && group) {
        expander.addEventListener("click", () => {
          const expanded = expander.getAttribute("aria-expanded") === "true";
          expander.setAttribute("aria-expanded", expanded ? "false" : "true");
          group.style.display = expanded ? "none" : "block";
        });
      }
      return group;
    };
    internal.wireSettingsListeners = function(ctx) {
      const { createToast, resetAutoCloseTimer } = ctx;
      const unregisterAudioSearch = ctx.registerSearch?.({
        pane: "ui",
        /** Find the moved detail-page preference by its visible label. */
        search(query) {
          const control = ctx.help?.querySelector('[data-pane="ui"] #showAudioLanguagesToggle');
          const label = JE.t("panel_settings_ui_audio_languages");
          return control instanceof HTMLElement && label.toLowerCase().includes(query) ? [{
            label,
            path: JE.t("panel_settings_ui"),
            run() {
              control.scrollIntoView?.({ block: "center" });
              control.focus({ preventScroll: true });
            }
          }] : [];
        }
      });
      if (unregisterAudioSearch) ctx.onClose?.(unregisterAudioSearch);
      const addSettingToggleListener = (id, settingKey, featureKey, requiresRefresh = false) => {
        requireId(id).addEventListener("change", (e) => {
          const checked = controlChecked(e.target);
          JE.currentSettings[settingKey] = checked;
          JE.core?.tagLayout?.invalidateSettings();
          JE.saveUserSettings("settings.json", JE.currentSettings);
          let toastMessage = createToast(featureKey, checked === true);
          const tagAction = Object.prototype.hasOwnProperty.call(TAG_TOGGLE_ACTIONS, id) ? TAG_TOGGLE_ACTIONS[id] : void 0;
          if (tagAction) {
            if (checked) tagAction.on();
            else tagAction.off();
            requiresRefresh = false;
          }
          if (TAG_GROUP_TOGGLES.includes(id)) featureCtx.peer("reinitializeTagLayout")?.();
          if (requiresRefresh) {
            toastMessage += ".<br> Refresh page to apply.";
          }
          JE.toast(toastMessage);
          if (id === "randomButtonToggle") JE.addRandomButton();
          if (id === "showWatchProgressToggle" && !checked) document.querySelectorAll(".mediaInfoItem-watchProgress").forEach((el) => el.remove());
          if (id === "showFileSizesToggle" && !checked) document.querySelectorAll(".mediaInfoItem-fileSize").forEach((el) => el.remove());
          if (id === "showAudioLanguagesToggle" && !checked) document.querySelectorAll(".mediaInfoItem-audioLanguage").forEach((el) => el.remove());
          resetAutoCloseTimer();
        });
      };
      const addSelectListener = (id, settingKey) => {
        const select = document.getElementById(id);
        if (!select) return;
        select.addEventListener("change", (e) => {
          JE.currentSettings[settingKey] = controlValue(e.target);
          JE.saveUserSettings("settings.json", JE.currentSettings);
          resetAutoCloseTimer();
        });
      };
      addSettingToggleListener("autoPauseToggle", "autoPauseEnabled", "feature_auto_pause");
      addSettingToggleListener("autoResumeToggle", "autoResumeEnabled", "feature_auto_resume");
      addSettingToggleListener("autoPipToggle", "autoPipEnabled", "feature_auto_pip");
      addSettingToggleListener("autoSkipIntroToggle", "autoSkipIntro", "feature_auto_skip_intro");
      addSettingToggleListener("autoSkipOutroToggle", "autoSkipOutro", "feature_auto_skip_outro");
      addSettingToggleListener("randomButtonToggle", "randomButtonEnabled", "feature_random_button");
      addSettingToggleListener("randomUnwatchedOnly", "randomUnwatchedOnly", "feature_unwatched_only");
      addSettingToggleListener("randomScopeCurrentContainer", "randomScopeCurrentContainer", "feature_random_scope_current");
      addSettingToggleListener("showWatchProgressToggle", "showWatchProgress", "feature_watch_progress_display");
      addSelectListener("watchProgressModeSelect", "watchProgressMode");
      addSelectListener("watchProgressTimeFormatSelect", "watchProgressTimeFormat");
      addSettingToggleListener("showFileSizesToggle", "showFileSizes", "feature_file_size_display");
      addSettingToggleListener("showAudioLanguagesToggle", "showAudioLanguages", "feature_audio_language_display");
      addSettingToggleListener("removeContinueWatchingToggle", "removeContinueWatchingEnabled", "feature_remove_continue_watching");
      document.getElementById("nativePosterTagsToggle")?.addEventListener("change", (event) => {
        if (JE.pluginConfig?.NativePosterTagsEnabled !== true) return;
        const enabled = controlChecked(event.target);
        JE.userConfig = JE.userConfig || { shortcuts: { Shortcuts: [] } };
        JE.userConfig.settings = JE.userConfig.settings || {};
        JE.userConfig.settings.useNativePosterTags = enabled;
        JE.currentSettings.useNativePosterTags = enabled;
        JE.saveUserSettings("settings.json", JE.currentSettings);
        JE.toast(JE.t("toast_native_poster_tags_saved"));
        resetAutoCloseTimer();
      });
      addSettingToggleListener("qualityTagsToggle", "qualityTagsEnabled", "feature_quality_tags", true);
      const qualitySubGroup = wireNestedList("qualityTagsToggle", "qualityTagsSubWrap", "qualityTagsSubToggles", "qualityTagsSubToggleExpander");
      if (qualitySubGroup) {
        qualitySubGroup.addEventListener("change", (e) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
          const row = target.closest(".je-quality-cat-row");
          if (!(row instanceof HTMLElement)) return;
          const settingKey = row.dataset.catKey;
          if (!settingKey) return;
          JE.setSettingInherited?.(JE.currentSettings, settingKey, false);
          JE.currentSettings[settingKey] = target.checked;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          const reinitQuality = featureCtx.peer("reinitializeQualityTags");
          if (typeof reinitQuality === "function" && JE.currentSettings.qualityTagsEnabled) {
            reinitQuality();
          }
          resetAutoCloseTimer();
        });
        qualitySubGroup.addEventListener("click", (e) => {
          const btn = closestTarget(e, ".je-cat-up, .je-cat-down");
          if (!btn || isDisabled(btn)) return;
          const row = btn.closest(".je-quality-cat-row");
          if (!row) return;
          const isUp = btn.classList.contains("je-cat-up");
          const sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
          if (!sibling || !sibling.classList.contains("je-quality-cat-row")) return;
          const parent = sibling.parentNode;
          if (!parent) return;
          if (isUp) {
            parent.insertBefore(row, sibling);
          } else {
            parent.insertBefore(sibling, row);
          }
          queryElements(qualitySubGroup, ".je-quality-cat-row").forEach((r, idx) => {
            const orderKey = r.dataset.orderKey;
            if (!orderKey) return;
            JE.setSettingInherited?.(JE.currentSettings, orderKey, false);
            JE.currentSettings[orderKey] = idx + 1;
          });
          JE.saveUserSettings("settings.json", JE.currentSettings);
          refreshQualityCatArrowStates(qualitySubGroup);
          const reinitQuality = featureCtx.peer("reinitializeQualityTags");
          if (typeof reinitQuality === "function" && JE.currentSettings.qualityTagsEnabled) {
            reinitQuality();
          }
          resetAutoCloseTimer();
        });
      }
      queryElements(document, "[data-quality-display-key]").forEach((select) => {
        select.addEventListener("change", () => {
          const key = select.dataset.qualityDisplayKey ?? "";
          const value = controlValue(select);
          if (value === "") {
            if (!JE.setSettingInherited?.(JE.currentSettings, key, true)) JE.currentSettings[key] = null;
          } else {
            JE.setSettingInherited?.(JE.currentSettings, key, false);
            JE.currentSettings[key] = key === "qualityHideSdr" ? value === "true" : value;
          }
          JE.saveUserSettings("settings.json", JE.currentSettings);
          featureCtx.peer("reinitializeQualityTags")?.();
          featureCtx.peer("reinitializeTagLayout")?.();
          resetAutoCloseTimer();
        });
      });
      const lowSourceToggle = inputById("showLowQualitySourceTagToggle");
      if (lowSourceToggle) lowSourceToggle.addEventListener("change", () => {
        JE.setSettingInherited?.(JE.currentSettings, "showLowQualitySourceTag", false);
        JE.currentSettings.showLowQualitySourceTag = lowSourceToggle.checked;
        JE.saveUserSettings("settings.json", JE.currentSettings);
        if (JE.currentSettings.qualityTagsEnabled) featureCtx.peer("reinitializeQualityTags")?.();
        resetAutoCloseTimer();
      });
      const aggregationSelect = selectById("seriesQualityAggregationSelect");
      if (aggregationSelect) {
        const policy = JE.currentSettings.seriesQualityAggregation;
        aggregationSelect.value = JE.isSettingInherited?.(JE.currentSettings, "seriesQualityAggregation") ? "" : String(policy || "representative");
        aggregationSelect.addEventListener("change", () => {
          const chosen = aggregationSelect.value;
          if (!chosen) {
            if (!JE.setSettingInherited?.(JE.currentSettings, "seriesQualityAggregation", true)) JE.currentSettings.seriesQualityAggregation = null;
          } else {
            JE.setSettingInherited?.(JE.currentSettings, "seriesQualityAggregation", false);
            JE.currentSettings.seriesQualityAggregation = chosen;
          }
          JE.saveUserSettings("settings.json", JE.currentSettings);
          featureCtx.peer("reinitializeQualityTags")?.();
          resetAutoCloseTimer();
        });
      }
      const qualityFollowServer = document.getElementById("qualityTagsFollowServer");
      if (qualityFollowServer) qualityFollowServer.addEventListener("click", () => {
        for (const key of JE.inheritedSettingKeys || []) {
          if (!JE.setSettingInherited?.(JE.currentSettings, key, true)) JE.currentSettings[key] = null;
        }
        JE.saveUserSettings("settings.json", JE.currentSettings);
        if (qualitySubGroup) queryElements(qualitySubGroup, ".je-quality-cat-row").forEach((row) => {
          const input = queryInput(row, 'input[type="checkbox"]');
          const value = JE.currentSettings[row.dataset.catKey ?? ""];
          if (input && typeof value === "boolean") input.checked = value;
        });
        queryElements(document, "[data-quality-display-key]").forEach((select) => {
          if (select instanceof HTMLSelectElement) select.value = "";
        });
        const lowSource = JE.currentSettings.showLowQualitySourceTag;
        if (lowSourceToggle && typeof lowSource === "boolean") lowSourceToggle.checked = lowSource;
        if (aggregationSelect) aggregationSelect.value = "";
        if (qualitySubGroup) {
          const orderOf = (r) => Number(JE.currentSettings[r.dataset.orderKey ?? ""]) || Number(r.dataset.defaultOrder) || 0;
          const rows = queryElements(qualitySubGroup, ".je-quality-cat-row");
          rows.sort((a, b) => orderOf(a) - orderOf(b) || Number(a.dataset.defaultOrder) - Number(b.dataset.defaultOrder)).forEach((r) => qualitySubGroup.appendChild(r));
          refreshQualityCatArrowStates(qualitySubGroup);
        }
        if (JE.currentSettings.qualityTagsEnabled) featureCtx.peer("reinitializeQualityTags")?.();
        featureCtx.peer("reinitializeTagLayout")?.();
        JE.toast(JE.t("toast_quality_tags_follow_server"));
        resetAutoCloseTimer();
      });
      const audioLangSelect = selectById("qualityTagsAudioLanguageSelect");
      if (audioLangSelect) {
        const savedLanguage = () => {
          const value = JE.currentSettings.qualityTagsPreferredAudioLanguage;
          return value ? String(value) : "";
        };
        const initial = savedLanguage();
        if (Array.from(audioLangSelect.options).some((o) => o.value === initial)) audioLangSelect.value = initial;
        (async () => {
          try {
            const client = apiClient();
            const cultures = decodeCultures(await client.ajax({ type: "GET", url: client.getUrl("/Localization/Cultures"), dataType: "json" }));
            audioLanguageOptions(cultures).forEach(({ code, name }) => {
              const option = document.createElement("option");
              option.value = code;
              option.textContent = name;
              option.style.background = "rgba(30,30,30,1)";
              option.style.color = "#fff";
              audioLangSelect.appendChild(option);
            });
          } catch (err) {
            console.warn("🪼 Jellyfin Enhanced: Failed to load audio language options:", err);
          }
          const saved = savedLanguage();
          if (saved && !Array.from(audioLangSelect.options).some((o) => o.value === saved)) {
            const option = document.createElement("option");
            option.value = saved;
            option.textContent = saved;
            audioLangSelect.appendChild(option);
          }
          audioLangSelect.value = saved;
        })();
        audioLangSelect.addEventListener("change", () => {
          JE.currentSettings.qualityTagsPreferredAudioLanguage = audioLangSelect.value;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          const reinitQuality = featureCtx.peer("reinitializeQualityTags");
          if (typeof reinitQuality === "function" && JE.currentSettings.qualityTagsEnabled) {
            reinitQuality();
          }
          resetAutoCloseTimer();
        });
      }
      addSettingToggleListener("genreTagsToggle", "genreTagsEnabled", "feature_genre_tags", true);
      addSettingToggleListener("pauseScreenToggle", "pauseScreenEnabled", "feature_custom_pause_screen", true);
      const pauseScreenDelayInput = document.getElementById("pauseScreenDelayInput");
      if (pauseScreenDelayInput instanceof HTMLInputElement) {
        pauseScreenDelayInput.addEventListener("keydown", (e) => e.stopPropagation());
        pauseScreenDelayInput.addEventListener("change", () => {
          const val = clampPauseDelay(pauseScreenDelayInput.value);
          pauseScreenDelayInput.value = String(val);
          JE.currentSettings.pauseScreenDelaySeconds = val;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          if (JE.pauseScreenInstance) {
            JE.pauseScreenInstance.pauseScreenDelayMs = val * 1e3;
          }
        });
      }
      addSettingToggleListener("languageTagsToggle", "languageTagsEnabled", "feature_language_tags", true);
      addSettingToggleListener("ratingTagsToggle", "ratingTagsEnabled", "feature_rating_tags", true);
      addSettingToggleListener("ageRatingTagsToggle", "ageRatingTagsEnabled", "feature_age_rating_tags", true);
      addSettingToggleListener("statusTagsToggle", "statusTagsEnabled", "feature_status_tags", true);
      if (document.getElementById("awardsTagsToggle")) addSettingToggleListener("awardsTagsToggle", "awardsTagsEnabled", "feature_awards_tags", true);
      addSettingToggleListener("logoTagsToggle", "logoTagsEnabled", "feature_logo_tags", true);
      addSettingToggleListener("customTagsToggle", "customTagsEnabled", "feature_custom_tags", true);
      addSettingToggleListener("peopleTagsToggle", "peopleTagsEnabled", "feature_people_tags", true);
      addSettingToggleListener("tagsHideOnHoverToggle", "tagsHideOnHover", "feature_tags_hide_on_hover", false);
      const saveTagLayoutSetting = (key, value) => {
        JE.core?.tagLayout?.promoteLegacySettings(JE.currentSettings);
        JE.currentSettings[key] = value;
        JE.currentSettings.tagLayoutSettingsVersion = 1;
        JE.saveUserSettings("settings.json", JE.currentSettings);
        const peerFn = featureCtx.peer("reinitializeTagLayout");
        if (typeof peerFn === "function") peerFn();
        JE.toast(JE.t("toast_tag_layout_updated"));
        resetAutoCloseTimer();
      };
      document.getElementById("jeTagLayoutChoice")?.addEventListener("change", (e) => saveTagLayoutSetting("tagLayout", controlValue(e.target)));
      document.getElementById("jeTagDensityChoice")?.addEventListener("change", (e) => saveTagLayoutSetting("tagLabelDensity", controlValue(e.target)));
      document.getElementById("jeTagScaleChoice")?.addEventListener("change", (e) => saveTagLayoutSetting("tagScale", controlValue(e.target)));
      document.getElementById("jeTagGapChoice")?.addEventListener("change", (e) => saveTagLayoutSetting("tagGap", controlValue(e.target)));
      document.getElementById("jeTagEdgeChoice")?.addEventListener("change", (e) => saveTagLayoutSetting("tagEdgeSpacing", controlValue(e.target)));
      document.getElementById("jeTagPresetChoice")?.addEventListener("change", (e) => {
        JE.currentSettings.tagStylePreset = controlValue(e.target) || null;
        JE.saveUserSettings("settings.json", JE.currentSettings);
        const peerFn = featureCtx.peer("initializeTagStyles");
        if (typeof peerFn === "function") peerFn();
        JE.toast(JE.t("toast_tag_style_preset_updated"));
        resetAutoCloseTimer();
      });
      const hideOnHoverCheckbox = inputById("tagsHideOnHoverToggle");
      if (hideOnHoverCheckbox) {
        hideOnHoverCheckbox.addEventListener("change", () => {
          document.body.classList.toggle("je-tags-hide-on-hover", hideOnHoverCheckbox.checked);
        });
      }
      const wireCatKeyToggles = (group, enabledKey, reinitialize) => {
        if (!group) return;
        group.addEventListener("change", (e) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
          const row = target.closest(".je-quality-cat-row");
          const settingKey = row instanceof HTMLElement ? row.dataset.catKey : void 0;
          if (!settingKey) return;
          JE.currentSettings[settingKey] = target.checked;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          if (JE.currentSettings[enabledKey]) reinitialize();
          resetAutoCloseTimer();
        });
      };
      wireCatKeyToggles(
        wireNestedList("ratingTagsToggle", "ratingTagsSubWrap", "ratingTagsSubToggles", "ratingTagsSubToggleExpander"),
        "ratingTagsEnabled",
        () => {
          const peerFn = featureCtx.peer("reinitializeRatingTags");
          if (typeof peerFn === "function") peerFn();
        }
      );
      wireCatKeyToggles(
        wireNestedList("statusTagsToggle", "statusTagsSubWrap", "statusTagsSubToggles", "statusTagsSubToggleExpander"),
        "statusTagsEnabled",
        () => {
          const peerFn = featureCtx.peer("reinitializeStatusTags");
          if (typeof peerFn === "function") peerFn();
        }
      );
      addSettingToggleListener("disableCustomSubtitleStyles", "disableCustomSubtitleStyles", "feature_disable_custom_subtitle_styles", true);
      addSettingToggleListener("longPress2xEnabled", "longPress2xEnabled", "feature_long_press_2x_speed");
      (function wireSubtitleStylingWarnings() {
        const positionNote = document.getElementById("je-subtitle-position-note");
        const formatWarning = document.getElementById("je-subtitle-format-warning");
        if (!positionNote && !formatWarning) return;
        const disableStylesCheckbox = document.getElementById("disableCustomSubtitleStyles");
        const stylesEnabled = () => !JE.currentSettings.disableCustomSubtitleStyles;
        if (positionNote) {
          let isCustom = false;
          try {
            const userId = optionalApiClient()?.getCurrentUserId?.();
            const raw = userId && localStorage.getItem(`${userId}-localplayersubtitleappearance3`);
            const appearance = raw ? JSON.parse(raw) : null;
            isCustom = appearance !== null && typeof appearance === "object" && Reflect.get(appearance, "subtitleStyling") === "Custom";
          } catch {
          }
          const applyPositionNoteState = () => {
            positionNote.style.display = stylesEnabled() && !isCustom ? "flex" : "none";
          };
          applyPositionNoteState();
          if (disableStylesCheckbox) disableStylesCheckbox.addEventListener("change", applyPositionNoteState);
        }
        if (formatWarning) {
          (async () => {
            let isUnsupportedFormat = false;
            try {
              const client = apiClient();
              const userId = client.getCurrentUserId?.();
              const sessions = userId ? await client.getSessions({ ControllableByUserId: userId }) : [];
              isUnsupportedFormat = activeSubtitleIsBitmap(sessions);
            } catch {
            }
            const applyFormatWarningState = () => {
              formatWarning.style.display = stylesEnabled() && isUnsupportedFormat ? "flex" : "none";
            };
            applyFormatWarningState();
            if (disableStylesCheckbox) disableStylesCheckbox.addEventListener("change", applyFormatWarningState);
          })();
        }
      })();
      const syncPreviewTextShadow = (bgColor) => {
        const shadow = JE.getSubtitleTextShadow(bgColor);
        ["subtitleColorPreview", "subtitlePositionPreview"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.style.textShadow = shadow;
        });
      };
      internal.syncSubtitlePreviewTextShadow = syncPreviewTextShadow;
      const customTextColorPicker = inputById("customSubtitleTextColorPicker");
      const customTextAlpha = inputById("customSubtitleTextAlpha");
      const customBgColorPicker = inputById("customSubtitleBgColorPicker");
      const customBgAlpha = inputById("customSubtitleBgAlpha");
      const updateCustomSubtitleColors = () => {
        if (!customTextColorPicker || !customTextAlpha || !customBgColorPicker || !customBgAlpha) {
          throw new TypeError("The custom subtitle colour controls are incomplete");
        }
        const textColor = colorWithAlpha(customTextColorPicker.value, customTextAlpha.value);
        const bgColor = colorWithAlpha(customBgColorPicker.value, customBgAlpha.value);
        JE.currentSettings.customSubtitleTextColor = textColor;
        JE.currentSettings.customSubtitleBgColor = bgColor;
        JE.currentSettings.usingCustomColors = true;
        const styleContainer = document.getElementById("subtitle-style-presets-container");
        if (styleContainer) {
          queryElements(styleContainer, ".preset-box").forEach((box) => {
            box.style.setProperty("border", "2px solid transparent", "important");
          });
        }
        const preview = document.getElementById("subtitleColorPreview");
        if (preview) {
          preview.style.color = textColor;
          preview.style.backgroundColor = bgColor;
        }
        const posPreviewEl = document.getElementById("subtitlePositionPreview");
        if (posPreviewEl) {
          posPreviewEl.style.color = textColor;
          posPreviewEl.style.backgroundColor = bgColor;
        }
        syncPreviewTextShadow(bgColor);
        JE.saveUserSettings("settings.json", JE.currentSettings);
        JE.applySavedStylesWhenReady();
        resetAutoCloseTimer();
      };
      if (customTextColorPicker) customTextColorPicker.addEventListener("input", updateCustomSubtitleColors);
      if (customTextAlpha) customTextAlpha.addEventListener("input", updateCustomSubtitleColors);
      if (customBgColorPicker) customBgColorPicker.addEventListener("input", updateCustomSubtitleColors);
      if (customBgAlpha) customBgAlpha.addEventListener("input", updateCustomSubtitleColors);
      const posGrid = document.getElementById("subtitlePositionGrid");
      const posPreview = document.getElementById("subtitlePositionPreview");
      const posResetBtn = document.getElementById("subtitlePositionReset");
      if (posGrid) {
        const updatePosition = (rawX, rawY) => {
          const xPct = clampPosition(rawX);
          const yPct = clampPosition(rawY);
          if (posPreview) {
            posPreview.style.left = `${xPct}%`;
            posPreview.style.top = "auto";
            posPreview.style.bottom = `${100 - yPct}%`;
          }
          JE.currentSettings.subtitleHorizontalPosition = Math.round(xPct);
          JE.currentSettings.subtitleVerticalPosition = Math.round(yPct);
          if (typeof JE.applySubtitlePosition === "function") JE.applySubtitlePosition();
        };
        const pctFrom = (clientX, clientY) => {
          const rect = posGrid.getBoundingClientRect();
          return {
            x: (clientX - rect.left) / rect.width * 100,
            y: (clientY - rect.top) / rect.height * 100
          };
        };
        const pctFromTouch = (e) => {
          const touch = e.touches[0];
          return touch ? pctFrom(touch.clientX, touch.clientY) : null;
        };
        let dragging = false;
        posGrid.addEventListener("mousedown", (e) => {
          const { x, y } = pctFrom(e.clientX, e.clientY);
          updatePosition(x, y);
          dragging = true;
          e.preventDefault();
        });
        const onMouseMove = (e) => {
          if (!dragging) return;
          const { x, y } = pctFrom(e.clientX, e.clientY);
          updatePosition(x, y);
          resetAutoCloseTimer();
        };
        const endDrag = () => {
          if (!dragging) return;
          dragging = false;
          JE.saveUserSettings("settings.json", JE.currentSettings);
        };
        posGrid.addEventListener("touchstart", (e) => {
          const at = pctFromTouch(e);
          if (at) updatePosition(at.x, at.y);
          dragging = true;
          e.preventDefault();
        }, { passive: false });
        const onTouchMove = (e) => {
          if (!dragging) return;
          const at = pctFromTouch(e);
          if (at) updatePosition(at.x, at.y);
          resetAutoCloseTimer();
        };
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", endDrag);
        document.addEventListener("touchmove", onTouchMove, { passive: true });
        document.addEventListener("touchend", endDrag);
        ctx.onClose?.(() => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", endDrag);
          document.removeEventListener("touchmove", onTouchMove);
          document.removeEventListener("touchend", endDrag);
          endDrag();
        });
      }
      if (posResetBtn) {
        posResetBtn.addEventListener("click", () => {
          JE.currentSettings.subtitleHorizontalPosition = 50;
          JE.currentSettings.subtitleVerticalPosition = 95;
          if (posPreview) {
            posPreview.style.left = "50%";
            posPreview.style.top = "auto";
            posPreview.style.bottom = "5%";
          }
          if (typeof JE.applySubtitlePosition === "function") JE.applySubtitlePosition();
          JE.saveUserSettings("settings.json", JE.currentSettings);
          resetAutoCloseTimer();
        });
      }
    };
    internal.wireMiscSettingsControls = function(ctx) {
      const { primaryAccentColor, resetAutoCloseTimer } = ctx;
      const includeMovies = requireId("randomIncludeMovies");
      const includeShows = requireId("randomIncludeShows");
      const wireItemType = (own, other, key, itemType) => {
        own.addEventListener("change", (e) => {
          const target = e.target;
          if (!controlChecked(target) && !controlChecked(other)) {
            if (target instanceof HTMLInputElement) target.checked = true;
            JE.toast(JE.t("toast_at_least_one_item_type"));
            return;
          }
          const checked = controlChecked(target);
          JE.currentSettings[key] = checked;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          JE.toast(JE.t("toast_random_selection_status", { item_type: itemType, status: checked ? JE.t("selection_included") : JE.t("selection_excluded") }));
          resetAutoCloseTimer();
        });
      };
      wireItemType(includeMovies, includeShows, "randomIncludeMovies", "Movies");
      wireItemType(includeShows, includeMovies, "randomIncludeShows", "Shows");
      const sourceSelect = selectById("randomSourceSelect");
      if (sourceSelect) {
        const savedId = String(JE.currentSettings.randomSourceId || "");
        const client = apiClient();
        const userId = client.getCurrentUserId() ?? "";
        client.ajax({ type: "GET", url: client.getUrl(`/Users/${userId}/Items?IncludeItemTypes=Playlist,BoxSet&Recursive=true&SortBy=SortName`), dataType: "json" }).then(async (response) => {
          if (!sourceSelect.isConnected) return;
          const groups = { Playlist: "panel_settings_random_button_source_playlists", BoxSet: "panel_settings_random_button_source_collections" };
          const all = sourceItems(response);
          for (const [type, labelKey] of Object.entries(groups)) {
            const items = all.filter((item) => item.type === type);
            if (items.length === 0) continue;
            const group = document.createElement("optgroup");
            group.label = JE.t(labelKey);
            items.forEach((item) => group.appendChild(new Option(item.name, item.id, false, item.id === savedId)));
            sourceSelect.appendChild(group);
          }
          if (savedId && sourceSelect.value !== savedId) {
            const saved = await apiClient().getItem(userId, savedId).catch(() => null);
            if (!sourceSelect.isConnected || JE.currentSettings.randomSourceId !== savedId) return;
            const type = saved !== null && typeof saved === "object" ? Reflect.get(saved, "Type") : void 0;
            const name = saved !== null && typeof saved === "object" ? Reflect.get(saved, "Name") : void 0;
            const label = (type === "Playlist" || type === "BoxSet") && typeof name === "string" ? name : JE.t("panel_settings_random_button_source_missing");
            sourceSelect.appendChild(new Option(label, savedId, false, true));
          }
        }).catch((err) => console.warn("🪼 Jellyfin Enhanced: Could not list playlists for the random source picker", err));
        sourceSelect.addEventListener("change", () => {
          JE.currentSettings.randomSourceId = sourceSelect.value;
          JE.saveUserSettings("settings.json", JE.currentSettings);
          JE.toast(JE.t("toast_random_source_set", { name: JE.escapeHtml(sourceSelect.selectedOptions[0]?.textContent || "") }));
          resetAutoCloseTimer();
        });
      }
      requireId("releaseNotesBtn").addEventListener("click", async () => {
        ctx.closePanel();
        if (!showReleaseNotesNotification) throw new TypeError("Release notes are unavailable");
        await showReleaseNotesNotification();
      });
      const highlight = (box) => {
        if (box instanceof HTMLElement) box.style.setProperty("border", `2px solid ${primaryAccentColor}`, "important");
      };
      const savedColors = () => ({
        textColor: String(JE.currentSettings.customSubtitleTextColor || "#FFFFFFFF"),
        bgColor: String(JE.currentSettings.customSubtitleBgColor || "#00000000")
      });
      const applyPreset = (type, presetIndex) => {
        if (type === "style") {
          const selectedPreset2 = JE.subtitlePresets[presetIndex];
          if (!selectedPreset2) return null;
          JE.currentSettings.selectedStylePresetIndex = presetIndex;
          JE.currentSettings.usingCustomColors = false;
          JE.currentSettings.customSubtitleTextColor = selectedPreset2.textColor;
          JE.currentSettings.customSubtitleBgColor = selectedPreset2.bgColor;
          const textColorPicker = inputById("customSubtitleTextColorPicker");
          const textAlphaSlider = inputById("customSubtitleTextAlpha");
          const bgColorPicker = inputById("customSubtitleBgColorPicker");
          const bgAlphaSlider = inputById("customSubtitleBgAlpha");
          const preview = document.getElementById("subtitleColorPreview");
          if (textColorPicker && textAlphaSlider) {
            const decodedText = JE.decodeSubtitleColor(selectedPreset2.textColor, { fallbackSwatch: "#FFFFFF", fallbackAlphaValue: 255 });
            textColorPicker.value = decodedText.swatch;
            textAlphaSlider.value = String(decodedText.alphaValue);
          }
          if (bgColorPicker && bgAlphaSlider) {
            const decodedBg = JE.decodeSubtitleColor(selectedPreset2.bgColor, { fallbackSwatch: "#000000", fallbackAlphaValue: 0 });
            bgColorPicker.value = decodedBg.swatch;
            bgAlphaSlider.value = String(decodedBg.alphaValue);
          }
          if (preview) {
            preview.style.color = selectedPreset2.textColor;
            preview.style.backgroundColor = selectedPreset2.bgColor;
          }
          const posPreviewEl = document.getElementById("subtitlePositionPreview");
          if (posPreviewEl) {
            posPreviewEl.style.color = selectedPreset2.textColor;
            posPreviewEl.style.backgroundColor = selectedPreset2.bgColor;
          }
          const fontSize2 = requirePreset(fontSizeAt(JE.currentSettings.selectedFontSizePresetIndex), "size");
          const fontFamily2 = requirePreset(fontFamilyAt(JE.currentSettings.selectedFontFamilyPresetIndex), "font");
          updatePositionPreviewFont(fontSize2, fontFamily2);
          internal.syncSubtitlePreviewTextShadow?.(selectedPreset2.bgColor);
          JE.applySubtitleStyles(selectedPreset2.textColor, selectedPreset2.bgColor, fontSize2.size, fontFamily2.family, JE.getSubtitleTextShadow(selectedPreset2.bgColor));
          return JE.t("toast_subtitle_style", { style: selectedPreset2.name });
        }
        if (type === "font-size") {
          const selectedPreset2 = JE.fontSizePresets[presetIndex];
          if (!selectedPreset2) return null;
          JE.currentSettings.selectedFontSizePresetIndex = presetIndex;
          const fontFamily2 = requirePreset(fontFamilyAt(JE.currentSettings.selectedFontFamilyPresetIndex), "font");
          const { textColor: textColor2, bgColor: bgColor2 } = savedColors();
          const textShadow = JE.getSubtitleTextShadow(bgColor2);
          updatePositionPreviewFont(selectedPreset2, fontFamily2);
          JE.applySubtitleStyles(textColor2, bgColor2, selectedPreset2.size, fontFamily2.family, textShadow);
          return JE.t("toast_subtitle_size", { size: selectedPreset2.name });
        }
        if (type === "font-family") {
          const selectedPreset2 = JE.fontFamilyPresets[presetIndex];
          if (!selectedPreset2) return null;
          JE.currentSettings.selectedFontFamilyPresetIndex = presetIndex;
          const fontSize2 = requirePreset(fontSizeAt(JE.currentSettings.selectedFontSizePresetIndex), "size");
          const { textColor: textColor2, bgColor: bgColor2 } = savedColors();
          const textShadow = JE.getSubtitleTextShadow(bgColor2);
          updatePositionPreviewFont(fontSize2, selectedPreset2);
          JE.applySubtitleStyles(textColor2, bgColor2, fontSize2.size, selectedPreset2.family, textShadow);
          return JE.t("toast_subtitle_font", { font: selectedPreset2.name });
        }
        const selectedPreset = JE.subtitleTextEffectPresets[presetIndex];
        if (!selectedPreset) return null;
        JE.currentSettings.selectedTextEffectPresetIndex = presetIndex;
        const fontSize = requirePreset(fontSizeAt(JE.currentSettings.selectedFontSizePresetIndex), "size");
        const fontFamily = requirePreset(fontFamilyAt(JE.currentSettings.selectedFontFamilyPresetIndex), "font");
        const { textColor, bgColor } = savedColors();
        internal.syncSubtitlePreviewTextShadow?.(bgColor);
        JE.applySubtitleStyles(textColor, bgColor, fontSize.size, fontFamily.family, JE.getSubtitleTextShadow(bgColor, presetIndex));
        return JE.t("toast_subtitle_text_effect", { effect: selectedPreset.name });
      };
      const currentIndexFor = (type) => {
        if (type === "style") {
          return JE.currentSettings.usingCustomColors ? void 0 : JE.currentSettings.selectedStylePresetIndex ?? 0;
        }
        if (type === "font-size") return JE.currentSettings.selectedFontSizePresetIndex ?? 2;
        if (type === "font-family") return JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
        const effect = JE.currentSettings.selectedTextEffectPresetIndex;
        return typeof effect === "number" && Number.isInteger(effect) && JE.subtitleTextEffectPresets[effect] ? effect : 0;
      };
      const setupPresetHandlers = (containerId, type) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.addEventListener("click", (e) => {
          const presetBox = closestTarget(e, `.${type}-preset`);
          if (!presetBox) return;
          const presetIndex = parseInt(presetBox.dataset.presetIndex ?? "", 10);
          const toast = applyPreset(type, presetIndex);
          if (toast === null) return;
          JE.toast(toast);
          JE.saveUserSettings("settings.json", JE.currentSettings);
          queryElements(container, ".preset-box").forEach((box) => {
            box.style.setProperty("border", "2px solid transparent", "important");
          });
          presetBox.style.setProperty("border", `2px solid ${primaryAccentColor}`, "important");
          resetAutoCloseTimer();
        });
        const currentIndex = currentIndexFor(type);
        if (currentIndex !== void 0) highlight(container.querySelector(`[data-preset-index="${String(currentIndex)}"]`));
      };
      setupPresetHandlers("subtitle-style-presets-container", "style");
      setupPresetHandlers("font-size-presets-container", "font-size");
      setupPresetHandlers("font-family-presets-container", "font-family");
      setupPresetHandlers("text-effect-presets-container", "text-effect");
    };
  }
  installUiPanelSettings(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-settings.js.map
