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

    /**
     * Wires the feature toggles, quality-tag category controls and subtitle
     * styling/position controls of the Settings tab.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    internal.wireSettingsListeners = function(ctx) {
        const { createToast, resetAutoCloseTimer } = ctx;

        const addSettingToggleListener = (id, settingKey, featureKey, requiresRefresh = false) => {
            document.getElementById(id).addEventListener('change', (e) => {
                JE.currentSettings[settingKey] = e.target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                let toastMessage = createToast(featureKey, e.target.checked);

                // Handle tag features with dynamic re-initialization
                if (id === 'qualityTagsToggle') {
                    if (e.target.checked) {
                        // Initialize for the first time if enabling
                        if (typeof JE.initializeQualityTags === 'function') {
                            JE.initializeQualityTags();
                        }
                    } else {
                        // Remove all tags if disabling
                        document.querySelectorAll('.quality-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false; // No longer needs refresh
                } else if (id === 'genreTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializeGenreTags === 'function') {
                            JE.initializeGenreTags();
                        }
                    } else {
                        document.querySelectorAll('.genre-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false;
                } else if (id === 'languageTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializeLanguageTags === 'function') {
                            JE.initializeLanguageTags();
                        }
                    } else {
                        document.querySelectorAll('.language-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false;
                } else if (id === 'ratingTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializeRatingTags === 'function') {
                            JE.initializeRatingTags();
                        }
                    } else {
                        document.querySelectorAll('.rating-overlay-container').forEach(el => el.remove());
                    }
                    requiresRefresh = false;
                } else if (id === 'peopleTagsToggle') {
                    if (e.target.checked) {
                        if (typeof JE.initializePeopleTags === 'function') {
                            JE.initializePeopleTags();
                        }
                    } else {
                        document.querySelectorAll('.je-people-place-banner').forEach(el => el.remove());
                        document.querySelectorAll('.je-people-age-container').forEach(el => el.remove());
                        document.querySelectorAll('.je-deceased-poster').forEach(el => el.classList.remove('je-deceased-poster'));
                    }
                    requiresRefresh = false;
                }

                if (requiresRefresh) {
                    toastMessage += ".<br> Refresh page to apply.";
                }
                JE.toast(toastMessage);
                if (id === 'randomButtonToggle') JE.addRandomButton();
                if (id === 'showWatchProgressToggle' && !e.target.checked) document.querySelectorAll('.mediaInfoItem-watchProgress').forEach(el => el.remove());
                if (id === 'showFileSizesToggle' && !e.target.checked) document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove());
                if (id === 'showAudioLanguagesToggle' && !e.target.checked) document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove());
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
        addSettingToggleListener('showWatchProgressToggle', 'showWatchProgress', 'feature_watch_progress_display');
                // Watch progress selects
                const modeSel = document.getElementById('watchProgressModeSelect');
                const fmtSel = document.getElementById('watchProgressTimeFormatSelect');
                if (modeSel) {
                    modeSel.addEventListener('change', (e) => {
                        JE.currentSettings.watchProgressMode = e.target.value;
                        JE.saveUserSettings('settings.json', JE.currentSettings);
                        resetAutoCloseTimer();
                    });
                }
                if (fmtSel) {
                    fmtSel.addEventListener('change', (e) => {
                        JE.currentSettings.watchProgressTimeFormat = e.target.value;
                        JE.saveUserSettings('settings.json', JE.currentSettings);
                        resetAutoCloseTimer();
                    });
                }
        addSettingToggleListener('showFileSizesToggle', 'showFileSizes', 'feature_file_size_display');
        addSettingToggleListener('showAudioLanguagesToggle', 'showAudioLanguages', 'feature_audio_language_display');
        addSettingToggleListener('removeContinueWatchingToggle', 'removeContinueWatchingEnabled', 'feature_remove_continue_watching');
        addSettingToggleListener('qualityTagsToggle', 'qualityTagsEnabled', 'feature_quality_tags', true);
        // Show or hide the nested category section when the master quality-tags toggle changes
        const qualityMasterToggle = document.getElementById('qualityTagsToggle');
        const qualitySubWrap = document.getElementById('qualityTagsSubWrap');
        const qualitySubGroup = document.getElementById('qualityTagsSubToggles');
        const qualitySubExpander = document.getElementById('qualityTagsSubToggleExpander');
        if (qualityMasterToggle && qualitySubWrap) {
            qualityMasterToggle.addEventListener('change', () => {
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
            qualitySubExpander.addEventListener('click', () => {
                const expanded = qualitySubExpander.getAttribute('aria-expanded') === 'true';
                qualitySubExpander.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                qualitySubGroup.style.display = expanded ? 'none' : 'block';
            });
        }
        // Wire the per-category sub-toggle controls via event delegation
        if (qualitySubGroup) {
            // Persist sub-toggle state and re-render existing cards with the new filter
            qualitySubGroup.addEventListener('change', (e) => {
                const target = e.target;
                if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
                const row = target.closest('.je-quality-cat-row');
                if (!row) return;
                const settingKey = row.dataset.catKey;
                if (!settingKey) return;
                JE.currentSettings[settingKey] = target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                if (typeof JE.reinitializeQualityTags === 'function' && JE.currentSettings.qualityTagsEnabled) {
                    JE.reinitializeQualityTags();
                }
                resetAutoCloseTimer();
            });
            // Handle ↑/↓ stack reorder buttons
            qualitySubGroup.addEventListener('click', (e) => {
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
                allRows.forEach((r, idx) => {
                    const orderKey = r.dataset.orderKey;
                    if (orderKey) JE.currentSettings[orderKey] = idx + 1;
                });
                JE.saveUserSettings('settings.json', JE.currentSettings);

                refreshQualityCatArrowStates(qualitySubGroup);
                if (typeof JE.reinitializeQualityTags === 'function' && JE.currentSettings.qualityTagsEnabled) {
                    JE.reinitializeQualityTags();
                }
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
            pauseScreenDelayInput.addEventListener('change', () => {
                const val = Math.max(1, Math.min(60, parseInt(pauseScreenDelayInput.value, 10) || 5));
                pauseScreenDelayInput.value = val;
                JE.currentSettings.pauseScreenDelaySeconds = val;
                JE.saveUserSettings();
            });
        }
        addSettingToggleListener('languageTagsToggle', 'languageTagsEnabled', 'feature_language_tags', true);
        addSettingToggleListener('ratingTagsToggle', 'ratingTagsEnabled', 'feature_rating_tags', true);
        addSettingToggleListener('peopleTagsToggle', 'peopleTagsEnabled', 'feature_people_tags', true);
        addSettingToggleListener('tagsHideOnHoverToggle', 'tagsHideOnHover', 'feature_tags_hide_on_hover', false);
        // Live-toggle the body class so hover fade CSS applies immediately (no refresh needed)
        const hideOnHoverCheckbox = document.getElementById('tagsHideOnHoverToggle');
        if (hideOnHoverCheckbox) {
            hideOnHoverCheckbox.addEventListener('change', () => {
                document.body.classList.toggle('je-tags-hide-on-hover', hideOnHoverCheckbox.checked);
            });
        }
        addSettingToggleListener('disableCustomSubtitleStyles', 'disableCustomSubtitleStyles', 'feature_disable_custom_subtitle_styles', true);
        addSettingToggleListener('longPress2xEnabled', 'longPress2xEnabled', 'feature_long_press_2x_speed');

        // Inline custom subtitle color pickers
        const customTextColorPicker = document.getElementById('customSubtitleTextColorPicker');
        const customTextAlpha = document.getElementById('customSubtitleTextAlpha');
        const customBgColorPicker = document.getElementById('customSubtitleBgColorPicker');
        const customBgAlpha = document.getElementById('customSubtitleBgAlpha');

        const updateCustomSubtitleColors = () => {
            const textColor = customTextColorPicker.value + parseInt(customTextAlpha.value).toString(16).padStart(2, '0').toUpperCase();
            const bgColor = customBgColorPicker.value + parseInt(customBgAlpha.value).toString(16).padStart(2, '0').toUpperCase();

            JE.currentSettings.customSubtitleTextColor = textColor;
            JE.currentSettings.customSubtitleBgColor = bgColor;
            JE.currentSettings.usingCustomColors = true;

            // Remove border from all style presets
            const styleContainer = document.getElementById('subtitle-style-presets-container');
            if (styleContainer) {
                styleContainer.querySelectorAll('.preset-box').forEach(box => {
                    box.style.border = '2px solid transparent';
                });
            }

            // Update live preview
            const preview = document.getElementById('subtitleColorPreview');
            if (preview) {
                preview.style.color = textColor;
                preview.style.backgroundColor = bgColor;
            }

            JE.saveUserSettings('settings.json', JE.currentSettings);
            JE.applySavedStylesWhenReady();
            resetAutoCloseTimer();
        };

        if (customTextColorPicker) customTextColorPicker.addEventListener('input', updateCustomSubtitleColors);
        if (customTextAlpha) customTextAlpha.addEventListener('input', updateCustomSubtitleColors);
        if (customBgColorPicker) customBgColorPicker.addEventListener('input', updateCustomSubtitleColors);
        if (customBgAlpha) customBgAlpha.addEventListener('input', updateCustomSubtitleColors);

        // --- Subtitle position drag grid ---
        const posGrid = document.getElementById('subtitlePositionGrid');
        const posPreview = document.getElementById('subtitlePositionPreview');
        const posResetBtn = document.getElementById('subtitlePositionReset');

        if (posGrid) {
            const updatePosition = (xPct, yPct) => {
                xPct = Math.max(2, Math.min(98, xPct));
                yPct = Math.max(2, Math.min(98, yPct));
                if (posPreview) {
                    posPreview.style.left = `${xPct}%`;
                    posPreview.style.top = `${yPct}%`;
                }
                JE.currentSettings.subtitleHorizontalPosition = Math.round(xPct);
                JE.currentSettings.subtitleVerticalPosition = Math.round(yPct);
                if (typeof JE.applySubtitlePosition === 'function') JE.applySubtitlePosition();
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

            posGrid.addEventListener('mousedown', (e) => {
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                dragging = true;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                resetAutoCloseTimer();
            });

            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                JE.saveUserSettings('settings.json', JE.currentSettings);
            });

            posGrid.addEventListener('touchstart', (e) => {
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                dragging = true;
                e.preventDefault();
            }, { passive: false });

            document.addEventListener('touchmove', (e) => {
                if (!dragging) return;
                const { x, y } = getPctFromEvent(e);
                updatePosition(x, y);
                resetAutoCloseTimer();
            }, { passive: true });

            document.addEventListener('touchend', () => {
                if (!dragging) return;
                dragging = false;
                JE.saveUserSettings('settings.json', JE.currentSettings);
            });
        }

        if (posResetBtn) {
            posResetBtn.addEventListener('click', () => {
                JE.currentSettings.subtitleHorizontalPosition = 50;
                JE.currentSettings.subtitleVerticalPosition = 85;
                if (posPreview) { posPreview.style.left = '50%'; posPreview.style.top = '85%'; }
                if (typeof JE.applySubtitlePosition === 'function') JE.applySubtitlePosition();
                JE.saveUserSettings('settings.json', JE.currentSettings);
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
        const { help, primaryAccentColor, resetAutoCloseTimer } = ctx;

        document.getElementById('randomIncludeMovies').addEventListener('change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeShows').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.currentSettings.randomIncludeMovies = e.target.checked; JE.saveUserSettings('settings.json', JE.currentSettings); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Movies', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });
        document.getElementById('randomIncludeShows').addEventListener('change', (e) => { if (!e.target.checked && !document.getElementById('randomIncludeMovies').checked) { e.target.checked = true; JE.toast(JE.t('toast_at_least_one_item_type')); return; } JE.currentSettings.randomIncludeShows = e.target.checked; JE.saveUserSettings('settings.json', JE.currentSettings); JE.toast(JE.t('toast_random_selection_status', { item_type: 'Shows', status: e.target.checked ? JE.t('selection_included') : JE.t('selection_excluded') })); resetAutoCloseTimer(); });

        document.getElementById('releaseNotesBtn').addEventListener('click', async () => { await showReleaseNotesNotification(); resetAutoCloseTimer(); });

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
            updateHighlight();

            // Click handler
            selector.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const cell = e.target.closest('[data-pos]');
                if (!cell) return;

                const newPos = cell.dataset.pos;
                JE.currentSettings[settingKey] = newPos;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                updateHighlight();

                // Reinitialize tags dynamically based on which position changed
                if (settingKey === 'qualityTagsPosition' && JE.currentSettings.qualityTagsEnabled) {
                    if (typeof JE.reinitializeQualityTags === 'function') {
                        JE.reinitializeQualityTags();
                    }
                } else if (settingKey === 'genreTagsPosition' && JE.currentSettings.genreTagsEnabled) {
                    if (typeof JE.reinitializeGenreTags === 'function') {
                        JE.reinitializeGenreTags();
                    }
                } else if (settingKey === 'languageTagsPosition' && JE.currentSettings.languageTagsEnabled) {
                    if (typeof JE.reinitializeLanguageTags === 'function') {
                        JE.reinitializeLanguageTags();
                    }
                } else if (settingKey === 'ratingTagsPosition' && JE.currentSettings.ratingTagsEnabled) {
                    if (typeof JE.reinitializeRatingTags === 'function') {
                        JE.reinitializeRatingTags();
                    }
                }

                JE.toast(`Position updated!`);
                resetAutoCloseTimer();
            });
        });

        const setupPresetHandlers = (containerId, presets, type) => {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.addEventListener('click', (e) => {
                const presetBox = e.target.closest(`.${type}-preset`);
                if (!presetBox) return;

                const presetIndex = parseInt(presetBox.dataset.presetIndex, 10);
                const selectedPreset = presets[presetIndex];

                if (selectedPreset) {
                    if (type === 'style') {
                        JE.currentSettings.selectedStylePresetIndex = presetIndex;
                        JE.currentSettings.usingCustomColors = false;
                        JE.currentSettings.customSubtitleTextColor = selectedPreset.textColor;
                        JE.currentSettings.customSubtitleBgColor = selectedPreset.bgColor;

                        // Update UI inputs
                        const textColorPicker = document.getElementById('customSubtitleTextColorPicker');
                        const textAlphaSlider = document.getElementById('customSubtitleTextAlpha');
                        const bgColorPicker = document.getElementById('customSubtitleBgColorPicker');
                        const bgAlphaSlider = document.getElementById('customSubtitleBgAlpha');
                        const preview = document.getElementById('subtitleColorPreview');

                        if (textColorPicker && textAlphaSlider) {
                            textColorPicker.value = selectedPreset.textColor.substring(0, 7);
                            textAlphaSlider.value = parseInt(selectedPreset.textColor.substring(7, 9) || 'FF', 16);
                        }
                        if (bgColorPicker && bgAlphaSlider) {
                            bgColorPicker.value = selectedPreset.bgColor.substring(0, 7);
                            bgAlphaSlider.value = parseInt(selectedPreset.bgColor.substring(7, 9) || '00', 16);
                        }
                        if (preview) {
                            preview.style.color = selectedPreset.textColor;
                            preview.style.backgroundColor = selectedPreset.bgColor;
                        }

                        const fontSizeIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
                        const fontFamilyIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
                        const fontSize = JE.fontSizePresets[fontSizeIndex].size;
                        const fontFamily = JE.fontFamilyPresets[fontFamilyIndex].family;
                        JE.applySubtitleStyles(selectedPreset.textColor, selectedPreset.bgColor, fontSize, fontFamily, selectedPreset.textShadow);
                        JE.toast(JE.t('toast_subtitle_style', { style: selectedPreset.name }));
                    } else if (type === 'font-size') {
                        JE.currentSettings.selectedFontSizePresetIndex = presetIndex;
                        const fontFamilyIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
                        const fontFamily = JE.fontFamilyPresets[fontFamilyIndex].family;

                        // Use saved custom colors
                        const textColor = JE.currentSettings.customSubtitleTextColor || '#FFFFFFFF';
                        const bgColor = JE.currentSettings.customSubtitleBgColor || '#00000000';
                        const textShadow = bgColor === 'transparent' || bgColor === '#00000000'
                            ? '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000'
                            : 'none';

                        JE.applySubtitleStyles(textColor, bgColor, selectedPreset.size, fontFamily, textShadow);
                        JE.toast(JE.t('toast_subtitle_size', { size: selectedPreset.name }));
                    } else if (type === 'font-family') {
                        JE.currentSettings.selectedFontFamilyPresetIndex = presetIndex;
                        const fontSizeIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
                        const fontSize = JE.fontSizePresets[fontSizeIndex].size;

                        // Use saved custom colors
                        const textColor = JE.currentSettings.customSubtitleTextColor || '#FFFFFFFF';
                        const bgColor = JE.currentSettings.customSubtitleBgColor || '#00000000';
                        const textShadow = bgColor === 'transparent' || bgColor === '#00000000'
                            ? '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000'
                            : 'none';

                        JE.applySubtitleStyles(textColor, bgColor, fontSize, selectedPreset.family, textShadow);
                        JE.toast(JE.t('toast_subtitle_font', { font: selectedPreset.name }));
                    }

                    JE.saveUserSettings('settings.json', JE.currentSettings);
                    container.querySelectorAll('.preset-box').forEach(box => {
                        box.style.border = '2px solid transparent';
                    });
                    presetBox.style.border = `2px solid ${primaryAccentColor}`;
                    resetAutoCloseTimer();
                }
            });

            let currentIndex;
            if (type === 'style') {
                currentIndex = JE.currentSettings.selectedStylePresetIndex ?? 0;
                // Only highlight if not using custom colors
                if (!JE.currentSettings.usingCustomColors) {
                    const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                    if (activeBox) {
                        activeBox.style.border = `2px solid ${primaryAccentColor}`;
                    }
                }
            } else if (type === 'font-size') {
                currentIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
                const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                if (activeBox) {
                    activeBox.style.border = `2px solid ${primaryAccentColor}`;
                }
            } else if (type === 'font-family') {
                currentIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
                const activeBox = container.querySelector(`[data-preset-index="${currentIndex}"]`);
                if (activeBox) {
                    activeBox.style.border = `2px solid ${primaryAccentColor}`;
                }
            }
        };

        setupPresetHandlers('subtitle-style-presets-container', JE.subtitlePresets, 'style');
        setupPresetHandlers('font-size-presets-container', JE.fontSizePresets, 'font-size');
        setupPresetHandlers('font-family-presets-container', JE.fontFamilyPresets, 'font-family');
    };

})(window.JellyfinEnhanced);
