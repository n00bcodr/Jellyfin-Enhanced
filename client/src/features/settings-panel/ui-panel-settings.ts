/**
 * @file Settings-tab wiring: feature toggles, quality-tag categories, subtitle
 * styling/position controls and subtitle presets (the poster tag group
 * editor is ui-panel-tag-editor.ts).
 * Strict TypeScript replacement of the module split from ui.js (same markup, ids and behaviour).
 */
import type { JsonValue } from '../../contracts/generated';
import { apiClient, optionalApiClient, panelHost, registry, settingsPanelContext, type FontFamilyPreset, type FontSizePreset, type PanelBridge } from './host';
import type { PanelContext } from './context';
import { closestTarget, controlChecked, controlValue, inputById, isDisabled, queryElements, queryInput, requireId, selectById, setDisabled } from '../shared/dom';
import { audioLanguageOptions, decodeCultures } from './language-options';
import { entryAt } from '../shared/settings-values';
import { activeSubtitleIsBitmap, clampPauseDelay, clampPosition, colorWithAlpha } from './subtitle-format';

type Deps = Pick<PanelBridge, 'internals' | 'core' | 'currentSettings' | 'userConfig' | 'pluginConfig' | 'saveUserSettings' | 'toast' | 't'
    | 'escapeHtml' | 'setSettingInherited' | 'isSettingInherited' | 'inheritedSettingKeys'
    | 'addRandomButton' | 'pauseScreenInstance' | 'getSubtitleTextShadow' | 'applySavedStylesWhenReady' | 'applySubtitlePosition'
    | 'applySubtitleStyles' | 'decodeSubtitleColor' | 'subtitlePresets' | 'fontSizePresets' | 'fontFamilyPresets' | 'subtitleTextEffectPresets'>;
type SettingsContext = Pick<PanelContext, 'createToast' | 'resetAutoCloseTimer'> & Partial<Pick<PanelContext, 'help' | 'registerSearch' | 'onClose'>>;
type MiscContext = Pick<PanelContext, 'primaryAccentColor' | 'resetAutoCloseTimer' | 'closePanel'>;
type PresetType = 'style' | 'font-size' | 'font-family' | 'text-effect';

/** Panel toggles of the poster tag groups the layout controller places. */
const TAG_GROUP_TOGGLES = ['qualityTagsToggle', 'genreTagsToggle', 'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'statusTagsToggle', 'awardsTagsToggle', 'logoTagsToggle', 'customTagsToggle'];

/** Whether any server tag-cache entry carries logos. */
const anyEntryHasLogos = (entries: Iterable<unknown>): boolean => {
    for (const entry of entries) {
        const logos: unknown = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'Logos') : undefined;
        if (Array.isArray(logos) && logos.length > 0) return true;
    }
    return false;
};

/** A random-source list item from /Users/{id}/Items (untrusted). */
interface SourceItem { id: string; name: string; type: unknown }
const sourceItems = (response: unknown): SourceItem[] => {
    const items: unknown = response !== null && typeof response === 'object' ? Reflect.get(response, 'Items') : undefined;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is object => item !== null && typeof item === 'object').map((item) => {
        const id: unknown = Reflect.get(item, 'Id');
        const name: unknown = Reflect.get(item, 'Name');
        return { id: typeof id === 'string' ? id : String(id), name: typeof name === 'string' ? name : '', type: Reflect.get(item, 'Type') };
    });
};

