/**
 * @file Media Tags admin tab, Groups › Quality: the quality tag categories
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
        ['ShowVersionsTag', 'VersionsTagOrder'],
    ];

    A.registerSection({
        id: 'group-quality',
        tab: 'groups',
        order: 10,
        title: 'Quality',
        hint: 'Resolution, source, HDR, format and sound badges. Pick the categories and the order they stack in.',
        group: {
            id: 'quality',
            // The categories shown; how they are shown and the audio language are inside the group (Display behaviour, Audio language defaults).
            summary(ctx) {
                const on = CATEGORIES.filter(([key]) => ctx.config[key] === true).length;
                return A.fmt('{n} of {total} categories', { n: on, total: CATEGORIES.length });
            },
            sample: (ctx) => [['quality', '4K'], ['hdr', 'DV'], ['quality', 'ATMOS']].filter((_, i) => [ctx.config.ShowResolutionTag, ctx.config.ShowDynamicRangeTag, ctx.config.ShowAudioInfoTag][i] === true),
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'qualityTagsEnabled', key: 'QualityTagsEnabled', type: 'enable', label: 'Quality tags for new users' },
            { id: 'showResolutionTag', key: 'ShowResolutionTag', type: 'ordered', orderKey: 'ResolutionTagOrder', defaultOrder: 1, label: 'Resolution (4K, 1080p, ...)' },
            { id: 'showSourceTag', key: 'ShowSourceTag', type: 'ordered', orderKey: 'SourceTagOrder', defaultOrder: 2, label: 'Source (REMUX, BluRay, WEB, HDTV, DVD, …)' },
            { id: 'showDynamicRangeTag', key: 'ShowDynamicRangeTag', type: 'ordered', orderKey: 'DynamicRangeTagOrder', defaultOrder: 3, label: 'HDR (HDR10+, Dolby Vision)' },
            { id: 'showSpecialFormatTag', key: 'ShowSpecialFormatTag', type: 'ordered', orderKey: 'SpecialFormatTagOrder', defaultOrder: 4, label: 'Special format (IMAX, 3D)' },
            { id: 'showVideoCodecTag', key: 'ShowVideoCodecTag', type: 'ordered', orderKey: 'VideoCodecTagOrder', defaultOrder: 5, label: 'Video format (HEVC, H264, AV1, ...)' },
            { id: 'showAudioInfoTag', key: 'ShowAudioInfoTag', type: 'ordered', orderKey: 'AudioInfoTagOrder', defaultOrder: 6, label: 'Sound (Atmos, DTS, 5.1, 7.1, ...)' },
            { id: 'showEditionTag', key: 'ShowEditionTag', type: 'ordered', orderKey: 'EditionTagOrder', defaultOrder: 7, label: 'Edition (Director’s Cut, Extended, …)' },
            { id: 'showRuntimeTag', key: 'ShowRuntimeTag', type: 'ordered', orderKey: 'RuntimeTagOrder', defaultOrder: 8, label: 'Runtime' },
            { id: 'showAspectRatioTag', key: 'ShowAspectRatioTag', type: 'ordered', orderKey: 'AspectRatioTagOrder', defaultOrder: 9, label: 'Aspect ratio' },
            { id: 'showFrameRateTag', key: 'ShowFrameRateTag', type: 'ordered', orderKey: 'FrameRateTagOrder', defaultOrder: 10, label: 'Frame rate' },
            { id: 'showVersionsTag', key: 'ShowVersionsTag', type: 'ordered', orderKey: 'VersionsTagOrder', defaultOrder: 11, label: 'Versions (2 versions, 3 versions …)' },
            { id: 'showLowQualitySourceTag', key: 'ShowLowQualitySourceTag', type: 'switch', label: 'Include low-quality sources (CAM, TS, TC, SCR)', desc: 'Shows CAM, TS, TC and SCR sources as well.', more: 'Display behaviour' },
            { id: 'qualityAudioDisplayMode', key: 'QualityAudioDisplayMode', type: 'select', label: 'Sound display mode', fallback: 'highest', options: [['highest', 'Highest only'], ['all', 'All distinct values']], more: 'Display behaviour' },
            { id: 'qualityVideoCodecDisplayMode', key: 'QualityVideoCodecDisplayMode', type: 'select', label: 'Video codec display mode', fallback: 'highest', options: [['highest', 'Highest only'], ['all', 'All distinct values']], more: 'Display behaviour' },
            { id: 'qualityHdrDisplayMode', key: 'QualityHdrDisplayMode', type: 'select', label: 'HDR display mode', fallback: 'highest', options: [['highest', 'Highest only'], ['all', 'All distinct values']], more: 'Display behaviour' },
            { id: 'qualityMinimumResolution', key: 'QualityMinimumResolution', type: 'select', label: 'Minimum resolution to show', fallback: 'off', options: [['off', 'Off'], ['720p', '=720p'], ['1080p', '=1080p'], ['4k', '=4K']], more: 'Display behaviour' },
            { id: 'qualityHideSdr', key: 'QualityHideSdr', type: 'switch', label: 'Hide SDR', more: 'Display behaviour' },
            { id: 'seriesQualityAggregation', key: 'SeriesQualityAggregation', type: 'select', label: 'Series and season quality', desc: 'Which episodes a series or season card describes.', fallback: 'representative', options: [['representative', 'Representative episode'], ['latest', 'Latest episode'], ['best', 'Best quality'], ['shared', 'Only what every episode has'], ['mixed', 'Best, marked when mixed']], more: 'Display behaviour' },
            { id: 'qualityTagsPreferredAudioLanguage', key: 'QualityTagsPreferredAudioLanguage', type: 'select', label: 'Preferred audio language for sound tags', desc: 'The sound tag describes the best track in this language, not the best track in the file. Titles without it fall back to their best track. Users can override this.', fallback: '', options: [['', 'No preference (best track overall)']], more: 'Audio language defaults' },
            { id: 'qualityTagsAudioLanguageFromUser', key: 'QualityTagsAudioLanguageFromUser', type: 'switch', label: 'Use each user\'s Jellyfin audio language', desc: 'Judge sound tags by each user\'s own preferred audio language. Users without one keep the language above.', more: 'Audio language defaults' },
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
