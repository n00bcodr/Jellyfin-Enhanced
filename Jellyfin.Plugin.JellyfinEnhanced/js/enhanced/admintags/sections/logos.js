(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-logos',
        tab: 'groups',
        order: 70,
        title: 'common_logos', hint: 'admin_tags_logos_desc',
        group: {
            id: 'logos',
            // The current choice, short (the description stays inside the group).
            summary: (ctx) => JE.t('admin_tags_logos_summary', { movies: ({ provider: 'Provider', studio: 'Studio', off: JE.t('track_off') })[ctx.config.LogoTagsMovieMode] || 'Provider', series: ({ network: 'Network', provider: 'Provider', off: JE.t('track_off') })[ctx.config.LogoTagsSeriesMode] || 'Network', n: Number(ctx.config.LogoTagsMaxLogos) || 1 }), sample: () => [['status', JE.t('common_logos')]] },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'logoTagsEnabled', key: 'LogoTagsEnabled', type: 'enable', label: 'admin_tags_logoTagsEnabled' },
            { id: 'logoTagsMovieMode', key: 'LogoTagsMovieMode', type: 'select', label: 'admin_tags_logoTagsMovieMode', options: [['provider', '=Provider'], ['studio', '=Studio'], ['off', 'track_off']] },
            { id: 'logoTagsSeriesMode', key: 'LogoTagsSeriesMode', type: 'select', label: 'admin_tags_logoTagsSeriesMode', options: [['network', '=Network'], ['provider', '=Provider'], ['off', 'track_off']] },
            { id: 'logoTagsRegion', key: 'LogoTagsRegion', type: 'text', label: 'admin_tags_logoTagsRegion' },
            { id: 'logoTagsMaxLogos', key: 'LogoTagsMaxLogos', type: 'number', label: 'admin_tags_logoTagsMaxLogos', min: 1, max: 2, fallback: 1 },
        ],
    });
})(window.JellyfinEnhanced);