export function installUiPanelSettings(JE: Deps, featureCtx = settingsPanelContext(JE)): void {
    const internal = registry(JE);

    const { showReleaseNotesNotification } = internal;

    /** The subtitle size preset a stored index selects; an index the presets lack shows Normal, as the template does. */
    const fontSizeAt = (value: JsonValue | undefined): FontSizePreset | undefined => entryAt(JE.fontSizePresets, value, 2) || JE.fontSizePresets[2];
    /** The subtitle font preset a stored index selects; an index the presets lack shows the first. */
    const fontFamilyAt = (value: JsonValue | undefined): FontFamilyPreset | undefined => entryAt(JE.fontFamilyPresets, value, 0) || JE.fontFamilyPresets[0];
    const requirePreset = <T>(preset: T | undefined, what: string): T => {
        if (preset === undefined) throw new TypeError(`Missing subtitle ${what} preset`);
        return preset;
    };

    // Position-tab preview text ("AaBbCcDd") mirrors the real font family, and
    // its size scaled relative to "Normal" so it stays legible in the small
    // preview box instead of rendering at the real on-video vw-based size.
    // Module-scoped (not inside wireSettingsListeners) since it's also called
    // from wireMiscSettingsControls' preset-click handlers, a separate closure.
    const updatePositionPreviewFont = (fontSizePreset: FontSizePreset | undefined, fontFamilyPreset: FontFamilyPreset | undefined) => {
        const posPreviewEl = document.getElementById('subtitlePositionPreview');
        const normal = JE.fontSizePresets[2];
        if (!posPreviewEl || !fontSizePreset || !fontFamilyPreset || !normal) return;
        const px = Math.max(8, Math.min(22, 13 * (fontSizePreset.size / normal.size)));
        posPreviewEl.style.fontSize = `${px}px`;
        posPreviewEl.style.fontFamily = fontFamilyPreset.family;
    };

    /**
     * Re-measure corner stacking on every card that still has tag overlays.
     * Called after a tag type's overlays are removed by its panel toggle, so
     * an overlay that was stacked above them (e.g. the age rating badge over
     * the rating chip) drops back into its corner instead of keeping a stale
     * translateY.
     */
    const restackTagCorners = () => {
        const restack = JE.core?.tagRenderer?.applyCornerStacking;
        if (typeof restack !== 'function') return;
        const hosts = new Set<Element>();
        document.querySelectorAll('[data-je-corner]').forEach(el => { if (el.parentElement) hosts.add(el.parentElement); });
        hosts.forEach(host => restack(host));
    };

    /**
     * Remove one tag group from every card after its toggle is switched off:
     * through the layout controller (which also drops its pill facts, dots
     * and hover copies), plus any wrapper it does not manage.
     * @param group - Layout group id (e.g. 'ageRating').
     * @param containerClass - The group's wrapper class.
     */
    const removeTagGroup = (group: string, containerClass: string) => {
        JE.core?.tagLayout?.removeGroupEverywhere(group);
        document.querySelectorAll(`.${containerClass}`).forEach(el => el.remove());
        restackTagCorners();
    };
    // An imported Media Tags document turns groups off the same way (ui-panel-tag-portable.ts).
    internal.removeTagGroup = removeTagGroup;

    /**
     * The Logos group was switched on. When nobody showed it before, the
     * server only now looks the logos up and republishes every entry in the
     * background, so the cards on the page were drawn from entries without
     * them: once a delta brings entries with logos, redraw the group once.
     * Entries that already carry logos (someone else shows the group) need
     * no wait.
     */
    const redrawLogosWhenServerHasThem = () => {
        const pipeline = featureCtx.peer('tagPipeline');
        if (!pipeline?.waitForServerCache || anyEntryHasLogos(pipeline.serverEntries?.() || [])) return;
        pipeline.waitForServerCache(anyEntryHasLogos).then((ready) => {
            if (ready && JE.currentSettings?.logoTagsEnabled) featureCtx.peer('reinitializeLogoTags')?.();
        }).catch(() => {});
    };

    /** Feature toggles that bring their tag group back (initialize) or remove it from every card. */
    const TAG_TOGGLE_ACTIONS: Readonly<Record<string, { on(): void; off(): void }>> = {
        qualityTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeQualityTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('quality', 'quality-overlay-container') },
        genreTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeGenreTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('genre', 'genre-overlay-container') },
        languageTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeLanguageTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('language', 'language-overlay-container') },
        ratingTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeRatingTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('rating', 'rating-overlay-container') },
        ageRatingTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeAgeRatingTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('ageRating', 'age-rating-overlay-container') },
        logoTagsToggle: {
            on: () => { const peerFn = featureCtx.peer('initializeLogoTags'); if (typeof peerFn === 'function') peerFn(); redrawLogosWhenServerHasThem(); },
            off: () => { featureCtx.peer('tagPipeline')?.stopWaitingForServerCache?.(); removeTagGroup('logos', 'logo-overlay-container'); }
        },
        statusTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeStatusTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('status', 'status-overlay-container') },
        awardsTagsToggle: { on: () => featureCtx.peer('initializeAwardsTags')?.(), off: () => removeTagGroup('awards', 'awards-overlay-container') },
        customTagsToggle: { on: () => { const peerFn = featureCtx.peer('initializeCustomTags'); if (typeof peerFn === 'function') peerFn(); }, off: () => removeTagGroup('custom', 'custom-overlay-container') },
        peopleTagsToggle: {
            on: () => { const peerFn = featureCtx.peer('initializePeopleTags'); if (typeof peerFn === 'function') peerFn(); },
            off: () => {
                document.querySelectorAll('.je-people-place-banner').forEach(el => el.remove());
                document.querySelectorAll('.je-people-age-container').forEach(el => el.remove());
                document.querySelectorAll('.je-deceased-poster').forEach(el => el.classList.remove('je-deceased-poster'));
            }
        },
    };

    /**
     * Updates ↑/↓ button enabled state to reflect each row's position in the list
     * @param group - The container holding the category rows
     */
    function refreshQualityCatArrowStates(group: HTMLElement) {
        const rows = queryElements(group, '.je-quality-cat-row');
        rows.forEach((row, idx) => {
            const upBtn = row.querySelector('.je-cat-up');
            const downBtn = row.querySelector('.je-cat-down');
            const isFirst = idx === 0;
            const isLast = idx === rows.length - 1;
            if (upBtn instanceof HTMLElement) {
                setDisabled(upBtn, isFirst);
                upBtn.style.cursor = isFirst ? 'not-allowed' : 'pointer';
                upBtn.style.opacity = isFirst ? '0.4' : '1';
            }
            if (downBtn instanceof HTMLElement) {
                setDisabled(downBtn, isLast);
                downBtn.style.cursor = isLast ? 'not-allowed' : 'pointer';
                downBtn.style.opacity = isLast ? '0.4' : '1';
            }
        });
    }

    /** A nested sub-toggle list under a master toggle (expander, collapse when turned off). */
    const wireNestedList = (masterId: string, wrapId: string, groupId: string, expanderId: string) => {
        const master = inputById(masterId);
        const wrap = document.getElementById(wrapId);
        const group = document.getElementById(groupId);
        const expander = document.getElementById(expanderId);
        if (master && wrap) {
            master.addEventListener('change', () => {
                wrap.style.display = master.checked ? 'block' : 'none';
                // Collapse the list when the feature is turned off so it returns
                // collapsed the next time the user enables it.
                if (!master.checked && group && expander) {
                    group.style.display = 'none';
                    expander.setAttribute('aria-expanded', 'false');
                }
            });
        }
        // The chevron rotation is driven by CSS via the aria-expanded attribute.
        if (expander && group) {
            expander.addEventListener('click', () => {
                const expanded = expander.getAttribute('aria-expanded') === 'true';
                expander.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                group.style.display = expanded ? 'none' : 'block';
            });
        }
        return group;
    };

    /**
     * Wires the feature toggles, quality-tag category controls and subtitle
     * styling/position controls of the Settings tab.
     * @param ctx Shared panel context assembled in ui-panel.ts.
     */
    internal.wireSettingsListeners = function(ctx: SettingsContext) {
        const { createToast, resetAutoCloseTimer } = ctx;

        // Detail-page languages belong to UI Settings, including search results.
        const unregisterAudioSearch = ctx.registerSearch?.({
            pane: 'ui',
            /** Find the moved detail-page preference by its visible label. */
            search(query) {
                const control = ctx.help?.querySelector('[data-pane="ui"] #showAudioLanguagesToggle');
                const label = JE.t('panel_settings_ui_audio_languages');
                return control instanceof HTMLElement && label.toLowerCase().includes(query) ? [{ label, path: JE.t('panel_settings_ui'),
                    run() { control.scrollIntoView?.({ block: 'center' }); control.focus({ preventScroll: true }); } }] : [];
            },
        });
        if (unregisterAudioSearch) ctx.onClose?.(unregisterAudioSearch);

        const addSettingToggleListener = (id: string, settingKey: string, featureKey: string, requiresRefresh = false) => {
            requireId(id).addEventListener('change', (e) => {
                const checked = controlChecked(e.target);
                JE.currentSettings[settingKey] = checked;
                // The layout settings depend on which tag types are on (caption
                // space is reserved only while a group can fill it).
                JE.core?.tagLayout?.invalidateSettings();
                JE.saveUserSettings('settings.json', JE.currentSettings);
                let toastMessage = createToast(featureKey, checked === true);

                // Handle tag features with dynamic re-initialization
                const tagAction = Object.prototype.hasOwnProperty.call(TAG_TOGGLE_ACTIONS, id) ? TAG_TOGGLE_ACTIONS[id] : undefined;
                if (tagAction) {
                    if (checked) tagAction.on();
                    else tagAction.off();
                    requiresRefresh = false; // No longer needs refresh
                }
                // Re-present every card for the new set of groups: caption space
                // is reserved on every card when a group that can fill it comes
                // on, and given back once none is left.
                if (TAG_GROUP_TOGGLES.includes(id)) featureCtx.peer('reinitializeTagLayout')?.();

                if (requiresRefresh) {
                    toastMessage += ".<br> Refresh page to apply.";
                }
                JE.toast(toastMessage);
                if (id === 'randomButtonToggle') JE.addRandomButton();
                if (id === 'showWatchProgressToggle' && !checked) document.querySelectorAll('.mediaInfoItem-watchProgress').forEach(el => el.remove());
                if (id === 'showFileSizesToggle' && !checked) document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove());
                if (id === 'showAudioLanguagesToggle' && !checked) document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove());
                resetAutoCloseTimer();
            });
        };

        /** A select that stores its value under one setting key. */
        const addSelectListener = (id: string, settingKey: string) => {
            const select = document.getElementById(id);
            if (!select) return;
            select.addEventListener('change', (e) => {
                JE.currentSettings[settingKey] = controlValue(e.target);
                JE.saveUserSettings('settings.json', JE.currentSettings);
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
        addSelectListener('watchProgressModeSelect', 'watchProgressMode');
        addSelectListener('watchProgressTimeFormatSelect', 'watchProgressTimeFormat');
        addSettingToggleListener('showFileSizesToggle', 'showFileSizes', 'feature_file_size_display');
        addSettingToggleListener('showAudioLanguagesToggle', 'showAudioLanguages', 'feature_audio_language_display');
        addSettingToggleListener('removeContinueWatchingToggle', 'removeContinueWatchingEnabled', 'feature_remove_continue_watching');
        document.getElementById('nativePosterTagsToggle')?.addEventListener('change', (event) => {
            if (JE.pluginConfig?.NativePosterTagsEnabled !== true) return;
            const enabled = controlChecked(event.target);
            // Record the explicit choice so saveUserSettings writes it (an untouched user stays unset = on).
            JE.userConfig = JE.userConfig || { shortcuts: { Shortcuts: [] } };
            JE.userConfig.settings = JE.userConfig.settings || {};
            JE.userConfig.settings.useNativePosterTags = enabled;
            JE.currentSettings.useNativePosterTags = enabled;
            JE.saveUserSettings('settings.json', JE.currentSettings);
            JE.toast(JE.t('toast_native_poster_tags_saved'));
            resetAutoCloseTimer();
        });
        addSettingToggleListener('qualityTagsToggle', 'qualityTagsEnabled', 'feature_quality_tags', true);
        // Show or hide the nested category section when the master quality-tags toggle changes
        const qualitySubGroup = wireNestedList('qualityTagsToggle', 'qualityTagsSubWrap', 'qualityTagsSubToggles', 'qualityTagsSubToggleExpander');
        // Wire the per-category sub-toggle controls via event delegation
        if (qualitySubGroup) {
            // Persist sub-toggle state and re-render existing cards with the new filter
            qualitySubGroup.addEventListener('change', (e) => {
                const target = e.target;
                if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
                const row = target.closest('.je-quality-cat-row');
                if (!(row instanceof HTMLElement)) return;
                const settingKey = row.dataset.catKey;
                if (!settingKey) return;
                // Any change is the user's own, even back to the administrator's value.
                JE.setSettingInherited?.(JE.currentSettings, settingKey, false);
                JE.currentSettings[settingKey] = target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                const reinitQuality = featureCtx.peer('reinitializeQualityTags'); if (typeof reinitQuality === 'function' && JE.currentSettings.qualityTagsEnabled) {
                    reinitQuality();
                }
                resetAutoCloseTimer();
            });
            // Handle ↑/↓ stack reorder buttons
            qualitySubGroup.addEventListener('click', (e) => {
                const btn = closestTarget(e, '.je-cat-up, .je-cat-down');
                if (!btn || isDisabled(btn)) return;
                const row = btn.closest('.je-quality-cat-row');
                if (!row) return;
                const isUp = btn.classList.contains('je-cat-up');
                const sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('je-quality-cat-row')) return;
                const parent = sibling.parentNode;
                if (!parent) return;

                // Move the row in the DOM so the user sees the change immediately
                if (isUp) {
                    parent.insertBefore(row, sibling);
                } else {
                    parent.insertBefore(sibling, row);
                }

                // Normalize order values to 1..N from visual position so any
                // pre-existing duplicates (e.g. admin set two rows to the same
                // value via XML) self-heal on the next user reorder. The whole
                // order is the user's now (none of it follows the admin's).
                queryElements(qualitySubGroup, '.je-quality-cat-row').forEach((r, idx) => {
                    const orderKey = r.dataset.orderKey;
                    if (!orderKey) return;
                    JE.setSettingInherited?.(JE.currentSettings, orderKey, false);
                    JE.currentSettings[orderKey] = idx + 1;
                });
                JE.saveUserSettings('settings.json', JE.currentSettings);

                refreshQualityCatArrowStates(qualitySubGroup);
                const reinitQuality = featureCtx.peer('reinitializeQualityTags'); if (typeof reinitQuality === 'function' && JE.currentSettings.qualityTagsEnabled) {
                    reinitQuality();
                }
                resetAutoCloseTimer();
            });
        }

        // Nullable display preferences retain live admin inheritance until explicitly chosen.
        queryElements(document, '[data-quality-display-key]').forEach(select => {
            select.addEventListener('change', () => {
                const key = select.dataset.qualityDisplayKey ?? '';
                const value = controlValue(select);
                if (value === '') {
                    if (!JE.setSettingInherited?.(JE.currentSettings, key, true)) JE.currentSettings[key] = null;
                } else {
                    JE.setSettingInherited?.(JE.currentSettings, key, false);
                    JE.currentSettings[key] = key === 'qualityHideSdr' ? value === 'true' : value;
                }
                JE.saveUserSettings('settings.json', JE.currentSettings);
                featureCtx.peer('reinitializeQualityTags')?.();
                featureCtx.peer('reinitializeTagLayout')?.();
                resetAutoCloseTimer();
            });
        });

        // Low-quality sources are a gate within Source, separate from category ordering.
        const lowSourceToggle = inputById('showLowQualitySourceTagToggle');
        if (lowSourceToggle) lowSourceToggle.addEventListener('change', () => {
            JE.setSettingInherited?.(JE.currentSettings, 'showLowQualitySourceTag', false);
            JE.currentSettings.showLowQualitySourceTag = lowSourceToggle.checked;
            JE.saveUserSettings('settings.json', JE.currentSettings);
            if (JE.currentSettings.qualityTagsEnabled) featureCtx.peer('reinitializeQualityTags')?.();
            resetAutoCloseTimer();
        });

        // Series and seasons share a quality policy; the summary supports switching without refetching.
        // The empty option follows the administrator (saved as null); a named policy is the user's.
        const aggregationSelect = selectById('seriesQualityAggregationSelect');
        if (aggregationSelect) {
            const policy = JE.currentSettings.seriesQualityAggregation;
            aggregationSelect.value = JE.isSettingInherited?.(JE.currentSettings, 'seriesQualityAggregation')
                ? '' : String(policy || 'representative');
            aggregationSelect.addEventListener('change', () => {
                const chosen = aggregationSelect.value;
                if (!chosen) {
                    if (!JE.setSettingInherited?.(JE.currentSettings, 'seriesQualityAggregation', true)) JE.currentSettings.seriesQualityAggregation = null;
                } else {
                    JE.setSettingInherited?.(JE.currentSettings, 'seriesQualityAggregation', false);
                    JE.currentSettings.seriesQualityAggregation = chosen;
                }
                JE.saveUserSettings('settings.json', JE.currentSettings);
                featureCtx.peer('reinitializeQualityTags')?.();
                resetAutoCloseTimer();
            });
        }

        // "Follow server settings": all nullable Quality switches, orders, display
        // preferences and the series policy follow the administrator again (saved as null).
        const qualityFollowServer = document.getElementById('qualityTagsFollowServer');
        if (qualityFollowServer) qualityFollowServer.addEventListener('click', () => {
            for (const key of JE.inheritedSettingKeys || []) {
                if (!JE.setSettingInherited?.(JE.currentSettings, key, true)) JE.currentSettings[key] = null;
            }
            JE.saveUserSettings('settings.json', JE.currentSettings);
            if (qualitySubGroup) queryElements(qualitySubGroup, '.je-quality-cat-row').forEach(row => {
                const input = queryInput(row, 'input[type="checkbox"]');
                const value = JE.currentSettings[row.dataset.catKey ?? ''];
                if (input && typeof value === 'boolean') input.checked = value;
            });
            queryElements(document, '[data-quality-display-key]').forEach(select => { if (select instanceof HTMLSelectElement) select.value = ''; });
            const lowSource = JE.currentSettings.showLowQualitySourceTag;
            if (lowSourceToggle && typeof lowSource === 'boolean') lowSourceToggle.checked = lowSource;
            if (aggregationSelect) aggregationSelect.value = '';
            if (qualitySubGroup) {
                const orderOf = (r: HTMLElement) => Number(JE.currentSettings[r.dataset.orderKey ?? '']) || Number(r.dataset.defaultOrder) || 0;
                const rows = queryElements(qualitySubGroup, '.je-quality-cat-row');
                rows.sort((a, b) => (orderOf(a) - orderOf(b)) || (Number(a.dataset.defaultOrder) - Number(b.dataset.defaultOrder)))
                    .forEach(r => qualitySubGroup.appendChild(r));
                refreshQualityCatArrowStates(qualitySubGroup);
            }
            if (JE.currentSettings.qualityTagsEnabled) featureCtx.peer('reinitializeQualityTags')?.();
            featureCtx.peer('reinitializeTagLayout')?.();
            JE.toast(JE.t('toast_quality_tags_follow_server'));
            resetAutoCloseTimer();
        });

        // Preferred audio language for the sound tag (#433). The fixed choices
        // (server default / my Jellyfin audio language / none) are in the
        // template; the language list comes from Jellyfin's cultures endpoint,
        // like the display-language dropdown.
        const audioLangSelect = selectById('qualityTagsAudioLanguageSelect');
        if (audioLangSelect) {
            const savedLanguage = () => {
                const value = JE.currentSettings.qualityTagsPreferredAudioLanguage;
                return value ? String(value) : '';
            };
            // The fixed choices exist already; a language is selected once the list loads.
            const initial = savedLanguage();
            if (Array.from(audioLangSelect.options).some(o => o.value === initial)) audioLangSelect.value = initial;
            (async () => {
                try {
                    const client = apiClient();
                    const cultures = decodeCultures(await client.ajax({ type: 'GET', url: client.getUrl('/Localization/Cultures'), dataType: 'json' }));
                    audioLanguageOptions(cultures).forEach(({ code, name }) => {
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
                const saved = savedLanguage();
                // A saved code the list doesn't offer (e.g. a hand-edited pt-BR) still shows as selected.
                if (saved && !Array.from(audioLangSelect.options).some(o => o.value === saved)) {
                    const option = document.createElement('option');
                    option.value = saved;
                    option.textContent = saved;
                    audioLangSelect.appendChild(option);
                }
                audioLangSelect.value = saved;
            })();
            audioLangSelect.addEventListener('change', () => {
                JE.currentSettings.qualityTagsPreferredAudioLanguage = audioLangSelect.value;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                const reinitQuality = featureCtx.peer('reinitializeQualityTags'); if (typeof reinitQuality === 'function' && JE.currentSettings.qualityTagsEnabled) {
                    reinitQuality();
                }
                resetAutoCloseTimer();
            });
        }

        addSettingToggleListener('genreTagsToggle', 'genreTagsEnabled', 'feature_genre_tags', true);
        addSettingToggleListener('pauseScreenToggle', 'pauseScreenEnabled', 'feature_custom_pause_screen', true);

        const pauseScreenDelayInput = document.getElementById('pauseScreenDelayInput');
        if (pauseScreenDelayInput instanceof HTMLInputElement) {
            // Without this, digit keydowns bubble to the document and Jellyfin's
            // native player intercepts them as percent-seek shortcuts (0-9)
            // instead of letting them reach the input.
            pauseScreenDelayInput.addEventListener('keydown', (e) => e.stopPropagation());
            pauseScreenDelayInput.addEventListener('change', () => {
                const val = clampPauseDelay(pauseScreenDelayInput.value);
                pauseScreenDelayInput.value = String(val);
                JE.currentSettings.pauseScreenDelaySeconds = val;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                // Push the new delay into the already-running pause-screen
                // instance so it takes effect immediately, without a page reload.
                if (JE.pauseScreenInstance) {
                    JE.pauseScreenInstance.pauseScreenDelayMs = val * 1000;
                }
            });
        }
        addSettingToggleListener('languageTagsToggle', 'languageTagsEnabled', 'feature_language_tags', true);
        addSettingToggleListener('ratingTagsToggle', 'ratingTagsEnabled', 'feature_rating_tags', true);
        addSettingToggleListener('ageRatingTagsToggle', 'ageRatingTagsEnabled', 'feature_age_rating_tags', true);
        addSettingToggleListener('statusTagsToggle', 'statusTagsEnabled', 'feature_status_tags', true);
        if (document.getElementById('awardsTagsToggle')) addSettingToggleListener('awardsTagsToggle', 'awardsTagsEnabled', 'feature_awards_tags', true);
        addSettingToggleListener('logoTagsToggle', 'logoTagsEnabled', 'feature_logo_tags', true);
        addSettingToggleListener('customTagsToggle', 'customTagsEnabled', 'feature_custom_tags', true);
        addSettingToggleListener('peopleTagsToggle', 'peopleTagsEnabled', 'feature_people_tags', true);
        addSettingToggleListener('tagsHideOnHoverToggle', 'tagsHideOnHover', 'feature_tags_hide_on_hover', false);
        // --- Tag layout, label density and edge spacing ---
        // Either choice promotes a document saved before layouts existed to the
        // normalized version (its corners, positions, arrival order, full labels
        // and limits carry over, so only the chosen value changes), then every
        // card is re-presented from the facts it already holds.
        const saveTagLayoutSetting = (key: string, value: string | undefined) => {
            JE.core?.tagLayout?.promoteLegacySettings(JE.currentSettings);
            JE.currentSettings[key] = value;
            JE.currentSettings.tagLayoutSettingsVersion = 1;
            JE.saveUserSettings('settings.json', JE.currentSettings);
            const peerFn = featureCtx.peer('reinitializeTagLayout'); if (typeof peerFn === 'function') peerFn();
            JE.toast(JE.t('toast_tag_layout_updated'));
            resetAutoCloseTimer();
        };
        // The Media Tags hub's layout tiles and density pills (radio groups).
        document.getElementById('jeTagLayoutChoice')?.addEventListener('change', (e) => saveTagLayoutSetting('tagLayout', controlValue(e.target)));
        document.getElementById('jeTagDensityChoice')?.addEventListener('change', (e) => saveTagLayoutSetting('tagLabelDensity', controlValue(e.target)));
        document.getElementById('jeTagScaleChoice')?.addEventListener('change', (e) => saveTagLayoutSetting('tagScale', controlValue(e.target)));
        document.getElementById('jeTagGapChoice')?.addEventListener('change', (e) => saveTagLayoutSetting('tagGap', controlValue(e.target)));
        document.getElementById('jeTagEdgeChoice')?.addEventListener('change', (e) => saveTagLayoutSetting('tagEdgeSpacing', controlValue(e.target)));

        // --- Tag Styles: user presets ---
        // The empty choice stores null (follow the admin's preset); the web
        // stylesheet is re-fetched right away, native posters pick the change
        // up through the per-user settings digest.
        document.getElementById('jeTagPresetChoice')?.addEventListener('change', (e) => {
            JE.currentSettings.tagStylePreset = controlValue(e.target) || null;
            JE.saveUserSettings('settings.json', JE.currentSettings);
            const peerFn = featureCtx.peer('initializeTagStyles'); if (typeof peerFn === 'function') peerFn();
            JE.toast(JE.t('toast_tag_style_preset_updated'));
            resetAutoCloseTimer();
        });

        // Live-toggle the body class so hover fade CSS applies immediately (no refresh needed)
        const hideOnHoverCheckbox = inputById('tagsHideOnHoverToggle');
        if (hideOnHoverCheckbox) {
            hideOnHoverCheckbox.addEventListener('change', () => {
                document.body.classList.toggle('je-tags-hide-on-hover', hideOnHoverCheckbox.checked);
            });
        }

        /** A delegated sub-toggle list whose rows carry their setting key (data-cat-key). */
        const wireCatKeyToggles = (group: HTMLElement | null, enabledKey: string, reinitialize: () => void) => {
            if (!group) return;
            group.addEventListener('change', (e) => {
                const target = e.target;
                if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
                const row = target.closest('.je-quality-cat-row');
                const settingKey = row instanceof HTMLElement ? row.dataset.catKey : undefined;
                if (!settingKey) return;
                JE.currentSettings[settingKey] = target.checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                if (JE.currentSettings[enabledKey]) reinitialize();
                resetAutoCloseTimer();
            });
        };
        // Rating tag scope (item types / home rows): nested under the master
        // toggle exactly like the quality-tag categories above.
        wireCatKeyToggles(wireNestedList('ratingTagsToggle', 'ratingTagsSubWrap', 'ratingTagsSubToggles', 'ratingTagsSubToggleExpander'),
            'ratingTagsEnabled', () => { const peerFn = featureCtx.peer('reinitializeRatingTags'); if (typeof peerFn === 'function') peerFn(); });
        // Status tag badges (Trending / New / Just Added): same nested
        // sub-toggle pattern as the rating scope above.
        wireCatKeyToggles(wireNestedList('statusTagsToggle', 'statusTagsSubWrap', 'statusTagsSubToggles', 'statusTagsSubToggleExpander'),
            'statusTagsEnabled', () => { const peerFn = featureCtx.peer('reinitializeStatusTags'); if (typeof peerFn === 'function') peerFn(); });
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

            const disableStylesCheckbox = document.getElementById('disableCustomSubtitleStyles');
            const stylesEnabled = () => !JE.currentSettings.disableCustomSubtitleStyles;

            // Read once, when the panel opens -- this setting doesn't change while
            // the panel is up, so there's no need to re-read localStorage on every
            // DOM mutation.
            if (positionNote) {
                let isCustom = false;
                try {
                    const userId = optionalApiClient()?.getCurrentUserId?.();
                    const raw = userId && localStorage.getItem(`${userId}-localplayersubtitleappearance3`);
                    const appearance: unknown = raw ? JSON.parse(raw) : null;
                    isCustom = appearance !== null && typeof appearance === 'object' && Reflect.get(appearance, 'subtitleStyling') === 'Custom';
                } catch { /* ignore, treat as not-custom */ }

                const applyPositionNoteState = () => {
                    positionNote.style.display = (stylesEnabled() && !isCustom) ? 'flex' : 'none';
                };
                applyPositionNoteState();
                if (disableStylesCheckbox) disableStylesCheckbox.addEventListener('change', applyPositionNoteState);
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
                (async () => {
                    let isUnsupportedFormat = false;
                    try {
                        const client = apiClient();
                        const userId = client.getCurrentUserId?.();
                        const sessions = userId ? await client.getSessions({ ControllableByUserId: userId }) : [];
                        isUnsupportedFormat = activeSubtitleIsBitmap(sessions);
                    } catch { /* leave hidden on failure */ }

                    const applyFormatWarningState = () => {
                        formatWarning.style.display = (stylesEnabled() && isUnsupportedFormat) ? 'flex' : 'none';
                    };
                    applyFormatWarningState();
                    if (disableStylesCheckbox) disableStylesCheckbox.addEventListener('change', applyFormatWarningState);
                })();
            }
        })();

        // Keeps the two panel previews showing the same text effect as the video.
        const syncPreviewTextShadow = (bgColor: string) => {
            const shadow = JE.getSubtitleTextShadow(bgColor);
            ['subtitleColorPreview', 'subtitlePositionPreview'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.textShadow = shadow;
            });
        };
        internal.syncSubtitlePreviewTextShadow = syncPreviewTextShadow;

        // Inline custom subtitle color pickers
        const customTextColorPicker = inputById('customSubtitleTextColorPicker');
        const customTextAlpha = inputById('customSubtitleTextAlpha');
        const customBgColorPicker = inputById('customSubtitleBgColorPicker');
        const customBgAlpha = inputById('customSubtitleBgAlpha');

        const updateCustomSubtitleColors = () => {
            if (!customTextColorPicker || !customTextAlpha || !customBgColorPicker || !customBgAlpha) {
                throw new TypeError('The custom subtitle colour controls are incomplete');
            }
            const textColor = colorWithAlpha(customTextColorPicker.value, customTextAlpha.value);
            const bgColor = colorWithAlpha(customBgColorPicker.value, customBgAlpha.value);

            JE.currentSettings.customSubtitleTextColor = textColor;
            JE.currentSettings.customSubtitleBgColor = bgColor;
            JE.currentSettings.usingCustomColors = true;

            // Remove border from all style presets
            const styleContainer = document.getElementById('subtitle-style-presets-container');
            if (styleContainer) {
                queryElements(styleContainer, '.preset-box').forEach(box => {
                    box.style.setProperty('border', '2px solid transparent', 'important');
                });
            }

            // Update live preview
            const preview = document.getElementById('subtitleColorPreview');
            if (preview) {
                preview.style.color = textColor;
                preview.style.backgroundColor = bgColor;
            }
            const posPreviewEl = document.getElementById('subtitlePositionPreview');
            if (posPreviewEl) {
                posPreviewEl.style.color = textColor;
                posPreviewEl.style.backgroundColor = bgColor;
            }
            syncPreviewTextShadow(bgColor);

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
            const updatePosition = (rawX: number, rawY: number) => {
                const xPct = clampPosition(rawX);
                const yPct = clampPosition(rawY);
                if (posPreview) {
                    posPreview.style.left = `${xPct}%`;
                    posPreview.style.top = 'auto';
                    posPreview.style.bottom = `${100 - yPct}%`;
                }
                JE.currentSettings.subtitleHorizontalPosition = Math.round(xPct);
                JE.currentSettings.subtitleVerticalPosition = Math.round(yPct);
                if (typeof JE.applySubtitlePosition === 'function') JE.applySubtitlePosition();
            };

            const pctFrom = (clientX: number, clientY: number) => {
                const rect = posGrid.getBoundingClientRect();
                return {
                    x: ((clientX - rect.left) / rect.width) * 100,
                    y: ((clientY - rect.top) / rect.height) * 100
                };
            };
            const pctFromTouch = (e: TouchEvent) => {
                const touch = e.touches[0];
                return touch ? pctFrom(touch.clientX, touch.clientY) : null;
            };

            let dragging = false;

            posGrid.addEventListener('mousedown', (e) => {
                const { x, y } = pctFrom(e.clientX, e.clientY);
                updatePosition(x, y);
                dragging = true;
                e.preventDefault();
            });

            const onMouseMove = (e: MouseEvent) => {
                if (!dragging) return;
                const { x, y } = pctFrom(e.clientX, e.clientY);
                updatePosition(x, y);
                resetAutoCloseTimer();
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                JE.saveUserSettings('settings.json', JE.currentSettings);
            };

            posGrid.addEventListener('touchstart', (e) => {
                const at = pctFromTouch(e);
                if (at) updatePosition(at.x, at.y);
                dragging = true;
                e.preventDefault();
            }, { passive: false });

            const onTouchMove = (e: TouchEvent) => {
                if (!dragging) return;
                const at = pctFromTouch(e);
                if (at) updatePosition(at.x, at.y);
                resetAutoCloseTimer();
            };

            // The drag follows the pointer anywhere on the page; these document
            // listeners go with the panel (they used to outlive every closed one).
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', endDrag);
            document.addEventListener('touchmove', onTouchMove, { passive: true });
            document.addEventListener('touchend', endDrag);
            ctx.onClose?.(() => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', endDrag);
                document.removeEventListener('touchmove', onTouchMove);
                document.removeEventListener('touchend', endDrag);
                // A drag still held when the panel closes keeps its last position.
                endDrag();
            });
        }

        if (posResetBtn) {
            posResetBtn.addEventListener('click', () => {
                JE.currentSettings.subtitleHorizontalPosition = 50;
                JE.currentSettings.subtitleVerticalPosition = 95;
                if (posPreview) { posPreview.style.left = '50%'; posPreview.style.top = 'auto'; posPreview.style.bottom = '5%'; }
                if (typeof JE.applySubtitlePosition === 'function') JE.applySubtitlePosition();
                JE.saveUserSettings('settings.json', JE.currentSettings);
                resetAutoCloseTimer();
            });
        }
    };

    /**
     * Wires the remaining panel controls: random-button item types, the
     * release-notes button, tag position selectors and subtitle preset grids.
     * @param ctx Shared panel context assembled in ui-panel.ts.
     */
    internal.wireMiscSettingsControls = function(ctx: MiscContext) {
        const { primaryAccentColor, resetAutoCloseTimer } = ctx;

        const includeMovies = requireId('randomIncludeMovies');
        const includeShows = requireId('randomIncludeShows');
        const wireItemType = (own: HTMLElement, other: HTMLElement, key: string, itemType: string) => {
            own.addEventListener('change', (e) => {
                const target = e.target;
                if (!controlChecked(target) && !controlChecked(other)) {
                    if (target instanceof HTMLInputElement) target.checked = true;
                    JE.toast(JE.t('toast_at_least_one_item_type'));
                    return;
                }
                const checked = controlChecked(target);
                JE.currentSettings[key] = checked;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                JE.toast(JE.t('toast_random_selection_status', { item_type: itemType, status: checked ? JE.t('selection_included') : JE.t('selection_excluded') }));
                resetAutoCloseTimer();
            });
        };
        wireItemType(includeMovies, includeShows, 'randomIncludeMovies', 'Movies');
        wireItemType(includeShows, includeMovies, 'randomIncludeShows', 'Shows');

        // Random source picker: lists the user's playlists and collections; '' = whole library.
        const sourceSelect = selectById('randomSourceSelect');
        if (sourceSelect) {
            const savedId = String(JE.currentSettings.randomSourceId || '');
            const client = apiClient();
            const userId = client.getCurrentUserId() ?? '';
            client.ajax({ type: 'GET', url: client.getUrl(`/Users/${userId}/Items?IncludeItemTypes=Playlist,BoxSet&Recursive=true&SortBy=SortName`), dataType: 'json' })
                .then(async response => {
                    if (!sourceSelect.isConnected) return; // panel closed before the list arrived
                    const groups = { Playlist: 'panel_settings_random_button_source_playlists', BoxSet: 'panel_settings_random_button_source_collections' };
                    const all = sourceItems(response);
                    for (const [type, labelKey] of Object.entries(groups)) {
                        const items = all.filter(item => item.type === type);
                        if (items.length === 0) continue;
                        const group = document.createElement('optgroup');
                        group.label = JE.t(labelKey);
                        items.forEach(item => group.appendChild(new Option(item.name, item.id, false, item.id === savedId)));
                        sourceSelect.appendChild(group);
                    }
                    // A saved source missing from the list is either gone (show why picks fall back) or
                    // still readable but filtered out of lists, e.g. hidden with Hidden Content, in which
                    // case the button still draws from it, so show its real name.
                    if (savedId && sourceSelect.value !== savedId) {
                        const saved: unknown = await apiClient().getItem(userId, savedId).catch(() => null);
                        if (!sourceSelect.isConnected || JE.currentSettings.randomSourceId !== savedId) return;
                        const type: unknown = saved !== null && typeof saved === 'object' ? Reflect.get(saved, 'Type') : undefined;
                        const name: unknown = saved !== null && typeof saved === 'object' ? Reflect.get(saved, 'Name') : undefined;
                        const label = (type === 'Playlist' || type === 'BoxSet') && typeof name === 'string'
                            ? name
                            : JE.t('panel_settings_random_button_source_missing');
                        sourceSelect.appendChild(new Option(label, savedId, false, true));
                    }
                })
                .catch(err => console.warn('🪼 Jellyfin Enhanced: Could not list playlists for the random source picker', err));
            sourceSelect.addEventListener('change', () => {
                JE.currentSettings.randomSourceId = sourceSelect.value;
                JE.saveUserSettings('settings.json', JE.currentSettings);
                JE.toast(JE.t('toast_random_source_set', { name: JE.escapeHtml(sourceSelect.selectedOptions[0]?.textContent || '') }));
                resetAutoCloseTimer();
            });
        }

        requireId('releaseNotesBtn').addEventListener('click', async () => {
            // Release this dialog's focus boundary before opening the secondary modal.
            ctx.closePanel();
            if (!showReleaseNotesNotification) throw new TypeError('Release notes are unavailable');
            await showReleaseNotesNotification();
        });

        /** Mark one preset box as the chosen one. */
        const highlight = (box: Element | null) => {
            if (box instanceof HTMLElement) box.style.setProperty('border', `2px solid ${primaryAccentColor}`, 'important');
        };

        /** The colours the size/font/effect presets apply with (the saved custom colours). */
        const savedColors = () => ({
            textColor: String(JE.currentSettings.customSubtitleTextColor || '#FFFFFFFF'),
            bgColor: String(JE.currentSettings.customSubtitleBgColor || '#00000000')
        });

        /** Apply one preset of its kind; returns the toast to show. */
        const applyPreset = (type: PresetType, presetIndex: number): string | null => {
            if (type === 'style') {
                const selectedPreset = JE.subtitlePresets[presetIndex];
                if (!selectedPreset) return null;
                JE.currentSettings.selectedStylePresetIndex = presetIndex;
                JE.currentSettings.usingCustomColors = false;
                JE.currentSettings.customSubtitleTextColor = selectedPreset.textColor;
                JE.currentSettings.customSubtitleBgColor = selectedPreset.bgColor;

                // Update UI inputs
                const textColorPicker = inputById('customSubtitleTextColorPicker');
                const textAlphaSlider = inputById('customSubtitleTextAlpha');
                const bgColorPicker = inputById('customSubtitleBgColorPicker');
                const bgAlphaSlider = inputById('customSubtitleBgAlpha');
                const preview = document.getElementById('subtitleColorPreview');

                if (textColorPicker && textAlphaSlider) {
                    const decodedText = JE.decodeSubtitleColor(selectedPreset.textColor, { fallbackSwatch: '#FFFFFF', fallbackAlphaValue: 255 });
                    textColorPicker.value = decodedText.swatch;
                    textAlphaSlider.value = String(decodedText.alphaValue);
                }
                if (bgColorPicker && bgAlphaSlider) {
                    const decodedBg = JE.decodeSubtitleColor(selectedPreset.bgColor, { fallbackSwatch: '#000000', fallbackAlphaValue: 0 });
                    bgColorPicker.value = decodedBg.swatch;
                    bgAlphaSlider.value = String(decodedBg.alphaValue);
                }
                if (preview) {
                    preview.style.color = selectedPreset.textColor;
                    preview.style.backgroundColor = selectedPreset.bgColor;
                }
                const posPreviewEl = document.getElementById('subtitlePositionPreview');
                if (posPreviewEl) {
                    posPreviewEl.style.color = selectedPreset.textColor;
                    posPreviewEl.style.backgroundColor = selectedPreset.bgColor;
                }

                const fontSize = requirePreset(fontSizeAt(JE.currentSettings.selectedFontSizePresetIndex), 'size');
                const fontFamily = requirePreset(fontFamilyAt(JE.currentSettings.selectedFontFamilyPresetIndex), 'font');
                updatePositionPreviewFont(fontSize, fontFamily);
                internal.syncSubtitlePreviewTextShadow?.(selectedPreset.bgColor);
                JE.applySubtitleStyles(selectedPreset.textColor, selectedPreset.bgColor, fontSize.size, fontFamily.family, JE.getSubtitleTextShadow(selectedPreset.bgColor));
                return JE.t('toast_subtitle_style', { style: selectedPreset.name });
            }
            if (type === 'font-size') {
                const selectedPreset = JE.fontSizePresets[presetIndex];
                if (!selectedPreset) return null;
                JE.currentSettings.selectedFontSizePresetIndex = presetIndex;
                const fontFamily = requirePreset(fontFamilyAt(JE.currentSettings.selectedFontFamilyPresetIndex), 'font');
                // Use saved custom colors
                const { textColor, bgColor } = savedColors();
                const textShadow = JE.getSubtitleTextShadow(bgColor);
                updatePositionPreviewFont(selectedPreset, fontFamily);
                JE.applySubtitleStyles(textColor, bgColor, selectedPreset.size, fontFamily.family, textShadow);
                return JE.t('toast_subtitle_size', { size: selectedPreset.name });
            }
            if (type === 'font-family') {
                const selectedPreset = JE.fontFamilyPresets[presetIndex];
                if (!selectedPreset) return null;
                JE.currentSettings.selectedFontFamilyPresetIndex = presetIndex;
                const fontSize = requirePreset(fontSizeAt(JE.currentSettings.selectedFontSizePresetIndex), 'size');
                // Use saved custom colors
                const { textColor, bgColor } = savedColors();
                const textShadow = JE.getSubtitleTextShadow(bgColor);
                updatePositionPreviewFont(fontSize, selectedPreset);
                JE.applySubtitleStyles(textColor, bgColor, fontSize.size, selectedPreset.family, textShadow);
                return JE.t('toast_subtitle_font', { font: selectedPreset.name });
            }
            const selectedPreset = JE.subtitleTextEffectPresets[presetIndex];
            if (!selectedPreset) return null;
            JE.currentSettings.selectedTextEffectPresetIndex = presetIndex;
            const fontSize = requirePreset(fontSizeAt(JE.currentSettings.selectedFontSizePresetIndex), 'size');
            const fontFamily = requirePreset(fontFamilyAt(JE.currentSettings.selectedFontFamilyPresetIndex), 'font');
            // Use saved custom colors
            const { textColor, bgColor } = savedColors();
            internal.syncSubtitlePreviewTextShadow?.(bgColor);
            JE.applySubtitleStyles(textColor, bgColor, fontSize.size, fontFamily.family, JE.getSubtitleTextShadow(bgColor, presetIndex));
            return JE.t('toast_subtitle_text_effect', { effect: selectedPreset.name });
        };

        /** The preset index the saved settings select for highlighting, or null when none shows. */
        const currentIndexFor = (type: PresetType): JsonValue | undefined => {
            if (type === 'style') {
                // Only highlight if not using custom colors
                return JE.currentSettings.usingCustomColors ? undefined : (JE.currentSettings.selectedStylePresetIndex ?? 0);
            }
            if (type === 'font-size') return JE.currentSettings.selectedFontSizePresetIndex ?? 2;
            if (type === 'font-family') return JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;
            const effect = JE.currentSettings.selectedTextEffectPresetIndex;
            // An unknown index renders as Auto (see JE.getSubtitleTextShadow), so highlight that.
            return typeof effect === 'number' && Number.isInteger(effect) && JE.subtitleTextEffectPresets[effect] ? effect : 0;
        };

        const setupPresetHandlers = (containerId: string, type: PresetType) => {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.addEventListener('click', (e) => {
                const presetBox = closestTarget(e, `.${type}-preset`);
                if (!presetBox) return;

                const presetIndex = parseInt(presetBox.dataset.presetIndex ?? '', 10);
                const toast = applyPreset(type, presetIndex);
                if (toast === null) return;
                JE.toast(toast);

                JE.saveUserSettings('settings.json', JE.currentSettings);
                queryElements(container, '.preset-box').forEach(box => {
                    box.style.setProperty('border', '2px solid transparent', 'important');
                });
                presetBox.style.setProperty('border', `2px solid ${primaryAccentColor}`, 'important');
                resetAutoCloseTimer();
            });

            const currentIndex = currentIndexFor(type);
            if (currentIndex !== undefined) highlight(container.querySelector(`[data-preset-index="${String(currentIndex)}"]`));
        };

        setupPresetHandlers('subtitle-style-presets-container', 'style');
        setupPresetHandlers('font-size-presets-container', 'font-size');
        setupPresetHandlers('font-family-presets-container', 'font-family');
        setupPresetHandlers('text-effect-presets-container', 'text-effect');
    };

}

installUiPanelSettings(panelHost());
