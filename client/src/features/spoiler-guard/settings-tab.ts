import { own } from './ownership';
import { spoilerHost } from './host';
const { JE, internal } = spoilerHost();
const owner = own(JE, 'settings-tab', true);
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    internal.buildSettingsHtml = function(ctx) {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return '';
        const prefs = internal.getUserPrefs();
        const escape = typeof JE.escapeHtml === 'function' ? JE.escapeHtml : (value: string) => String(value);
        const adminOn = {
            seriesOverview: JE.pluginConfig.SpoilerStripSeriesOverview !== false,
            overview: JE.pluginConfig.SpoilerStripOverview !== false,
            tags: JE.pluginConfig.SpoilerStripTags !== false,
            chapters: JE.pluginConfig.SpoilerStripChapters !== false,
            taglines: JE.pluginConfig.SpoilerStripTaglines !== false,
            ratings: JE.pluginConfig.SpoilerStripRatings !== false,
            premiereDate: JE.pluginConfig.SpoilerStripPremiereDate !== false,
            replaceTitle: JE.pluginConfig.SpoilerReplaceTitle !== false,
            cast: JE.pluginConfig.SpoilerStripCast !== false,
            reviews: JE.pluginConfig.SpoilerStripReviews !== false,
            // Trickplay seek previews (admin SpoilerBlurTrickplay, default on).
            trickplay: JE.pluginConfig.SpoilerBlurTrickplay !== false,
            // Advanced per-category reveals. Gated on the admin having
            // explicitly ENABLED advanced mode (not "not disabled" like the
            // strip categories above) — there is nothing to opt out of while
            // the uniform strip is in force. The row also runs the opposite
            // direction of effect from its neighbours: the same checkbox
            // mechanics (checked => null/inherit, unchecked => false) make
            // this user's Spoiler Guard STRICTER when unchecked, restoring
            // the uniform full strip instead of the admin's reveals.
            advanced: JE.pluginConfig.SpoilerAdvancedMode === true,
        };
        const checked = (value: boolean | null | undefined) => value === false ? '' : 'checked';
        const row = (id: string, pref: string, label: string, description: string, gate: boolean) => gate ? `
            <div style="margin-bottom:8px;padding:12px;background:${ctx.presetBoxBackground};border-radius:6px;border-left:3px solid rgba(255,255,255,0.15);">
                <label style="display:flex;align-items:center;gap:12px;cursor:pointer;">
                    <input type="checkbox" id="${id}" ${checked(prefs[pref])} data-pref="${pref}" style="width:16px;height:16px;accent-color:${ctx.toggleAccentColor};cursor:pointer;">
                    <div><div style="font-weight:500;font-size:13px;">${escape(JE.t(label))}</div><div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:1px;">${escape(JE.t(description))}</div></div>
                </label>
            </div>` : '';

        return `
            <section class="je-pane" data-pane="spoiler-guard">
                <h3 class="je-pane-title">${JE.icon(JE.IconName.BLUR_ON)} ${escape(JE.t('panel_settings_spoiler_guard'))}</h3>
                <div style="padding:0 16px 16px 16px;">
                    <div style="font-weight:500;font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:8px;padding-left:4px;">${escape(JE.t('panel_settings_spoiler_guard_overrides_section'))}</div>
                    ${row('sbPrefHideSeriesOverview', 'HideSeriesDescriptions', 'panel_settings_spoiler_guard_override_series_overview', 'panel_settings_spoiler_guard_override_series_overview_desc', adminOn.seriesOverview)}
                    ${row('sbPrefHideOverview', 'HideEpisodeDescriptions', 'panel_settings_spoiler_guard_override_overview', 'panel_settings_spoiler_guard_override_overview_desc', adminOn.overview)}
                    ${row('sbPrefReplaceTitle', 'ReplaceEpisodeTitles', 'panel_settings_spoiler_guard_override_titles', 'panel_settings_spoiler_guard_override_titles_desc', adminOn.replaceTitle)}
                    ${row('sbPrefHideChapters', 'HideChapterNames', 'panel_settings_spoiler_guard_override_chapters', 'panel_settings_spoiler_guard_override_chapters_desc', adminOn.chapters)}
                    ${row('sbPrefHideCast', 'HideCast', 'panel_settings_spoiler_guard_override_cast', 'panel_settings_spoiler_guard_override_cast_desc', adminOn.cast)}
                    ${row('sbPrefHideRatings', 'HideRatings', 'panel_settings_spoiler_guard_override_ratings', 'panel_settings_spoiler_guard_override_ratings_desc', adminOn.ratings)}
                    ${row('sbPrefHideAirDate', 'HideAirDate', 'panel_settings_spoiler_guard_override_air_date', 'panel_settings_spoiler_guard_override_air_date_desc', adminOn.premiereDate)}
                    ${row('sbPrefHideTaglines', 'HideTaglines', 'panel_settings_spoiler_guard_override_taglines', 'panel_settings_spoiler_guard_override_taglines_desc', adminOn.taglines)}
                    ${row('sbPrefHideTags', 'HideTags', 'panel_settings_spoiler_guard_override_tags', 'panel_settings_spoiler_guard_override_tags_desc', adminOn.tags)}
                    ${row('sbPrefHideReviews', 'HideReviews', 'panel_settings_spoiler_guard_override_reviews', 'panel_settings_spoiler_guard_override_reviews_desc', adminOn.reviews)}
                    ${row('sbPrefHideTrickplay', 'HideTrickplay', 'panel_settings_spoiler_guard_override_trickplay', 'panel_settings_spoiler_guard_override_trickplay_desc', adminOn.trickplay)}
                    ${row('sbPrefUseAdvancedCategories', 'UseAdvancedCategories', 'panel_settings_spoiler_guard_override_advanced', 'panel_settings_spoiler_guard_override_advanced_desc', adminOn.advanced)}
                    <div style="margin-top:12px;padding:12px;background:${ctx.presetBoxBackground};border-radius:6px;border-left:3px solid ${ctx.toggleAccentColor};">
                        <label style="display:flex;align-items:center;gap:12px;cursor:pointer;">
                            <input type="checkbox" id="sbPrefSkipDisableConfirm" ${prefs.SkipDisableConfirm ? 'checked' : ''} data-pref="SkipDisableConfirm" style="width:16px;height:16px;accent-color:${ctx.toggleAccentColor};cursor:pointer;">
                            <div><div style="font-weight:500;font-size:13px;">${escape(JE.t('panel_settings_spoiler_guard_skip_confirm'))}</div><div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:1px;">${escape(JE.t('panel_settings_spoiler_guard_skip_confirm_desc'))}</div></div>
                        </label>
                    </div>
                </div>
            </section>`;
    };

    internal.wireSettings = function(ctx) {
        owner.reset();
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return;
        const token = owner.lease();
        const current = () => token.current() && ctx.help.isConnected;
        ctx.onClose?.(() => { if (token.current()) owner.reset(); });
        const boxes = Array.from(ctx.help.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id^="sbPref"][data-pref]'));
        if (boxes.length === 0) return;
        const setDisabled = (disabled: boolean) => boxes.forEach(box => { box.disabled = disabled; });

        async function save(changed: HTMLInputElement, previousChecked: boolean) {
            setDisabled(true);
            try {
                await internal.whenLoaded();
                if (!current()) return;
                if (!internal.isLoadOk()) throw new Error('Initial Spoiler Guard load failed; refusing to overwrite preferences.');
                const prefs = internal.getUserPrefs();
                const key = changed.dataset.pref;
                if (!key) throw new Error('Missing preference key');
                prefs[key] = key === 'SkipDisableConfirm' ? !!changed.checked : (changed.checked ? null : false);
                await internal.setUserPrefs(prefs);
                if (!current()) return;
            } catch (e) {
                if (!current()) return;
                console.error(`${logPrefix} preference save failed:`, e);
                changed.checked = previousChecked;
                JE.toast?.(JE.t('spoiler_blur_error_toast'));
            } finally {
                if (current()) setDisabled(!internal.isLoadOk());
            }
        }

        boxes.forEach(function(box) {
            owner.listen(box, 'change', function() {
                void save(box, !box.checked);
                ctx.resetAutoCloseTimer();
            });
        });

        void (async function() {
            try {
                await internal.whenLoaded();
                if (!current()) return;
                if (!internal.isLoadOk()) { setDisabled(true); return; }
                const prefs = internal.getUserPrefs();
                boxes.forEach(function(box) {
                    const key = box.dataset.pref;
                    if (!key) return;
                    box.checked = key === 'SkipDisableConfirm' ? !!prefs[key] : prefs[key] !== false;
                });
            } catch (e) {
                if (!current()) return;
                console.warn(`${logPrefix} preference sync failed:`, e);
                setDisabled(true);
            }
        })();
    };
