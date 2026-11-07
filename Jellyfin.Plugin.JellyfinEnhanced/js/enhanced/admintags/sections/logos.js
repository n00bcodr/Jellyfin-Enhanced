(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-logos',
        tab: 'groups',
        order: 70,
        title: 'Logos', hint: 'Choose movie and series logos, their region and maximum count. Images share a fixed 64 MiB cache budget.',
        group: {
            id: 'logos',
            // The current choice, short (the description stays inside the group).
            summary: (ctx) => A.fmt('Movies: {movies} · Series: {series} · up to {n}', { movies: ({ provider: 'Provider', studio: 'Studio', off: A.fmt('Off') })[ctx.config.LogoTagsMovieMode] || 'Provider', series: ({ network: 'Network', provider: 'Provider', off: A.fmt('Off') })[ctx.config.LogoTagsSeriesMode] || 'Network', n: Number(ctx.config.LogoTagsMaxLogos) || 1 }), sample: () => [['status', A.fmt('Logos')]] },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'logoTagsEnabled', key: 'LogoTagsEnabled', type: 'enable', label: 'Logos for new users' },
            { id: 'logoTagsMovieMode', key: 'LogoTagsMovieMode', type: 'select', label: 'Movie logos', options: [['provider', '=Provider'], ['studio', '=Studio'], ['off', 'Off']] },
            { id: 'logoTagsSeriesMode', key: 'LogoTagsSeriesMode', type: 'select', label: 'Series logos', options: [['network', '=Network'], ['provider', '=Provider'], ['off', 'Off']] },
            { id: 'logoTagsRegion', key: 'LogoTagsRegion', type: 'text', label: 'Logo region (two letters; blank follows the server)' },
            { id: 'logoTagsMaxLogos', key: 'LogoTagsMaxLogos', type: 'number', label: 'Maximum logos', min: 1, max: 2, fallback: 1 },
        ],
    });
})(window.JellyfinEnhanced);
