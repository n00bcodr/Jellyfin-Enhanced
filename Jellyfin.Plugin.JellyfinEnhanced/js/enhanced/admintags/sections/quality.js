/**
 * @file Media Tags admin page, Groups › Quality: the quality tag categories
 * new users start with and their stacking order, low-quality sources, the
 * series/season aggregation default and the sound tag's audio language.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    const CATEGORIES = [
        ['ShowResolutionTag', 'ResolutionTagOrder'], ['ShowSourceTag', 'SourceTagOrder'], ['ShowDynamicRangeTag', 'DynamicRangeTagOrder'],
        ['ShowSpecialFormatTag', 'SpecialFormatTagOrder'], ['ShowVideoCodecTag', 'VideoCodecTagOrder'], ['ShowAudioInfoTag', 'AudioInfoTagOrder'],
        ['ShowEditionTag', 'EditionTagOrder'],
        ['ShowRuntimeTag', 'RuntimeTagOrder'], ['ShowAspectRatioTag', 'AspectRatioTagOrder'], ['ShowFrameRateTag', 'FrameRateTagOrder'],
    ];

    A.registerSection({
        id: 'group-quality',
        tab: 'groups',
        order: 10,
        title: 'panel_settings_ui_tag_group_quality',
        hint: 'admin_tags_quality_desc',
        group: {
            id: 'quality',
            summary(ctx) {
                const c = ctx.config;
                const on = CATEGORIES.filter(([key]) => c[key] === true).length;
                const lang = c.QualityTagsAudioLanguageFromUser === true ? JE.t('admin_tags_quality_lang_user')
                    : c.QualityTagsPreferredAudioLanguage ? JE.t('admin_tags_quality_lang', { lang: c.QualityTagsPreferredAudioLanguage }) : JE.t('admin_tags_quality_lang_any');
                return [JE.t('admin_tags_quality_summary', { n: on, total: CATEGORIES.length }), JE.t(`series_quality_aggregation_${c.SeriesQualityAggregation || 'representative'}`), lang].join(' · ');
            },
            sample: (ctx) => [['quality', '4K'], ['hdr', 'DV'], ['quality', 'ATMOS']].filter((_, i) => [ctx.config.ShowResolutionTag, ctx.config.ShowDynamicRangeTag, ctx.config.ShowAudioInfoTag][i] === true),
        },
        fields: [
            { id: 'qualityTagsEnabled', key: 'QualityTagsEnabled', type: 'enable', label: 'admin_tags_quality_enabled' },
            { id: 'showResolutionTag', key: 'ShowResolutionTag', type: 'ordered', orderKey: 'ResolutionTagOrder', defaultOrder: 1, label: 'panel_settings_ui_quality_tags_resolution' },
            { id: 'showSourceTag', key: 'ShowSourceTag', type: 'ordered', orderKey: 'SourceTagOrder', defaultOrder: 2, label: 'panel_settings_ui_quality_tags_source' },
            { id: 'showDynamicRangeTag', key: 'ShowDynamicRangeTag', type: 'ordered', orderKey: 'DynamicRangeTagOrder', defaultOrder: 3, label: 'panel_settings_ui_quality_tags_dynamic_range' },
            { id: 'showSpecialFormatTag', key: 'ShowSpecialFormatTag', type: 'ordered', orderKey: 'SpecialFormatTagOrder', defaultOrder: 4, label: 'panel_settings_ui_quality_tags_special_format' },
            { id: 'showVideoCodecTag', key: 'ShowVideoCodecTag', type: 'ordered', orderKey: 'VideoCodecTagOrder', defaultOrder: 5, label: 'panel_settings_ui_quality_tags_video_codec' },
            { id: 'showAudioInfoTag', key: 'ShowAudioInfoTag', type: 'ordered', orderKey: 'AudioInfoTagOrder', defaultOrder: 6, label: 'panel_settings_ui_quality_tags_audio_info' },
            { id: 'showEditionTag', key: 'ShowEditionTag', type: 'ordered', orderKey: 'EditionTagOrder', defaultOrder: 7, label: 'panel_settings_ui_quality_tags_edition' },
            { id: 'showRuntimeTag', key: 'ShowRuntimeTag', type: 'ordered', orderKey: 'RuntimeTagOrder', defaultOrder: 8, label: 'panel_settings_ui_quality_tags_runtime' },
            { id: 'showAspectRatioTag', key: 'ShowAspectRatioTag', type: 'ordered', orderKey: 'AspectRatioTagOrder', defaultOrder: 9, label: 'panel_settings_ui_quality_tags_aspect_ratio' },
            { id: 'showFrameRateTag', key: 'ShowFrameRateTag', type: 'ordered', orderKey: 'FrameRateTagOrder', defaultOrder: 10, label: 'panel_settings_ui_quality_tags_frame_rate' },
            { id: 'showLowQualitySourceTag', key: 'ShowLowQualitySourceTag', type: 'switch', label: 'panel_settings_ui_quality_tags_low_source', desc: 'admin_tags_quality_low_source_desc' },
            { id: 'seriesQualityAggregation', key: 'SeriesQualityAggregation', type: 'select', label: 'admin_tags_quality_aggregation', desc: 'admin_tags_quality_aggregation_desc', fallback: 'representative', options: [['representative', 'series_quality_aggregation_representative'], ['latest', 'series_quality_aggregation_latest'], ['best', 'series_quality_aggregation_best'], ['shared', 'series_quality_aggregation_shared'], ['mixed', 'series_quality_aggregation_mixed']] },
            { id: 'qualityTagsPreferredAudioLanguage', key: 'QualityTagsPreferredAudioLanguage', type: 'select', label: 'admin_tags_quality_audio_language', desc: 'admin_tags_quality_audio_language_desc', fallback: '', options: [['', 'panel_settings_ui_quality_tags_audio_language_none']] },
            { id: 'qualityTagsAudioLanguageFromUser', key: 'QualityTagsAudioLanguageFromUser', type: 'switch', label: 'admin_tags_quality_audio_from_user', desc: 'admin_tags_quality_audio_from_user_desc' },
        ],
        render(ctx) {
            const select = /** @type {HTMLSelectElement|null} */ (ctx.root.querySelector('#qualityTagsPreferredAudioLanguage'));
            if (!select) return;
            // Park the saved code as a bare option until the named list is in, so it stays selected.
            const park = () => {
                const saved = String(ctx.config.QualityTagsPreferredAudioLanguage || '');
                if (saved && !Array.from(select.options).some((o) => o.value === saved)) {
                    const option = document.createElement('option');
                    option.value = saved;
                    option.textContent = saved;
                    select.appendChild(option);
                }
                select.value = saved;
            };
            park();
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' }).then((cultures) => {
                if (!ctx.isCurrent()) return;
                const seen = new Set(['']);
                const options = (cultures || [])
                    .map((c) => ({ code: c.TwoLetterISOLanguageName || c.ThreeLetterISOLanguageName, name: c.DisplayName || c.Name }))
                    .filter((o) => o.code && o.name && !seen.has(o.code) && seen.add(o.code))
                    .sort((a, b) => a.name.localeCompare(b.name));
                select.replaceChildren(select.options[0], ...options.map(({ code, name }) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = name;
                    return option;
                }));
                park();
            }).catch((err) => console.warn('🪼 Jellyfin Enhanced: could not load the audio language list', err));
        },
    });
})(window.JellyfinEnhanced);
