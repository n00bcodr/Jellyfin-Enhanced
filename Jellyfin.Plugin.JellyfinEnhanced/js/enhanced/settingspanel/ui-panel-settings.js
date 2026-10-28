/**
 * @file Settings-tab wiring: feature toggles, quality-tag categories, subtitle
 * styling/position controls, tag position selectors and subtitle presets.
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const { showReleaseNotesNotification } = internal;

    // Position-tab preview text ("AaBbCcDd") mirrors the real font family, and
    // its size scaled relative to "Normal" so it stays legible in the small
    // preview box instead of rendering at the real on-video vw-based size.
    // Module-scoped (not inside wireSettingsListeners) since it's also called
    // from wireMiscSettingsControls' preset-click handlers, a separate closure.
    const updatePositionPreviewFont = (fontSizePreset, fontFamilyPreset) => {
        const posPreviewEl = document.getElementById('subtitlePositionPreview');
        if (!posPreviewEl || !fontSizePreset || !fontFamilyPreset) return;
        const normalSize = JE.fontSizePresets[2].size;
        const px = Math.max(8, Math.min(22, 13 * (fontSizePreset.size / normalSize)));
        posPreviewEl.style.fontSize = `${px}px`;
        posPreviewEl.style.fontFamily = fontFamilyPreset.family;
    };

    /**
     * Wires the feature toggles, quality-tag category controls and subtitle
     * styling/position controls of the Settings tab.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    internal.wireSettingsListeners = function(ctx) {
        const scope = JE.internals.settingsPanelScope(ctx);
        const { listen } = scope;
        const { createToast, resetAutoCloseTimer } = ctx;

        const bindings = {
            nativePosterTagsToggle: 'useNativePosterTags',
            autoSeasonRequestsSelect: 'autoSeasonRequests', autoMovieRequestsSelect: 'autoMovieRequests',
            listPlaceholdersSelect: 'listPlaceholders', listStatusSelect: 'listStatus', listSwapInSelect: 'listSwapIn',
            listPlaylistUiSelect: 'listPlaylistUi', listCollectionUiSelect: 'listCollectionUi',
            acquisitionBadgesSelect: 'acquisitionBadges', nativeAcquisitionStampsSelect: 'nativeAcquisitionStamps',
            homeRowRequestsSelect: 'homeRowRequests', homeRowSoonSelect: 'homeRowSoon', homeRowArrivedSelect: 'homeRowArrived', homeOpsStripSelect: 'homeOpsStrip',
            watchProgressModeSelect: 'watchProgressMode', watchProgressTimeFormatSelect: 'watchProgressTimeFormat',
            qualityTagsAudioLanguageSelect: 'qualityTagsPreferredAudioLanguage', pauseScreenDelayInput: 'pauseScreenDelaySeconds',
            randomIncludeMovies: 'randomIncludeMovies', randomIncludeShows: 'randomIncludeShows', randomSourceSelect: 'randomSourceId'
            // The display-language select renders itself (ui-panel-language.js): it may need an option for the stored tag.
        };
        for (const [id, key] of Object.entries(bindings)) {
            const control = document.getElementById(id);
            if (control) control.dataset.jeSetting = key;
        }
        JE.internals.observeSettingsDocument('panel-settings', () => {
            document.querySelectorAll('[data-je-setting], [data-cat-key] input, [data-rating-key] input').forEach(control => {
                const key = control.dataset.jeSetting || control.closest('[data-cat-key]')?.dataset.catKey
                    || control.closest('[data-rating-key]')?.dataset.ratingKey;
                const value = JE.currentSettings[key];
                if (control.type === 'checkbox') control.checked = !!value;
                else if (['acquisitionBadges', 'nativeAcquisitionStamps', 'homeRowRequests', 'homeRowSoon', 'homeRowArrived', 'homeOpsStrip'].includes(key)) control.value = value === false ? 'off' : '';
                else if (key === 'listSwapIn') control.value = value === true ? 'on' : '';
                else if (['autoSeasonRequests', 'autoMovieRequests', 'listPlaceholders', 'listStatus', 'listPlaylistUi', 'listCollectionUi'].includes(key)) {
                    control.value = value === true ? 'on' : value === false ? 'off' : '';
                } else control.value = value ?? '';
            });
            for (const type of ['quality', 'rating']) {
                const wrap = document.getElementById(type + 'TagsSubWrap');
                if (wrap) wrap.style.display = JE.currentSettings[type + 'TagsEnabled'] ? 'block' : 'none';
            }
            const qualityRows = document.getElementById('qualityTagsSubToggles');
            if (qualityRows) {
                const rows = Array.from(qualityRows.querySelectorAll('.je-quality-cat-row'));
                const ordered = rows.slice().sort((a, b) => JE.currentSettings[a.dataset.orderKey] - JE.currentSettings[b.dataset.orderKey]);
                if (ordered.some((row, index) => row !== rows[index])) ordered.forEach(row => qualityRows.appendChild(row));
                refreshQualityCatArrowStates(qualityRows);
            }
            // Compound controls render directly from the same derived value after any completion.
            const settings = JE.currentSettings;
            const position = document.getElementById('subtitlePositionPreview');
            if (position) {
                position.style.left = `${settings.subtitleHorizontalPosition}%`;
                position.style.top = 'auto';
                position.style.bottom = `${100 - settings.subtitleVerticalPosition}%`;
            }
            for (const [key, pickerId, alphaId, fallbackSwatch, fallbackAlphaValue] of [
                ['customSubtitleTextColor', 'customSubtitleTextColorPicker', 'customSubtitleTextAlpha', '#FFFFFF', 255],
                ['customSubtitleBgColor', 'customSubtitleBgColorPicker', 'customSubtitleBgAlpha', '#000000', 0]
            ]) {
                const picker = document.getElementById(pickerId), alpha = document.getElementById(alphaId);
                if (picker && alpha) {
                    const decoded = JE.decodeSubtitleColor(settings[key], { fallbackSwatch, fallbackAlphaValue });
                    picker.value = decoded.swatch;
                    alpha.value = decoded.alphaValue;
                }
            }
            for (const id of ['subtitleColorPreview', 'subtitlePositionPreview']) {
                const preview = document.getElementById(id);
                if (preview) {
                    preview.style.color = settings.customSubtitleTextColor;
                    preview.style.backgroundColor = settings.customSubtitleBgColor;
                    preview.style.textShadow = JE.getSubtitleTextShadow(settings.customSubtitleBgColor);
                }
            }
            updatePositionPreviewFont(JE.fontSizePresets?.[settings.selectedFontSizePresetIndex ?? 2],
                JE.fontFamilyPresets?.[settings.selectedFontFamilyPresetIndex ?? 0]);
        });

        const addSettingToggleListener = (id, settingKey, featureKey, requiresRefresh = false) => {
            document.getElementById(id).dataset.jeSetting = settingKey;
            listen(document.getElementById(id), 'change', (e) => {
                JE.updateSettings({ [settingKey]: e.target.checked });
                let toastMessage = createToast(featureKey, e.target.checked);

                if (['qualityTagsToggle', 'genreTagsToggle', 'languageTagsToggle', 'ratingTagsToggle',
                    'ageRatingTagsToggle', 'peopleTagsToggle'].includes(id)) requiresRefresh = false;

                if (requiresRefresh) {
                    toastMessage += ".<br> Refresh page to apply.";
                }
                JE.toast(toastMessage);
                resetAutoCloseTimer();
            });
        };

        addSettingToggleListener('autoPauseToggle', 'autoPauseEnabled', 'feature_auto_pause');
        addSettingToggleListener('autoResumeToggle', 'autoResumeEnabled', 'feature_auto_resume');
        addSettingToggleListener('autoPipToggle', 'autoPipEnabled', 'feature_auto_pip');
        addSettingToggleListener('autoSkipIntroToggle', 'autoSkipIntro', 'feature_auto_skip_intro');
        addSettingToggleListener('autoSkipOutroToggle', 'autoSkipOutro', 'feature_auto_skip_outro');
        addSettingToggleListener('randomButtonToggle', 'randomButtonEnabled', 'feature_random_button');
        addSettingToggleListener('randomUnwatchedOnly', 'randomUnwatchedOnly', 'feature_unwatched_only');
        addSettingToggleListener('randomScopeCurrentContainer', 'randomScopeCurrentContainer', 'feature_random_scope_current');
        addSettingToggleListener('showWatchProgressToggle', 'showWatchProgress', 'feature_watch_progress_display');
                // Watch progress selects
                const modeSel = document.getElementById('watchProgressModeSelect');
                const fmtSel = document.getElementById('watchProgressTimeFormatSelect');
                if (modeSel) {
                    listen(modeSel, 'change', (e) => {
                        JE.updateSettings({ watchProgressMode: e.target.value });
                        resetAutoCloseTimer();
                    });
                }
                if (fmtSel) {
                    listen(fmtSel, 'change', (e) => {
                        JE.updateSettings({ watchProgressTimeFormat: e.target.value });
                        resetAutoCloseTimer();
                    });
                }
        addSettingToggleListener('showFileSizesToggle', 'showFileSizes', 'feature_file_size_display');
        addSettingToggleListener('showAudioLanguagesToggle', 'showAudioLanguages', 'feature_audio_language_display');
        addSettingToggleListener('removeContinueWatchingToggle', 'removeContinueWatchingEnabled', 'feature_remove_continue_watching');
        listen(document.getElementById('nativePosterTagsToggle'), 'change', (event) => {
            if (JE.pluginConfig?.NativePosterTagsEnabled !== true) return;
            const enabled = event.target.checked;
            JE.updateSettings({ useNativePosterTags: enabled });
            resetAutoCloseTimer();
        });
        // Automatic requests per person: "" follows the household (null), "on" / "off" are explicit. They are consents:
        // only the consent operation saves them (a whole settings save keeps them as stored).
        for (const [id, key] of [['autoSeasonRequestsSelect', 'autoSeasonRequests'], ['autoMovieRequestsSelect', 'autoMovieRequests']]) {
            listen(document.getElementById(id), 'change', (event) => {
                if (JE.pluginConfig?.ArrAutomationEngineEnabled !== true) return;
                const value = event.target.value === 'on' ? true : event.target.value === 'off' ? false : null;
                JE.setPersonalConsent(key, value, { throwOnError: true })
                    .catch(err => { if (scope.session.isCurrent()) console.warn('🪼 Jellyfin Enhanced: automatic request preference save failed', err); });
                resetAutoCloseTimer();
            });
        }
        // Phase 4c1: list preferences per person ("" = null: follow the household; swap-in "" = no).
        // Phase 4c3a: the playlist and collection page preferences (display: "" = follow the household).
        for (const [id, key] of [['listPlaceholdersSelect', 'listPlaceholders'], ['listStatusSelect', 'listStatus'], ['listSwapInSelect', 'listSwapIn'], ['listPlaylistUiSelect', 'listPlaylistUi'], ['listCollectionUiSelect', 'listCollectionUi']]) {
            listen(document.getElementById(id), 'change', (event) => {
                if (JE.pluginConfig?.ArrListsEnabled !== true) return;
                const value = event.target.value === 'on' ? true : event.target.value === 'off' ? false : null;
                const save = key === 'listSwapIn' ? JE.setPersonalConsent(key, value === true, { throwOnError: true })
                    : JE.updateSettings({ [key]: value }, { throwOnError: true });
                save.catch(err => { if (scope.session.isCurrent()) console.warn('🪼 Jellyfin Enhanced: list settings save failed', err); });
                resetAutoCloseTimer();
            });
        }
        // Phase 4e: pure document views. Persistence and rollback belong only to config.js.
        const badgeControls = [['acquisitionBadgesSelect', 'acquisitionBadges'], ['nativeAcquisitionStampsSelect', 'nativeAcquisitionStamps']];
        for (const [id, key] of badgeControls) {
            listen(document.getElementById(id), 'change', async (event) => {
                if (JE.pluginConfig?.ArrAcquisitionBadgesEnabled !== true) return;
                const value = event.target.value === 'off' ? false : null;
                resetAutoCloseTimer();
                try {
                    await JE.updateSettings({ [key]: value }, { throwOnError: true });
                } catch (err) {
                    if (scope.session.isCurrent()) console.warn('🪼 Jellyfin Enhanced: badge settings save failed', err);
                }
            });
        }
        // Phase 4d: home rows per person ("" = null: follow the administrator; "off" = false: hide). Saved through the
        // settings store like every other preference: the home page reads its rows again, and "saved" shows, only once
        // the choice is persisted (store effects); a failed save puts the select back.
        for (const [id, key] of [['homeRowRequestsSelect', 'homeRowRequests'], ['homeRowSoonSelect', 'homeRowSoon'], ['homeRowArrivedSelect', 'homeRowArrived'], ['homeOpsStripSelect', 'homeOpsStrip']]) {
            listen(document.getElementById(id), 'change', (event) => {
                if (JE.pluginConfig?.ArrHomeRowsEnabled !== true) return;
                const value = event.target.value === 'off' ? false : null;
                JE.updateSettings({ [key]: value }, { throwOnError: true })
                    .catch(err => { if (scope.session.isCurrent()) console.warn('🪼 Jellyfin Enhanced: home row settings save failed', err); });
                resetAutoCloseTimer();
            });
        }
        addSettingToggleListener('qualityTagsToggle', 'qualityTagsEnabled', 'feature_quality_tags', true);
        // Show or hide the nested category section when the master quality-tags toggle changes
        const qualityMasterToggle = document.getElementById('qualityTagsToggle');
        const qualitySubWrap = document.getElementById('qualityTagsSubWrap');
        const qualitySubGroup = document.getElementById('qualityTagsSubToggles');
        const qualitySubExpander = document.getElementById('qualityTagsSubToggleExpander');
        if (qualityMasterToggle && qualitySubWrap) {
            listen(qualityMasterToggle, 'change', () => {
                qualitySubWrap.style.display = qualityMasterToggle.checked ? 'block' : 'none';
                // Collapse the category list when the feature is turned off so it
                // returns collapsed the next time the user enables it
                if (!qualityMasterToggle.checked && qualitySubGroup && qualitySubExpander) {
                    qualitySubGroup.style.display = 'none';
                    qualitySubExpander.setAttribute('aria-expanded', 'false');
                }
            });
        }
        // Expand or collapse the 6 category rows when the user clicks the chevron.
        // The chevron rotation is driven by CSS via the aria-expanded attribute.
        if (qualitySubExpander && qualitySubGroup) {
            listen(qualitySubExpander, 'click', () => {
                const expanded = qualitySubExpander.getAttribute('aria-expanded') === 'true';
                qualitySubExpander.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                qualitySubGroup.style.display = expanded ? 'none' : 'block';
            });
        }
        // Wire the per-category sub-toggle controls via event delegation
        if (qualitySubGroup) {
            // Persist sub-toggle state and re-render existing cards with the new filter
            listen(qualitySubGroup, 'change', (e) => {
                const target = e.target;
                if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
                const row = target.closest('.je-quality-cat-row');
                if (!row) return;
                const settingKey = row.dataset.catKey;
                if (!settingKey) return;
                JE.updateSettings({ [settingKey]: target.checked });
                resetAutoCloseTimer();
            });
            // Handle ↑/↓ stack reorder buttons
            listen(qualitySubGroup, 'click', (e) => {
                const btn = e.target.closest('.je-cat-up, .je-cat-down');
                if (!btn || btn.disabled) return;
                const row = btn.closest('.je-quality-cat-row');
                if (!row) return;
                const isUp = btn.classList.contains('je-cat-up');
                const sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('je-quality-cat-row')) return;

                // Move the row in the DOM so the user sees the change immediately
                if (isUp) {
                    sibling.parentNode.insertBefore(row, sibling);
                } else {
                    sibling.parentNode.insertBefore(sibling, row);
                }

                // Normalize order values to 1..N from visual position so any
                // pre-existing duplicates (e.g. admin set two rows to the same
                // value via XML) self-heal on the next user reorder.
                const allRows = qualitySubGroup.querySelectorAll('.je-quality-cat-row');
                const order = {};
                allRows.forEach((r, idx) => {
                    const orderKey = r.dataset.orderKey;
                    if (orderKey) order[orderKey] = idx + 1;
                });
                JE.updateSettings(order);

                refreshQualityCatArrowStates(qualitySubGroup);
                resetAutoCloseTimer();
            });
        }

        // Preferred audio language for the sound tag (#433). The fixed choices
        // (server default / my Jellyfin audio language / none) are in the
        // template; the language list comes from Jellyfin's cultures endpoint,
        // like the display-language dropdown.
        const audioLangSelect = document.getElementById('qualityTagsAudioLanguageSelect');
        if (audioLangSelect) {
            // The fixed choices exist already; a language is selected once the list loads.
            const initial = JE.currentSettings.qualityTagsPreferredAudioLanguage || '';
            if (Array.from(audioLangSelect.options).some(o => o.value === initial)) audioLangSelect.value = initial;
            (async () => {
                try {
                    const cultures = await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' });
                    if (!scope.isCurrent()) return;
                    const seen = new Set();
                    cultures
                        .map(c => ({ code: c.TwoLetterISOLanguageName || c.ThreeLetterISOLanguageName, name: c.DisplayName || c.Name }))
                        .filter(o => o.code && o.name && !seen.has(o.code) && seen.add(o.code))
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .forEach(({ code, name }) => {
                            const option = document.createElement('option');
                            option.value = code;
                            option.textContent = name;
                            option.style.background = 'rgba(30,30,30,1)';
                            option.style.color = '#fff';
                            audioLangSelect.appendChild(option);
                        });
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to load audio language options:', err);
                }
                // Read the setting only now: the user may have picked one of the
                // fixed choices while the list was loading.
                if (!scope.isCurrent()) return;
                const saved = JE.currentSettings.qualityTagsPreferredAudioLanguage || '';
                // A saved code the list doesn't offer (e.g. a hand-edited pt-BR) still shows as selected.
                if (saved && !Array.from(audioLangSelect.options).some(o => o.value === saved)) {
                    const option = document.createElement('option');
                    option.value = saved;
                    option.textContent = saved;
                    audioLangSelect.appendChild(option);
                }
                audioLangSelect.value = saved;
            })();
            listen(audioLangSelect, 'change', (e) => {
                JE.updateSettings({ qualityTagsPreferredAudioLanguage: e.target.value });
                resetAutoCloseTimer();
            });
        }

        /**
         * Updates ↑/↓ button enabled state to reflect each row's position in the list
         * @param {HTMLElement} group - The container holding the category rows
         */
        function refreshQualityCatArrowStates(group) {
            const rows = group.querySelectorAll('.je-quality-cat-row');
            rows.forEach((row, idx) => {
                const upBtn = row.querySelector('.je-cat-up');
                const downBtn = row.querySelector('.je-cat-down');
                const isFirst = idx === 0;
                const isLast = idx === rows.length - 1;
                if (upBtn) {
                    upBtn.disabled = isFirst;
                    upBtn.style.cursor = isFirst ? 'not-allowed' : 'pointer';
                    upBtn.style.opacity = isFirst ? '0.4' : '1';
                }
                if (downBtn) {
                    downBtn.disabled = isLast;
                    downBtn.style.cursor = isLast ? 'not-allowed' : 'pointer';
                    downBtn.style.opacity = isLast ? '0.4' : '1';
                }
            });
        }
        addSettingToggleListener('genreTagsToggle', 'genreTagsEnabled', 'feature_genre_tags', true);
        addSettingToggleListener('pauseScreenToggle', 'pauseScreenEnabled', 'feature_custom_pause_screen', true);

        const pauseScreenDelayInput = document.getElementById('pauseScreenDelayInput');
        if (pauseScreenDelayInput) {
            // Without this, digit keydowns bubble to the document and Jellyfin's
            // native player intercepts them as percent-seek shortcuts (0-9)
            // instead of letting them reach the input.
            listen(pauseScreenDelayInput, 'keydown', (e) => e.stopPropagation());
            listen(pauseScreenDelayInput, 'change', () => {
                const val = Math.max(1, Math.min(60, parseInt(pauseScreenDelayInput.value, 10) || 5));
                pauseScreenDelayInput.value = val;
                JE.updateSettings({ pauseScreenDelaySeconds: val });

            });
        }
        addSettingToggleListener('languageTagsToggle', 'languageTagsEnabled', 'feature_language_tags', true);
        addSettingToggleListener('ratingTagsToggle', 'ratingTagsEnabled', 'feature_rating_tags', true);
        addSettingToggleListener('ageRatingTagsToggle', 'ageRatingTagsEnabled', 'feature_age_rating_tags', true);
        addSettingToggleListener('peopleTagsToggle', 'peopleTagsEnabled', 'feature_people_tags', true);
        addSettingToggleListener('tagsHideOnHoverToggle', 'tagsHideOnHover', 'feature_tags_hide_on_hover', false);
        // Rating tag scope (item types / home rows): nested under the master
        // toggle exactly like the quality-tag categories above.
        const ratingMasterToggle = document.getElementById('ratingTagsToggle');
        const ratingSubWrap = document.getElementById('ratingTagsSubWrap');
        const ratingSubGroup = document.getElementById('ratingTagsSubToggles');
        const ratingSubExpander = document.getElementById('ratingTagsSubToggleExpander');
        if (ratingMasterToggle && ratingSubWrap) {
            listen(ratingMasterToggle, 'change', () => {
                ratingSubWrap.style.display = ratingMasterToggle.checked ? 'block' : 'none';
                if (!ratingMasterToggle.checked && ratingSubGroup && ratingSubExpander) {
                    ratingSubGroup.style.display = 'none';
                    ratingSubExpander.setAttribute('aria-expanded', 'false');
                }
            });
        }
        if (ratingSubExpander && ratingSubGroup) {
            listen(ratingSubExpander, 'click', () => {
                const expanded = ratingSubExpander.getAttribute('aria-expanded') === 'true';
                ratingSubExpander.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                ratingSubGroup.style.display = expanded ? 'none' : 'block';
            });
        }
        if (ratingSubGroup) {
            listen(ratingSubGroup, 'change', (e) => {
                const target = e.target;
                if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
                const settingKey = target.closest('.je-quality-cat-row')?.dataset.catKey;
                if (!settingKey) return;
                JE.updateSettings({ [settingKey]: target.checked });
                resetAutoCloseTimer();
            });
        }
        addSettingToggleListener('disableCustomSubtitleStyles', 'disableCustomSubtitleStyles', 'feature_disable_custom_subtitle_styles', true);
        addSettingToggleListener('longPress2xEnabled', 'longPress2xEnabled', 'feature_long_press_2x_speed');

        // --- Dynamic subtitle-styling warnings ---
        // Both warnings only matter when JE's custom subtitle styling is actually
        // in play (disableCustomSubtitleStyles off) -- otherwise nothing is being
        // applied and flagging why it "wouldn't work" is just noise.
        // Position only takes effect when Jellyfin's own subtitle appearance is set
        // to "Custom" (native player settings write that choice to localStorage
        // per-user) -- non-Custom mode renders native browser ::cue captions instead
        // of the repositionable .videoSubtitles container. Color/font/size still
        // apply either way (JE styles both .videoSubtitlesInner and ::cue), so only
        // the position note needs to flag the missing setting.
        (function wireSubtitleStylingWarnings() {
            const positionNote = document.getElementById('je-subtitle-position-note');
            const formatWarning = document.getElementById('je-subtitle-format-warning');
            if (!positionNote && !formatWarning) return;

            const stylesEnabled = () => !JE.currentSettings.disableCustomSubtitleStyles;

            // Read once, when the panel opens -- this setting doesn't change while
            // the panel is up, so there's no need to re-read localStorage on every
            // DOM mutation.
            if (positionNote) {
                let appearance = null;
                try {
                    const userId = ApiClient.getCurrentUserId?.();
                    const raw = userId && localStorage.getItem(`${userId}-localplayersubtitleappearance3`);
                    appearance = raw ? JSON.parse(raw) : null;
                } catch (e) { /* ignore, treat as not-custom */ }
                const isCustom = appearance?.subtitleStyling === 'Custom';

                const applyPositionNoteState = () => {
                    positionNote.style.display = (stylesEnabled() && !isCustom) ? 'flex' : 'none';
                };
                JE.internals.observeSettingsDocument('panel-subtitle-position-note', applyPositionNoteState);
            }

            // Bitmap/graphical subtitle formats (ASS/SSA, PGS, VobSub, DVB) never
            // pass through the styled .videoSubtitlesInner text node -- they either
            // render to their own canvas client-side, or get burned directly into
            // the video pixels by a server-side transcode when the client can't
            // render them (confirmed live: a PGS track here shows up as
            // TranscodeReasons: ["SubtitleCodecNotSupported", ...] with no DOM
            // element at all). Checked once against the live playback session
            // rather than polled, since it's a network call, not a cheap read.
            if (formatWarning) {
                const NON_TEXT_CODECS = new Set(['ass', 'ssa', 'pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub']);
                (async () => {
                    let isUnsupportedFormat = false;
                    try {
                        const userId = ApiClient.getCurrentUserId?.();
                        const sessions = userId ? await ApiClient.getSessions({ ControllableByUserId: userId }) : [];
                        const session = sessions.find(s => s.NowPlayingItem);
                        const streams = session?.NowPlayingItem?.MediaStreams || [];
                        const activeIndex = session?.PlayState?.SubtitleStreamIndex;
                        const activeStream = activeIndex != null
                            ? streams.find(s => s.Type === 'Subtitle' && s.Index === activeIndex)
                            : null;
                        isUnsupportedFormat = !!activeStream && NON_TEXT_CODECS.has((activeStream.Codec || '').toLowerCase());
                    } catch (e) { /* leave hidden on failure */ }

                    if (!scope.isCurrent()) return;
                    const applyFormatWarningState = () => {
                        formatWarning.style.display = (stylesEnabled() && isUnsupportedFormat) ? 'flex' : 'none';
                    };
                    JE.internals.observeSettingsDocument('panel-subtitle-format-warning', applyFormatWarningState);
                })();
            }
        })();

        // Inline custom subtitle color pickers
        const customTextColorPicker = document.getElementById('customSubtitleTextColorPicker');
        const customTextAlpha = document.getElementById('customSubtitleTextAlpha');
        const customBgColorPicker = document.getElementById('customSubtitleBgColorPicker');
        const customBgAlpha = document.getElementById('customSubtitleBgAlpha');

        const updateCustomSubtitleColors = () => {
            const textColor = customTextColorPicker.value + parseInt(customTextAlpha.value).toString(16).padStart(2, '0').toUpperCase();
            const bgColor = customBgColorPicker.value + parseInt(customBgAlpha.value).toString(16).padStart(2, '0').toUpperCase();

            JE.updateSettings({ customSubtitleTextColor: textColor, customSubtitleBgColor: bgColor, usingCustomColors: true });

            resetAutoCloseTimer();
        };

        if (customTextColorPicker) listen(customTextColorPicker, 'input', updateCustomSubtitleColors);
        if (customTextAlpha) listen(customTextAlpha, 'input', updateCustomSubtitleColors);
        if (customBgColorPicker) listen(customBgColorPicker, 'input', updateCustomSubtitleColors);
        if (customBgAlpha) listen(customBgAlpha, 'input', updateCustomSubtitleColors);

        // --- Subtitle position drag grid ---
        const posGrid = document.getElementById('subtitlePositionGrid');
        const posPreview = document.getElementById('subtitlePositionPreview');
        const posResetBtn = document.getElementById('subtitlePositionReset');

        if (posGrid) {
            let gesture;
            const commitPosition = () => {
                if (!gesture || !scope.isCurrent()) { gesture = undefined; return; }
                JE.updateSettings(gesture);
                gesture = undefined;
            };
            const updatePosition = (xPct, yPct) => {
                xPct = Math.max(2, Math.min(98, xPct));
                yPct = Math.max(2, Math.min(98, yPct));
                if (posPreview) {
                    posPreview.style.left = `${xPct}%`;
                    posPreview.style.top = 'auto';
                    posPreview.style.bottom = `${100 - yPct}%`;
                }
                gesture = { subtitleHorizontalPosition: Math.round(xPct), subtitleVerticalPosition: Math.round(yPct) };
            };

            const getPctFromEvent = (e) => {
                const rect = posGrid.getBoundingClientRect();
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const clientY = e.touches ? e.touches[0].clientY : e.clientY;
                return {
                    x: ((clientX - rect.left) / rect.width) * 100,
                    y: ((clientY - rect.top) / rect.height) * 100
                };
            };

            let dragging = false;
            scope.onCleanup(() => { dragging = false; gesture = undefined; });
            listen(document, 'touchcancel', () => { dragging = false; gesture = undefined; });

            listen(posGrid, 'mousedown', (e) => {
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                dragging = true;
                e.preventDefault();
            });

            listen(document, 'mousemove', (e) => {
                if (!dragging) return;
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                resetAutoCloseTimer();
            });

            listen(document, 'mouseup', () => {
                if (!dragging) return;
                dragging = false;
                commitPosition();
            });

            listen(posGrid, 'touchstart', (e) => {
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                dragging = true;
                e.preventDefault();
            }, { passive: false });

            listen(document, 'touchmove', (e) => {
                if (!dragging) return;
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                resetAutoCloseTimer();
            }, { passive: true });

            listen(document, 'touchend', () => {
                if (!dragging) return;
                dragging = false;
                commitPosition();
            });
        }

        if (posResetBtn) {
            listen(posResetBtn, 'click', () => {
                JE.updateSettings({ subtitleHorizontalPosition: 50, subtitleVerticalPosition: 95 });
                if (posPreview) { posPreview.style.left = '50%'; posPreview.style.top = 'auto'; posPreview.style.bottom = '5%'; }
                resetAutoCloseTimer();
            });
        }
    };

    /**
     * Wires the remaining panel controls: random-button item types, the
     * release-notes button, tag position selectors and subtitle preset grids.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    internal.wireMiscSettingsControls = function(ctx) {
        const scope = JE.internals.settingsPanelScope(ctx);
        const { listen } = scope;
        const { help, primaryAccentColor, resetAutoCloseTimer } = ctx;

        listen(document.getElementById('randomIncludeMovies'), 'change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeShows').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.updateSettings({ randomIncludeMovies: e.target.checked }); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Movies', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });
        listen(document.getElementById('randomIncludeShows'), 'change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeMovies').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.updateSettings({ randomIncludeShows: e.target.checked }); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Shows', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });

        // Random source picker: lists the user's playlists and collections; '' = whole library.
        const sourceSelect = document.getElementById('randomSourceSelect');
        if (sourceSelect) {
            const userId = ApiClient.getCurrentUserId();
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=Playlist,BoxSet&Recursive=true&SortBy=SortName`), dataType: 'json' })
                .then(async response => {
                    if (!scope.isCurrent() || !sourceSelect.isConnected) return; // panel closed before the list arrived
                    const groups = { Playlist: 'panel_settings_random_button_source_playlists', BoxSet: 'panel_settings_random_button_source_collections' };
                    for (const [type, labelKey] of Object.entries(groups)) {
                        const items = (response?.Items || []).filter(item => item.Type === type);
                        if (items.length === 0) continue;
                        const group = document.createElement('optgroup');
                        group.label = JE.t(labelKey);
                        items.forEach(item => group.appendChild(new Option(item.Name, item.Id)));
                        sourceSelect.appendChild(group);
                    }
                    const savedId = JE.currentSettings.randomSourceId || '';
                    sourceSelect.value = savedId;
                    // A saved source missing from the list is either gone (show why picks fall back) or
                    // still readable but filtered out of lists, e.g. hidden with Hidden Content, in which
                    // case the button still draws from it, so show its real name.
                    if (savedId && sourceSelect.value !== savedId) {
                        const saved = await ApiClient.getItem(userId, savedId).catch(() => null);
                        if (!scope.isCurrent() || !sourceSelect.isConnected || JE.currentSettings.randomSourceId !== savedId) return;
                        const label = saved && ['Playlist', 'BoxSet'].includes(saved.Type)
                            ? saved.Name
                            : JE.t('panel_settings_random_button_source_missing');
                        sourceSelect.appendChild(new Option(label, savedId, false, true));
                    }
                })
                .catch(err => console.warn('🪼 Jellyfin Enhanced: Could not list playlists for the random source picker', err));
            listen(sourceSelect, 'change', (e) => {
                JE.updateSettings({ randomSourceId: e.target.value });
                JE.toast(JE.t('toast_random_source_set', { name: JE.escapeHtml(e.target.selectedOptions[0]?.textContent || '') }));
                resetAutoCloseTimer();
            });
        }

        listen(document.getElementById('releaseNotesBtn'), 'click', async (e) => { await showReleaseNotesNotification(e); if (scope.isCurrent()) resetAutoCloseTimer(); });

        // --- Position Selectors ---
        const positionSelectors = help.querySelectorAll('.position-selector');
        positionSelectors.forEach(selector => {
            const settingKey = selector.dataset.setting;
            const cells = selector.querySelectorAll('[data-pos]');

            // Highlight current position
            const updateHighlight = () => {
                const currentPos = JE.currentSettings[settingKey] || 'top-left';
                cells.forEach(cell => {
                    if (cell.dataset.pos === currentPos) {
                        cell.style.background = primaryAccentColor;
                    } else {
                        cell.style.background = 'rgba(255,255,255,0.1)';
                    }
                });
            };
            JE.internals.observeSettingsDocument('panel-position-' + settingKey, updateHighlight);

            // Click handler
            listen(selector, 'click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const cell = e.target.closest('[data-pos]');
                if (!cell) return;

                const newPos = cell.dataset.pos;
                JE.updateSettings({ [settingKey]: newPos });
                updateHighlight();

                JE.toast(`Position updated!`);
                resetAutoCloseTimer();
            });
        });

        const setupPresetHandlers = (containerId, presets, type) => {
            const container = document.getElementById(containerId);
            if (!container) return;

            listen(container, 'click', (e) => {
                const presetBox = e.target.closest(`.${type}-preset`);
                if (!presetBox) return;

                const presetIndex = parseInt(presetBox.dataset.presetIndex, 10);
                const selectedPreset = presets[presetIndex];

                if (selectedPreset) {
                    if (type === 'style') {
                        JE.updateSettings({ selectedStylePresetIndex: presetIndex, usingCustomColors: false,
                            customSubtitleTextColor: selectedPreset.textColor, customSubtitleBgColor: selectedPreset.bgColor });
                        JE.toast(JE.t('toast_subtitle_style', { style: selectedPreset.name }));
                    } else if (type === 'font-size') {
                        JE.updateSettings({ selectedFontSizePresetIndex: presetIndex });
                        JE.toast(JE.t('toast_subtitle_size', { size: selectedPreset.name }));
                    } else if (type === 'font-family') {
                        JE.updateSettings({ selectedFontFamilyPresetIndex: presetIndex });
                        JE.toast(JE.t('toast_subtitle_font', { font: selectedPreset.name }));
                    } else if (type === 'text-effect') {
                        JE.updateSettings({ selectedTextEffectPresetIndex: presetIndex });
                        JE.toast(JE.t('toast_subtitle_text_effect', { effect: selectedPreset.name }));
                    }

                    resetAutoCloseTimer();
                }
            });

            JE.internals.observeSettingsDocument('panel-preset-' + type, () => {
                container.querySelectorAll('.preset-box').forEach(box => {
                    box.style.setProperty('border', '2px solid transparent', 'important');
                });
                let currentIndex;
                if (type === 'style') {
                    currentIndex = JE.currentSettings.selectedStylePresetIndex ?? 0;
                    // Only highlight if not using custom colors
                    if (!JE.currentSettings.usingCustomColors) {
                        const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                        if (activeBox) {
                            activeBox.style.setProperty('border', `2px solid ${primaryAccentColor}`, 'important');
                        }
                    }
                } else if (type === 'font-size') {
                    currentIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
                    const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                    if (activeBox) {
                        activeBox.style.setProperty('border', `2px solid ${primaryAccentColor}`, 'important');
                    }
                } else if (type === 'font-family') {
                    currentIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
                    const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                    if (activeBox) {
                        activeBox.style.setProperty('border', `2px solid ${primaryAccentColor}`, 'important');
                    }
                } else if (type === 'text-effect') {
                    currentIndex = JE.currentSettings.selectedTextEffectPresetIndex;
                    // An unknown index renders as Auto (see JE.getSubtitleTextShadow), so highlight that.
                    if (!Number.isInteger(currentIndex) || !JE.subtitleTextEffectPresets[currentIndex]) currentIndex = 0;
                    const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                    if (activeBox) {
                        activeBox.style.setProperty('border', `2px solid ${primaryAccentColor}`, 'important');
                    }
                }
            });
        };

        setupPresetHandlers('subtitle-style-presets-container', JE.subtitlePresets, 'style');
        setupPresetHandlers('font-size-presets-container', JE.fontSizePresets, 'font-size');
        setupPresetHandlers('font-family-presets-container', JE.fontFamilyPresets, 'font-family');
        setupPresetHandlers('text-effect-presets-container', JE.subtitleTextEffectPresets, 'text-effect');
    };

})(window.JellyfinEnhanced);
